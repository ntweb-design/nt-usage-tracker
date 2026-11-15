/**
 * VPS resource monitor over SSH. Uses Windows' own OpenSSH client, so the
 * user's ~/.ssh/config, keys, agent and Tailscale host names all work, and
 * nothing is installed on the server: one long-lived session runs a small
 * POSIX shell loop that prints raw /proc readings every INTERVAL, and the
 * numbers are worked out here. Any non-root user can read these files.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, execFile } = require('child_process');
const readline = require('readline');
const { t } = require('./i18n');

const INTERVAL = 2; // seconds between samples on the server
const STALL = 20000; // no sample for this long = connection is dead

const OPENSSH = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'OpenSSH');
const exe = (name) => {
  const p = path.join(OPENSSH, `${name}.exe`);
  return fs.existsSync(p) ? p : name;
};

let knownHosts = null; // the app's own known_hosts, set by configure()
function configure({ dataDir }) {
  knownHosts = path.join(dataDir, 'ssh', 'known_hosts').replace(/\\/g, '/');
  fs.mkdirSync(path.dirname(knownHosts), { recursive: true });
}

/** ssh arguments for one VPS; `remote` is the command to run there. */
function sshArgs(v, remote) {
  const a = [
    '-T',
    '-o', 'BatchMode=yes', // never wait on a password or passphrase prompt
    '-o', 'ConnectTimeout=10',
    '-o', 'ServerAliveInterval=10',
    '-o', 'ServerAliveCountMax=2',
    // First contact trusts and remembers the server's key (in the app's own file); a changed key is refused.
    '-o', 'StrictHostKeyChecking=accept-new',
  ];
  if (knownHosts) a.push('-o', `UserKnownHostsFile="${knownHosts}" ~/.ssh/known_hosts`);
  if (v.keyFile) a.push('-i', v.keyFile, '-o', 'IdentitiesOnly=yes');
  if (v.port) a.push('-p', String(v.port));
  a.push(v.user ? `${v.user}@${v.host}` : v.host, remote);
  return a;
}

/** Turns ssh's stderr into a short reason in Portuguese. */
function reason(stderr, code) {
  const s = String(stderr || '').trim();
  const lines = s.split(/\r?\n/).filter((l) => l && !/^Warning: Permanently added/i.test(l));
  const last = lines[lines.length - 1] || '';
  if (/Permission denied/i.test(s)) return t('Access denied: the VPS did not accept the key (check authorized_keys and the user).');
  if (/Could not resolve hostname/i.test(s)) return t('Host not found (wrong name or IP, or Tailscale is off).');
  if (/timed out/i.test(s)) return t('No answer from the VPS (timed out).');
  if (/Connection refused/i.test(s)) return t('Connection refused (is SSH running on that port?).');
  if (/REMOTE HOST IDENTIFICATION HAS CHANGED|Host key verification failed/i.test(s)) return t('The server key changed since the last connection; blocked for safety.');
  if (/UNPROTECTED PRIVATE KEY|bad permissions/i.test(s)) return t('Windows left the key file readable by other users, so SSH refuses to use it.');
  if (/passphrase|incorrect passphrase/i.test(s)) return t('The key has a passphrase; use a key without one or load it into ssh-agent.');
  if (/Identity file .* not accessible|No such file/i.test(s)) return t('Key file not found.');
  return last || (code != null ? t('SSH exited with code {code}.', { code }) : t('Connection failed.'));
}

// One sample per block between @S and @E. Kept to POSIX sh + awk so it runs on any Linux.
const SCRIPT = `
export LC_ALL=C
h=$(uname -n); c=$(grep -c '^processor' /proc/cpuinfo); o=$( (. /etc/os-release 2>/dev/null; echo "$PRETTY_NAME") )
echo "@I	$h	$c	$o"
while :; do
  echo "@S $(date +%s)"
  grep '^cpu' /proc/stat
  grep -E '^(MemTotal|MemAvailable|SwapTotal|SwapFree):' /proc/meminfo
  echo "@L $(cat /proc/loadavg)"
  echo "@U $(cut -d' ' -f1 /proc/uptime)"
  df -P -k / | tail -n 1 | sed 's/^/@D /'
  awk 'NR>2{gsub(":"," ");print "@N",$1,$2,$10}' /proc/net/dev
  awk '{print "@K",$3,$13}' /proc/diskstats
  echo "@E"
  sleep ${INTERVAL}
done
`;

