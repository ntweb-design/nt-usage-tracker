/**
 * Collector. Runs as a worker thread inside the app (so log parsing never
 * blocks window dragging) or standalone: `npm run collect`.
 */
const path = require('path');
const os = require('os');
const { parentPort, workerData } = require('worker_threads');
const { DAY, FileCache, addBucket, findBinary } = require('./util');
const { loadPricing, costOf } = require('./pricing');

const claudeApi = require('./claude-api');
const i18n = require('../i18n');

i18n.setLang(workerData?.lang);

const PROVIDERS = [require('./claude'), claudeApi, require('./codex'), require('./grok'), require('./opencode'), require('./antigravity')];
const HISTORY_DAYS = 30;

const dataDir = workerData?.dataDir || path.join(os.tmpdir(), 'nt-usage-tracker');
const caches = Object.fromEntries(PROVIDERS.map((p) => [p.id, new FileCache(path.join(dataDir, 'cache', p.id))]));
const priceFor = loadPricing(dataDir);
const state = {}; // per provider: last good limits + usage
if (workerData?.claudeApi) claudeApi.configure(workerData.claudeApi);

function sinceTs() {
  const d = new Date(Date.now() - (HISTORY_DAYS - 1) * DAY);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

function buildUsage(raw) {
  const buckets = {};
  const unpriced = new Set();
  for (const r of raw.records) {
    let cost = r.cost;
    if (cost == null) {
      cost = costOf(priceFor(r.model), r);
      if (cost == null) unpriced.add(r.model);
    }
    addBucket(buckets, r.ts, r.model, { ...r, cost });
  }
  return { buckets, sessions: raw.sessions, unpriced: [...unpriced] };
}

async function collect({ limits = true, usage = true } = {}) {
  const since = sinceTs();
  await Promise.all(PROVIDERS.map(async (p) => {
    const s = state[p.id] || (state[p.id] = { detected: false, limits: { status: 'loading' }, usage: { buckets: {}, sessions: 0, unpriced: [] } });
    // A provider shows up when its CLI is installed or it has left data on this machine.
    s.bin = p.cli.bin ? findBinary(p.cli.bin, p.cli.dirs) : null;
    s.detected = Boolean(s.bin) || p.detect();
    if (!s.detected) return;
    if (usage || !s.raw) {
      try {
        s.raw = await p.usage({ cache: caches[p.id], since });
        s.usage = buildUsage(s.raw);
        s.usageError = null;
      } catch (err) {
        s.usageError = String(err.message || err);
      }
    }
    if (limits) {
      try {
        s.limits = { ...(await p.limits(s.raw || {})), fetchedAt: Date.now() };
      } catch (err) {
        // Keep showing the last good numbers, flagged as stale.
        const prev = s.limits?.windows ? s.limits : null;
        s.limits = prev
          ? { ...prev, status: 'stale', message: i18n.t('No connection ({error}). Showing the last reading.', { error: err.message }) }
          : { status: 'error', message: i18n.t('Request failed: {error}', { error: err.message }) };
      }
    }
  }));
  return {
    generatedAt: Date.now(),
    historyDays: HISTORY_DAYS,
    providers: PROVIDERS.filter((p) => state[p.id].detected).map((p) => ({
      id: p.id,
      name: p.name,
      color: p.color,
      cli: {
        path: state[p.id].bin,
        // 'app' = credentials are entered in the app itself, not through a CLI.
        login: p.cli.login === 'app' ? 'app' : state[p.id].bin && p.cli.login ? p.cli.login : null,
        hint: p.cli.hint ? i18n.t(p.cli.hint) : null,
      },
      limits: state[p.id].limits,
      usage: state[p.id].usage,
      usageError: state[p.id].usageError || null,
    })),
  };
}

if (parentPort) {
  let busy = Promise.resolve();
  parentPort.on('message', (msg) => {
    if (msg.type === 'config') {
      if (msg.lang) i18n.setLang(msg.lang);
      if (msg.claudeApi) claudeApi.configure(msg.claudeApi);
      return;
    }
    if (msg.type !== 'refresh') return;
    busy = busy.then(() => collect(msg)).then(
      (snapshot) => parentPort.postMessage({ type: 'snapshot', snapshot }),
      (err) => parentPort.postMessage({ type: 'error', message: String(err.stack || err) }),
    );
  });
} else {
  const t0 = Date.now();
  collect().then((snap) => {
    for (const p of snap.providers) {
      const tot = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, requests: 0, cost: 0 };
      for (const b of Object.values(p.usage.buckets)) for (const k in tot) tot[k] += b[k];
      console.log(`\n== ${p.name} · cli: ${p.cli.path || '(not found)'}`);
      console.log(' limits:', JSON.stringify(p.limits));
      console.log(' usage :', JSON.stringify({ ...tot, cost: +tot.cost.toFixed(2), sessions: p.usage.sessions, buckets: Object.keys(p.usage.buckets).length, unpriced: p.usage.unpriced }), p.usageError || '');
    }
    console.log(`\n${Date.now() - t0} ms · cache em ${dataDir}`);
  });
}
