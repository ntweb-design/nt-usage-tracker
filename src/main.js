const { app, BrowserWindow, ipcMain, screen, Menu, shell, Tray, nativeImage, nativeTheme, safeStorage, dialog } = require('electron');
const path = require('path');
const fs = require('fs');
const { Worker } = require('worker_threads');
const { spawn } = require('child_process');
const sysmon = require('./sysmon');
const vpsmon = require('./vpsmon');
const i18n = require('./i18n');

const { t } = i18n;

// ---------------------------------------------------------------- constants
const ITEM = 46;          // ring cell size (px)
const PAD = 6;            // box inner padding
const THICK = ITEM + PAD * 2;
const LABEL = 13;         // the box's name strip, above the rings
const MARGIN = 8;         // gap between a box and the screen edge
const GAP = 6;            // gap between boxes attached to each other
const EDGE_SNAP = 32;     // a dragged box this close to a screen edge docks to it
const CORNER_SNAP = 48;   // …and this close to the end of that edge, to the corner
const SNAP_REACH = 28;    // a dragged box this close to another box attaches to it
const POINT_SNAP = 12;    // along a side, this close to a corner or the centre wins over the grid
const CENTER_SNAP = 16;   // this close to the screen's centre lines, a box lines up on them
const GLIDE_MS = 45;      // how soft the glide into a snap is while dragging (time constant)
const SETTLE_MS = 220;    // the glide into place after letting go
const GRID_STEPS = [1, 0.5, 0]; // snap grid along a side, in icon cells (0 = corners and centre only)
const TIP_GAP = 8;
const LIMITS_EVERY = 90 * 1000;
const SHOT_DIR = process.env.UT_SHOT || null; // dev: save window captures here
const REPO_URL = 'https://github.com/ntweb-design/nt-usage-tracker'; // project page for "About…"
const MIN_OPACITY = 0.2;
const SURFACE = { dark: '#161616', light: '#f6f6f4' };
const DEFAULT_NAMES = { ai: 'AI', sys: 'This PC' }; // shown through t()

// Dev: UT_DATA=<dir> runs a separate copy with its own settings, next to the installed one.
if (process.env.UT_DATA) app.setPath('userData', process.env.UT_DATA);
if (!app.requestSingleInstanceLock()) app.quit();

app.setPath('userData', process.env.UT_DATA || path.join(app.getPath('appData'), 'nt-usage-tracker'));
const dataDir = app.getPath('userData');
const stateFile = path.join(dataDir, 'state.json');
const apiKeyFile = path.join(dataDir, 'claude-api-admin.key'); // encrypted with the OS (DPAPI)
const sshDir = path.join(dataDir, 'ssh');
vpsmon.configure({ dataDir });

/*
 * Boxes: `ai` (plan limits), `sys` (this PC) and one `vps:<id>` per server.
 * Each visible box is either a root, docked to a screen edge (edge + fraction
 * `t` along it), or hangs off another box: on its top, bottom, left or right
 * side, lined up with that side's start or end corner. A root and everything
 * hanging off it form a group that moves as one and shares its orientation.
 * Dragging a root moves its group; dragging any other box takes it (and what
 * hangs off it) out; dropping it next to any side of any box attaches it.
 */
let state = {
  place: {}, // boxId → { edge, t, displayId } | { x, y, displayId, vertical } (root) | { parent, side, align, offset } (attached)
  snapGrid: 1, // icon cells between snap points along a side
  lang: 'en', // interface language: 'en' or 'pt'
  sys: { visible: true },
  vps: [], // [{ id, name, host, user, port, keyFile, visible }]
  names: {}, // custom names for 'ai' and 'sys'
  labels: true,
  hidden: [],
  opacity: 1,
  theme: 'dark',
  apiBudget: null, // monthly Claude API budget in USD
};

/** Older layouts were rows of boxes along one edge; each becomes a root with a straight line of boxes. */
function placeFromChains(chains) {
  const place = {};
  for (const c of chains || []) {
    const order = (c.order || []).filter(Boolean);
    if (!order.length) continue;
    const i = Math.max(0, order.indexOf(c.anchor));
    const vertical = c.edge === 'left' || c.edge === 'right';
    place[order[i]] = { edge: c.edge || 'right', t: c.t ?? 0.5, displayId: c.displayId ?? null };
    for (let k = i - 1; k >= 0; k--) place[order[k]] = { parent: order[k + 1], side: vertical ? 'top' : 'left', align: 'start' };
    for (let k = i + 1; k < order.length; k++) place[order[k]] = { parent: order[k - 1], side: vertical ? 'bottom' : 'right', align: 'start' };
  }
  return place;
}

try {
  const saved = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
  if (saved.place && typeof saved.place === 'object') {
    state.place = saved.place;
  } else if (Array.isArray(saved.chains)) {
    state.place = placeFromChains(saved.chains);
  } else if (saved.ai) {
    // Two-box format: the PC box was either on its own or coupled to one end of the AI box.
    const ai = { edge: saved.ai.edge || 'right', t: saved.ai.t ?? 0.5, displayId: saved.ai.displayId ?? null };
    const sys = saved.sys || {};
    state.place = sys.visible !== false && sys.attach
      ? placeFromChains([{ ...ai, anchor: 'ai', order: sys.attach === 'before' ? ['sys', 'ai'] : ['ai', 'sys'] }])
      : { ai, sys: { edge: sys.edge || 'right', t: sys.t ?? 0.9, displayId: sys.displayId ?? null } };
  } else if (saved.edge) {
    state.place = { ai: { edge: saved.edge, t: saved.t ?? 0.5, displayId: saved.displayId ?? null } };
  }
  state.sys.visible = saved.sys?.visible !== false;
  state.vps = Array.isArray(saved.vps) ? saved.vps : [];
  state.names = saved.names || {};
  state.labels = saved.labels !== false;
  if (GRID_STEPS.includes(saved.snapGrid)) state.snapGrid = saved.snapGrid;
  if (saved.lang === 'pt') state.lang = 'pt';
  state.hidden = saved.hidden || [];
  if (typeof saved.opacity === 'number') state.opacity = Math.min(1, Math.max(MIN_OPACITY, saved.opacity));
  if (saved.theme === 'light') state.theme = 'light';
  if (saved.apiBudget > 0) state.apiBudget = saved.apiBudget;
} catch { /* first run */ }
nativeTheme.themeSource = state.theme;
i18n.setLang(state.lang);
const saveState = () => { try { fs.writeFileSync(stateFile, JSON.stringify(state)); } catch { /* ignore */ } };

const vpsBox = (v) => `vps:${v.id}`;
const vpsOf = (id) => (id?.startsWith('vps:') ? state.vps.find((v) => vpsBox(v) === id) : null);
const kindOf = (id) => (id === 'ai' ? 'ai' : id === 'sys' ? 'sys' : 'vps');
const nameOf = (id) => (kindOf(id) === 'vps' ? vpsOf(id)?.name || 'VPS' : state.names[id] || t(DEFAULT_NAMES[id]));

/** The boxes that should be on screen, in a stable order. */
function visibleIds() {
  return ['ai', ...(state.sys.visible ? ['sys'] : []), ...state.vps.filter((v) => v.visible !== false).map(vpsBox)];
}

const boxes = {}; // id → { win, count }
let tip, report, worker, tray, trayWin, apiKeyWin, vpsWin, nameWin;
let widgetHidden = false;
let trayHiddenAt = 0;
let traySize = { width: 264, height: 300 };
let raw = null;      // everything the collector found
let snapshot = null; // what is shown (minus providers the user hid)
let sysData = null;
let stopSysmon = null;
const vpsData = {};  // vps id → latest reading
const vpsMon = {};   // vps id → { stop, reconnect }
let drag = null;
let anim = null;
let tipFor = null;
let tipSize = { width: 300, height: 120 };

