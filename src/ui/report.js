const { t, num, locale, icon, SERIES, STACK_ORDER, tokens, money, int, esc, limitRow, lastDays, ago } = window.UT;

const view = { id: null, days: 30, metric: 'tokens', group: 'model' };
let snapshot = null;

const $ = (s) => document.querySelector(s);
const root = $('#root');
const short = (name) => name.replace(/ (CLI|Code)$/, '');
const zero = () => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, requests: 0, cost: 0, hasCost: false });
const add = (a, b) => {
  a.input += b.input; a.output += b.output; a.cacheRead += b.cacheRead; a.cacheWrite += b.cacheWrite;
  a.requests += b.requests; a.cost += b.cost; a.hasCost ||= b.hasCost;
  return a;
};
// "Tokens" everywhere means new work: input + output + cache writes, without cache re-reads.
const work = (t) => t.input + t.output + t.cacheWrite;
const metric = (t) => (view.metric === 'cost' ? t.cost : work(t));
const fmt = (v) => (view.metric === 'cost' ? money(v) : tokens(v));
const costCell = (t) => (t.hasCost ? money(t.cost) : '<span class="muted">—</span>');

function compute() {
  const days = lastDays(view.days);
  const inRange = new Set(days);
  const scope = snapshot.providers.filter((p) => !view.id || p.id === view.id);
  const total = zero();
  const byProvider = new Map();
  const byModel = new Map();
  const byDay = new Map(days.map((d) => [d, { total: zero(), series: {} }]));
  let sessions = 0;
  const unpriced = new Set();

  for (const p of scope) {
    const pt = zero();
    for (const [key, b] of Object.entries(p.usage?.buckets || {})) {
      const [day, model] = [key.slice(0, 10), key.slice(11)];
      if (!inRange.has(day)) continue;
      add(pt, b);
      const mk = p.id + '|' + model;
      add(byModel.get(mk) || byModel.set(mk, { ...zero(), provider: p, model }).get(mk), b);
      const d = byDay.get(day);
      add(d.total, b);
      // Stack by provider in the overview, by nothing (single series) inside one provider.
      add(d.series[p.id] || (d.series[p.id] = zero()), b);
      if (!b.hasCost) unpriced.add(model);
    }
    byProvider.set(p.id, pt);
    add(total, pt);
    sessions += p.usage?.sessions || 0;
  }
  return { days, scope, total, byProvider, byModel, byDay, sessions, unpriced: [...unpriced] };
}

// ------------------------------------------------------------------ sections
function limitsSection(scope) {
  const order = { short: 0, long: 1, extra: 2 };
  return `<section><h2>${t('Plan limits')}</h2><div class="cards">${scope.map((p) => {
    const lim = p.limits || {};
    const ws = [...(lim.windows || [])].sort((a, b) => order[a.role] - order[b.role]);
    const notes = [lim.message, lim.asOf && ws.length ? t('Last reading {ago}.', { ago: ago(lim.asOf) }) : ''].filter(Boolean).join(' ');
    return `<div class="card">
      <div class="card-head">${icon(p.id, 16)}<b>${esc(short(p.name))}</b><span>${esc(lim.plan || '')}</span></div>
      ${ws.map(limitRow).join('')}
      ${notes ? `<p>${esc(notes)}</p>` : ''}
      ${lim.status !== 'auth' ? '' : p.cli?.login
        ? `<button class="ghost connect" data-connect="${p.id}">${t('Connect')}</button>`
        : `<p>${esc(p.cli?.hint || t('CLI not found on this machine.'))}</p>`}
    </div>`;
  }).join('')}</div></section>`;
}

