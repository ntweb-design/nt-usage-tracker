const { t, locale } = require('../i18n');
const Anthropic = require('@anthropic-ai/sdk');
const { DAY } = require('./util');

/**
 * Claude API (Console) usage and spend, from the organization's Usage and Cost
 * Analytics API. Needs an Admin API key (sk-ant-admin…), or the personal /
 * service-account key (sk-ant-usr…) of an admin that is not tied to one
 * workspace — the Admin API treats those like the linked account. The app stores it
 * encrypted and hands it to the collector with `configure()`; standalone runs
 * read ANTHROPIC_ADMIN_KEY. Regular API keys are rejected by these endpoints.
 *
 * Anthropic refreshes this data within ~4 h (up to 24 h), so it is fetched at
 * most every FETCH_EVERY and today's numbers lag behind.
 */
const FETCH_EVERY = 10 * 60 * 1000;

let config = { key: process.env.ANTHROPIC_ADMIN_KEY || null, budget: null };
let client = null;
let last = null;   // last good result
let pending = null;
let fetchedAt = 0;
let error = null;  // { kind: 'auth' | 'unavailable' | 'net', message }

function configure({ key, budget } = {}) {
  if (key !== undefined && key !== config.key) {
    config.key = key || null;
    client = null;
    last = null;
    error = null;
    fetchedAt = 0;
  }
  if (budget !== undefined) config.budget = budget > 0 ? budget : null;
}

const detect = () => Boolean(config.key);

const utcDay = (ts) => { const d = new Date(ts); d.setUTCHours(0, 0, 0, 0); return d.getTime(); };
const utcMonth = (ts) => { const d = new Date(ts); return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1); };
const nextUtcMonth = (ts) => { const d = new Date(ts); return Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1); };

/** Reads every page of a report, returning its rows and the data_refreshed_at mark. */
async function readAll(pagePromise) {
  const rows = [];
  let refreshed = null;
  for await (const page of (await pagePromise).iterPages()) {
    refreshed = page.data_refreshed_at || refreshed;
    rows.push(...page.data);
  }
  return { rows, refreshed };
}

async function fetchReports(since) {
  client ||= new Anthropic({ apiKey: config.key, maxRetries: 1, timeout: 30000 });
  const now = Date.now();
  const monthStart = utcMonth(now);
  // One query covers both the report history and the current billing month (always < 31 days).
  const params = {
    starting_at: new Date(Math.min(utcDay(since), monthStart)).toISOString(),
    ending_at: new Date(now).toISOString(),
    time_bucket_width: '1d',
    group_by: ['model'],
    limit: 1000,
  };
  const [usage, cost] = await Promise.all([
    readAll(client.beta.organization.analytics.usage.list(params)),
    readAll(client.beta.organization.analytics.cost.list(params)),
  ]);

  // Merge tokens and dollars per UTC day and model.
  const rows = new Map();
  const row = (startIso, model) => {
    const k = startIso + '|' + (model || '');
    if (!rows.has(k)) rows.set(k, { start: Date.parse(startIso), model: model || 'other (tools)', input: 0, output: 0, cacheRead: 0, cacheWrite: 0, requests: 0, cost: 0 });
    return rows.get(k);
  };
  for (const r of usage.rows) {
    const u = r.usage;
    const x = row(r.starting_at, r.group.model);
    x.input += u.uncached_input_tokens || 0;
    x.output += u.output_tokens || 0;
    x.cacheRead += u.cache_read_input_tokens || 0;
    x.cacheWrite += (u.cache_creation?.ephemeral_5m_input_tokens || 0) + (u.cache_creation?.ephemeral_1h_input_tokens || 0);
    x.requests += u.requests || 0;
  }
  let monthCost = 0;
  for (const r of cost.rows) {
    const usd = Number(r.cost.amount) / 100; // decimal string in cents
    if (!Number.isFinite(usd)) continue;
    row(r.starting_at, r.group.model).cost += usd;
    if (Date.parse(r.starting_at) >= monthStart) monthCost += usd;
  }

  const refreshed = [usage.refreshed, cost.refreshed].filter(Boolean).map(Date.parse);
  return {
    // Stamp each UTC-day row at its midday so it lands on the same local calendar day.
    records: [...rows.values()].map((r) => ({ ts: r.start + DAY / 2, model: r.model, input: r.input, output: r.output, cacheRead: r.cacheRead, cacheWrite: r.cacheWrite, requests: r.requests, cost: r.cost })),
    monthCost,
    monthEnd: nextUtcMonth(now),
    refreshedAt: refreshed.length ? Math.min(...refreshed) : null,
  };
}