const ui = (f) => path.join(__dirname, 'ui', f);
/** Loads a UI page with the current theme in its URL, so it never flashes the wrong one. */
const load = (win, file, query = {}) => win.loadFile(ui(file), { query: { ...query, theme: state.theme, lang: state.lang } });
const webPreferences = { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, sandbox: true };
const alive = (w) => w && !w.isDestroyed();
const winOf = (id) => (alive(boxes[id]?.win) ? boxes[id].win : null);
const allBoxWins = () => Object.keys(boxes).map(winOf).filter(Boolean);
// The boxes sit on Windows' acrylic material: the desktop behind them is blurred
// by the system and the page only adds a faint tint on top.
const BOX_WINDOW = {
  frame: false, maximizable: false, minimizable: false,
  skipTaskbar: true, alwaysOnTop: true, show: false,
  backgroundMaterial: 'acrylic', backgroundColor: '#00000000', roundedCorners: true,
};

// ----------------------------------------------------------------- geometry
const isVertical = (edge) => edge === 'left' || edge === 'right';
const clamp = (v, lo, hi) => Math.min(Math.max(v, lo), Math.max(lo, hi));
const SIDES = ['top', 'bottom', 'left', 'right'];
const EDGES = SIDES;

const parentOf = (id) => state.place[id]?.parent || null;
function rootOf(id) {
  let r = id;
  for (let n = 0; parentOf(r) && n < 50; n++) r = parentOf(r);
  return r;
}
const childrenOf = (id) => Object.keys(state.place).filter((k) => state.place[k].parent === id);
/** A box and everything hanging off it, parents before children. */
function subtree(id) {
  const out = [id];
  for (let i = 0; i < out.length; i++) out.push(...childrenOf(out[i]).filter((c) => !out.includes(c)));
  return out;
}
const roots = () => Object.keys(state.place).filter((id) => !parentOf(id));
/** A group is vertical when docked to a side edge, or when it was left that way. */
const verticalOfPlace = (p) => (p?.edge ? isVertical(p.edge) : p?.vertical !== false);
const verticalOf = (id) => verticalOfPlace(state.place[rootOf(id)]);
const countOf = (id) => boxes[id]?.count || (kindOf(id) === 'ai' ? 5 : 3);

function sizeFor(id, vertical) {
  const label = state.labels ? LABEL : 0;
  const long = countOf(id) * ITEM + PAD * 2;
  return vertical ? { width: THICK, height: long + label } : { width: long, height: THICK + label };
}

const alongSide = (side) => (side === 'top' || side === 'bottom' ? 'x' : 'y');
const lenOf = (r, axis) => (axis === 'x' ? r.width : r.height);

/**
 * Where a box of size `s` goes on `side` of rect `p`. Along that side it lines
 * up with the start corner, the centre or the end corner (`align`), moved by
 * `offset` px; an offset may leave part of the box hanging past the side.
 */
function attachRect(p, side, align, s, offset = 0) {
  const axis = alongSide(side);
  const pLen = lenOf(p, axis);
  const sLen = lenOf(s, axis);
  const along = p[axis] + (align === 'end' ? pLen - sLen : align === 'center' ? (pLen - sLen) / 2 : 0) + (offset || 0);
  if (axis === 'x') return { x: along, y: side === 'top' ? p.y - GAP - s.height : p.y + p.height + GAP, ...s };
  return { x: side === 'left' ? p.x - GAP - s.width : p.x + p.width + GAP, y: along, ...s };
}

/**
 * The snap point nearest to `want` (the dragged box's start along the side,
 * relative to the side's start): the corners and the centre pull hardest,
 * otherwise the grid, which lets the box hang past the side by all but one icon.
 */
function alongSnap(pLen, sLen, want) {
  const named = [['start', 0], ['center', (pLen - sLen) / 2], ['end', pLen - sLen]];
  const near = named.reduce((a, b) => (Math.abs(b[1] - want) < Math.abs(a[1] - want) ? b : a));
  const step = state.snapGrid * ITEM;
  if (!step || Math.abs(near[1] - want) <= POINT_SNAP) return { align: near[0], offset: 0, pos: near[1] };
  const lo = -(sLen - ITEM);
  const hi = pLen - ITEM;
  const pos = clamp(Math.round(want / step) * step, Math.ceil(lo / step) * step, Math.floor(hi / step) * step);
  return { align: 'start', offset: pos, pos };
}

const union = (a, b) => {
  const x = Math.min(a.x, b.x), y = Math.min(a.y, b.y);
  return { x, y, width: Math.max(a.x + a.width, b.x + b.width) - x, height: Math.max(a.y + a.height, b.y + b.height) - y };
};
const overlaps = (a, b) => a.x < b.x + b.width - 1 && b.x < a.x + a.width - 1 && a.y < b.y + b.height - 1 && b.y < a.y + a.height - 1;

/** Rects of a box and everything hanging off it, relative to that box at (0, 0), plus their bounding box. */
function layout(rootId, vertical) {
  const rel = { [rootId]: { x: 0, y: 0, ...sizeFor(rootId, vertical) } };
  for (const id of subtree(rootId).slice(1)) {
    const p = state.place[id];
    if (rel[p.parent]) rel[id] = attachRect(rel[p.parent], p.side, p.align, sizeFor(id, vertical), p.offset);
  }
  return { rel, bb: Object.values(rel).reduce(union) };
}

function displayFor(id) {
  return screen.getAllDisplays().find((d) => d.id === id) || screen.getPrimaryDisplay();
}

/** Bounds of something of `size` attached to `edge` of work area `wa`, at fraction `t` along it. */
function dockedBounds(wa, edge, t, size) {
  const { width, height } = size;
  const free = isVertical(edge) ? wa.height - height - MARGIN * 2 : wa.width - width - MARGIN * 2;
  const along = MARGIN + Math.round(clamp(t, 0, 1) * Math.max(0, free));
  if (edge === 'left') return { x: wa.x + MARGIN, y: wa.y + along, width, height };
  if (edge === 'right') return { x: wa.x + wa.width - width - MARGIN, y: wa.y + along, width, height };
  if (edge === 'top') return { x: wa.x + along, y: wa.y + MARGIN, width, height };
  return { x: wa.x + along, y: wa.y + wa.height - height - MARGIN, width, height };
}

function fractionAlong(wa, edge, b) {
  const free = isVertical(edge) ? wa.height - b.height - MARGIN * 2 : wa.width - b.width - MARGIN * 2;
  if (free <= 0) return 0.5;
  const pos = isVertical(edge) ? b.y - wa.y - MARGIN : b.x - wa.x - MARGIN;
  return clamp(pos / free, 0, 1);
}

/** Keeps a free-standing rect inside the work area it mostly sits on. */
function keepOnScreen(b) {
  const wa = screen.getDisplayMatching({ x: Math.round(b.x), y: Math.round(b.y), width: b.width, height: b.height }).workArea;
  return { ...b, x: clamp(b.x, wa.x, wa.x + wa.width - b.width), y: clamp(b.y, wa.y, wa.y + wa.height - b.height) };
}

function setBounds(id, b) {
  const win = winOf(id);
  if (win) win.setBounds({ x: Math.round(b.x), y: Math.round(b.y), width: b.width, height: b.height });
}

/**
 * The boxes are created resizable because Windows mis-sizes frameless
 * non-resizable windows; resizing by the user is blocked here instead.
 */
function lockSize(win) {
  win.on('will-resize', (e) => e.preventDefault());
  win.on('maximize', () => win.unmaximize());
}