function rankSection(c) {
  const rows = view.id
    ? [...c.byModel.values()].map((m) => ({ color: SERIES[m.provider.id], name: esc(m.model), t: m }))
    : c.scope.map((p) => ({ color: SERIES[p.id], name: icon(p.id, 15) + esc(p.name), t: c.byProvider.get(p.id) }));
  const all = metric(c.total) || 1;
  rows.sort((a, b) => metric(b.t) - metric(a.t));
  return `<div class="rank">${rows.filter((r) => r.t.requests > 0).slice(0, 6).map((r) => `
    <div class="rank-row">
      <span class="dot" style="background:${r.color}"></span>
      <span class="rank-name">${r.name}</span>
      <span class="rank-val">${view.metric === 'cost' && !r.t.hasCost ? '—' : fmt(metric(r.t))}</span>
      <span class="rank-sub">${num(metric(r.t) / all * 100, 1)}% · ${t('{n} requests', { n: int(r.t.requests) })}</span>
    </div>`).join('')}</div>`;
}

function chart(c) {
  const el = $('#chart');
  const ids = STACK_ORDER.filter((id) => c.scope.some((p) => p.id === id) && metric(c.byProvider.get(id)) > 0);
  $('#legend').innerHTML = ids.length > 1 ? ids.map((id) => `<span><i style="background:${SERIES[id]}"></i>${esc(short(c.scope.find((p) => p.id === id).name))}</span>`).join('') : '';
  const max = Math.max(...c.days.map((d) => metric(c.byDay.get(d).total)));
  if (!ids.length || !max) { el.innerHTML = `<div class="empty">${t('No usage recorded in this period.')}</div>`; return; }

  const W = el.clientWidth, H = el.clientHeight;
  const m = { l: 8, r: 52, t: 10, b: 24 };
  const pw = W - m.l - m.r, ph = H - m.t - m.b;
  // Round the axis top up to a clean number.
  const mag = Math.pow(10, Math.floor(Math.log10(max)));
  const top = [1, 1.5, 2, 3, 4, 5, 6, 8, 10].map((k) => k * mag).find((v) => v >= max);
  const y = (v) => m.t + ph - (v / top) * ph;
  const step = pw / c.days.length;
  const bw = Math.max(3, Math.min(34, step - (step > 14 ? 6 : 2)));
  const every = Math.ceil(c.days.length / 8);
  const label = (d) => new Date(`${d}T12:00`).toLocaleDateString(locale(), { day: '2-digit', month: '2-digit' });

  let s = '';
  for (const f of [0, 0.5, 1]) {
    s += `<line class="grid" x1="${m.l}" x2="${m.l + pw}" y1="${y(top * f)}" y2="${y(top * f)}"/>`;
    s += `<text x="${m.l + pw + 8}" y="${y(top * f) + 4}">${fmt(top * f)}</text>`;
  }
  c.days.forEach((d, i) => {
    const x = m.l + i * step + (step - bw) / 2;
    let base = 0;
    const segs = ids.map((id) => ({ id, v: metric(c.byDay.get(d).series[id] || zero()) })).filter((g) => g.v > 0);
    segs.forEach((g, k) => {
      const y1 = y(base + g.v), y0 = y(base);
      const gap = k ? 2 : 0; // surface gap between stacked segments
      const h = Math.max(0, y0 - y1 - gap);
      const r = k === segs.length - 1 ? Math.min(4, bw / 2, h) : 0; // only the data end is rounded
      if (h > 0) s += `<path fill="${SERIES[g.id]}" d="M${x},${y0 - gap} v${-(h - r)} q0,${-r} ${r},${-r} h${bw - 2 * r} q${r},0 ${r},${r} v${h - r} z"/>`;
      base += g.v;
    });
    if (i % every === 0 || c.days.length <= 8) s += `<text x="${m.l + i * step + step / 2}" y="${H - 6}" text-anchor="middle">${label(d)}</text>`;
    s += `<rect class="hit" data-day="${d}" x="${m.l + i * step}" y="${m.t}" width="${step}" height="${ph}"/>`;
  });
  el.innerHTML = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="${t('Daily usage')}">${s}</svg><div id="hover"></div>`;

  const hover = $('#hover');
  el.onmousemove = (e) => {
    const day = e.target.dataset?.day;
    if (!day) { hover.style.display = 'none'; return; }
    const d = c.byDay.get(day);
    const rows = ids.map((id) => ({ id, v: metric(d.series[id] || zero()) })).filter((g) => g.v > 0).reverse();
    hover.innerHTML = `<b>${label(day)} · ${fmt(metric(d.total))}</b>` + (ids.length > 1
      ? rows.map((g) => `<div><i class="dot" style="background:${SERIES[g.id]}"></i><span>${esc(short(c.scope.find((p) => p.id === g.id).name))}</span><span>${fmt(g.v)}</span></div>`).join('')
      : `<div><span>${t('{n} requests', { n: int(d.total.requests) })}</span></div>`);
    hover.style.display = 'block';
    const r = el.getBoundingClientRect();
    const hx = e.clientX - r.left + 14;
    hover.style.left = Math.min(hx, r.width - hover.offsetWidth - 4) + 'px';
    hover.style.top = Math.max(0, e.clientY - r.top - hover.offsetHeight - 10) + 'px';
  };
  el.onmouseleave = () => { hover.style.display = 'none'; };
}

function table(c) {
  let head, rows;
  const cols = (t) => `<td>${tokens(work(t))}</td><td>${tokens(t.input)}</td><td>${tokens(t.output)}</td><td>${tokens(t.cacheWrite)}</td><td>${tokens(t.cacheRead)}</td><td>${int(t.requests)}</td><td>${costCell(t)}</td>`;
  if (view.group === 'day') {
    head = t('Day');
    rows = [...c.days].reverse().filter((d) => c.byDay.get(d).total.requests).map((d) => `<tr><td>${new Date(`${d}T12:00`).toLocaleDateString(locale())}</td>${cols(c.byDay.get(d).total)}</tr>`);
  } else if (view.group === 'provider') {
    head = t('Provider');
    rows = c.scope.map((p) => ({ p, t: c.byProvider.get(p.id) })).sort((a, b) => work(b.t) - work(a.t)).map(({ p, t }) => `<tr><td>${icon(p.id, 15)}${esc(p.name)}</td>${cols(t)}</tr>`);
  } else {
    head = t('Model');
    rows = [...c.byModel.values()].sort((a, b) => work(b) - work(a)).map((t) => `<tr><td>${icon(t.provider.id, 15)}${esc(t.model)}</td>${cols(t)}</tr>`);
  }
  const tabs = [['model', t('Model')], ['day', t('Day')], ...(view.id ? [] : [['provider', t('Provider')]])];
  return `<section>
    <div class="table-head"><h2>${t('Breakdown')}</h2><div class="spacer"></div>
      <div class="seg" id="group">${tabs.map(([v, l]) => `<button data-v="${v}" aria-pressed="${view.group === v}">${l}</button>`).join('')}</div></div>
    <table><thead><tr><th>${head}</th><th>${t('Tokens')}</th><th>${t('Input')}</th><th>${t('Output')}</th><th>${t('Cache written')}</th><th>${t('Cache read')}</th><th>${t('Requests')}</th><th>${t('Est. cost')}</th></tr></thead>
    <tbody>${rows.join('') || `<tr><td class="muted">${t('No data in this period.')}</td></tr>`}</tbody></table>
  </section>`;
}

// -------------------------------------------------------------------- render
function render() {
  if (!snapshot) { root.innerHTML = `<div class="notice">${t('Loading data…')}</div>`; return; }
  if (view.id && !snapshot.providers.some((p) => p.id === view.id)) view.id = null;
  if (view.id && view.group === 'provider') view.group = 'model';

  $('#tabs').innerHTML = `<button data-v="" aria-pressed="${!view.id}">${t('All')}</button>` +
    snapshot.providers.map((p) => `<button data-v="${p.id}" aria-pressed="${view.id === p.id}">${icon(p.id, 14)}${esc(short(p.name))}</button>`).join('');
  for (const [sel, val] of [['#metric', view.metric], ['#range', String(view.days)]]) {
    document.querySelectorAll(`${sel} button`).forEach((b) => b.setAttribute('aria-pressed', b.dataset.v === val));
  }

  const c = compute();
  const period = view.days === 1 ? t('today') : t('last {n} days', { n: view.days });
  const notices = [];
  const errs = c.scope.filter((p) => p.usageError).map((p) => `${short(p.name)}: ${p.usageError}`);
  if (errs.length) notices.push(t('Could not read usage — {errors}.', { errors: esc(errs.join('; ')) }));
  if (view.metric === 'cost' && c.unpriced.length) notices.push(t('Partial cost · no list price for {models}. Adjust it in pricing.json (widget menu › Open data folder).', { models: esc(c.unpriced.join(', ')) }));

  const tot = c.total;
  root.innerHTML = `
    ${notices.length ? `<div class="notice">${notices.join('<br>')}</div>` : ''}
    ${limitsSection(c.scope)}
    <section class="hero">
      <div>
        <div class="big">${fmt(metric(tot))}</div>
        <div class="sub">${view.metric === 'cost' ? t('estimate at API prices · USD') : t('tokens (cache re-reads excluded)')} · ${t('{n} sessions', { n: int(c.sessions) })} · ${period}</div>
        ${rankSection(c)}
      </div>
      <div>
        <div class="chart-head"><h2>${view.metric === 'cost' ? t('Cost per day') : t('Tokens per day')}</h2><div class="legend" id="legend"></div></div>
        <div id="chart"></div>
      </div>
    </section>
    <section><h2>${t('Totals')}</h2><div class="totals">
      <div><span>${t('Tokens without cache reads')}</span><b>${tokens(work(tot))}</b></div>
      <div><span>${t('Processed including cache')}</span><b>${tokens(work(tot) + tot.cacheRead)}</b></div>
      <div><span>${t('Cache read')}</span><b>${tokens(tot.cacheRead)}</b></div>
      <div><span>${t('Uncached input')}</span><b>${tokens(tot.input)}</b></div>
      <div><span>${t('Cache written')}</span><b>${tokens(tot.cacheWrite)}</b></div>
      <div><span>${t('Output')}</span><b>${tokens(tot.output)}</b></div>
      <div><span>${t('Requests')}</span><b>${int(tot.requests)}</b></div>
      <div><span>${t('Estimated cost')}</span><b>${tot.hasCost ? money(tot.cost) : '—'}</b></div>
    </div></section>
    ${table(c)}
    <footer>${t("Limits come from the accounts signed in to the CLIs on this machine; usage comes from each CLI's local logs (up to {days} days). Updated {ago}.", { days: snapshot.historyDays, ago: ago(snapshot.generatedAt) })}</footer>`;
  chart(c);
}

// -------------------------------------------------------------------- events
function seg(sel, apply) {
  document.addEventListener('click', (e) => {
    const b = e.target.closest(`${sel} button`);
    if (b) { apply(b.dataset.v); render(); }
  });
}
seg('#tabs', (v) => { view.id = v || null; });
seg('#metric', (v) => { view.metric = v; });
seg('#range', (v) => { view.days = Number(v); });
seg('#group', (v) => { view.group = v; });
$('#refresh').addEventListener('click', () => window.tracker.refresh());
document.addEventListener('click', (e) => {
  const b = e.target.closest('[data-connect]');
  if (!b) return;
  window.tracker.connect(b.dataset.connect);
  b.textContent = t('Finish signing in in the terminal…');
  b.disabled = true;
});
window.addEventListener('resize', () => { if (snapshot) chart(compute()); });
document.addEventListener('themechange', () => render());

window.tracker.onReport((msg) => { view.id = msg.id || null; if (msg.snapshot) snapshot = msg.snapshot; render(); });
window.tracker.onSnapshot((snap) => { snapshot = snap; render(); });
window.tracker.getSnapshot().then((snap) => { if (snap && !snapshot) { snapshot = snap; render(); } });
render();
