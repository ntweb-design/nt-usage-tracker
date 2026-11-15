const { t } = require('../i18n');
const fs = require('fs');
const path = require('path');
const { HOME, walk, readJson, readLinesFrom } = require('./util');

const ROOT = path.join(HOME, '.claude');
const CREDS = path.join(ROOT, '.credentials.json');
const PROJECTS = path.join(ROOT, 'projects');

const detect = () => fs.existsSync(ROOT);

const PLAN_NAMES = { max: 'Max', pro: 'Pro', team: 'Team', enterprise: 'Enterprise', free: 'Free' };

function planName(c) {
  const base = PLAN_NAMES[c.subscriptionType] || c.subscriptionType || '';
  const mult = /(\d+)x/.exec(c.rateLimitTier || '');
  return mult ? `${base} ${mult[1]}x` : base;
}

/**
 * Plan limits straight from the endpoint Claude Code itself uses for /usage,
 * authenticated with the CLI's own login. The token is only ever read here —
 * refreshing is left to Claude Code so its login is never invalidated.
 */
async function limits() {
  const c = readJson(CREDS)?.claudeAiOauth;
  if (!c?.accessToken) return { status: 'auth', message: t('Sign in to Claude Code (claude /login).') };
  const plan = planName(c);
  if (c.expiresAt && c.expiresAt < Date.now()) {
    return { status: 'auth', plan, message: t('Sign-in expired — open Claude Code to renew it.') };
  }
  const res = await fetch('https://api.anthropic.com/api/oauth/usage', {
    headers: {
      Authorization: `Bearer ${c.accessToken}`,
      'anthropic-beta': 'oauth-2025-04-20',
      'User-Agent': 'claude-code/2.0.0',
    },
    signal: AbortSignal.timeout(15000),
  });
  if (res.status === 401 || res.status === 403) {
    return { status: 'auth', plan, message: t('Sign-in expired — open Claude Code to renew it.') };
  }
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const j = await res.json();

  const windows = [];
  const ts = (s) => (s ? Date.parse(s) : null);
  if (Array.isArray(j.limits) && j.limits.length) {
    for (const l of j.limits) {
      if (l.percent == null) continue;
      if (l.kind === 'session') windows.push({ id: 'session', label: t('5 hours'), role: 'short', usedPct: l.percent, resetsAt: ts(l.resets_at) });
      else if (l.kind === 'weekly_all') windows.push({ id: 'weekly', label: t('Weekly'), role: 'long', usedPct: l.percent, resetsAt: ts(l.resets_at) });
      else {
        const scope = l.scope?.model?.display_name || l.scope?.surface || l.kind;
        const period = l.group === 'weekly' ? t('Weekly') : l.group === 'session' ? t('5 hours') : t('Limit');
        windows.push({ id: `${l.kind}:${scope}`, label: `${period} · ${scope}`, role: 'extra', usedPct: l.percent, resetsAt: ts(l.resets_at) });
      }
    }
  } else {
    if (j.five_hour?.utilization != null) windows.push({ id: 'session', label: t('5 hours'), role: 'short', usedPct: j.five_hour.utilization, resetsAt: ts(j.five_hour.resets_at) });
    if (j.seven_day?.utilization != null) windows.push({ id: 'weekly', label: t('Weekly'), role: 'long', usedPct: j.seven_day.utilization, resetsAt: ts(j.seven_day.resets_at) });
    for (const [k, label] of [['seven_day_opus', `${t('Weekly')} · Opus`], ['seven_day_sonnet', `${t('Weekly')} · Sonnet`]]) {
      if (j[k]?.utilization != null) windows.push({ id: k, label, role: 'extra', usedPct: j[k].utilization, resetsAt: ts(j[k].resets_at) });
    }
  }
  if (j.extra_usage?.is_enabled && j.extra_usage.utilization != null) {
    windows.push({ id: 'extra', label: t('Extra usage'), role: 'extra', usedPct: j.extra_usage.utilization, resetsAt: null });
  }
  return { status: 'ok', plan, windows, source: 'api' };
}

/**
 * Token usage from Claude Code's session transcripts. Records are kept per
 * message id so streamed duplicates (and histories copied into resumed
 * sessions) are only counted once.
 */
function usage({ cache, since }) {
  const files = walk(PROJECTS, (p) => p.endsWith('.jsonl'));
  const seen = new Set();
  const records = [];
  let sessions = 0;

  for (const file of files) {
    let st;
    try { st = fs.statSync(file); } catch { continue; }
    if (st.mtimeMs < since) continue;
    const entry = cache.get(file);
    if (st.size < entry.offset) { entry.offset = 0; entry.data = {}; }
    if (st.size !== entry.size || st.mtimeMs !== entry.mtime) {
      const recs = entry.data.recs || (entry.data.recs = {});
      try {
        entry.offset = readLinesFrom(file, entry.offset, (line) => {
          if (!line.includes('"usage"') || !line.includes('"assistant"')) return;
          let j;
          try { j = JSON.parse(line); } catch { return; }
          const m = j.message;
          const u = m?.usage;
          if (!u || j.type !== 'assistant' || !m.model || m.model === '<synthetic>') return;
          const id = m.id || j.uuid;
          // Later lines of the same message carry the final counts.
          recs[id] = [Date.parse(j.timestamp) || st.mtimeMs, m.model, u.input_tokens || 0, u.output_tokens || 0, u.cache_read_input_tokens || 0, u.cache_creation_input_tokens || 0];
        });
        entry.size = st.size;
        entry.mtime = st.mtimeMs;
        cache.save(file);
      } catch { /* file busy; retry next pass */ }
    }
    let counted = false;
    const recs = entry.data.recs || {};
    for (const id in recs) {
      const r = recs[id];
      if (r[0] < since || seen.has(id)) continue;
      seen.add(id);
      records.push({ ts: r[0], model: r[1], input: r[2], output: r[3], cacheRead: r[4], cacheWrite: r[5] });
      counted = true;
    }
    if (counted) sessions++;
  }
  return { records, sessions };
}

const cli = { bin: 'claude', dirs: [path.join(HOME, '.local', 'bin')], login: ['auth', 'login'] };

module.exports = { id: 'claude', name: 'Claude Code', color: '#d97757', dataDir: ROOT, cli, detect, limits, usage };
