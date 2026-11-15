const $ = (id) => document.getElementById(id);
const act = (type, value) => window.tracker.trayAction({ type, value });

function show(s) {
  $('version').textContent = 'v' + s.version;
  $('toggle').textContent = window.UT.t(s.hidden ? 'Show widget' : 'Hide widget');
  $('lang-value').textContent = s.lang === 'pt' ? 'Português' : 'English';
  // The slider is transparency (0 = solid); the app stores opacity.
  const transparency = Math.round((1 - s.opacity) * 100);
  $('opacity').value = transparency;
  $('opacity-value').textContent = transparency + '%';
  $('theme').setAttribute('aria-checked', String(s.theme === 'light'));
}

window.tracker.onTrayState(show);
window.tracker.trayState().then(show);

$('report').onclick = () => act('report');
$('toggle').onclick = () => act('toggle');
$('theme').onclick = () => act('theme', $('theme').getAttribute('aria-checked') === 'true' ? 'dark' : 'light');
$('about').onclick = () => act('about');
$('quit').onclick = () => act('quit');
$('lang').onclick = () => act('lang', $('lang-value').textContent === 'English' ? 'pt' : 'en');
$('opacity').oninput = (e) => {
  $('opacity-value').textContent = e.target.value + '%';
  act('opacity', 1 - Number(e.target.value) / 100);
};
window.addEventListener('keydown', (e) => { if (e.key === 'Escape') act('close'); });

// Tell the main process how tall the menu is so the window fits it exactly.
const r = $('menu').getBoundingClientRect();
window.tracker.traySize({ width: r.width, height: r.height });