/** Tells each box how it is laid out and what its name is. */
function setLayout(ids, vertical) {
  for (const id of ids) {
    const win = winOf(id);
    if (win) win.webContents.send('layout', { vertical, label: state.labels ? nameOf(id) : null });
  }
}

/** Moves a group so that its bounding box starts at `origin`. */
function applyGroup(rootId, vertical, origin, lay = layout(rootId, vertical)) {
  for (const [id, r] of Object.entries(lay.rel)) setBounds(id, { ...r, x: origin.x + r.x - lay.bb.x, y: origin.y + r.y - lay.bb.y });
}

/** Where a group's bounding box belongs on screen, from its root's saved place. */
function groupTarget(rootId) {
  const p = state.place[rootId];
  const vertical = verticalOfPlace(p);
  const lay = layout(rootId, vertical);
  const size = { width: lay.bb.width, height: lay.bb.height };
  const origin = p.edge
    ? dockedBounds(displayFor(p.displayId).workArea, p.edge, p.t, size)
    : keepOnScreen({ x: p.x ?? 0, y: p.y ?? 0, ...size });
  return { vertical, lay, origin };
}

function placeGroup(rootId) {
  const { vertical, lay, origin } = groupTarget(rootId);
  applyGroup(rootId, vertical, origin, lay);
  setLayout(Object.keys(lay.rel), vertical);
}

/** Puts every box where the saved state says it belongs. */
function placeAll() {
  for (const r of roots()) placeGroup(r);
}

/** Current on-screen bounding box of a group. */
function groupRect(rootId) {
  const rects = subtree(rootId).map(winOf).filter(Boolean).map((w) => w.getBounds());
  return rects.length ? rects.reduce(union) : null;
}

/** Re-saves a root's place from where its boxes are now, so they stay put. */
function settleRoot(rootId) {
  const p = state.place[rootId];
  const w = winOf(rootId);
  if (!p || !w) return;
  // Measured from the root box alone: a box still gliding into the group must not move it.
  const r = w.getBounds();
  const { rel, bb } = layout(rootId, verticalOfPlace(p));
  const box = { x: r.x - (rel[rootId].x - bb.x), y: r.y - (rel[rootId].y - bb.y), width: bb.width, height: bb.height };
  const display = screen.getDisplayMatching(r);
  if (p.edge) p.t = fractionAlong(display.workArea, p.edge, box);
  else Object.assign(p, { x: box.x, y: box.y });
  p.displayId = display.id;
}

/**
 * Makes the layout match the visible boxes: a hidden or removed box hands its
 * spot to its first child (the rest hang off that child), and boxes that are
 * new or shown again hang off the AI group in the first free spot.
 */
function normalizePlaces() {
  const want = new Set(visibleIds());
  for (const id of Object.keys(state.place)) {
    if (want.has(id)) continue;
    const [first, ...rest] = childrenOf(id);
    if (first) {
      state.place[first] = { ...state.place[id] };
      for (const c of rest) state.place[c] = { ...state.place[c], parent: first };
    }
    delete state.place[id];
  }
  // Broken links (missing parent, loops, bad values) become free boxes.
  for (const [id, p] of Object.entries(state.place)) {
    if (p.parent) {
      const loops = (() => { let r = p.parent; for (let n = 0; r; n++) { if (r === id || n > 50) return true; r = parentOf(r); } return false; })();
      if (!state.place[p.parent] || loops || !SIDES.includes(p.side)) state.place[id] = { x: 200, y: 200, displayId: null, vertical: true };
      else {
        if (!['start', 'center', 'end'].includes(p.align)) p.align = 'start';
        if (!Number.isFinite(p.offset)) p.offset = 0;
      }
    } else if (p.edge && !EDGES.includes(p.edge)) p.edge = 'right';
    else if (!p.edge && (typeof p.x !== 'number' || typeof p.y !== 'number')) state.place[id] = { edge: 'right', t: 0.5, displayId: null };
    if (!p.parent && p.edge && typeof p.t !== 'number') p.t = 0.5;
  }
  if (!state.place.ai) state.place.ai = { edge: 'right', t: 0.5, displayId: null };
  for (const id of want) if (!state.place[id]) state.place[id] = freeSpotNear(rootOf('ai'), id);
}

/** The first spot next to a group where a box fits without covering another, preferring the group's long direction. */
function freeSpotNear(rootId, id) {
  const vertical = verticalOf(rootId);
  const { rel } = layout(rootId, vertical);
  const s = sizeFor(id, vertical);
  const sides = vertical ? ['bottom', 'top', 'left', 'right'] : ['right', 'left', 'top', 'bottom'];
  for (const host of Object.keys(rel).reverse()) {
    for (const side of sides) {
      for (const align of ['start', 'end']) {
        const r = attachRect(rel[host], side, align, s);
        if (!Object.values(rel).some((o) => overlaps(o, r))) return { parent: host, side, align };
      }
    }
  }
  return { x: 200, y: 200, displayId: null, vertical };
}
normalizePlaces();

// ----------------------------------------------------------------- dragging
/** A rect's distance to another (0 when they touch or overlap). */
function rectGap(a, b) {
  const dx = Math.max(0, a.x - (b.x + b.width), b.x - (a.x + a.width));
  const dy = Math.max(0, a.y - (b.y + b.height), b.y - (a.y + a.height));
  return Math.hypot(dx, dy);
}
const centreDist = (a, b) => Math.hypot(a.x + a.width / 2 - (b.x + b.width / 2), a.y + a.height / 2 - (b.y + b.height / 2));

/** Cached layout of the dragged group in one orientation. */
function dragLayout(vertical) {
  drag.lays[vertical] ||= layout(drag.root, vertical);
  return drag.lays[vertical];
}

/**
 * The best spot to attach the dragged group to another box: any of the four
 * sides of any box, at the snap point along that side nearest to where the
 * box is (corners, centre or grid), where nothing would end up covered.
 * Null when no box is close enough.
 */
function findSnap(origin) {
  const cur = dragLayout(drag.vertical);
  const freeRoot = { ...cur.rel[drag.root], x: origin.x + cur.rel[drag.root].x - cur.bb.x, y: origin.y + cur.rel[drag.root].y - cur.bb.y };
  const others = Object.keys(boxes).filter((id) => winOf(id) && !drag.ids.includes(id)).map((id) => ({ id, rect: winOf(id).getBounds() }));
  let best = null;
  for (const t of others) {
    const vertical = verticalOf(t.id);
    const lay = dragLayout(vertical);
    const s = sizeFor(drag.root, vertical);
    for (const side of SIDES) {
      const axis = alongSide(side);
      const at = alongSnap(lenOf(t.rect, axis), lenOf(s, axis), freeRoot[axis] - t.rect[axis]);
      const r = attachRect(t.rect, side, at.align, s, at.offset);
      if (rectGap(r, freeRoot) > SNAP_REACH) continue;
      const d = centreDist(r, freeRoot);
      if (best && d >= best.d) continue;
      // Everything that moves with the dragged box must land on free space.
      const o = { x: r.x - (lay.rel[drag.root].x - lay.bb.x), y: r.y - (lay.rel[drag.root].y - lay.bb.y) };
      const moved = Object.values(lay.rel).map((q) => ({ ...q, x: o.x + q.x - lay.bb.x, y: o.y + q.y - lay.bb.y }));
      if (moved.some((m) => others.some((x) => overlaps(m, x.rect)))) continue;
      best = { d, target: t.id, side, align: at.align, offset: at.offset, vertical, origin: o };
    }
  }
  return best;
}