function classify(err) {
  if (err instanceof Anthropic.AuthenticationError) {
    return { kind: 'auth', message: t('Invalid, expired or deleted key (Anthropic answered 401). Keys have an expiry chosen when they are created; make a new one in the Console.') };
  }
  if (err instanceof Anthropic.PermissionDeniedError) {
    return { kind: 'auth', message: t('Key without admin rights (403): use an Admin key (sk-ant-admin…) or the personal key of an admin account that is not tied to a workspace.') };
  }
  if (err instanceof Anthropic.NotFoundError) {
    return { kind: 'unavailable', message: t('The usage API is not available for this organization (individual Console accounts need to create an organization).') };
  }
  if (err instanceof Anthropic.APIError && err.status) return { kind: 'net', message: `HTTP ${err.status}` };
  return { kind: 'net', message: String(err.message || err) };
}

async function usage({ since }) {
  if (!config.key) return { records: [], sessions: 0 };
  if (!pending && (!last || Date.now() - fetchedAt > FETCH_EVERY)) {
    pending = fetchReports(since)
      .then((r) => { last = r; error = null; })
      .catch((err) => { error = classify(err); })
      .finally(() => { fetchedAt = Date.now(); pending = null; });
  }
  if (pending) await pending;
  const keep = (last?.records || []).filter((r) => r.ts >= since);
  return { records: keep, sessions: 0, api: last, error };
}

const fmtUsd = (n) => '$' + n.toFixed(2);
const fmtTime = (ts) => new Date(ts).toLocaleString(locale(), { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });

async function limits({ api, error: err } = {}) {
  if (!config.key) return { status: 'auth', plan: 'API', message: t("Enter an Anthropic Admin key (or an admin's personal key).") };
  if (err?.kind === 'auth') return { status: 'auth', plan: 'API', message: err.message };
  if (err?.kind === 'unavailable') return { status: 'unavailable', plan: 'API', message: err.message };
  if (err) throw new Error(err.message); // the collector keeps the last reading, flagged stale
  if (!api) return { status: 'loading' };

  const asOf = ' ' + (api.refreshedAt ? t('Data up to {time}.', { time: fmtTime(api.refreshedAt) }) : t('No processed data yet.'));
  const spent = t('Spent this month: {amount}', { amount: fmtUsd(api.monthCost) });
  if (!config.budget) {
    return { status: 'nolimit', plan: 'API', source: 'api', message: `${spent}. ${t('Set a monthly budget to see the ring.')}${asOf}` };
  }
  return {
    status: 'ok',
    plan: 'API',
    source: 'api',
    message: `${t('{spent} of {budget}.', { spent, budget: fmtUsd(config.budget) })}${asOf}`,
    windows: [{ id: 'month', label: t('Monthly budget'), role: 'long', usedPct: (api.monthCost / config.budget) * 100, resetsAt: api.monthEnd }],
  };
}

/**
 * Checks a key before it is saved, with a one-day usage query.
 * Returns null when it works, or { kind, message }.
 */
async function validate(key) {
  const c = new Anthropic({ apiKey: key, maxRetries: 0, timeout: 20000 });
  const now = Date.now();
  try {
    await c.beta.organization.analytics.usage.list({
      starting_at: new Date(utcDay(now - DAY)).toISOString(),
      ending_at: new Date(now).toISOString(),
      time_bucket_width: '1d',
      limit: 1,
    });
    return null;
  } catch (err) {
    return classify(err);
  }
}

const cli = { bin: null, dirs: [], login: 'app', hint: 'Admin key entered in the app.' };

module.exports = { id: 'claude-api', name: 'Claude API', color: '#8b6ee0', dataDir: null, cli, detect, limits, usage, configure, validate };
