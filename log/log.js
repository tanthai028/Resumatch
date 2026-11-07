/**
 * log.js — the application log page: filter, remove (with undo), clear all
 * (two-step, with undo) and CSV export.
 */
'use strict';

const $ = (id) => document.getElementById(id);

let config = null;
let log = [];
let undoSnapshot = null;     // log as it was before the last remove / clear
let undoTimer = null;
let confirmClear = false;    // second click on "Clear all"
const fileExists = new Map(); // resume filename -> Promise<boolean>

// Old entries (before match levels) only have a score; derive the level.
function matchOf(e) {
  if (e.match) return e.match;
  return typeof e.score === 'number' && config ? ResumeScoring.matchLevel(e.score, config) : '';
}

// Old entries don't store the file; look it up from the resume name.
function fileOf(e) {
  if (e.resumeFile) return e.resumeFile;
  const r = config && config.resumes.find((x) => e.resume === x.name || e.resume === 'Tailored (based on ' + x.name + ')');
  return r ? r.filename : '';
}

// Resume PDFs are packaged with the extension in resumes/. Check once per
// file so a missing PDF shows a hint instead of a broken link.
function checkFile(name) {
  if (!fileExists.has(name)) {
    fileExists.set(name, fetch(chrome.runtime.getURL('resumes/' + name)).then((r) => r.ok, () => false));
  }
  return fileExists.get(name);
}

// "2026-11-06" -> "Nov 6, 2026" (ISO stays in the CSV).
function prettyDate(iso) {
  const d = new Date(iso + 'T00:00:00');
  return isNaN(d) ? iso || '' : d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
}

function cell(content, className) {
  const td = document.createElement('td');
  if (className) td.className = className;
  if (content instanceof Node) td.append(content);
  else td.textContent = content === undefined || content === null ? '' : String(content);
  return td;
}

function link(href, text) {
  const a = document.createElement('a');
  a.href = href;
  a.target = '_blank';
  a.rel = 'noopener';
  a.textContent = text;
  return a;
}

function resumeCell(e) {
  const td = cell('');
  const file = fileOf(e);
  td.textContent = e.resume || '';
  if (!file) return td;
  checkFile(file).then((ok) => {
    td.replaceChildren();
    if (ok) {
      // A tailored resume was edited after download, so the stored PDF is
      // only its starting point; say so instead of implying it's what was sent.
      const tailored = /^Tailored\b/.test(e.resume || '');
      const a = link(chrome.runtime.getURL('resumes/' + file), tailored ? 'Base PDF' : 'PDF');
      a.className = 'pdf';
      a.title = tailored ? `${file} (the base resume, not the tailored version you sent)` : file;
      td.append(e.resume || '', ' ', a);
    } else {
      td.append(e.resume || '');
      // "Link PDF" expands one-line instructions in place.
      const how = document.createElement('button');
      how.className = 'link hint';
      how.textContent = 'Link PDF';
      const steps = document.createElement('div');
      steps.className = 'hint';
      steps.hidden = true;
      steps.textContent = `Copy ${file} into the extension's resumes folder, then click reload on Resume Matcher in chrome://extensions.`;
      how.addEventListener('click', () => { steps.hidden = !steps.hidden; });
      const line = document.createElement('div');
      line.append(how);
      td.append(line, steps);
    }
  });
  return td;
}

function render() {
  const q = $('filter').value.trim().toLowerCase();
  const shown = q ? log.filter((e) => [e.company, e.title, e.jobId, e.resume].join(' ').toLowerCase().includes(q)) : log;

  $('count').textContent = log.length === 1 ? '1 application' : `${log.length} applications`;
  $('empty').hidden = log.length > 0;
  $('no-match').hidden = !(log.length && !shown.length);
  $('table').hidden = !shown.length;
  $('export').disabled = !log.length;
  $('clear').disabled = !log.length;

  const rows = $('rows');
  rows.replaceChildren();
  for (const e of shown) {
    const tr = document.createElement('tr');

    const match = matchOf(e);
    const badge = document.createElement('span');
    badge.className = 'match ' + match.toLowerCase();
    badge.textContent = match;

    const remove = document.createElement('button');
    remove.className = 'link remove';
    remove.textContent = 'Remove';
    remove.setAttribute('aria-label', `Remove ${e.title || 'application'} at ${e.company || 'unknown company'}`);
    remove.addEventListener('click', () => removeEntry(e));

    tr.append(
      cell(prettyDate(e.date), 'date'),
      cell(e.company),
      cell(e.url ? link(e.url, e.title || e.url) : e.title),
      cell(e.jobId, 'num'),
      resumeCell(e),
      cell(match ? badge : ''),
      cell(remove, 'actions')
    );
    rows.append(tr);
  }
}

async function load() {
  log = await LogStore.getLog();
  render();
}

// --- Undo -------------------------------------------------------------------

function offerUndo(message) {
  $('undo-msg').textContent = message;
  $('undo-bar').hidden = false;
  clearTimeout(undoTimer);
  undoTimer = setTimeout(() => { $('undo-bar').hidden = true; undoSnapshot = null; }, 10000);
}

async function undo() {
  if (!undoSnapshot) return;
  await LogStore.saveLog(undoSnapshot);
  undoSnapshot = null;
  $('undo-bar').hidden = true;
  await load();
}

async function removeEntry(e) {
  undoSnapshot = log.slice();
  await LogStore.deleteEntry(e.id);
  await load();
  offerUndo(`Removed ${e.title || 'application'}${e.company ? ' at ' + e.company : ''}.`);
}

async function clearAll() {
  if (!confirmClear) {
    confirmClear = true;
    $('clear').textContent = `Delete all ${log.length}?`;
    setTimeout(() => { confirmClear = false; $('clear').textContent = 'Clear all'; }, 4000);
    return;
  }
  confirmClear = false;
  $('clear').textContent = 'Clear all';
  undoSnapshot = log.slice();
  await LogStore.saveLog([]);
  await load();
  offerUndo(`Cleared ${undoSnapshot.length} applications.`);
}

// --- Export -----------------------------------------------------------------

function exportCSV() {
  const rows = log.map((e) => Object.assign({}, e, { match: matchOf(e), resumeFile: fileOf(e) }));
  const blob = new Blob([LogStore.toCSV(rows)], { type: 'text/csv' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `applications-${new Date().toISOString().slice(0, 10)}.csv`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

// --- Startup ----------------------------------------------------------------

$('filter').addEventListener('input', render);
$('export').addEventListener('click', exportCSV);
$('clear').addEventListener('click', clearAll);
$('undo').addEventListener('click', undo);
// "/" jumps to the filter, like most list pages.
document.addEventListener('keydown', (ev) => {
  if (ev.key === '/' && document.activeElement !== $('filter')) {
    ev.preventDefault();
    $('filter').focus();
  }
});

// Refresh if the popup logs something while this page is open.
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes.applications) load();
});

fetch(chrome.runtime.getURL('config.json'))
  .then((r) => r.json())
  .then((c) => { config = c; }, () => {})
  .then(load);