function startDrag(id) {
  if (drag || !winOf(id) || !state.place[id]) return;
  stopAnim();
  hideTip();
  if (parentOf(id)) {
    // Taking a box out: it leaves with whatever hangs off it, and the group it left stays where it is.
    const oldRoot = rootOf(id);
    const r = groupRect(id);
    state.place[id] = { x: r.x, y: r.y, displayId: null, vertical: verticalOf(oldRoot) };
    settleRoot(oldRoot);
    placeGroup(oldRoot);
  }
  const root = rootOf(id);
  const cur = screen.getCursorScreenPoint();
  const b = groupRect(root);
  const vertical = verticalOf(root);
  drag = {
    id, root, ids: subtree(root), lays: {}, dx: cur.x - b.x, dy: cur.y - b.y, vertical,
    edge: null, snap: null, free: null,
    shown: { x: b.x, y: b.y }, mode: 'free', modeAt: Date.now(), lastAt: Date.now(),
    timer: setInterval(dragTick, 8),
  };
  winOf(id).webContents.send('dragging', true);
}

function setDragVertical(vertical) {
  if (vertical === drag.vertical) return;
  drag.vertical = vertical;
  setLayout(drag.ids, vertical);
}

/**
 * Moves the dragged group towards `origin`. Plain dragging follows the mouse
 * exactly; whenever a snap takes over (or lets go), the group glides there
 * instead of jumping.
 */
function moveDrag(vertical, origin, lay, mode) {
  const now = Date.now();
  if (mode !== drag.mode) { drag.mode = mode; drag.modeAt = now; }
  const gliding = mode !== 'free' || now - drag.modeAt < GLIDE_MS * 5;
  if (gliding) {
    const k = 1 - Math.exp(-Math.max(1, now - drag.lastAt) / GLIDE_MS);
    drag.shown = { x: drag.shown.x + (origin.x - drag.shown.x) * k, y: drag.shown.y + (origin.y - drag.shown.y) * k };
  } else {
    drag.shown = { ...origin };
  }
  drag.lastAt = now;
  applyGroup(drag.root, vertical, drag.shown, lay);
}

function dragTick() {
  if (!drag) return;
  const cur = screen.getCursorScreenPoint();
  let origin = { x: cur.x - drag.dx, y: cur.y - drag.dy };
  drag.edge = null;
  drag.free = null;

  // 1) Other boxes are magnets: near any side of one, the group attaches there.
  const snap = findSnap(origin);
  drag.snap = snap;
  if (snap) {
    setDragVertical(snap.vertical);
    return moveDrag(snap.vertical, snap.origin, dragLayout(snap.vertical), `box:${snap.target}:${snap.side}:${snap.align}:${snap.offset}`);
  }

  // 2) Screen edges are magnets too: close to one, the group docks to it; near its ends, to the corner; near its middle, to the centre.
  const display = screen.getDisplayNearestPoint(cur);
  const wa = display.workArea;
  let lay = dragLayout(drag.vertical);
  let b = { ...origin, width: lay.bb.width, height: lay.bb.height };
  const dist = { left: b.x - wa.x, right: wa.x + wa.width - (b.x + b.width), top: b.y - wa.y, bottom: wa.y + wa.height - (b.y + b.height) };
  const edge = EDGES.reduce((a, e) => (dist[e] < dist[a] ? e : a));
  if (dist[edge] < EDGE_SNAP) {
    if (isVertical(edge) !== drag.vertical) {
      // Orientation flips: re-centre the grab point on the reshaped group.
      setDragVertical(isVertical(edge));
      lay = dragLayout(drag.vertical);
      drag.dx = lay.bb.width / 2;
      drag.dy = lay.bb.height / 2;
      origin = { x: cur.x - drag.dx, y: cur.y - drag.dy };
      b = { ...origin, width: lay.bb.width, height: lay.bb.height };
    }
    let t = fractionAlong(wa, edge, b);
    const room = isVertical(edge) ? wa.height - b.height - MARGIN * 2 : wa.width - b.width - MARGIN * 2;
    let pin = '';
    if (t * room < CORNER_SNAP) { t = 0; pin = 'start'; }
    else if ((1 - t) * room < CORNER_SNAP) { t = 1; pin = 'end'; }
    else if (Math.abs(t - 0.5) * room < CENTER_SNAP) { t = 0.5; pin = 'center'; }
    drag.edge = { edge, t, displayId: display.id };
    return moveDrag(drag.vertical, dockedBounds(wa, edge, t, b), lay, `edge:${edge}:${pin}`);
  }

  // 3) Anywhere else the group follows the mouse, lining up on the screen's centre lines when close.
  const cx = wa.x + wa.width / 2;
  const cy = wa.y + wa.height / 2;
  const onX = Math.abs(b.x + b.width / 2 - cx) < CENTER_SNAP;
  const onY = Math.abs(b.y + b.height / 2 - cy) < CENTER_SNAP;
  if (onX) origin.x = cx - b.width / 2;
  if (onY) origin.y = cy - b.height / 2;
  drag.free = { x: origin.x, y: origin.y, displayId: display.id };
  moveDrag(drag.vertical, origin, lay, onX || onY ? `centre:${onX}:${onY}` : 'free');
}

function endDrag() {
  if (!drag) return;
  clearInterval(drag.timer);
  const { id, root, snap, edge, free, vertical } = drag;
  drag = null;
  if (winOf(id)) winOf(id).webContents.send('dragging', false);

  let target = root;
  if (snap) {
    // Attached: the group it joined keeps its spot on the screen.
    state.place[root] = { parent: snap.target, side: snap.side, align: snap.align, offset: snap.offset };
    target = rootOf(snap.target);
    settleRoot(target);
  } else if (edge) {
    state.place[root] = edge;
  } else {
    // Where the mouse put it (the glide may still be on its way there).
    const now = groupRect(root);
    const at = free || now;
    state.place[root] = { x: Math.round(at.x), y: Math.round(at.y), displayId: free?.displayId ?? screen.getDisplayMatching(now).id, vertical };
  }
  saveState();
  const to = groupTarget(target);
  setLayout(Object.keys(to.lay.rel), to.vertical);
  animateTo(target, to);
}

function stopAnim() {
  if (anim) { clearInterval(anim); anim = null; }
}

/**
 * Ease-out glide of every box in a group from wherever it is now to its final
 * spot — the "snap" of the magnet. Each box moves on its own, so one that was
 * still gliding in carries on smoothly.
 */
function animateTo(rootId, { lay, origin }) {
  stopAnim();
  const moves = Object.entries(lay.rel).map(([id, r]) => {
    const to = { ...r, x: origin.x + r.x - lay.bb.x, y: origin.y + r.y - lay.bb.y };
    return { id, to, from: winOf(id)?.getBounds() || to };
  });
  const t0 = Date.now();
  anim = setInterval(() => {
    const k = Math.min(1, (Date.now() - t0) / SETTLE_MS);
    const e = 1 - Math.pow(1 - k, 4);
    for (const m of moves) setBounds(m.id, { ...m.to, x: m.from.x + (m.to.x - m.from.x) * e, y: m.from.y + (m.to.y - m.from.y) * e });
    if (k >= 1) stopAnim();
  }, 8);
}

// ------------------------------------------------------------------ tooltip
function sendTip() {
  if (!tipFor || !alive(tip)) return;
  const kind = kindOf(tipFor.which);
  if (kind === 'sys') tip.webContents.send('tip', { kind: 'sys', id: tipFor.id, sys: sysData });
  else if (kind === 'vps') {
    const v = vpsOf(tipFor.which);
    tip.webContents.send('tip', { kind: 'vps', id: tipFor.id, name: v?.name, vps: v && vpsData[v.id] });
  } else tip.webContents.send('tip', { kind: 'ai', id: tipFor.id, snapshot });
}

