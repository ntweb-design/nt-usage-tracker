/**
 * Dev only (UT_SHOT=<dir>): captures each window to PNG so the UI can be
 * checked without a human at the screen, then quits.
 */
const fs = require('fs');
const path = require('path');

module.exports = ({ SHOT_DIR, boxes, getTip, getReport, openReport, showTip, getSnapshot, getSys, getTrayWin, showTrayMenu, setTheme, getTheme, app }) => {
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const list = (name, fallback) => (process.env[name] ?? fallback).split(',').filter(Boolean);
  const shot = async (win, name) => {
    const img = await win.webContents.capturePage();
    fs.writeFileSync(path.join(SHOT_DIR, name + '.png'), img.toPNG());
    console.log('shot', name, JSON.stringify(win.getBounds()));
  };
  const tipShot = async (which, id) => {
    showTip(which, id, { x: 6, y: 6, width: 46, height: 46 });
    await wait(700);
    console.log('tip visible before capture:', getTip().isVisible());
    await shot(getTip(), `tip-${id}`);
  };
  (async () => {
    fs.mkdirSync(SHOT_DIR, { recursive: true });
    for (let i = 0; i < 240 && !getSnapshot(); i++) await wait(500);
    await wait(900);
    await shot(boxes.ai.win, 'dock');
    if (process.env.UT_HOLD) {
      // Leave the real windows on screen so an OS-level capture can see the blur.
      const scale = (w) => { const b = w.getBounds(); const f = require('electron').screen.getDisplayMatching(b).scaleFactor; return { ...b, scaleFactor: f }; };
      fs.writeFileSync(path.join(SHOT_DIR, 'bounds.json'), JSON.stringify({ ai: scale(boxes.ai.win), sys: boxes.sys.win ? scale(boxes.sys.win) : null }));
      await wait(Number(process.env.UT_HOLD));
      return app.quit();
    }
    for (const id of list('UT_TIPS', 'claude')) await tipShot('ai', id);
    if (boxes.sys.win) {
      for (let i = 0; i < 40 && !getSys()?.gpu; i++) await wait(500);
      await wait(2500);
      await shot(boxes.sys.win, 'sys');
      for (const id of list('UT_SYSTIPS', 'cpu,mem,gpu')) await tipShot('sys', id);
    }
    for (const id of list('UT_REPORTS', 'all')) {
      openReport(id === 'all' ? null : id);
      if (!getReport().__logging) {
        getReport().__logging = true;
        getReport().webContents.on('console-message', (e) => console.log('report console:', e.level, e.message, e.lineNumber));
      }
      await wait(1500);
      await shot(getReport(), 'report-' + id);
    }
    if (process.env.UT_TRAY) {
      showTrayMenu();
      await wait(800);
      console.log('tray menu visible:', getTrayWin().isVisible());
      await shot(getTrayWin(), 'tray');
      // Same windows in the other theme, then back to the user's choice.
      const original = getTheme();
      setTheme(original === 'light' ? 'dark' : 'light');
      await wait(800);
      await shot(getTrayWin(), 'tray-alt');
      await shot(boxes.ai.win, 'dock-alt');
      if (boxes.sys.win) await shot(boxes.sys.win, 'sys-alt');
      await tipShot('ai', 'claude');
      if (getReport()) await shot(getReport(), 'report-alt');
      setTheme(original);
      await wait(300);
    }
    if (process.env.UT_JS) {
      await getReport().webContents.executeJavaScript(process.env.UT_JS);
      await wait(600);
      await shot(getReport(), 'report-js');
    }
    app.quit();
  })().catch((err) => { console.error(err); app.quit(); });
};
