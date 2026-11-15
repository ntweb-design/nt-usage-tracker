/**
 * Dev only (UT_DRAGTEST=1): drives the drag code with a fake cursor, so
 * attaching, detaching, free placement and edge/corner snapping can be
 * checked without touching the real mouse. UT_WINSHOT=<dir> captures the
 * VPS and name windows instead.
 */
module.exports = ({ screen, startDrag, endDrag, winOf, getState, app, openVpsWindow, openNameWindow, getWins, placeAll, showTip, openReport, getReport, getSnapshot }) => {
  if (process.env.UT_HERO) return hero({ screen, winOf, getState, app, placeAll, showTip, openReport, getReport, getSnapshot });
  let cursor = { x: 0, y: 0 };
  screen.getCursorScreenPoint = () => cursor;
  const fs = require('fs');
  const path = require('path');
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const centre = (b) => ({ x: Math.round(b.x + b.width / 2), y: Math.round(b.y + b.height / 2) });
  const bounds = (id) => winOf(id).getBounds();
  let fails = 0;
  const check = (label, ok, extra = '') => { if (!ok) fails++; console.log('DRAGTEST', ok ? 'ok  ' : 'FAIL', label, extra); };
  const place = (id) => getState().place[id];

  /** Grabs `id` at its centre and lets go with its centre at `to`. */
  async function drag(id, to) {
    cursor = centre(bounds(id));
    startDrag(id);
    const from = { ...cursor };
    for (let k = 1; k <= 24; k++) { cursor = { x: from.x + ((to.x - from.x) * k) / 24, y: from.y + ((to.y - from.y) * k) / 24 }; await wait(16); }
    await wait(60);
    endDrag();
    await wait(400);
  }

  (async () => {
    for (let i = 0; i < 100 && !(winOf('ai') && winOf('sys') && winOf('vps:vtest')); i++) await wait(200);
    await wait(1500);

    if (process.env.UT_WINSHOT) {
      const cap = async (win, name) => { await wait(1500); fs.writeFileSync(path.join(process.env.UT_WINSHOT, name + '.png'), (await win.webContents.capturePage()).toPNG()); };
      openVpsWindow(null); await cap(getWins().vps, 'vps-new');
      openNameWindow('vps:vtest'); await cap(getWins().name, 'name');
      return app.quit();
    }

    const wa = screen.getPrimaryDisplay().workArea;
    console.log('DRAGTEST start', JSON.stringify(getState().place));

    // 1) Free placement in the middle of the screen.
    const mid = { x: wa.x + wa.width / 2, y: wa.y + wa.height / 2 };
    await drag('ai', mid);
    let c = centre(bounds('ai'));
    check('AI group dropped mid-screen stays free', !place('ai').edge && !place('ai').parent && Math.abs(c.x - mid.x) < 3 && Math.abs(c.y - mid.y) < 3, JSON.stringify(place('ai')));

    // 2) Pull the VPS out and drop it in empty space.
    await drag('vps:vtest', { x: wa.x + 300, y: wa.y + 300 });
    check('VPS pulled out is free', !place('vps:vtest').parent && !place('vps:vtest').edge, JSON.stringify(place('vps:vtest')));

    // 3) VPS on the LEFT side of the AI box, near its bottom → left / end.
    let a = bounds('ai');
    let v = bounds('vps:vtest');
    await drag('vps:vtest', { x: a.x - 6 - v.width / 2 - 8, y: a.y + a.height - v.height / 2 - 10 });
    check('VPS attaches to the left of AI, bottom corner', place('vps:vtest').parent === 'ai' && place('vps:vtest').side === 'left' && place('vps:vtest').align === 'end', JSON.stringify(place('vps:vtest')));
    a = bounds('ai'); v = bounds('vps:vtest');
    check('…and lines up with the AI box bottom', Math.abs(v.y + v.height - (a.y + a.height)) <= 1 && v.x + v.width <= a.x, `ai=${JSON.stringify(a)} vps=${JSON.stringify(v)}`);

    // 4) PC box on the RIGHT side of the AI box, near its top → right / start.
    await drag('sys', { x: wa.x + 300, y: wa.y + 300 });
    a = bounds('ai'); let s = bounds('sys');
    await drag('sys', { x: a.x + a.width + 6 + s.width / 2 + 8, y: a.y + s.height / 2 + 10 });
    check('PC attaches to the right of AI, top corner', place('sys').parent === 'ai' && place('sys').side === 'right' && place('sys').align === 'start', JSON.stringify(place('sys')));

    // 5) Dragging the AI box moves all three together.
    const before = { a: bounds('ai'), v: bounds('vps:vtest'), s: bounds('sys') };
    await drag('ai', { x: centre(before.a).x - 150, y: centre(before.a).y + 40 });
    const after = { a: bounds('ai'), v: bounds('vps:vtest'), s: bounds('sys') };
    const same = (k) => after[k].x - after.a.x === before[k].x - before.a.x && after[k].y - after.a.y === before[k].y - before.a.y;
    check('group moves as one', same('v') && same('s'));

    // 6) Near the top-left corner: docks to an edge, pulled into the corner.
    const lay = { w: after.v.x < after.a.x ? after.a.x + after.a.width - after.v.x : after.a.width };
    await drag('ai', { x: wa.x + (after.a.x - Math.min(after.a.x, after.v.x)) + after.a.width / 2 + 15, y: wa.y + after.a.height / 2 + 30 });
    const p = place('ai');
    const g = ['ai', 'sys', 'vps:vtest'].map(bounds);
    const minX = Math.min(...g.map((r) => r.x));
    const minY = Math.min(...g.map((r) => r.y));
    check('near the top-left corner it docks into the corner', p.edge && p.t === 0 && minX - wa.x <= 9 && minY - wa.y <= 9, JSON.stringify(p) + ` group at ${minX - wa.x},${minY - wa.y} (w ${lay.w})`);

    // 7) Pull the PC box off and drop it under the VPS box, near its right corner.
    v = bounds('vps:vtest'); s = bounds('sys');
    await drag('sys', { x: wa.x + 700, y: wa.y + 500 });
    s = bounds('sys'); v = bounds('vps:vtest');
    await drag('sys', { x: v.x + v.width - s.width / 2, y: v.y + v.height + 6 + s.height / 2 + 6 });
    check('PC attaches under the VPS box', place('sys').parent === 'vps:vtest' && place('sys').side === 'bottom', JSON.stringify(place('sys')));

    // ---- grid, centre and glide
    await drag('sys', { x: wa.x + 700, y: wa.y + 650 });
    await drag('vps:vtest', { x: wa.x + 300, y: wa.y + 650 });
    await drag('ai', mid);
    a = bounds('ai'); v = bounds('vps:vtest');
    const leftOf = (top) => ({ x: a.x - 6 - v.width / 2 - 8, y: top + v.height / 2 });

    // 8) One icon down from the top corner → start + 46 px.
    await drag('vps:vtest', leftOf(a.y + 46 + 5));
    v = bounds('vps:vtest');
    check('grid: one icon below the top corner', place('vps:vtest').parent === 'ai' && v.y - a.y === 46, JSON.stringify(place('vps:vtest')) + ` dy=${v.y - a.y}`);

    // 9) Hanging two icons above the AI box (podium/triangle shapes).
    await drag('vps:vtest', { x: wa.x + 300, y: wa.y + 650 });
    a = bounds('ai'); v = bounds('vps:vtest');
    await drag('vps:vtest', leftOf(a.y - 92 + 4));
    v = bounds('vps:vtest');
    check('grid: two icons hanging past the top', place('vps:vtest').offset === -92 && v.y === a.y - 92, JSON.stringify(place('vps:vtest')) + ` dy=${v.y - a.y}`);

    // 10) Centre of the side.
    await drag('vps:vtest', { x: wa.x + 300, y: wa.y + 650 });
    a = bounds('ai'); v = bounds('vps:vtest');
    await drag('vps:vtest', leftOf(a.y + (a.height - v.height) / 2 + 7));
    v = bounds('vps:vtest');
    check('centre of the side', place('vps:vtest').align === 'center' && Math.abs(v.y + v.height / 2 - (a.y + a.height / 2)) <= 1, JSON.stringify(place('vps:vtest')));

    // 11) Glide: right after a snap takes over, the box is still on its way; a moment later it is there.
    await drag('vps:vtest', { x: wa.x + 300, y: wa.y + 650 });
    a = bounds('ai'); v = bounds('vps:vtest');
    cursor = centre(v);
    startDrag('vps:vtest');
    const target = leftOf(a.y + 8); // pulls to the top corner (8 px away)
    const steps = 6;
    const from = { ...cursor };
    for (let k = 1; k <= steps; k++) { cursor = { x: from.x + ((target.x - from.x) * k) / steps, y: from.y + ((target.y - from.y) * k) / steps }; await wait(16); }
    await wait(10);
    const midGlide = bounds('vps:vtest');
    await wait(300);
    const settled = bounds('vps:vtest');
    endDrag();
    await wait(400);
    check('glide into a snap is gradual', midGlide.y !== settled.y && settled.y === a.y, `during=${midGlide.y} settled=${settled.y} aiTop=${a.y}`);

    // 12) Free drop near the screen centre lines up on it exactly.
    await drag('vps:vtest', { x: wa.x + 300, y: wa.y + 650 });
    await drag('ai', { x: wa.x + 200, y: wa.y + 300 });
    await drag('sys', { x: wa.x + wa.width / 2 + 9, y: wa.y + wa.height / 2 - 11 });
    s = bounds('sys');
    check('free drop snaps to the screen centre', Math.abs(s.x + s.width / 2 - (wa.x + wa.width / 2)) <= 1 && Math.abs(s.y + s.height / 2 - (wa.y + wa.height / 2)) <= 1, JSON.stringify(place('sys')));

    // 13) Near the middle of an edge → centred on it.
    s = bounds('sys');
    await drag('sys', { x: wa.x + wa.width - s.width / 2 - 20, y: wa.y + wa.height / 2 + 10 });
    check('edge centre', place('sys').edge === 'right' && place('sys').t === 0.5, JSON.stringify(place('sys')));

    console.log('DRAGTEST end', JSON.stringify(getState().place));
    console.log('DRAGTEST', fails ? `${fails} FAILED` : 'ALL PASSED');
    app.quit();
  })();
};