function showTip(which, id, rect) {
  if (drag || !alive(tip)) return;
  tipFor = { which, id, rect };
  sendTip();
}

function positionTip() {
  if (!tipFor || !alive(tip) || !winOf(tipFor.which)) return;
  const d = winOf(tipFor.which).getBounds();
  const wa = screen.getDisplayMatching(d).workArea;
  const r = tipFor.rect;
  const { width, height } = tipSize;
  let x, y;
  if (verticalOf(tipFor.which)) {
    // Beside the box, on the side with more room.
    const leftRoom = d.x - wa.x;
    const rightRoom = wa.x + wa.width - (d.x + d.width);
    x = rightRoom >= width + TIP_GAP || rightRoom >= leftRoom ? d.x + d.width + TIP_GAP : d.x - width - TIP_GAP;
    y = d.y + r.y + r.height / 2 - height / 2;
  } else {
    const above = d.y - wa.y;
    const below = wa.y + wa.height - (d.y + d.height);
    y = below >= height + TIP_GAP || below >= above ? d.y + d.height + TIP_GAP : d.y - height - TIP_GAP;
    x = d.x + r.x + r.width / 2 - width / 2;
  }
  x = clamp(x, wa.x + 4, wa.x + wa.width - width - 4);
  y = clamp(y, wa.y + 4, wa.y + wa.height - height - 4);
  tip.setBounds({ x: Math.round(x), y: Math.round(y), width, height });
  if (!tip.isVisible()) tip.showInactive();
  tip.setAlwaysOnTop(true, 'screen-saver');
}

function hideTip() {
  tipFor = null;
  if (alive(tip) && tip.isVisible()) tip.hide();
}

// ------------------------------------------------------------------- report
function openReport(id) {
  hideTip();
  if (alive(report)) {
    report.webContents.send('report', { id, snapshot });
    if (report.isMinimized()) report.restore();
    report.show();
    report.focus();
    return;
  }
  const wa = screen.getDisplayMatching(winOf('ai').getBounds()).workArea;
  const width = Math.min(1040, wa.width - 80);
  const height = Math.min(820, wa.height - 80);
  report = new BrowserWindow({
    width, height,
    x: Math.round(wa.x + (wa.width - width) / 2),
    y: Math.round(wa.y + (wa.height - height) / 2),
    minWidth: 640, minHeight: 480,
    backgroundColor: SURFACE[state.theme],
    title: t('Usage'),
    autoHideMenuBar: true,
    show: false,
    webPreferences,
  });
  report.removeMenu();
  load(report, 'report.html');
  report.webContents.once('did-finish-load', () => {
    report.webContents.send('report', { id, snapshot });
    report.show();
  });
  report.on('closed', () => { report = null; });
}

// --------------------------------------------------------------------- data
/** Applies the user's show/hide choices and pushes the result to every window. */
function publish() {
  if (!raw) return;
  const hidden = new Set(state.hidden || []);
  snapshot = { ...raw, providers: raw.providers.filter((p) => !hidden.has(p.id)) };
  const n = Math.max(1, snapshot.providers.length);
  if (boxes.ai && n !== boxes.ai.count) { boxes.ai.count = n; if (!drag) placeAll(); }
  for (const w of [winOf('ai'), report]) if (alive(w)) w.webContents.send('snapshot', snapshot);
  if (tipFor?.which === 'ai') sendTip();
}

function toggleProvider(id, show) {
  const hidden = new Set(state.hidden || []);
  if (show) hidden.delete(id); else hidden.add(id);
  state.hidden = [...hidden];
  saveState();
  hideTip();
  publish();
}

/**
 * Sign-in is delegated to each CLI's own login command, opened in a terminal:
 * the CLI runs its official browser flow and stores the session, and the
 * widget picks it up on the next refresh. No credentials pass through here.
 */
function connect(id) {
  if (id === 'claude-api') return openApiKeyWindow();
  const p = raw?.providers.find((x) => x.id === id);
  if (!p?.cli?.path || !p.cli.login) return;
  const child = /\s/.test(p.cli.path)
    ? spawn(p.cli.path, p.cli.login, { detached: true, stdio: 'ignore' })
    : spawn('cmd.exe', ['/k', p.cli.path, ...p.cli.login], { detached: true, stdio: 'ignore' });
  child.on('error', (err) => console.error('connect', err));
  child.unref();
  for (const s of [15, 40, 90, 180]) setTimeout(refresh, s * 1000);
}


// ---------------------------------------------------------- Claude API key
/**
 * The Claude API has no CLI session to borrow, so its Admin API key is pasted
 * into a small window, encrypted with the OS (safeStorage/DPAPI) and only ever
 * handed to the collector in memory.
 */
function readApiKey() {
  try {
    if (!safeStorage.isEncryptionAvailable()) return null;
    return safeStorage.decryptString(fs.readFileSync(apiKeyFile));
  } catch { return null; }
}

const claudeApiConfig = () => ({ key: readApiKey(), budget: state.apiBudget });

function openApiKeyWindow() {
  if (alive(apiKeyWin)) { apiKeyWin.focus(); return; }
  apiKeyWin = new BrowserWindow({
    width: 460, height: 360, useContentSize: true, resizable: false, minimizable: false, maximizable: false,
    backgroundColor: SURFACE[state.theme],
    title: 'Claude API',
    autoHideMenuBar: true,
    show: false,
    webPreferences,
  });
  apiKeyWin.removeMenu();
  load(apiKeyWin, 'apikey.html');
  apiKeyWin.once('ready-to-show', () => apiKeyWin.show());
  apiKeyWin.on('closed', () => { apiKeyWin = null; });
}

ipcMain.handle('apikey-state', () => {
  const key = readApiKey();
  return { hasKey: Boolean(key), hint: key ? `…${key.slice(-4)}` : '', budget: state.apiBudget, canEncrypt: safeStorage.isEncryptionAvailable() };
});

ipcMain.handle('apikey-save', async (_e, { key, remove, budget }) => {
  if (remove) {
    try { fs.unlinkSync(apiKeyFile); } catch { /* already gone */ }
  } else if (key) {
    // Admin keys (sk-ant-admin…) or a personal/service-account key of an admin (sk-ant-usr…, …).
    if (!/^sk-ant-\S{20,}$/.test(key)) return { ok: false, message: t("That doesn't look like an Anthropic key (sk-ant-…).") };
    if (!safeStorage.isEncryptionAvailable()) return { ok: false, message: t('System encryption is not available.') };
    // Ask Anthropic first, so a dead or under-privileged key is refused here instead of failing silently later.
    const problem = await require('./collect/claude-api').validate(key);
    if (problem && problem.kind !== 'net') return { ok: false, message: problem.message };
    try {
      fs.mkdirSync(dataDir, { recursive: true });
      fs.writeFileSync(apiKeyFile, safeStorage.encryptString(key));
    } catch (err) {
      return { ok: false, message: t('Could not save the key: {error}', { error: err.message }) };
    }
  } else if (!readApiKey()) {
    return { ok: false, message: t('Paste the Admin key.') };
  }
  state.apiBudget = budget > 0 ? budget : null;
  saveState();
  if (worker) worker.postMessage({ type: 'config', claudeApi: claudeApiConfig() });
  refresh();
  if (alive(apiKeyWin)) apiKeyWin.close();
  return { ok: true };
});

function startWorker() {
  worker = new Worker(path.join(__dirname, 'collect', 'index.js').replace('app.asar', 'app.asar.unpacked'), { workerData: { dataDir, claudeApi: claudeApiConfig(), lang: state.lang } });
  worker.on('message', (msg) => {
    if (msg.type !== 'snapshot') { if (msg.type === 'error') console.error(msg.message); return; }
    raw = msg.snapshot;
    publish();
  });
  worker.on('error', (err) => console.error('collector', err));
  refresh();
  setInterval(refresh, LIMITS_EVERY);
}

