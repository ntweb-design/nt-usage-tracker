/**
 * PC resource monitor: CPU and RAM from Node, GPU/VRAM/commit from a small
 * long-lived PowerShell helper (sysmon.ps1) that streams JSON lines.
 */
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const readline = require('readline');

const INTERVAL = 2000;

function start(onData) {
  let prev = os.cpus();
  let extra = null; // last line from the helper
  let child = null;
  let stopped = false;

  function spawnHelper() {
    if (stopped) return;
    child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', path.join(__dirname, 'sysmon.ps1').replace('app.asar', 'app.asar.unpacked'), '-IntervalMs', String(INTERVAL)], {
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    readline.createInterface({ input: child.stdout }).on('line', (line) => {
      try { extra = { at: Date.now(), ...JSON.parse(line) }; } catch { /* partial line */ }
    });
    child.on('error', () => {});
    child.on('exit', () => { child = null; if (!stopped) setTimeout(spawnHelper, 15000); });
  }
  spawnHelper();

  const timer = setInterval(() => {
    const now = os.cpus();
    let busy = 0, total = 0, maxCore = 0;
    now.forEach((c, i) => {
      const a = prev[i]?.times || c.times;
      const idle = c.times.idle - a.idle;
      const sum = Object.keys(c.times).reduce((s, k) => s + c.times[k] - a[k], 0);
      if (sum > 0) {
        busy += sum - idle;
        total += sum;
        maxCore = Math.max(maxCore, ((sum - idle) / sum) * 100);
      }
    });
    prev = now;

    const memTotal = os.totalmem();
    const memUsed = memTotal - os.freemem();
    const fresh = extra && Date.now() - extra.at < INTERVAL * 4 ? extra : null;

    let gpu = null;
    if (fresh?.gpus?.length) {
      // The adapter holding the most dedicated memory is the one doing the work.
      const main = fresh.gpus.reduce((a, b) => (b.mem > a.mem ? b : a));
      gpu = {
        name: fresh.name || 'GPU',
        pct: Math.min(100, main.util),
        memUsed: main.mem,
        memTotal: fresh.vram || 0,
        memPct: fresh.vram ? Math.min(100, (main.mem / fresh.vram) * 100) : null,
      };
    }

    onData({
      at: Date.now(),
      cpu: { name: now[0]?.model.replace(/\s+/g, ' ').trim() || 'CPU', cores: now.length, pct: total ? (busy / total) * 100 : 0, maxCore },
      mem: { used: memUsed, total: memTotal, pct: (memUsed / memTotal) * 100, commitPct: fresh?.commit ?? null },
      gpu,
      gpuPending: !fresh,
    });
  }, INTERVAL);

  return () => {
    stopped = true;
    clearInterval(timer);
    if (child) child.kill();
  };
}

module.exports = { start };