/**
 * UT_HERO=<dir>: the README screenshots. Lays the boxes out in a row over a
 * plain backdrop window (so nothing from the desktop shows through the
 * acrylic), opens one tooltip, captures that screen area, then the report.
 */
function hero({ screen, winOf, getState, app, placeAll, showTip, openReport, getReport, getSnapshot }) {
  const fs = require('fs');
  const path = require('path');
  const { BrowserWindow } = require('electron');
  const { execFileSync } = require('child_process');
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const dir = process.env.UT_HERO;
  const wa = screen.getPrimaryDisplay().workArea;
  const W = 820, H = 300;
  const x = wa.x + Math.round((wa.width - W) / 2), y = wa.y + Math.round((wa.height - H) / 2);
  (async () => {
    for (let i = 0; i < 100 && !(winOf('ai') && winOf('sys') && winOf('vps:vtest')); i++) await wait(200);
    for (let i = 0; i < 240 && !getSnapshot(); i++) await wait(500);
    const PADB = 24; // backdrop larger than the captured area, so its rounded corners stay out of the picture
    const back = new BrowserWindow({ x: x - PADB, y: y - PADB, width: W + PADB * 2, height: H + PADB * 2, roundedCorners: false, frame: false, show: false, skipTaskbar: true, focusable: false, resizable: false, backgroundColor: '#20232b' });
    back.setAlwaysOnTop(true, 'floating');
    await back.loadURL('data:text/html,' + encodeURIComponent('<body style="margin:0;height:100vh;background:linear-gradient(135deg,#2b3a55 0%,#1f2430 45%,#3a2b45 100%)"></body>'));
    back.showInactive();
    getState().place = {
      ai: { x: x + Math.round((W - 554) / 2), y: y + 36, displayId: null, vertical: false },
      sys: { parent: 'ai', side: 'right', align: 'start', offset: 0 },
      'vps:vtest': { parent: 'sys', side: 'right', align: 'start', offset: 0 },
    };
    placeAll();
    await wait(9000); // let the PC and VPS rings fill in
    showTip('ai', 'claude', { x: 6, y: 6 + 13, width: 46, height: 46 });
    await wait(1200);
    execFileSync('powershell.exe', ['-NoProfile', '-Command',
      `Add-Type -AssemblyName System.Drawing; $b=New-Object System.Drawing.Bitmap ${W},${H}; $g=[System.Drawing.Graphics]::FromImage($b); $g.CopyFromScreen(${x},${y},0,0,$b.Size); $b.Save('${path.join(dir, 'screenshot-widget.png')}')`]);
    back.destroy();
    openReport(null);
    await wait(2500);
    fs.writeFileSync(path.join(dir, 'screenshot-report.png'), (await getReport().webContents.capturePage()).toPNG());
    console.log('HERO saved');
    app.quit();
  })();
}
