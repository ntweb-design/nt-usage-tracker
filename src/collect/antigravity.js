const { t } = require('../i18n');
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const { HOME, readJson, writeJson } = require('./util');

/**
 * Antigravity (Google's Gemini CLI, `agy`) plan quota, from the same Code Assist
 * service the CLI calls. The CLI signs in with Google OAuth and keeps the token
 * either in the Windows Credential Manager (`gemini:antigravity`, plain `agy`)
 * or in a token file (`agy acp`, used by OpenBot and the IDE). The access token
 * lives one hour and only the CLI renews it, so the quota is read while a token
 * is valid and the last reading is kept on disk. The quota only moves when the
 * CLI runs, which is also when the token is renewed.
 */
const GEMINI = process.env.GEMINI_HOME?.trim() || path.join(HOME, '.gemini');
const ROOT = path.join(GEMINI, 'antigravity-cli');
const TOKEN_FILES = [
  path.join(GEMINI, 'antigravity-acp', 'antigravity-oauth-token'),
  path.join(GEMINI, 'antigravity-cli', 'antigravity-oauth-token'),
  path.join(GEMINI, 'jetski-standalone-oauth-token'),
];
const VAULT_TARGET = 'gemini:antigravity';
// The collector already runs from app.asar.unpacked in the installed app; only rewrite a plain app.asar path.
const VAULT_SCRIPT = path.join(__dirname, 'vault.ps1').replace(/app\.asar(?!\.unpacked)/, 'app.asar.unpacked');
const CODE_ASSIST = 'https://cloudcode-pa.googleapis.com/v1internal';
const FETCH_EVERY = 3 * 60 * 1000;
const LOCAL = process.env.LOCALAPPDATA || path.join(HOME, 'AppData', 'Local');
const BIN_DIR = path.join(LOCAL, 'agy', 'bin');

const detect = () => fs.existsSync(ROOT) || TOKEN_FILES.some((f) => fs.existsSync(f));

let store = null;      // FileCache dir, for the last reading
let vaultToken = null; // last token read from the vault, kept until it expires
let last = null;       // { ts, plan, windows }
let fetchedAt = 0;
let triedAt = 0;       // last token lookup, so a missing sign-in is not polled every refresh

const lastFile = () => store && path.join(store, 'last-quota.json');

/** `{ access_token, expiry }` with expiry in ms, or null. */
function parseToken(text) {
  try {
    const t = JSON.parse(text)?.token;
    const expiry = Date.parse(t?.expiry || '');
    return t?.access_token && Number.isFinite(expiry) ? { access: t.access_token, expiry } : null;
  } catch { return null; }
}

const fresh = (t) => t && t.expiry > Date.now() + 60000;

function readVault() {
  if (process.platform !== 'win32' || !fs.existsSync(VAULT_SCRIPT)) return Promise.resolve(null);
  return new Promise((resolve) => {
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', VAULT_SCRIPT, '-Target', VAULT_TARGET],
      { timeout: 15000, windowsHide: true },
      (err, stdout) => resolve(err || !stdout.trim() ? null : parseToken(Buffer.from(stdout.trim(), 'base64').toString('utf8'))));
  });
}

/** The valid token that expires last, from the token files or the vault. */
async function currentToken() {
  const files = TOKEN_FILES.map((f) => { try { return parseToken(fs.readFileSync(f, 'utf8')); } catch { return null; } });
  if (!fresh(vaultToken)) vaultToken = await readVault();
  const all = [...files, vaultToken].filter(fresh).sort((a, b) => b.expiry - a.expiry);
  return all[0] || null;
}