const refresh = () => worker && worker.postMessage({ type: 'refresh', limits: true, usage: true });


// -------------------------------------------------------------------- boxes
/** Sends a box the data it shows. */
function pushData(id) {
  const win = winOf(id);
  if (!win) return;
  const kind = kindOf(id);
  if (kind === 'ai') { if (snapshot) win.webContents.send('snapshot', snapshot); }
  else if (kind === 'sys') { if (sysData) win.webContents.send('sys', sysData); }
  else { const v = vpsOf(id); if (v && vpsData[v.id]) win.webContents.send('sys', vpsData[v.id]); }
}

function createBox(id) {
  const kind = kindOf(id);
  const win = new BrowserWindow({ ...sizeFor(id, verticalOf(id)), ...BOX_WINDOW, webPreferences });
  boxes[id] = { count: countOf(id), win };
  lockSize(win);
  win.setAlwaysOnTop(true, 'screen-saver');
  win.setOpacity(state.opacity);
  load(win, 'dock.html', { kind });
  win.webContents.once('did-finish-load', () => {
    placeAll();
    pushData(id);
    if (!widgetHidden) win.showInactive();
  });
  win.on('closed', () => {
    if (kind === 'ai') return app.quit();
    if (boxes[id]?.win === win) delete boxes[id];
  });
  return win;
}

function destroyBox(id) {
  const win = winOf(id);
  delete boxes[id];
  if (win) win.destroy();
  if (tipFor?.which === id) hideTip();
}

// ------------------------------------------------------------------- PC box
function createSysBox() {
  createBox('sys');
  stopSysmon = sysmon.start((data) => {
    sysData = data;
    pushData('sys');
    if (tipFor?.which === 'sys') sendTip();
  });
}

function setSysVisible(on) {
  state.sys.visible = on;
  normalizePlaces();
  saveState();
  hideTip();
  if (on && !winOf('sys')) createSysBox(); // places everything once loaded
  if (!on) {
    if (stopSysmon) { stopSysmon(); stopSysmon = null; }
    destroyBox('sys');
  }
  placeAll();
}

// ---------------------------------------------------------------- VPS boxes
function startVps(v) {
  stopVps(v.id);
  vpsData[v.id] = { status: 'connecting' };
  vpsMon[v.id] = vpsmon.start(v, (data) => {
    vpsData[v.id] = data;
    pushData(vpsBox(v));
    if (tipFor?.which === vpsBox(v)) sendTip();
  });
}

function stopVps(id) {
  if (vpsMon[id]) { vpsMon[id].stop(); delete vpsMon[id]; }
  delete vpsData[id];
}

function showVps(v) {
  startVps(v);
  if (!winOf(vpsBox(v))) createBox(vpsBox(v));
}

function setVpsVisible(id, on) {
  const v = state.vps.find((x) => x.id === id);
  if (!v) return;
  v.visible = on;
  normalizePlaces();
  saveState();
  hideTip();
  if (on) showVps(v);
  else { stopVps(id); destroyBox(vpsBox(v)); }
  placeAll();
}

async function removeVps(id) {
  const v = state.vps.find((x) => x.id === id);
  if (!v) return;
  const { response } = await dialog.showMessageBox({
    type: 'question', buttons: [t('Remove'), t('Cancel')], defaultId: 1, cancelId: 1,
    title: t('Remove VPS'), message: t('Remove "{name}" from the widget?', { name: v.name }),
    detail: t('It only leaves the widget; nothing changes on the VPS. A key the app generated for it stays in the data folder.'),
  });
  if (response !== 0) return;
  stopVps(id);
  destroyBox(vpsBox(v));
  state.vps = state.vps.filter((x) => x.id !== id);
  normalizePlaces();
  saveState();
  placeAll();
}

// ---------------------------------------------------------- small windows
function smallWindow(file, title, size, query = {}) {
  const win = new BrowserWindow({
    ...size, useContentSize: true, resizable: false, minimizable: false, maximizable: false,
    backgroundColor: SURFACE[state.theme], title, autoHideMenuBar: true, show: false, webPreferences,
  });
  win.removeMenu();
  load(win, file, query);
  win.once('ready-to-show', () => win.show());
  return win;
}

/** Add (id = null) or edit one VPS. */
function openVpsWindow(id = null) {
  if (alive(vpsWin)) vpsWin.close();
  vpsWin = smallWindow('vps.html', id ? t('Edit VPS') : t('Add VPS'), { width: 500, height: 700 }, id ? { id } : {});
  vpsWin.on('closed', () => { vpsWin = null; });
}

function openNameWindow(boxId) {
  if (alive(nameWin)) nameWin.close();
  nameWin = smallWindow('name.html', t('Box name'), { width: 340, height: 170 }, { box: boxId });
  nameWin.on('closed', () => { nameWin = null; });
}

function setLabels(on) {
  state.labels = on;
  saveState();
  hideTip();
  placeAll();
}

/** A pasted private key is kept as a file in the app's ssh folder, which only this user can read. */
function savePastedKey(id, text) {
  const body = String(text || '').replace(/\r\n/g, '\n').trim();
  if (!/^-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]+-----END [A-Z ]*PRIVATE KEY-----$/.test(body)) {
    throw new Error(t('That does not look like a private key (it should start with -----BEGIN … PRIVATE KEY-----). The .pub goes on the VPS, not here.'));
  }
  fs.mkdirSync(sshDir, { recursive: true });
  const file = path.join(sshDir, `${id}_key`);
  try { fs.unlinkSync(file); } catch { /* new */ }
  fs.writeFileSync(file, body + '\n', { mode: 0o600 });
  return file;
}

/** Cleans what the VPS window sends; `key` decides where the private key comes from. */
async function vpsFromForm(f, id) {
  const host = String(f.host || '').trim();
  if (!host) throw new Error(t('Enter the host: an IP, a Tailscale name or a Host from ~/.ssh/config.'));
  if (/\s/.test(host)) throw new Error(t('The host cannot contain spaces.'));
  const port = f.port ? Number(f.port) : null;
  if (port != null && !(port > 0 && port < 65536)) throw new Error(t('Invalid port.'));
  let keyFile = null;
  if (f.keyMode === 'file' || f.keyMode === 'generated') keyFile = String(f.keyFile || '').trim() || null;
  if (f.keyMode === 'paste') {
    if (f.keyText) { keyFile = savePastedKey(id, f.keyText); await vpsmon.lockDown(keyFile); }
    else keyFile = String(f.keyFile || '').trim() || null;
  }
  if ((f.keyMode === 'file' || f.keyMode === 'generated' || f.keyMode === 'paste') && !keyFile) throw new Error(t('Choose, paste or generate the key.'));
  if (keyFile && !fs.existsSync(keyFile)) throw new Error(t('Key file not found.'));
  return {
    id,
    name: String(f.name || '').trim() || host,
    host,
    user: String(f.user || '').trim() || null,
    port,
    keyMode: f.keyMode || 'default',
    keyFile,
  };
}

const newVpsId = () => 'v' + Date.now().toString(36);

ipcMain.handle('vps-get', async (_e, id) => {
  const v = id ? state.vps.find((x) => x.id === id) : null;
  return {
    vps: v || null,
    draftId: v?.id || newVpsId(),
    hosts: vpsmon.configHosts(),
    pub: v?.keyFile ? await vpsmon.publicKey(v.keyFile) : null,
  };
});

