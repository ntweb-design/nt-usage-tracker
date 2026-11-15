const box = new URLSearchParams(location.search).get('box');
const input = document.getElementById('name');
window.tracker.nameGet(box).then(({ name, fallback }) => {
  input.value = name || '';
  if (fallback) input.placeholder = window.UT.t('empty = {name}', { name: fallback });
  input.select();
});
const save = () => window.tracker.nameSave({ box, name: input.value });
document.getElementById('save').addEventListener('click', save);
document.getElementById('cancel').addEventListener('click', () => window.close());
document.addEventListener('keydown', (e) => { if (e.key === 'Enter') save(); if (e.key === 'Escape') window.close(); });