const SKIP_NET = /^(lo|veth|docker|br-|virbr|cni|flannel|kube)/;
const SKIP_DISK = /^(loop|ram|sr|zram|fd)/;

/** Reads raw blocks into usable numbers, keeping the previous counters for rates. */
function parser() {
  let info = {};
  let prev = null;
  return {
    info: (line) => {
      const [, host, cores, osName] = line.split('\t');
      info = { host, cores: Number(cores) || null, os: (osName || '').trim() || null };
    },
    sample(lines) {
      const cur = { at: Date.now(), cpu: {}, net: { rx: 0, tx: 0 }, disks: {} };
      const mem = {};
      for (const l of lines) {
        const f = l.trim().split(/\s+/);
        if (/^cpu\d*$/.test(f[0])) {
          const v = f.slice(1, 9).map(Number); // user nice system idle iowait irq softirq steal
          const total = v.reduce((a, b) => a + (b || 0), 0);
          cur.cpu[f[0]] = { total, idle: (v[3] || 0) + (v[4] || 0) };
        } else if (f[0].endsWith(':')) mem[f[0].slice(0, -1)] = Number(f[1]) * 1024;
        else if (f[0] === '@L') cur.load = f.slice(1, 4).map(Number);
        else if (f[0] === '@U') cur.uptime = Number(f[1]);
        else if (f[0] === '@D') cur.df = { fs: f[1], total: Number(f[2]) * 1024, used: Number(f[3]) * 1024, avail: Number(f[4]) * 1024, mount: f[6] || '/' };
        else if (f[0] === '@N' && !SKIP_NET.test(f[1])) { cur.net.rx += Number(f[2]) || 0; cur.net.tx += Number(f[3]) || 0; }
        else if (f[0] === '@K' && !SKIP_DISK.test(f[1])) cur.disks[f[1]] = Number(f[2]) || 0;
      }

      const out = { ...info, at: cur.at, load: cur.load || null, uptime: cur.uptime || null };
      if (prev) {
        const busy = (a, b) => (b && a && a.total > b.total ? ((a.total - b.total - (a.idle - b.idle)) / (a.total - b.total)) * 100 : null);
        let maxCore = 0;
        for (const k of Object.keys(cur.cpu)) if (k !== 'cpu') maxCore = Math.max(maxCore, busy(cur.cpu[k], prev.cpu[k]) || 0);
        const secs = (cur.at - prev.at) / 1000;
        let io = 0;
        for (const [d, t] of Object.entries(cur.disks)) if (prev.disks[d] != null) io = Math.max(io, ((t - prev.disks[d]) / (secs * 1000)) * 100);
        out.cpu = { pct: busy(cur.cpu.cpu, prev.cpu.cpu) ?? 0, maxCore, cores: info.cores || Object.keys(cur.cpu).length - 1 };
        out.net = { rx: Math.max(0, (cur.net.rx - prev.net.rx) / secs), tx: Math.max(0, (cur.net.tx - prev.net.tx) / secs) };
        out.ioPct = Math.min(100, io);
      }
      if (mem.MemTotal) {
        const used = mem.MemTotal - (mem.MemAvailable ?? 0);
        const swapUsed = (mem.SwapTotal || 0) - (mem.SwapFree || 0);
        out.mem = {
          total: mem.MemTotal, used, pct: (used / mem.MemTotal) * 100,
          swapTotal: mem.SwapTotal || 0, swapUsed, swapPct: mem.SwapTotal ? (swapUsed / mem.SwapTotal) * 100 : null,
        };
      }
      if (cur.df) out.disk = { ...cur.df, pct: cur.df.used + cur.df.avail ? (cur.df.used / (cur.df.used + cur.df.avail)) * 100 : 0 };
      prev = cur;
      return out;
    },
  };
}

/**
 * Keeps one VPS connected and calls onData with { status, message, ...reading }.
 * status: connecting | online | offline. Returns stop().
 */
