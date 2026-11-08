/**
 * settings.js — the autofill profile form. Every change saves (debounced) to
 * chrome.storage.local via ProfileStore; there is no Save button.
 */
'use strict';

const $ = (id) => document.getElementById(id);

let profile = null;
let saveTimer = null;

// --- Saving -------------------------------------------------------------------

function scheduleSave() {
  $('saved').textContent = '';
  clearTimeout(saveTimer);
  saveTimer = setTimeout(save, 400);
}

async function save() {
  clearTimeout(saveTimer);
  await ProfileStore.saveProfile(profile);
  $('saved').textContent = 'Saved';
}

// --- Simple fields (data-key="first" or "eeo.gender") ---------------------------

function getPath(obj, path) { return path.split('.').reduce((o, k) => (o ? o[k] : ''), obj); }
function setPath(obj, path, value) {
  const keys = path.split('.');
  const last = keys.pop();
  keys.reduce((o, k) => o[k], obj)[last] = value;
}

function bindSimpleFields() {
  document.querySelectorAll('[data-key]').forEach((input) => {
    input.value = getPath(profile, input.dataset.key) || '';
    if (input.dataset.bound) return; // re-render after a restore: listener already there
    input.dataset.bound = '1';
    input.addEventListener('input', () => { setPath(profile, input.dataset.key, input.value.trim()); scheduleSave(); });
  });
}

// --- Repeatable cards (jobs, schools) ------------------------------------------

function renderCards(listKey, containerId, templateId) {
  const container = $(containerId);
  container.replaceChildren();
  profile[listKey].forEach((item, i) => {
    const card = $(templateId).content.firstElementChild.cloneNode(true);
    card.querySelectorAll('[data-f]').forEach((input) => {
      const f = input.dataset.f;
      if (input.type === 'checkbox') input.checked = Boolean(item[f]);
      else input.value = item[f] || '';
      input.addEventListener('input', () => {
        item[f] = input.type === 'checkbox' ? input.checked : input.value.trim();
        if (f === 'current') syncCurrent(card, item);
        scheduleSave();
      });
    });
    syncCurrent(card, item);
    card.querySelector('.remove-card').addEventListener('click', () => {
      profile[listKey].splice(i, 1);
      renderCards(listKey, containerId, templateId);
      save();
    });
    card.querySelector('.up').addEventListener('click', () => {
      [profile[listKey][i - 1], profile[listKey][i]] = [profile[listKey][i], profile[listKey][i - 1]];
      renderCards(listKey, containerId, templateId);
      save();
    });
    container.append(card);
  });
  $(containerId + '-empty').hidden = profile[listKey].length > 0;
}

// "I currently work here" disables the end date.
function syncCurrent(card, item) {
  const end = card.querySelector('[data-f="end"]');
  const current = card.querySelector('[data-f="current"]');
  if (end && current) end.disabled = Boolean(item.current);
}

function addCard(listKey, containerId, templateId, blank) {
  profile[listKey].push(blank);
  renderCards(listKey, containerId, templateId);
  const cards = $(containerId).children;
  cards[cards.length - 1].querySelector('input').focus();
  save();
}

// --- Other answers (question words -> answer) -----------------------------------

function renderAnswers() {
  const list = $('answers');
  list.replaceChildren();
  profile.answers.forEach((row, i) => {
    const wrap = document.createElement('div');
    wrap.className = 'answer';
    const q = Object.assign(document.createElement('input'), { value: row.q, placeholder: 'Question contains…' });
    const a = Object.assign(document.createElement('input'), { value: row.a, placeholder: 'Answer' });
    q.setAttribute('aria-label', 'Question contains');
    a.setAttribute('aria-label', 'Answer');
    q.addEventListener('input', () => { row.q = q.value.trim(); scheduleSave(); });
    a.addEventListener('input', () => { row.a = a.value.trim(); scheduleSave(); });
    const remove = Object.assign(document.createElement('button'), { className: 'link danger remove-answer', textContent: 'Remove' });
    remove.addEventListener('click', () => { profile.answers.splice(i, 1); renderAnswers(); save(); });
    wrap.append(q, a, remove);
    list.append(wrap);
  });
}

// --- Backup ------------------------------------------------------------------------

function exportProfile() {
  const blob = new Blob([JSON.stringify(profile, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'resume-matcher-profile.json';
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

async function importProfile(file) {
  try {
    profile = ProfileStore.withDefaults(JSON.parse(await file.text()));
    await save();
    renderAll();
  } catch (e) {
    $('saved').textContent = "That file isn't a profile backup.";
  }
}

// --- Startup -------------------------------------------------------------------------

function renderAll() {
  bindSimpleFields();
  renderCards('jobs', 'jobs', 'job-tpl');
  renderCards('schools', 'schools', 'school-tpl');
  renderAnswers();
}

async function init() {
  profile = await ProfileStore.getProfile();
  renderAll();
  $('add-job').addEventListener('click', () => addCard('jobs', 'jobs', 'job-tpl', { title: '', company: '', location: '', start: '', end: '', current: false, description: '' }));
  $('add-school').addEventListener('click', () => addCard('schools', 'schools', 'school-tpl', { school: '', degree: '', field: '', start: '', end: '', gpa: '' }));
  $('add-answer').addEventListener('click', () => { profile.answers.push({ q: '', a: '' }); renderAnswers(); $('answers').lastElementChild.querySelector('input').focus(); });
  $('export').addEventListener('click', exportProfile);
  $('import').addEventListener('click', () => $('import-file').click());
  $('import-file').addEventListener('change', (e) => { if (e.target.files[0]) importProfile(e.target.files[0]); e.target.value = ''; });
  // Flush a pending save if the tab closes mid-typing.
  window.addEventListener('beforeunload', () => { if (saveTimer) ProfileStore.saveProfile(profile); });
}

init();