ipcMain.handle('vps-pick-key', async () => {
  const r = await dialog.showOpenDialog(vpsWin, {
    title: t('SSH private key'), defaultPath: path.join(require('os').homedir(), '.ssh'),
    properties: ['openFile', 'showHiddenFiles'],
  });
  if (r.canceled || !r.filePaths[0]) return null;
  const file = r.filePaths[0];
  if (file.endsWith('.pub')) return { error: t('That is the public file (.pub): it goes on the VPS. Pick the file without .pub here.') };
  return { keyFile: file, pub: await vpsmon.publicKey(file) };
});

ipcMain.handle('vps-gen-key', async (_e, { draftId, host }) => {
  try {
    const file = path.join(sshDir, `${draftId}_ed25519`);
    const pub = await vpsmon.generateKey(file, `nt-usage-tracker@${String(host || 'vps').replace(/[^\w.-]/g, '')}`);
    return { ok: true, keyFile: file, pub };
  } catch (err) {
    return { ok: false, message: t('Could not generate the key: {error}', { error: err.message }) };
  }
});

ipcMain.handle('vps-test', async (_e, { draftId, form }) => {
  try {
    return await vpsmon.test(await vpsFromForm(form, draftId));
  } catch (err) {
    return { ok: false, message: err.message };
  }
});

ipcMain.handle('vps-save', async (_e, { draftId, form }) => {
  let v;
  try { v = await vpsFromForm(form, draftId); } catch (err) { return { ok: false, message: err.message }; }
  const i = state.vps.findIndex((x) => x.id === draftId);
  if (i >= 0) {
    v.visible = state.vps[i].visible;
    state.vps[i] = v;
    saveState();
    if (v.visible !== false) { startVps(v); setLayout([vpsBox(v)], verticalOf(vpsBox(v))); }
  } else {
    v.visible = true;
    state.vps.push(v);
    normalizePlaces();
    saveState();
    showVps(v);
    placeAll();
  }
  if (alive(vpsWin)) vpsWin.close();
  return { ok: true };
});

ipcMain.handle('copy-text', (_e, text) => { require('electron').clipboard.writeText(String(text || '')); return true; });
ipcMain.handle('name-get', (_e, boxId) => ({ name: nameOf(boxId), fallback: DEFAULT_NAMES[boxId] || '' }));
ipcMain.handle('name-save', (_e, { box, name }) => {
  const clean = String(name || '').trim().slice(0, 40);
  const v = vpsOf(box);
  if (v) v.name = clean || v.host;
  else if (box === 'ai' || box === 'sys') { if (clean) state.names[box] = clean; else delete state.names[box]; }
  saveState();
  setLayout([box], verticalOf(box));
  if (alive(nameWin)) nameWin.close();
  return { ok: true };
});

// --------------------------------------------------------------------- tray
/** Draws the tray icon (two rings, like the widget) so no image file is needed. */
function trayIcon() {
  const size = 32;
  const buf = Buffer.alloc(size * size * 4);
  const rings = [{ r: 13.2, w: 1.7, rgb: [47, 194, 107] }, { r: 7.6, w: 1.7, rgb: [250, 178, 25] }];
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const d = Math.hypot(x + 0.5 - size / 2, y + 0.5 - size / 2);
      for (const ring of rings) {
        const a = Math.max(0, Math.min(1, ring.w + 0.5 - Math.abs(d - ring.r)));
        if (!a) continue;
        const i = (y * size + x) * 4; // BGRA, premultiplied
        buf[i] = ring.rgb[2] * a; buf[i + 1] = ring.rgb[1] * a; buf[i + 2] = ring.rgb[0] * a; buf[i + 3] = 255 * a;
      }
    }
  }
  return nativeImage.createFromBitmap(buf, { width: size, height: size });
}

const trayState = () => ({ version: app.getVersion(), opacity: state.opacity, theme: state.theme, hidden: widgetHidden, lang: state.lang });
const pushTrayState = () => { if (alive(trayWin)) trayWin.webContents.send('tray-state', trayState()); };

function createTray() {
  tray = new Tray(trayIcon());
  tray.setToolTip('NT Usage Tracker');
  tray.on('click', toggleTrayMenu);
  tray.on('right-click', toggleTrayMenu);

  // A small window instead of a native menu, because it needs a slider and a switch.
  trayWin = new BrowserWindow({
    ...traySize,
    frame: false, transparent: true, resizable: false, maximizable: false, minimizable: false,
    skipTaskbar: true, alwaysOnTop: true, hasShadow: false, show: false,
    webPreferences: { ...webPreferences, backgroundThrottling: false },
  });
  trayWin.setAlwaysOnTop(true, 'screen-saver');
  load(trayWin, 'tray.html');
  trayWin.on('blur', hideTrayMenu);
}

function hideTrayMenu() {
  if (alive(trayWin) && trayWin.isVisible()) { trayWin.hide(); trayHiddenAt = Date.now(); }
}

function showTrayMenu() {
  if (!alive(trayWin)) return;
  hideTip();
  pushTrayState();
  // Open next to the tray icon, kept inside the screen whichever side the taskbar is on.
  const t = tray.getBounds();
  const wa = screen.getDisplayNearestPoint({ x: t.x + t.width / 2, y: t.y + t.height / 2 }).workArea;
  const { width, height } = traySize;
  const x = clamp(t.x + t.width / 2 - width / 2, wa.x + 8, wa.x + wa.width - width - 8);
  const y = clamp(t.y - height - 8, wa.y + 8, wa.y + wa.height - height - 8);
  trayWin.setBounds({ x: Math.round(x), y: Math.round(y), width, height });
  trayWin.show();
  trayWin.focus();
}

function toggleTrayMenu() {
  // The click that closes the menu (by blurring it) must not reopen it.
  if (alive(trayWin) && trayWin.isVisible()) return hideTrayMenu();
  if (Date.now() - trayHiddenAt < 250) return;
  showTrayMenu();
}

function setWidgetHidden(on) {
  widgetHidden = on;
  hideTip();
  for (const win of allBoxWins()) { if (on) win.hide(); else win.showInactive(); }
  pushTrayState();
}

function setOpacity(value) {
  state.opacity = Math.min(1, Math.max(MIN_OPACITY, Number(value) || 1));
  for (const win of allBoxWins()) win.setOpacity(state.opacity);
  saveState();
}

function setTheme(theme) {
  state.theme = theme === 'light' ? 'light' : 'dark';
  nativeTheme.themeSource = state.theme;
  saveState();
  for (const w of [...allBoxWins(), tip, report, trayWin, apiKeyWin, vpsWin, nameWin]) if (alive(w)) w.webContents.send('theme', state.theme);
  if (alive(report)) report.setBackgroundColor(SURFACE[state.theme]);
  pushTrayState();
}

/**
 * Switches the interface language: the collector rewrites its messages on the
 * next refresh and every open window reloads in the new language.
 */
function setLanguage(lang) {
  const next = lang === 'pt' ? 'pt' : 'en';
  if (next === state.lang) return;
  state.lang = next;
  i18n.setLang(next);
  saveState();
  hideTip();
  if (worker) worker.postMessage({ type: 'config', lang: next });
  for (const id of Object.keys(boxes)) {
    const win = winOf(id);
    if (!win) continue;
    win.webContents.once('did-finish-load', () => { pushData(id); setLayout([id], verticalOf(id)); });
    load(win, 'dock.html', { kind: kindOf(id) });
  }
  if (alive(tip)) load(tip, 'tip.html');
  if (alive(trayWin)) load(trayWin, 'tray.html');
  if (alive(report)) {
    report.setTitle(t('Usage'));
    report.webContents.once('did-finish-load', () => report.webContents.send('report', { id: null, snapshot }));
    load(report, 'report.html');
  }
  for (const w of [apiKeyWin, vpsWin, nameWin]) if (alive(w)) w.close();
  refresh();
}

