/**
 * log-store.js — application log kept in chrome.storage.local.
 * Used by both the popup ("Log this application") and the log page.
 *
 * Entry shape: { id, company, title, url, date, resume, verdict, score }
 */
(function (root) {
  'use strict';

  const KEY = 'applications';

  async function getLog() {
    const data = await chrome.storage.local.get(KEY);
    return Array.isArray(data[KEY]) ? data[KEY] : [];
  }

  async function saveLog(entries) {
    await chrome.storage.local.set({ [KEY]: entries });
  }

  // Returns the new entry's id (used by the popup's "Undo").
  async function addEntry(entry) {
    const log = await getLog();
    const id = Date.now() + '-' + Math.random().toString(36).slice(2, 7);
    log.unshift(Object.assign({ id }, entry));
    await saveLog(log);
    return id;
  }

  async function deleteEntry(id) {
    const log = await getLog();
    await saveLog(log.filter((e) => e.id !== id));
  }

  // Drop the #fragment and utm_* tracking params so the same posting compares equal.
  function normalizeUrl(url) {
    try {
      const u = new URL(url);
      u.hash = '';
      [...u.searchParams.keys()].filter((k) => k.startsWith('utm_')).forEach((k) => u.searchParams.delete(k));
      return u.toString().replace(/\/$/, '').toLowerCase();
    } catch (e) {
      return String(url || '').trim().toLowerCase();
    }
  }

  const clean = (s) => String(s || '').trim().toLowerCase().replace(/\s+/g, ' ');

  // Entries already logged with the same URL, or the same company + title.
  function findDuplicates(log, { url, company, title }) {
    const nu = url ? normalizeUrl(url) : '';
    return log.filter((e) =>
      (nu && normalizeUrl(e.url) === nu) ||
      (clean(company) && clean(title) && clean(e.company) === clean(company) && clean(e.title) === clean(title))
    );
  }

  function toCSV(log) {
    const cols = ['date', 'company', 'title', 'url', 'resume', 'verdict', 'score'];
    const esc = (v) => {
      const s = v === undefined || v === null ? '' : String(v);
      return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
    };
    return [cols.join(',')].concat(log.map((e) => cols.map((c) => esc(e[c])).join(','))).join('\r\n');
  }

  root.LogStore = { getLog, saveLog, addEntry, deleteEntry, findDuplicates, normalizeUrl, toCSV };
})(typeof self !== 'undefined' ? self : this);
