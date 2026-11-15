const $ = (s) => document.querySelector(s);
const { t } = window.UT;
const editId = new URLSearchParams(location.search).get('id');

let draftId = null;
let keyFile = null; // chosen or generated private key file
let busy = false;

function setStatus(text, kind = '') {
  $('#status').textContent = text;
  $('#status').className = kind;
}

function showMode() {
  const mode = $('#keyMode').value;
  document.querySelectorAll('.keypart').forEach((el) => { el.hidden = el.dataset.mode !== mode; });
  if (mode === 'default') showPub(null);
}

function showPub(pub) {
  $('#pubBox').hidden = !pub;
  $('#pub').value = pub || '';
}

const shortPath = (p) => (p ? p.replace(/^.*[\\/]/, '') : t('none'));

function form() {
  return {
    name: $('#name').value,
    host: $('#host').value,
    user: $('#user').value,
    port: $('#port').value,
    keyMode: $('#keyMode').value,
    keyFile,
    keyText: $('#keyMode').value === 'paste' ? $('#keyText').value : '',
  };
}

async function run(label, fn) {
  if (busy) return;
  busy = true;
  document.querySelectorAll('button').forEach((b) => { b.disabled = true; });
  setStatus(label);
  try { await fn(); } catch (err) { setStatus(String(err.message || err), 'bad'); }
  busy = false;
  document.querySelectorAll('button').forEach((b) => { b.disabled = false; });
}

window.tracker.vpsGet(editId).then(({ vps, draftId: id, hosts, pub }) => {
  draftId = id;
  $('#hosts').innerHTML = hosts.map((h) => `<option value="${window.UT.esc(h)}">`).join('');
  if (vps) {
    $('#title').textContent = t('Edit VPS · {name}', { name: vps.name });
    $('#name').value = vps.name || '';
    $('#host').value = vps.host || '';
    $('#user').value = vps.user || '';
    $('#port').value = vps.port || '';
    $('#keyMode').value = vps.keyMode || (vps.keyFile ? 'file' : 'default');
    keyFile = vps.keyFile || null;
    $('#fileName').textContent = shortPath(keyFile);
    if ($('#keyMode').value === 'generated' && keyFile) $('#genName').textContent = shortPath(keyFile);
    if ($('#keyMode').value === 'paste' && keyFile) $('#keyText').placeholder = t('Key already saved. Paste another only to replace it.');
    showMode();
    showPub(vps.keyMode === 'default' ? null : pub);
  } else {
    showMode();
  }
  $('#host').focus();
});

$('#keyMode').addEventListener('change', () => {
  if (!editId) keyFile = null;
  $('#fileName').textContent = shortPath(keyFile);
  showMode();
});

$('#pick').addEventListener('click', () => run(t('Opening…'), async () => {
  const r = await window.tracker.vpsPickKey();
  if (!r) return setStatus('');
  if (r.error) return setStatus(r.error, 'bad');
  keyFile = r.keyFile;
  $('#fileName').textContent = shortPath(keyFile);
  showPub(r.pub);
  setStatus(r.pub ? t('Key chosen. If the VPS does not know it yet, use the command below.') : t('Key chosen.'));
}));

$('#gen').addEventListener('click', () => run(t('Generating the key…'), async () => {
  const r = await window.tracker.vpsGenKey({ draftId, host: $('#host').value });
  if (!r.ok) return setStatus(r.message, 'bad');
  keyFile = r.keyFile;
  $('#genName').textContent = shortPath(keyFile);
  showPub(r.pub);
  setStatus(t('Key generated. Put the public key on the VPS, then click Test connection.'), 'good');
}));

const authorizeCmd = (pub) => `mkdir -p ~/.ssh && chmod 700 ~/.ssh && echo '${pub}' >> ~/.ssh/authorized_keys && chmod 600 ~/.ssh/authorized_keys`;

$('#copyCmd').addEventListener('click', async () => {
  await window.tracker.copyText(authorizeCmd($('#pub').value.trim()));
  setStatus(t('Command copied.'), 'good');
});
$('#copyPub').addEventListener('click', async () => {
  await window.tracker.copyText($('#pub').value.trim());
  setStatus(t('Public key copied.'), 'good');
});

$('#test').addEventListener('click', () => run(t('Connecting… (up to 25 s)'), async () => {
  const r = await window.tracker.vpsTest({ draftId, form: form() });
  setStatus(r.message, r.ok ? 'good' : 'bad');
}));

$('#save').addEventListener('click', () => run(t('Saving…'), async () => {
  const r = await window.tracker.vpsSave({ draftId, form: form() });
  if (!r.ok) setStatus(r.message, 'bad');
}));

$('#cancel').addEventListener('click', () => window.close());
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') window.close(); });