function trayAction({ type, value }) {
  if (type === 'opacity') return setOpacity(value);
  if (type === 'theme') return setTheme(value);
  if (type === 'toggle') return setWidgetHidden(!widgetHidden);
  if (type === 'lang') return setLanguage(value);
  hideTrayMenu();
  if (type === 'report') openReport(null);
  else if (type === 'about' && /^https:\/\//.test(REPO_URL)) shell.openExternal(REPO_URL);
  else if (type === 'quit') app.quit();
}

// ---------------------------------------------------------------------- app
function loginItemOptions() {
  // In development the executable is electron.exe, so the app path must be passed along.
  return app.isPackaged ? {} : { path: process.execPath, args: [app.getAppPath()] };
}

function contextMenu(which) {
  const startsAtLogin = app.getLoginItemSettings(loginItemOptions()).openAtLogin;
  const all = raw?.providers || [];
  const hidden = new Set(state.hidden || []);
  const thisVps = vpsOf(which);
  Menu.buildFromTemplate([
    ...(thisVps ? [
      { label: thisVps.name, enabled: false },
      { label: t('Reconnect'), click: () => vpsMon[thisVps.id]?.reconnect() },
      { label: t('Edit this VPS…'), click: () => openVpsWindow(thisVps.id) },
      { type: 'separator' },
    ] : []),
    { label: t('Open report'), click: () => openReport(null) },
    { label: t('Refresh now'), click: refresh },
    { type: 'separator' },
    {
      label: t('Providers'),
      submenu: all.length
        ? all.map((p) => ({ label: p.name, type: 'checkbox', checked: !hidden.has(p.id), click: (item) => toggleProvider(p.id, item.checked) }))
        : [{ label: t('No CLI detected'), enabled: false }],
    },
    {
      label: t('Connect account'),
      submenu: [
        ...all.map((p) => ({
          label: p.cli.login ? `${p.name}…` : `${p.name} — ${p.cli.hint ? t('in the app') : t('unavailable')}`,
          enabled: Boolean(p.cli.login),
          click: () => connect(p.id),
        })),
        // The Claude API only shows up once it has a key, so it is always offered here.
        ...(all.some((p) => p.id === 'claude-api') ? [] : [{ label: t('Claude API (Admin key)…'), click: openApiKeyWindow }]),
      ],
    },
    { label: t('PC monitor'), type: 'checkbox', checked: state.sys.visible, click: (item) => setSysVisible(item.checked) },
    {
      label: 'VPS',
      submenu: [
        { label: t('Add VPS…'), click: () => openVpsWindow(null) },
        ...(state.vps.length ? [{ type: 'separator' }] : []),
        ...state.vps.map((v) => ({
          label: v.name,
          submenu: [
            { label: t('Show'), type: 'checkbox', checked: v.visible !== false, click: (item) => setVpsVisible(v.id, item.checked) },
            { label: t('Edit…'), click: () => openVpsWindow(v.id) },
            { label: t('Reconnect'), enabled: Boolean(vpsMon[v.id]), click: () => vpsMon[v.id]?.reconnect() },
            { type: 'separator' },
            { label: t('Remove…'), click: () => removeVps(v.id) },
          ],
        })),
      ],
    },
    { type: 'separator' },
    { label: t('Rename this box…'), click: () => openNameWindow(which) },
    { label: t('Show box names'), type: 'checkbox', checked: state.labels, click: (item) => setLabels(item.checked) },
    {
      label: t('Snap grid'),
      submenu: [[1, '1 icon'], [0.5, 'Half an icon'], [0, 'Corners and centre only']].map(([v, label]) => ({
        label: t(label), type: 'radio', checked: state.snapGrid === v, click: () => { state.snapGrid = v; saveState(); },
      })),
    },
    { type: 'separator' },
    {
      label: t('Language'),
      submenu: [['en', 'English'], ['pt', 'Português (Brasil)']].map(([v, label]) => ({
        label, type: 'radio', checked: state.lang === v, click: () => setLanguage(v),
      })),
    },
    { type: 'separator' },
    { label: t('Start with Windows'), type: 'checkbox', checked: startsAtLogin, click: (item) => app.setLoginItemSettings({ ...loginItemOptions(), openAtLogin: item.checked }) },
    { label: t('Open data folder'), click: () => shell.openPath(dataDir) },
    { type: 'separator' },
    { label: t('Quit'), click: () => app.quit() },
  ]).popup({ window: winOf(which) || winOf('ai') });
}

function createWindows() {
  createBox('ai');

  tip = new BrowserWindow({
    width: tipSize.width, height: tipSize.height,
    frame: false, transparent: true, resizable: false, focusable: false,
    skipTaskbar: true, alwaysOnTop: true, hasShadow: false, show: false,
    webPreferences: { ...webPreferences, backgroundThrottling: false },
  });
  tip.setIgnoreMouseEvents(true);
  load(tip, 'tip.html');

  if (state.sys.visible) createSysBox();
  for (const v of state.vps) if (v.visible !== false) showVps(v);
}

/** Which box sent this IPC message. */
const from = (e) => Object.keys(boxes).find((id) => winOf(id)?.webContents === e.sender) || 'ai';

ipcMain.on('drag-start', (e) => startDrag(from(e)));
ipcMain.on('drag-end', endDrag);
ipcMain.on('hover', (e, { id, rect }) => (id ? showTip(from(e), id, rect) : hideTip()));
ipcMain.on('tip-size', (_e, size) => {
  tipSize = { width: Math.ceil(size.width), height: Math.ceil(size.height) };
  positionTip();
});
ipcMain.on('open-report', (_e, id) => openReport(id));
ipcMain.on('context-menu', (e) => contextMenu(from(e)));
ipcMain.on('refresh', refresh);
ipcMain.on('connect', (_e, id) => connect(id));
ipcMain.handle('get-snapshot', () => snapshot);
ipcMain.handle('get-sys', (e) => {
  const v = vpsOf(from(e));
  return v ? vpsData[v.id] || null : sysData;
});
ipcMain.handle('tray-state', trayState);
ipcMain.on('tray-action', (_e, action) => trayAction(action));
ipcMain.on('tray-size', (_e, size) => { traySize = { width: Math.ceil(size.width), height: Math.ceil(size.height) }; });

app.on('second-instance', () => openReport(null));
app.on('window-all-closed', () => app.quit());
app.on('before-quit', () => {
  if (stopSysmon) stopSysmon();
  for (const id of Object.keys(vpsMon)) stopVps(id);
  if (tray) tray.destroy();
});

app.whenReady().then(() => {
  createWindows();
  createTray();
  startWorker();
  const replace = () => { if (!drag) placeAll(); };
  screen.on('display-metrics-changed', replace);
  screen.on('display-removed', replace);
  screen.on('display-added', replace);
  if (process.env.UT_DRAGTEST) require('./devdrag')({ screen, startDrag, endDrag, winOf, getState: () => state, app, openVpsWindow, openNameWindow, getWins: () => ({ vps: vpsWin, name: nameWin }), placeAll, showTip, openReport, getReport: () => report, getSnapshot: () => snapshot });
  if (SHOT_DIR) require('./devshots')({ SHOT_DIR, boxes: new Proxy({}, { get: (_t, id) => ({ win: winOf(id) }) }), getTip: () => tip, getReport: () => report, openReport, showTip, getSnapshot: () => snapshot, getSys: () => sysData, getTrayWin: () => trayWin, showTrayMenu, setTheme, getTheme: () => state.theme, app });
});
