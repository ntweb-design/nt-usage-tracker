const { t } = require('../i18n');
const fs = require('fs');
const path = require('path');
const { HOME, DAY, readLinesFrom } = require('./util');

const ROOT = path.join(HOME, '.grok');
const LOG = path.join(ROOT, 'logs', 'unified.jsonl');

const detect = () => fs.existsSync(ROOT);

const PERIODS = { USAGE_PERIOD_TYPE_WEEKLY: 'Weekly', USAGE_PERIOD_TYPE_MONTHLY: 'Monthly', USAGE_PERIOD_TYPE_DAILY: 'Daily' };

/**
 * Grok CLI writes both per-request token counts and its own billing checks to
 * a unified log. The log can be rotated, so everything read is kept in cache.
 */
function scan({ cache }) {
  const entry = cache.get(LOG);
  const d = entry.data;
  d.recs ||= {};
  d.models ||= {};
  let st;
  try { st = fs.statSync(LOG); } catch { return d; }
  if (st.size < entry.offset) entry.offset = 0; // rotated
  if (st.size === entry.size && st.mtimeMs === entry.mtime) return d;
  try {
    entry.offset = readLinesFrom(LOG, entry.offset, (line) => {
      const inf = line.includes('"shell.turn.inference_done"');
      const bill = !inf && line.includes('"billing: fetched credits config"');
      const mod = !inf && !bill && line.includes('"model changed"');
      if (!inf && !bill && !mod) return;
      let j;
      try { j = JSON.parse(line); } catch { return; }
      const ts = Date.parse(j.ts) || Date.now();
      const c = j.ctx || {};
      if (mod) { if (j.sid && c.model) d.models[j.sid] = c.model; return; }
      if (bill) { d.billing = { ts, config: c.config, tier: c.subscriptionTier }; return; }
      const cached = c.cached_prompt_tokens || 0;
      d.recs[`${j.ts}|${j.sid}|${c.loop_index}`] = [ts, d.models[j.sid] || d.lastModel || 'grok', Math.max(0, (c.prompt_tokens || 0) - cached), c.completion_tokens || 0, cached, j.sid];
      if (d.models[j.sid]) d.lastModel = d.models[j.sid];
    });
    const old = Date.now() - 100 * DAY;
    for (const k in d.recs) if (d.recs[k][0] < old) delete d.recs[k];
    entry.size = st.size;
    entry.mtime = st.mtimeMs;
    cache.save(LOG);
  } catch { /* retry next pass */ }
  return d;
}

function usage(ctx) {
  const d = scan(ctx);
  const records = [];
  const sids = new Set();
  for (const k in d.recs) {
    const r = d.recs[k];
    if (r[0] < ctx.since) continue;
    records.push({ ts: r[0], model: r[1], input: r[2], output: r[3], cacheRead: r[4], cacheWrite: 0 });
    sids.add(r[5]);
  }
  return { records, sessions: sids.size, billing: d.billing };
}

function loggedIn() {
  try { return Object.keys(JSON.parse(fs.readFileSync(path.join(ROOT, 'auth.json'), 'utf8'))).length > 0; } catch { return false; }
}

async function limits({ billing } = {}) {
  if (!loggedIn()) return { status: 'auth', message: t('Not signed in to the Grok CLI.') };
  const cfg = billing?.config;
  if (!cfg || cfg.creditUsagePercent == null) {
    return { status: 'unavailable', message: t('No data yet — run the Grok CLI once.') };
  }
  const end = Date.parse(cfg.currentPeriod?.end || cfg.billingPeriodEnd || '') || null;
  if (end && end < Date.now()) {
    return { status: 'unavailable', plan: billing.tier, message: t('Previous period ended — run the Grok CLI to update.') };
  }
  return {
    status: 'ok',
    plan: billing.tier || '',
    source: 'log',
    asOf: billing.ts,
    message: t('Updated when the Grok CLI runs.'),
    windows: [{ id: 'period', label: t(PERIODS[cfg.currentPeriod?.type] || 'Period'), role: 'long', usedPct: cfg.creditUsagePercent, resetsAt: end }],
  };
}

const cli = { bin: 'grok', dirs: [path.join(ROOT, 'bin')], login: ['login'] };

module.exports = { id: 'grok', name: 'Grok CLI', color: '#4fc3f7', dataDir: ROOT, cli, detect, limits, usage };