function start(v, onData) {
  let child = null;
  let stopped = false;
  let retry = 5000;
  let watchdog = null;
  let lastGood = null;

  const emit = (status, message = null) => onData({ status, message, ...(lastGood || {}), status_at: Date.now() });

  function connect() {
    if (stopped) return;
    emit('connecting');
    const p = parser();
    let block = null;
    let stderr = '';
    child = spawn(exe('ssh'), sshArgs(v, 'sh -s'), { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    child.stdin.on('error', () => {});
    child.stdin.end(SCRIPT);
    child.stderr.on('data', (d) => { stderr = (stderr + d).slice(-4000); });
    const kick = () => {
      clearTimeout(watchdog);
      watchdog = setTimeout(() => { stderr = 'timed out'; child?.kill(); }, STALL);
    };
    kick();
    readline.createInterface({ input: child.stdout }).on('line', (line) => {
      if (line.startsWith('@I\t')) return p.info(line);
      if (line.startsWith('@S')) { block = []; return; }
      if (line === '@E') {
        if (!block) return;
        const r = p.sample(block);
        block = null;
        kick();
        retry = 5000;
        if (r.cpu) { lastGood = r; emit('online'); }
        return;
      }
      if (block) block.push(line);
    });
    child.on('error', (err) => { stderr = err.message; });
    child.on('close', (code) => {
      clearTimeout(watchdog);
      child = null;
      if (stopped) return;
      emit('offline', reason(stderr, code));
      setTimeout(connect, retry);
      retry = Math.min(retry * 2, 60000);
    });
  }
  connect();

  return {
    stop() {
      stopped = true;
      clearTimeout(watchdog);
      if (child) child.kill();
    },
    reconnect() {
      retry = 5000;
      if (child) child.kill(); // close handler reconnects
    },
  };
}

/** One quick connection to check the settings before saving them. */
function test(v) {
  return new Promise((resolve) => {
    execFile(exe('ssh'), sshArgs(v, 'uname -n; grep -c ^processor /proc/cpuinfo; df -P -k / | tail -n 1'), { timeout: 25000, windowsHide: true }, (err, stdout, stderr) => {
      if (err) return resolve({ ok: false, message: reason(stderr || err.message, err.code) });
      const [host, cores] = stdout.trim().split(/\r?\n/);
      resolve({ ok: true, message: t('Connected to {host} ({cores} cores).', { host, cores }) });
    });
  });
}

/**
 * Leaves a private key readable only by this user (and SYSTEM). Files under
 * AppData inherit extra entries that make OpenSSH reject the key as unprotected.
 */
function lockDown(file) {
  if (process.platform !== 'win32') { fs.chmodSync(file, 0o600); return Promise.resolve(); }
  const user = process.env.USERDOMAIN ? `${process.env.USERDOMAIN}\\${os.userInfo().username}` : os.userInfo().username;
  return new Promise((resolve, reject) => {
    execFile('icacls', [file, '/inheritance:r', '/grant:r', `${user}:F`, '/grant:r', 'SYSTEM:F'], { timeout: 10000, windowsHide: true }, (err, _o, stderr) => {
      if (err) reject(new Error(t('could not protect the key file: {error}', { error: String(stderr || err.message).trim() })));
      else resolve();
    });
  });
}

/** Creates a new ed25519 key pair with no passphrase; returns the public key line. */
function generateKey(file, comment) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  for (const f of [file, `${file}.pub`]) { try { fs.unlinkSync(f); } catch { /* none */ } }
  return new Promise((resolve, reject) => {
    execFile(exe('ssh-keygen'), ['-q', '-t', 'ed25519', '-N', '', '-C', comment, '-f', file], { timeout: 20000, windowsHide: true }, (err, _o, stderr) => {
      if (err) return reject(new Error(String(stderr || err.message).trim()));
      lockDown(file).then(() => resolve(fs.readFileSync(`${file}.pub`, 'utf8').trim()), reject);
    });
  });
}

/** Public key for a private key file: its .pub, or derived with ssh-keygen -y. */
function publicKey(file) {
  try { return Promise.resolve(fs.readFileSync(`${file}.pub`, 'utf8').trim()); } catch { /* derive */ }
  return new Promise((resolve) => {
    execFile(exe('ssh-keygen'), ['-y', '-f', file], { timeout: 10000, windowsHide: true }, (err, stdout) => resolve(err ? null : stdout.trim()));
  });
}

/** Host aliases from ~/.ssh/config, for the host field's suggestions. */
function configHosts() {
  try {
    const text = fs.readFileSync(path.join(os.homedir(), '.ssh', 'config'), 'utf8');
    const out = [];
    for (const m of text.matchAll(/^\s*Host\s+(.+)$/gim)) {
      for (const h of m[1].trim().split(/\s+/)) if (!/[*?!]/.test(h)) out.push(h);
    }
    return [...new Set(out)];
  } catch { return []; }
}

module.exports = { configure, start, test, generateKey, publicKey, configHosts, lockDown };
