const { t } = require('../i18n');
const fs = require('fs');
const path = require('path');
const { HOME, readJson } = require('./util');

// OpenCode keeps its database and auth.json in $XDG_DATA_HOME/opencode (default ~/.local/share/opencode).
const DATA = path.join(process.env.XDG_DATA_HOME?.trim() || path.join(HOME, '.local', 'share'), 'opencode');
const DB = path.join(DATA, process.env.OPENCODE_DB || 'opencode.db');
const AUTH = path.join(DATA, 'auth.json');
const GO_USAGE_URL = 'https://opencode.ai/zen/go/v1/usage';
const CONSOLE_URL = 'https://opencode.ai/console';

const detect = () => fs.existsSync(DB) || fs.existsSync(path.join(HOME, '.opencode'));

function openDb() {
  const { DatabaseSync } = require('node:sqlite');
  const db = new DatabaseSync(DB, { readOnly: true });
  db.exec('PRAGMA busy_timeout = 200'); // OpenCode writes in WAL mode; don't wait long for it
  return db;
}

function usage({ since }) {
  if (!fs.existsSync(DB)) return { records: [], sessions: 0 };
  const db = openDb();
  try {
    const rows = db.prepare(`
      select time_created ts, session_id sid,
        json_extract(data, '$.model.id') model,
        json_extract(data, '$.model.providerID') provider,
        json_extract(data, '$.cost') cost,
        json_extract(data, '$.tokens.input') ti,
        json_extract(data, '$.tokens.output') tout,
        json_extract(data, '$.tokens.reasoning') tr,
        json_extract(data, '$.tokens.cache.read') cr,
        json_extract(data, '$.tokens.cache.write') cw
      from session_message
      where type = 'assistant' and time_created >= ? and json_extract(data, '$.tokens.input') is not null
    `).all(since);
    const sids = new Set();
    const records = rows.map((r) => {
      sids.add(r.sid);
      return {
        ts: r.ts,
        model: r.model || 'unknown',
        input: r.ti || 0,
        output: (r.tout || 0) + (r.tr || 0),
        cacheRead: r.cr || 0,
        cacheWrite: r.cw || 0,
        cost: r.cost || 0, // OpenCode reports its own cost
      };
    });
    return { records, sessions: sids.size };
  } finally {
    db.close();
  }
}

/**
 * The active OpenCode Console sign-in from OpenCode 2's `credential` table: the
 * OAuth access token (`opencode auth login` in the browser) or a pasted key.
 * A self-hosted console is skipped, since its token means nothing to opencode.ai.
 */
function consoleCredential() {
  if (!fs.existsSync(DB)) return null;
  let db;
  try {
    db = openDb();
    const row = db.prepare(`select value from credential
      where integration_id = 'opencode' and active is not 0
      order by active desc, time_created desc, id desc limit 1`).get();
    const v = row?.value ? JSON.parse(row.value) : null;
    if (!v) return null;
    const server = v.metadata?.server;
    if (typeof server === 'string' && server.replace(/\/+$/, '') !== CONSOLE_URL) return null;
    if (v.type === 'oauth' && v.access) {
      return v.expires && v.expires < Date.now() + 60000 ? { expired: true } : { key: v.access, kind: 'oauth' };
    }
    if (v.type === 'key' && v.key?.trim()) return { key: v.key.trim(), kind: 'key' };
    return null;
  } catch {
    return null; // locked, missing table (OpenCode 1), unexpected shape
  } finally {
    try { db?.close(); } catch { /* ignore */ }
  }
}

/** Every key OpenCode could use for its Go plan, in the order the CLI prefers them. */
function goKeys() {
  const out = [];
  let expired = false;
  const cred = consoleCredential();
  if (cred?.key) out.push(cred.key);
  if (cred?.expired) expired = true;
  const go = readJson(AUTH)?.['opencode-go'];
  if (go?.type === 'api' && go.key?.trim()) out.push(go.key.trim());
  if (process.env.OPENCODE_API_KEY?.trim()) out.push(process.env.OPENCODE_API_KEY.trim());
  return { keys: [...new Set(out)], expired };
}

function goWindow(w, id, label, role) {
  if (!w || !Number.isFinite(w.percent)) return null;
  const resetsAt = Date.parse(w.resetsAt || '');
  return { id, label, role, usedPct: Math.max(0, Math.min(100, w.percent)), resetsAt: Number.isFinite(resetsAt) ? resetsAt : null };
}

/** OpenCode Go plan limits: a 5-hour rolling window plus weekly and monthly caps. */
async function limits() {
  const { keys, expired } = goKeys();
  if (!keys.length) {
    if (expired) return { status: 'auth', message: t('OpenCode sign-in expired — open OpenCode to renew it.') };
    return { status: 'nolimit', message: t('No OpenCode Console sign-in or OpenCode Go key — usage only.') };
  }
  let rejected = 0;
  for (const key of keys) {
    const res = await fetch(GO_USAGE_URL, { headers: { Authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(10000) });
    if (res.status === 401 || res.status === 403) { rejected++; continue; }
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const u = (await res.json())?.usage || {};
    const rolling = goWindow(u.rolling, 'rolling', t('5 hours'), 'short');
    const weekly = goWindow(u.weekly, 'weekly', t('Weekly'), 'long');
    const monthly = goWindow(u.monthly, 'monthly', t('Monthly'), 'long');
    // The outer ring is whichever long cap is closer to stopping you; the other one is listed too.
    let long = weekly || monthly;
    let extra = null;
    if (weekly && monthly) {
      long = monthly.usedPct > weekly.usedPct ? monthly : weekly;
      extra = { ...(long === weekly ? monthly : weekly), role: 'extra' };
    }
    const windows = [rolling, long, extra].filter(Boolean);
    if (!windows.length) return { status: 'nolimit', message: t('Account without an OpenCode Go subscription — usage only.') };
    return { status: 'ok', plan: 'Go', source: 'api', windows };
  }
  if (rejected === keys.length) return { status: 'nolimit', message: t('Account without an OpenCode Go subscription (or sign-in refused) — usage only.') };
  return { status: 'nolimit', message: t('OpenCode reported no limits.') };
}

const cli = { bin: 'opencode', dirs: [path.join(HOME, '.opencode', 'bin')], login: ['auth', 'login'] };

module.exports = { id: 'opencode', name: 'OpenCode CLI', color: '#e6e6e6', dataDir: DATA, cli, detect, limits, usage };
