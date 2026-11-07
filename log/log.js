/**
 * log.js — the application log page: filter, status, one-click follow-up,
 * a detail dialog with notes (click a row), remove (with undo), clear all
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
let detailId = null;         // entry shown in the detail dialog
let notesTimer = null;

const followUpDays = () => (config && config.thresholds && config.thresholds.followUpDays) ?? 10;

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

// Status column: the status word, or a "Follow up" nudge with a one-click "Done".
function statusCell(e) {
  const td = cell('', 'status');
  if (LogStore.followUpDue(e, followUpDays())) {
    const days = LogStore.daysSince(e.lastFollowUp || e.date);
    const due = document.createElement('span');
    due.className = 'due';
    due.textContent = 'Follow up';
    due.title = `No reply for ${days} days since you ${e.lastFollowUp ? 'last followed up' : 'applied'}.`;
    const done = document.createElement('button');
    done.className = 'link done';
    done.textContent = 'Done';
    done.setAttribute('aria-label', `Mark ${e.title || 'application'} as followed up today`);
    done.addEventListener('click', () => LogStore.updateEntry(e.id, { lastFollowUp: LogStore.today() }));
    td.append(due, ' ', done);
  } else {
    const status = LogStore.statusOf(e);
    const span = document.createElement('span');
    span.className = 'st ' + status.toLowerCase();
    span.textContent = status;
    td.append(span);
  }
  return td;
}

function render() {
  const q = $('filter').value.trim().toLowerCase();
  const text = (e) => [e.company, e.title, e.jobId, e.resume, LogStore.statusOf(e), e.notes].join(' ').toLowerCase();
  const shown = q ? log.filter((e) => text(e).includes(q)) : log;

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
    tr.tabIndex = 0;
    tr.title = 'Open status and notes';
    if (LogStore.statusOf(e) === 'Rejected') tr.className = 'closed';
    // Clicking a row (but not its links or buttons) opens the detail dialog.
    tr.addEventListener('click', (ev) => { if (!ev.target.closest('a, button')) openDetail(e.id); });
    tr.addEventListener('keydown', (ev) => { if (ev.key === 'Enter' && ev.target === tr) openDetail(e.id); });

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
      statusCell(e),
      cell(remove, 'actions')
    );
    rows.append(tr);
  }
}

async function load() {
  log = await LogStore.getLog();
  render();
  if (detailId) renderDetail(false);
}

// --- Detail dialog ------------------------------------------------------------

function openDetail(id) {
  detailId = id;
  renderDetail(true);
  $('detail').showModal();
}

// fillNotes is false on refreshes, so a save never overwrites what you're typing.
function renderDetail(fillNotes) {
  const e = log.find((x) => x.id === detailId);
  if (!e) { $('detail').close(); return; }

  $('d-title').textContent = e.title || 'Untitled role';
  $('d-sub').textContent = [e.company, e.jobId && 'ID ' + e.jobId, 'Applied ' + prettyDate(e.date)].filter(Boolean).join(' · ');

  const status = LogStore.statusOf(e);
  const group = $('d-status');
  group.replaceChildren(...LogStore.STATUSES.map((s) => {
    const b = document.createElement('button');
    b.textContent = s;
    b.className = 'seg ' + s.toLowerCase();
    b.setAttribute('role', 'radio');
    b.setAttribute('aria-checked', String(s === status));
    b.addEventListener('click', () => LogStore.updateEntry(e.id, { status: s }));
    return b;
  }));

  const today = LogStore.today();
  const days = LogStore.daysSince(e.date);
  $('d-follow-text').textContent = e.lastFollowUp
    ? `Last followed up ${e.lastFollowUp === today ? 'today' : prettyDate(e.lastFollowUp)}.`
    : `No follow-up yet. Applied ${days === 0 ? 'today' : days === 1 ? '1 day ago' : days + ' days ago'}.`;
  $('d-follow').hidden = e.lastFollowUp === today;

  if (fillNotes) { $('d-notes').value = e.notes || ''; $('d-saved').textContent = ''; }

  const links = $('d-links');
  links.replaceChildren();
  if (e.url) links.append(link(e.url, 'Open posting'));
  const file = fileOf(e);
  if (file) checkFile(file).then((ok) => { if (ok) links.append(link(chrome.runtime.getURL('resumes/' + file), /^Tailored\b/.test(e.resume || '') ? 'Base resume PDF' : 'Resume PDF')); });
}

// Notes save shortly after you stop typing, and right away when the dialog closes.
function saveNotes() {
  clearTimeout(notesTimer);
  notesTimer = null;
  const e = log.find((x) => x.id === detailId);
  const notes = $('d-notes').value;
  if (!e || (e.notes || '') === notes) return;
  LogStore.updateEntry(e.id, { notes }).then(() => { $('d-saved').textContent = 'Saved'; });
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
$('d-close').addEventListener('click', () => $('detail').close());
$('d-follow').addEventListener('click', () => LogStore.updateEntry(detailId, { lastFollowUp: LogStore.today() }));
$('d-notes').addEventListener('input', () => {
  $('d-saved').textContent = '';
  clearTimeout(notesTimer);
  notesTimer = setTimeout(saveNotes, 500);
});
// Clicking the dimmed backdrop closes the dialog, like Esc.
$('detail').addEventListener('click', (ev) => { if (ev.target === $('detail')) $('detail').close(); });
$('detail').addEventListener('close', () => { saveNotes(); detailId = null; });
// "/" jumps to the filter, like most list pages.
document.addEventListener('keydown', (ev) => {
  if (ev.key === '/' && !$('detail').open && document.activeElement !== $('filter')) {
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
