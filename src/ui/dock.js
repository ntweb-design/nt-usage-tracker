const { icon, pick, left, leftColor, loadColor, sysItems, vpsItems, STATUS } = window.UT;
const dock = document.getElementById('dock');
const itemsEl = document.getElementById('items');
const labelEl = document.getElementById('label');
// The same page drives every box: AI plan limits (default), this PC (?kind=sys) and a VPS (?kind=vps).
const KIND = ['sys', 'vps'].includes(new URLSearchParams(location.search).get('kind')) ? new URLSearchParams(location.search).get('kind') : 'ai';

const R_OUT = 18.2;
const R_IN = 13.2;

/** A ring with `pct` of its circumference drawn; null leaves just the track. */
function ring(r, pct, color) {
  const c = 2 * Math.PI * r;
  const track = `<circle class="track" cx="20" cy="20" r="${r}"/>`;
  if (pct == null) return track;
  const p = Math.max(0, Math.min(100, pct));
  return `${track}<circle class="arc" cx="20" cy="20" r="${r}" stroke="${color}" stroke-dasharray="${c}" stroke-dashoffset="${c * (1 - p / 100)}"/>`;
}

function item(id, outer, inner, { dim = false, badge = null } = {}) {
  return `<div class="item${dim ? ' dim' : ''}" data-id="${id}">
    <svg class="rings" viewBox="0 0 40 40">${outer}${inner}</svg>
    ${icon(id, 15)}
    ${badge ? `<span class="badge" style="background:${badge}"></span>` : ''}
  </div>`;
}

// Arcs are updated in place when the set of items is unchanged, so they animate
// instead of being rebuilt on every sample.
let shape = '';
function render(items) {
  const next = items.map((i) => i.key).join('|');
  if (next === shape) {
    items.forEach((i) => {
      const el = itemsEl.querySelector(`[data-id="${i.id}"]`);
      el.querySelectorAll('.arc').forEach((arc, k) => {
        const a = i.arcs[k];
        if (!a) return;
        arc.setAttribute('stroke', a.color);
        arc.setAttribute('stroke-dashoffset', a.c * (1 - a.pct / 100));
      });
    });
    return;
  }
  shape = next;
  itemsEl.innerHTML = items.map((i) => i.html).join('');
}

function describe(id, outer, inner, colorOf, opts) {
  const arcs = [[R_OUT, outer], [R_IN, inner]].filter(([, v]) => v != null)
    .map(([r, v]) => ({ c: 2 * Math.PI * r, pct: Math.max(0, Math.min(100, v)), color: colorOf(v) }));
  return {
    id,
    arcs,
    key: `${id}:${outer != null}:${inner != null}:${opts?.dim}:${opts?.badge}`,
    html: item(id, ring(R_OUT, outer, outer != null && colorOf(outer)), ring(R_IN, inner, inner != null && colorOf(inner)), opts),
  };
}

if (KIND === 'ai') {
  // Outer ring = long window (weekly), inner ring = short window (5 hours); arcs show what is left.
  const show = (snap) => render(snap.providers.map((p) => {
    const status = p.limits?.status;
    const long = pick(p, 'long');
    const short = pick(p, 'short');
    const badge = status === 'auth' || status === 'error' ? STATUS.bad : status === 'stale' ? STATUS.warn : null;
    return describe(p.id, long && left(long), short && left(short), leftColor, { dim: !long && !short, badge });
  }));
  window.tracker.onSnapshot(show);
  window.tracker.getSnapshot().then((snap) => snap && show(snap));
} else if (KIND === 'sys') {
  // Arcs show load. CPU: total / busiest core. Memory: RAM / commit. GPU: load / VRAM.
  const show = (d) => render(sysItems(d).map((i) => describe(i.id, i.outer, i.inner, loadColor, { dim: i.outer == null })));
  itemsEl.innerHTML = ['cpu', 'mem', 'gpu'].map((id) => item(id, ring(R_OUT, null), ring(R_IN, null), { dim: true })).join('');
  window.tracker.onSys(show);
  window.tracker.getSys().then((d) => d && show(d));
} else {
  // A VPS over SSH. CPU: total / busiest core. Memory: RAM / swap. Disk: / used / I/O busy.
  // While connecting the last reading stays, dimmed; offline adds a red dot.
  const show = (d) => {
    const badge = d.status === 'offline' ? STATUS.bad : d.status === 'connecting' && d.cpu ? STATUS.warn : null;
    const dim = d.status !== 'online';
    render(vpsItems(d).map((i) => describe(i.id, i.outer, i.inner, loadColor, { dim: dim || i.outer == null, badge })));
  };
  itemsEl.innerHTML = ['cpu', 'mem', 'disk'].map((id) => item(id, ring(R_OUT, null), ring(R_IN, null), { dim: true })).join('');
  window.tracker.onSys(show);
  window.tracker.getSys().then((d) => d && show(d));
}

window.tracker.onLayout(({ vertical, label }) => {
  dock.classList.toggle('horizontal', !vertical);
  labelEl.hidden = !label;
  labelEl.textContent = label || '';
  labelEl.title = label || '';
});
window.tracker.onDragging((on) => dock.classList.toggle('dragging', on));

// ---- hover → tooltip
let hovered = null;
let press = null;
const itemAt = (e) => e.target.closest?.('.item');

function hover(el) {
  const id = el?.dataset.id || null;
  if (id === hovered) return;
  hovered = id;
  if (!el) return window.tracker.hover(null);
  const r = el.getBoundingClientRect();
  window.tracker.hover(id, { x: r.x, y: r.y, width: r.width, height: r.height });
}

dock.addEventListener('pointermove', (e) => { if (!press?.dragging) hover(itemAt(e)); });
dock.addEventListener('pointerleave', () => { if (!press) hover(null); });

// ---- press: a small movement starts a drag, otherwise it is a click
dock.addEventListener('pointerdown', (e) => {
  if (e.button !== 0) return;
  press = { x: e.screenX, y: e.screenY, id: itemAt(e)?.dataset.id || null, dragging: false };
  dock.setPointerCapture(e.pointerId);
});

dock.addEventListener('pointermove', (e) => {
  if (!press || press.dragging) return;
  if (Math.hypot(e.screenX - press.x, e.screenY - press.y) > 4) {
    press.dragging = true;
    hover(null);
    window.tracker.dragStart();
  }
});

function release(click) {
  if (!press) return;
  const p = press;
  press = null;
  if (p.dragging) window.tracker.dragEnd();
  else if (click && p.id && KIND === 'ai') window.tracker.openReport(p.id);
}

dock.addEventListener('pointerup', () => release(true));
dock.addEventListener('pointercancel', () => release(false));
dock.addEventListener('lostpointercapture', () => release(false));
window.addEventListener('blur', () => release(false));

window.addEventListener('contextmenu', (e) => { e.preventDefault(); hover(null); window.tracker.contextMenu(); });
