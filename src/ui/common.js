/* Shared by dock, tooltip and report. */
(() => {
  // Language comes in the page URL, like the theme; i18n.js is loaded just before this file.
  const I18N = window.I18N;
  I18N.setLang(new URLSearchParams(location.search).get('lang'));
  const t = I18N.t;
  document.documentElement.lang = I18N.getLang() === 'pt' ? 'pt-BR' : 'en';
  /** Static page text marked in the HTML: data-t (content), data-tp (placeholder), and the title. */
  function translatePage() {
    document.title = t(document.title);
    document.querySelectorAll('[data-t]').forEach((el) => { el.innerHTML = t(el.innerHTML.replace(/\s+/g, ' ').trim()); });
    document.querySelectorAll('[data-tp]').forEach((el) => { el.placeholder = t(el.placeholder); });
  }
  translatePage();

  // Simple original glyphs, one per provider (not the vendors' logos).
  const ICONS = {
    claude: '<g stroke="#e8825d" stroke-width="2.2" stroke-linecap="round"><path d="M12 3v18M3 12h18M5.6 5.6l12.8 12.8M18.4 5.6 5.6 18.4M8.5 3.7l7 16.6M3.7 15.5l16.6-7"/></g>',
    codex: '<g fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2.8 20 7.4v9.2l-8 4.6-8-4.6V7.4z"/><path d="m9 10 2.5 2L9 14M13 14.4h2.6"/></g>',
    grok: '<g fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><circle cx="12" cy="12" r="7.2"/><path d="M5 19 19 5"/></g>',
    opencode: '<g fill="none" stroke="currentColor" stroke-width="2.4"><rect x="5" y="3.5" width="14" height="17" rx="1"/><rect x="9.2" y="8" width="5.6" height="8" fill="currentColor" stroke="none"/></g>',
    // Claude API: a key.
    'claude-api': '<g fill="none" stroke="#a48cf0" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><circle cx="8" cy="12" r="4.2"/><path d="M12.2 12H21M17.5 12v3.4M20.5 12v2.4"/></g>',
    antigravity: '<path fill="#a99cff" d="M12 2c.9 5.6 4.4 9.1 10 10-5.6.9-9.1 4.4-10 10-.9-5.6-4.4-9.1-10-10 5.6-.9 9.1-4.4 10-10z"/>',
    cpu: '<g fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><rect x="6" y="6" width="12" height="12" rx="1.5"/><rect x="10" y="10" width="4" height="4" fill="currentColor" stroke="none"/><path d="M9.5 2.5V6M14.5 2.5V6M9.5 18v3.5M14.5 18v3.5M2.5 9.5H6M2.5 14.5H6M18 9.5h3.5M18 14.5h3.5"/></g>',
    mem: '<g fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 7h18v9H3z"/><path d="M7 10.5v2.5M12 10.5v2.5M17 10.5v2.5M6 16v3M10 16v3M14 16v3M18 16v3"/></g>',
    gpu: '<g fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M2.5 5v15M2.5 7h18v9h-18"/><circle cx="14.5" cy="11.5" r="2.4"/><path d="M7 11.5h2"/></g>',
    disk: '<g fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><ellipse cx="12" cy="6" rx="7.5" ry="2.8"/><path d="M4.5 6v12c0 1.5 3.4 2.8 7.5 2.8s7.5-1.3 7.5-2.8V6"/><path d="M4.5 12c0 1.5 3.4 2.8 7.5 2.8s7.5-1.3 7.5-2.8"/></g>',
  };
  const icon = (id, size = 16) => `<svg class="icon" width="${size}" height="${size}" viewBox="0 0 24 24" aria-hidden="true">${ICONS[id] || ''}</svg>`;

  // Chart series colours: fixed per provider, validated as a set for the dark surface.
  // Same hues, stepped separately for each surface.
  const PALETTES = {
    dark: { codex: '#3987e5', claude: '#d95926', 'claude-api': '#8b6ee0', grok: '#199e70', opencode: '#c98500', antigravity: '#d55181' },
    light: { codex: '#2a78d6', claude: '#eb6834', 'claude-api': '#7a5cd6', grok: '#1baf7a', opencode: '#eda100', antigravity: '#e87ba4' },
  };
  const SERIES = { ...PALETTES.dark };

  // Theme comes in the page URL (so there is no flash) and then live from the tray menu.
  function setTheme(theme) {
    const t = theme === 'light' ? 'light' : 'dark';
    document.documentElement.dataset.theme = t;
    Object.assign(SERIES, PALETTES[t]);
    document.dispatchEvent(new Event('themechange'));
  }
  setTheme(new URLSearchParams(location.search).get('theme'));
  window.tracker?.onTheme?.(setTheme);

  const STACK_ORDER = ['codex', 'claude', 'claude-api', 'grok', 'opencode', 'antigravity'];

  const STATUS = { good: '#2fc26b', warn: '#fab219', bad: '#e5484d' };
  const leftColor = (left) => (left <= 10 ? STATUS.bad : left <= 30 ? STATUS.warn : STATUS.good);

  const pick = (p, role) => p.limits?.windows?.find((w) => w.role === role) || null;
  const left = (w) => Math.max(0, Math.min(100, 100 - (w.usedPct || 0)));

  function tokens(n) {
    if (n == null) return '—';
    const a = Math.abs(n);
    const f = (v, digits, unit) => Number(v.toFixed(digits)).toLocaleString(I18N.locale(), { maximumFractionDigits: digits }) + unit;
    if (a >= 1e9) return f(n / 1e9, a >= 1e10 ? 1 : 2, 'B');
    if (a >= 1e6) return f(n / 1e6, a >= 1e8 ? 0 : a >= 1e7 ? 1 : 2, 'M');
    if (a >= 1e3) return f(n / 1e3, a >= 1e5 ? 0 : 1, 'K');
    return String(Math.round(n));
  }
  const money = (n) => (n == null ? '—' : '$' + n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }));
  const int = (n) => Math.round(n).toLocaleString(I18N.locale());

  function timeLeft(ts) {
    if (!ts) return '';
    let m = Math.round((ts - Date.now()) / 60000);
    if (m <= 0) return t('now');
    const d = Math.floor(m / 1440); m -= d * 1440;
    const h = Math.floor(m / 60); m -= h * 60;
    if (d) return `${d}d ${h}h`;
    if (h) return `${h}h ${m}m`;
    return `${m}m`;
  }

  function ago(ts) {
    const m = Math.round((Date.now() - ts) / 60000);
    if (m < 1) return t('now');
    if (m < 60) return t('{n} min ago', { n: m });
    if (m < 1440) return t('{n} h ago', { n: Math.floor(m / 60) });
    return t('{n} d ago', { n: Math.floor(m / 1440) });
  }

  const dayKey = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  /** Last `n` local days, oldest first. */
  function lastDays(n) {
    const out = [];
    const d = new Date();
    d.setHours(12, 0, 0, 0);
    for (let i = n - 1; i >= 0; i--) out.push(dayKey(new Date(d.getTime() - i * 86400000)));
    return out;
  }

  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  /** One limit row: label, bar of what is left, percentage, time to reset. */
  function limitRow(w) {
    const l = left(w);
    return `<div class="limit">
      <span class="limit-label">${esc(w.label)}</span>
      <span class="bar"><span class="bar-fill" style="width:${l}%;background:${leftColor(l)}"></span></span>
      <span class="limit-pct">${t('{n}% free', { n: Math.round(l) })}</span>
      <span class="limit-reset">${timeLeft(w.resetsAt)}</span>
    </div>`;
  }

  // PC resources are shown as load (how much is in use), so high is the warning side.
  const loadColor = (pct) => (pct >= 90 ? STATUS.bad : pct >= 75 ? STATUS.warn : STATUS.good);
  const gb = (bytes) => I18N.num(bytes / 2 ** 30, 1);

  /** One resource row: label, bar of what is in use, percentage, detail. */
  function loadRow(label, pct, detail = '') {
    const p = Math.max(0, Math.min(100, pct));
    return `<div class="limit">
      <span class="limit-label">${esc(label)}</span>
      <span class="bar"><span class="bar-fill" style="width:${p}%;background:${loadColor(p)}"></span></span>
      <span class="limit-pct">${Math.round(p)}%</span>
      <span class="limit-reset">${esc(detail)}</span>
    </div>`;
  }

  /** The three PC resources in ring form: outer/inner load percentages (null = no reading). */
  function sysItems(d) {
    if (!d) return [];
    return [
      { id: 'cpu', outer: d.cpu.pct, inner: d.cpu.maxCore },
      { id: 'mem', outer: d.mem.pct, inner: d.mem.commitPct },
      { id: 'gpu', outer: d.gpu?.pct ?? null, inner: d.gpu?.memPct ?? null },
    ];
  }

  /** A VPS in ring form. CPU: total / busiest core. Memory: RAM / swap. Disk: / used / I/O busy. */
  function vpsItems(d) {
    if (!d) return [];
    return [
      { id: 'cpu', outer: d.cpu?.pct ?? null, inner: d.cpu?.maxCore ?? null },
      { id: 'mem', outer: d.mem?.pct ?? null, inner: d.mem?.swapPct ?? null },
      { id: 'disk', outer: d.disk?.pct ?? null, inner: d.ioPct ?? null },
    ];
  }

  /** Bytes per second, short. */
  function rate(bps) {
    if (bps == null) return '—';
    const u = [['GB/s', 2 ** 30], ['MB/s', 2 ** 20], ['KB/s', 2 ** 10]].find(([, f]) => bps >= f);
    return u ? I18N.num(bps / u[1], bps / u[1] >= 100 ? 0 : 1) + ' ' + u[0] : Math.round(bps) + ' B/s';
  }

  function duration(secs) {
    if (!secs) return '—';
    const d = Math.floor(secs / 86400), h = Math.floor((secs % 86400) / 3600), m = Math.floor((secs % 3600) / 60);
    return d ? `${d}d ${h}h` : h ? `${h}h ${m}m` : `${m}m`;
  }

  window.UT = { t, num: I18N.num, locale: I18N.locale, vpsItems, rate, duration, loadColor, gb, loadRow, sysItems, icon,SERIES, STACK_ORDER, STATUS, leftColor, pick, left, tokens, money, int, timeLeft, ago, dayKey, lastDays, esc, limitRow };
})();
