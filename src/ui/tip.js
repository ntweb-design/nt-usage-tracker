const { t, num, icon, esc, limitRow, loadRow, gb, tokens, ago, lastDays, rate, duration } = window.UT;
const card = document.getElementById('card');

function aiTip({ id, snapshot }) {
  const p = snapshot?.providers.find((x) => x.id === id);
  if (!p) return null;
  const lim = p.limits || {};
  const order = { short: 0, long: 1, extra: 2 };
  const windows = [...(lim.windows || [])].sort((a, b) => order[a.role] - order[b.role]);

  const today = lastDays(1)[0];
  let tok = 0;
  let req = 0;
  for (const [key, b] of Object.entries(p.usage?.buckets || {})) {
    if (!key.startsWith(today)) continue;
    tok += b.input + b.output + b.cacheWrite;
    req += b.requests;
  }

  const notes = [];
  if (lim.status === 'loading') notes.push(`<div class="note">${t('Loading…')}</div>`);
  else if (lim.message) notes.push(`<div class="note${lim.status === 'auth' || lim.status === 'error' ? ' alert' : ''}">${esc(lim.message)}</div>`);
  if (lim.asOf && windows.length) notes.push(`<div class="note">${t('Last reading {ago}.', { ago: ago(lim.asOf) })}</div>`);

  return `
    <div class="head">${icon(p.id, 16)}<b>${esc(p.name.replace(/ (CLI|Code)$/, ''))}</b><span class="plan">${esc(lim.plan || '')}</span></div>
    ${windows.map(limitRow).join('')}
    ${notes.join('')}
    <div class="today"><span>${t('Today')}</span><span><b>${tokens(tok)}</b> tokens · <b>${req}</b> req.</span></div>`;
}

function sysTip({ id, sys }) {
  if (!sys) return `<div class="head">${icon(id, 16)}<b>${t('Reading…')}</b></div>`;
  const head = (title, sub) => `<div class="head">${icon(id, 16)}<b>${title}</b><span class="plan">${esc(sub)}</span></div>`;
  const foot = (text) => `<div class="today"><span>${esc(text)}</span></div>`;
  if (id === 'cpu') {
    return head('CPU', t('{n} cores', { n: sys.cpu.cores })) +
      loadRow(t('Total use'), sys.cpu.pct) +
      loadRow(t('Busiest core'), sys.cpu.maxCore) +
      foot(sys.cpu.name);
  }
  if (id === 'mem') {
    const m = sys.mem;
    return head(t('Memory'), `${gb(m.total)} GB`) +
      loadRow(t('RAM in use'), m.pct, `${gb(m.used)} GB`) +
      (m.commitPct != null ? loadRow(t('Commit (RAM + swap)'), m.commitPct) : '') +
      foot(t('{n} GB free', { n: gb(m.total - m.used) }));
  }
  const g = sys.gpu;
  if (!g) return head('GPU', '') + `<div class="note">${sys.gpuPending ? t('Reading the GPU…') : t('No GPU with a reading available.')}</div>`;
  return head('GPU', g.memTotal ? `${gb(g.memTotal)} GB` : '') +
    loadRow(t('Load'), g.pct) +
    (g.memPct != null ? loadRow('VRAM', g.memPct, `${gb(g.memUsed)} GB`) : '') +
    foot(g.name);
}

function vpsTip({ id, name, vps: d }) {
  const title = { cpu: 'CPU', mem: t('Memory'), disk: t('Disk') }[id] || id;
  const state = !d || d.status === 'connecting' ? (d?.cpu ? 'reconnecting' : 'connecting') : d.status === 'offline' ? 'offline' : 'online';
  const head = (sub) => `<div class="head">${icon(id, 16)}<b>${esc(name || 'VPS')} · ${title}</b><span class="plan">${esc(sub)}</span></div>`;
  const notes = [];
  if (d?.status === 'offline' && d.message) notes.push(`<div class="note alert">${esc(d.message)}</div>`);
  else if (state !== 'online') notes.push(`<div class="note">${esc(t(state === 'reconnecting' ? 'Reconnecting…' : 'Connecting…'))}</div>`);
  if (d?.status !== 'online' && d?.at) notes.push(`<div class="note">${t('Last reading {ago}.', { ago: ago(d.at) })}</div>`);
  const foot = d?.host ? `<div class="today"><span>${esc(d.host)}</span><span>${esc(d.os || '')}${d.uptime ? ` · ${t('up for {time}', { time: duration(d.uptime) })}` : ''}</span></div>` : '';
  if (!d?.cpu) return head(state) + notes.join('') + foot;
  let rows = '';
  if (id === 'cpu') {
    rows = loadRow(t('Total use'), d.cpu.pct) + loadRow(t('Busiest core'), d.cpu.maxCore) +
      (d.load ? `<div class="note">${t('Load average {values} ({n} cores)', { values: d.load.map((x) => num(x, 2)).join(' · '), n: d.cpu.cores })}</div>` : '') +
      `<div class="note">${t('Network ↓ {rx} · ↑ {tx}', { rx: rate(d.net?.rx), tx: rate(d.net?.tx) })}</div>`;
  } else if (id === 'mem') {
    rows = loadRow(t('RAM in use'), d.mem.pct, t('{used} of {total} GB', { used: gb(d.mem.used), total: gb(d.mem.total) })) +
      (d.mem.swapTotal ? loadRow('Swap', d.mem.swapPct, t('{used} of {total} GB', { used: gb(d.mem.swapUsed), total: gb(d.mem.swapTotal) })) : `<div class="note">${t('No swap.')}</div>`);
  } else {
    rows = loadRow(t('Used on {mount}', { mount: d.disk.mount }), d.disk.pct, t('{used} of {total} GB', { used: gb(d.disk.used), total: gb(d.disk.total) })) +
      loadRow(t('Disk busy (I/O)'), d.ioPct ?? 0) +
      `<div class="note">${t('{n} GB free', { n: gb(d.disk.avail) })}</div>`;
  }
  return head(state) + rows + notes.join('') + foot;
}

window.tracker.onTip((msg) => {
  const html = msg.kind === 'sys' ? sysTip(msg) : msg.kind === 'vps' ? vpsTip(msg) : aiTip(msg);
  if (html == null) return;
  card.innerHTML = html;
  // Measured synchronously: a hidden window never gets an animation frame.
  const r = card.getBoundingClientRect();
  window.tracker.tipSize({ width: r.width, height: r.height });
});
