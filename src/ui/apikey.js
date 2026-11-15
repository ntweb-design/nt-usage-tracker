const { t, icon, esc } = window.UT;
const $ = (s) => document.querySelector(s);

$('#title').innerHTML = `${icon('claude-api', 18)}${esc('Claude API')}`;

function setStatus(text, bad = false) {
  $('#status').textContent = text;
  $('#status').classList.toggle('bad', bad);
}

// Opened outside the app (e.g. as a plain file) there is nothing to save to.
if (!window.tracker?.apiKeySave) {
  setStatus(t('Open this window from the widget: right-click › Connect account › Claude API.'), true);
  $('#save').disabled = true;
}

window.tracker?.apiKeyState().then((s) => {
  if (s.hasKey) {
    $('#key').placeholder = t('Saved key ({hint}) — leave empty to keep it', { hint: s.hint });
    $('#remove').hidden = false;
  } else {
    $('#key').placeholder = t('sk-ant-admin… or sk-ant-usr…');
  }
  if (s.budget) $('#budget').value = s.budget;
  if (!s.canEncrypt) setStatus(t('System encryption is not available, so the key cannot be saved.'), true);
  $('#key').focus();
});

async function save(remove = false) {
  const key = $('#key').value.trim();
  const budget = Number($('#budget').value) || null;
  if (!window.tracker?.apiKeySave) return;
  setStatus(t('Checking the key with Anthropic…'));
  try {
    const res = await window.tracker.apiKeySave({ key: remove ? null : key || undefined, remove, budget });
    if (!res?.ok) setStatus(res?.message || t('Could not save.'), true);
  } catch (err) {
    setStatus(t('Could not save: {error}', { error: err.message || err }), true);
  }
}

$('#save').addEventListener('click', () => save(false));
$('#remove').addEventListener('click', () => save(true));
$('#cancel').addEventListener('click', () => window.close());
document.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') save(false);
  if (e.key === 'Escape') window.close();
});