async function call(token, method, body) {
  const res = await fetch(`${CODE_ASSIST}:${method}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', 'User-Agent': 'antigravity/1.5 windows/amd64' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(10000),
  });
  if (res.status === 401 || res.status === 403) throw Object.assign(new Error(`HTTP ${res.status}`), { auth: true });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

const pct = (b) => Math.max(0, Math.min(100, 100 - b.remainingFraction * 100));

/** One group of the quota summary, e.g. "Gemini Models" or "Claude and GPT models". */
function groupWindows(g) {
  let short = null;
  let long = null;
  for (const b of g.buckets || []) {
    if (typeof b.remainingFraction !== 'number') continue;
    const label = `${b.window || ''} ${b.displayName || ''}`;
    const resetsAt = Date.parse(b.resetTime || '');
    const w = { usedPct: pct(b), resetsAt: Number.isFinite(resetsAt) ? resetsAt : null };
    if (/\b5\s*-?\s*h|five.?hour/i.test(label)) { if (!short || w.usedPct > short.usedPct) short = w; }
    else if (!long || w.usedPct > long.usedPct) long = { ...w, weekly: /week/i.test(label) };
  }
  return { name: (g.displayName || '').trim(), short, long };
}

/**
 * The rings show the Gemini group, or the group with the least room left when
 * the plan has none; every other group's windows are listed as extras.
 */
function toWindows(summary) {
  const groups = (summary.groups || []).map(groupWindows).filter((g) => g.name && (g.short || g.long));
  if (!groups.length) return [];
  const used = (g) => Math.max(g.short?.usedPct || 0, g.long?.usedPct || 0);
  const main = groups.find((g) => /^gemini models$/i.test(g.name)) || groups.find((g) => /^gemini\b/i.test(g.name))
    || groups.reduce((a, b) => (used(a) >= used(b) ? a : b));
  const out = [];
  const tag = (g) => (groups.length > 1 ? ` · ${g.name}` : '');
  for (const g of [main, ...groups.filter((x) => x !== main)]) {
    const isMain = g === main;
    if (g.short) out.push({ id: `${g.name}:5h`, label: `${t('5 hours')}${isMain ? '' : tag(g)}`, role: isMain ? 'short' : 'extra', usedPct: g.short.usedPct, resetsAt: g.short.resetsAt });
    if (g.long) out.push({ id: `${g.name}:long`, label: `${g.long.weekly ? t('Weekly') : t('Period')}${isMain ? '' : tag(g)}`, role: isMain ? 'long' : 'extra', usedPct: g.long.usedPct, resetsAt: g.long.resetsAt });
  }
  return out;
}

async function fetchQuota(token) {
  const load = await call(token, 'loadCodeAssist', {});
  const project = load.cloudaicompanionProject;
  const summary = project ? await call(token, 'retrieveUserQuotaSummary', { project }) : {};
  const plan = load.paidTier?.name || load.currentTier?.name || null;
  return { ts: Date.now(), plan, windows: toWindows(summary) };
}

/** A saved reading, with windows that already reset shown as empty again. */
function aged(r) {
  const now = Date.now();
  return r.windows.map((w) => (w.resetsAt && w.resetsAt <= now ? { ...w, usedPct: 0, resetsAt: null } : w));
}

function usage({ cache }) {
  store = cache?.dir || store;
  if (!last && lastFile()) last = readJson(lastFile());
  return { records: [], sessions: 0 };
}

async function limits() {
  if (Date.now() - fetchedAt > FETCH_EVERY && Date.now() - triedAt > 60000) {
    triedAt = Date.now();
    const token = await currentToken();
    if (token) {
      try {
        last = await fetchQuota(token.access);
        fetchedAt = Date.now();
        if (lastFile()) writeJson(lastFile(), last);
      } catch (err) {
        if (!err.auth && !last) throw err;
        if (err.auth) vaultToken = null;
      }
    }
  }
  if (!last) {
    return { status: 'auth', message: t('No valid Antigravity sign-in. Open agy (Gemini) to sign in; the reading shows while that sign-in is active.') };
  }
  const live = Date.now() - last.ts < FETCH_EVERY + 60000;
  const windows = aged(last);
  if (!windows.length) return { status: 'nolimit', plan: last.plan, message: t('Google reported no limits for this account.') };
  return live
    ? { status: 'ok', plan: last.plan, source: 'api', windows }
    : { status: 'ok', plan: last.plan, source: 'api', windows, asOf: last.ts, message: t('Updates when Antigravity runs (its sign-in lasts 1 h).') };
}

// The Antigravity CLI installs as `agy` under %LOCALAPPDATA%\agy\bin; running it signs in.
const cli = { bin: 'agy', dirs: [BIN_DIR], login: [], hint: 'Open agy in a terminal and sign in with your Google account.' };

module.exports = { id: 'antigravity', name: 'Gemini (Antigravity)', color: '#9d8cff', dataDir: ROOT, cli, detect, limits, usage };
