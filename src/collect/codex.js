const { t } = require('../i18n');
const fs = require('fs');
const path = require('path');
const { HOME, walk, readJson, readLinesFrom, windowLabel } = require('./util');

const ROOT = path.join(HOME, '.codex');
const AUTH = path.join(ROOT, 'auth.json');
const SESSIONS = path.join(ROOT, 'sessions');

const detect = () => fs.existsSync(ROOT);

const cap = (s) => (s ? s[0].toUpperCase() + s.slice(1) : '');

function toWindows(list) {
  // list: [{ usedPct, seconds, resetsAt }] — shortest window is the inner ring.
  const ws = list.filter((w) => w && w.usedPct != null).sort((a, b) => (a.seconds || 0) - (b.seconds || 0));
  return ws.map((w, i) => {
    const short = (w.seconds || 0) > 0 && w.seconds <= 6 * 3600;
    return {
      id: i === 0 ? 'primary' : 'secondary',
      label: windowLabel(w.seconds),
      role: short ? 'short' : i === ws.length - 1 ? 'long' : 'extra',
      usedPct: w.usedPct,
      resetsAt: w.resetsAt,
    };
  });
}

/** Limits from the same backend endpoint the Codex CLI uses for /status. */
async function limits({ lastLog } = {}) {
  const a = readJson(AUTH);
  const tok = a?.tokens;
  if (!tok?.access_token) {
    if (a?.OPENAI_API_KEY) return { status: 'nolimit', plan: 'API key', message: t('API key sign-in has no plan limit.') };
    return { status: 'auth', message: t('Sign in to the Codex CLI (codex login).') };
  }
  try {
    const res = await fetch('https://chatgpt.com/backend-api/wham/usage', {
      headers: { Authorization: `Bearer ${tok.access_token}`, 'chatgpt-account-id': tok.account_id || '', 'User-Agent': 'codex-cli' },
      signal: AbortSignal.timeout(15000),
    });
    if (res.status === 401 || res.status === 403) throw Object.assign(new Error('auth'), { auth: true });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const j = await res.json();
    const rl = j.rate_limit || {};
    const w = (x) => x && { usedPct: x.used_percent, seconds: x.limit_window_seconds, resetsAt: x.reset_at ? x.reset_at * 1000 : null };
    return { status: 'ok', plan: cap(j.plan_type), windows: toWindows([w(rl.primary_window), w(rl.secondary_window)]), source: 'api' };
  } catch (err) {
    // Fall back to the last rate-limit snapshot the CLI wrote to its own logs.
    if (lastLog?.rl) {
      const w = (x) => x && { usedPct: x.used_percent, seconds: (x.window_minutes || 0) * 60, resetsAt: x.resets_at ? x.resets_at * 1000 : null };
      const windows = toWindows([w(lastLog.rl.primary), w(lastLog.rl.secondary)]).filter((x) => !x.resetsAt || x.resetsAt > Date.now());
      if (windows.length) return { status: 'stale', plan: cap(lastLog.rl.plan_type), windows, source: 'log', asOf: lastLog.ts, message: t('Read from the last Codex CLI log.') };
    }
    if (err.auth) return { status: 'auth', message: t('Sign-in expired — open the Codex CLI to renew it.') };
    throw err;
  }
}

function usage({ cache, since }) {
  const files = walk(SESSIONS, (p) => p.endsWith('.jsonl'));
  const records = [];
  let sessions = 0;
  let lastLog = null;

  for (const file of files) {
    let st;
    try { st = fs.statSync(file); } catch { continue; }
    if (st.mtimeMs < since) continue;
    const entry = cache.get(file);
    if (st.size < entry.offset) { entry.offset = 0; entry.data = {}; }
    const d = entry.data;
    d.recs ||= [];
    if (st.size !== entry.size || st.mtimeMs !== entry.mtime) {
      try {
        entry.offset = readLinesFrom(file, entry.offset, (line) => {
          const isTok = line.includes('"token_count"');
          if (!isTok && !line.includes('"turn_context"')) return;
          let j;
          try { j = JSON.parse(line); } catch { return; }
          if (j.type === 'turn_context') { if (j.payload?.model) d.model = j.payload.model; return; }
          const p = j.payload;
          if (j.type !== 'event_msg' || p?.type !== 'token_count') return;
          const ts = Date.parse(j.timestamp) || st.mtimeMs;
          if (p.rate_limits?.primary || p.rate_limits?.secondary) d.rl = { ts, rl: p.rate_limits };
          const tot = p.info?.total_token_usage;
          if (!tot) return;
          const prev = d.prev || { input_tokens: 0, cached_input_tokens: 0, output_tokens: 0, total_tokens: 0 };
          if (tot.total_tokens === prev.total_tokens) return; // repeated snapshot
          // Totals are cumulative per session; fall back to the per-request numbers if they ever reset.
          const use = tot.total_tokens > prev.total_tokens
            ? { i: tot.input_tokens - prev.input_tokens, c: tot.cached_input_tokens - prev.cached_input_tokens, o: tot.output_tokens - prev.output_tokens }
            : { i: p.info.last_token_usage?.input_tokens || 0, c: p.info.last_token_usage?.cached_input_tokens || 0, o: p.info.last_token_usage?.output_tokens || 0 };
          d.prev = { input_tokens: tot.input_tokens, cached_input_tokens: tot.cached_input_tokens, output_tokens: tot.output_tokens, total_tokens: tot.total_tokens };
          d.recs.push([ts, d.model || 'codex', Math.max(0, use.i - use.c), Math.max(0, use.o), Math.max(0, use.c)]);
        });
        entry.size = st.size;
        entry.mtime = st.mtimeMs;
        cache.save(file);
      } catch { /* retry next pass */ }
    }
    let counted = false;
    for (const r of d.recs) {
      if (r[0] < since) continue;
      records.push({ ts: r[0], model: r[1], input: r[2], output: r[3], cacheRead: r[4], cacheWrite: 0 });
      counted = true;
    }
    if (counted) sessions++;
    if (d.rl && (!lastLog || d.rl.ts > lastLog.ts)) lastLog = d.rl;
  }
  return { records, sessions, lastLog };
}

const cli = { bin: 'codex', dirs: [], login: ['login'], hint: 'Open the Codex app and sign in.' };

module.exports = { id: 'codex', name: 'Codex CLI', color: '#b39ddb', dataDir: ROOT, cli, detect, limits, usage };
