/**
 * log.js — shows the application log, with filter, delete, clear and CSV export.
 */
'use strict';

const $ = (id) => document.getElementById(id);
let log = [];

function cell(text) {
  const td = document.createElement('td');
  td.textContent = text === undefined || text === null ? '' : String(text);
  return td;
}

function render() {
  const q = $('filter').value.trim().toLowerCase();
  const shown = q ? log.filter((e) => [e.company, e.title, e.resume, e.verdict].join(' ').toLowerCase().includes(q)) : log;

  $('count').textContent = `${log.length} logged` + (q ? `, ${shown.length} shown` : '');
  $('empty').hidden = log.length > 0;

  const rows = $('rows');
  rows.replaceChildren();
  for (const e of shown) {
    const tr = document.createElement('tr');

    // Title links to the posting.
    const titleCell = document.createElement('td');
    if (e.url) {
      const a = document.createElement('a');
      a.href = e.url;
      a.target = '_blank';
      a.rel = 'noopener';
      a.textContent = e.title || e.url;
      titleCell.append(a);
    } else {
      titleCell.textContent = e.title || '';
    }

    const scoreCell = cell(e.score);
    scoreCell.className = 'num';

    const delCell = document.createElement('td');
    const del = document.createElement('button');
    del.className = 'del';
    del.textContent = 'Delete';
    del.addEventListener('click', async () => {
      await LogStore.deleteEntry(e.id);
      await load();
    });
    delCell.append(del);

    tr.append(cell(e.date), cell(e.company), titleCell, cell(e.resume), cell(e.verdict), scoreCell, delCell);
    rows.append(tr);
  }
}

async function load() {
  log = await LogStore.getLog();
  render();
}

function exportCSV() {
  const blob = new Blob([LogStore.toCSV(log)], { type: 'text/csv' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `applications-${new Date().toISOString().slice(0, 10)}.csv`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

$('filter').addEventListener('input', render);
$('export').addEventListener('click', exportCSV);
$('clear').addEventListener('click', async () => {
  if (!log.length) return;
  if (!confirm(`Delete all ${log.length} logged applications? This cannot be undone.`)) return;
  await LogStore.saveLog([]);
  await load();
});

// Refresh if the popup logs something while this page is open.
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes.applications) load();
});

load();
