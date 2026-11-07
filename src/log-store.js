/**
 * log-store.js — application log kept in chrome.storage.local.
 * Used by both the popup ("Log this application") and the log page.
 *
 * Entry shape: { id, company, title, jobId, url, date, resume, resumeFile,
 *                verdict, score, match, status, lastFollowUp, notes }
 *   match  = "High" | "Medium" | "Low"
 *   status = one of STATUSES (missing on old entries = "Applied")
 *   lastFollowUp = ISO date of the last "I followed up" click, or missing
 */
(function (root) {
  'use strict';

  const KEY = 'applications';
  // Kept short on purpose; "ghosted" is just Applied with no reply.
  const STATUSES = ['Applied', 'Interview', 'Offer', 'Rejected'];
  const DAY = 24 * 60 * 60 * 1000;

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

  // Merge fields into one entry (status, notes, follow-up date).
  async function updateEntry(id, patch) {
    const log = await getLog();
    const e = log.find((x) => x.id === id);
    if (!e) return;
    Object.assign(e, patch);
    await saveLog(log);
  }

  const statusOf = (e) => e.status || 'Applied';
  const today = () => new Date().toLocaleDateString('en-CA'); // local YYYY-MM-DD

  // Whole days since an ISO date (local time).
  function daysSince(iso, now) {
    const d = new Date(iso + 'T00:00:00');
    return isNaN(d) ? 0 : Math.floor(((now || new Date()) - d) / DAY);
  }

  // Still "Applied" and nothing heard for `days` since applying or the last follow-up.
  function followUpDue(e, days, now) {
    return statusOf(e) === 'Applied' && days > 0 && daysSince(e.lastFollowUp || e.date, now) >= days;
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

  // Entries already logged with the same URL, the same company + title,
  // or the same company + job ID.
  function findDuplicates(log, { url, company, title, jobId }) {
    const nu = url ? normalizeUrl(url) : '';
    const same = (a, b) => clean(a) && clean(a) === clean(b);
    return log.filter((e) =>
      (nu && normalizeUrl(e.url) === nu) ||
      (same(company, e.company) && same(title, e.title)) ||
      (same(company, e.company) && same(jobId, e.jobId))
    );
  }

  function toCSV(log) {
    const cols = ['date', 'company', 'title', 'jobId', 'url', 'resume', 'resumeFile', 'match', 'verdict', 'status', 'lastFollowUp', 'notes'];
    const esc = (v) => {
      const s = v === undefined || v === null ? '' : String(v);
      return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
    };
    return [cols.join(',')].concat(log.map((e) => cols.map((c) => esc(e[c])).join(','))).join('\r\n');
  }

  root.LogStore = {
    STATUSES, getLog, saveLog, addEntry, updateEntry, deleteEntry,
    statusOf, today, daysSince, followUpDue, findDuplicates, normalizeUrl, toCSV
  };
})(typeof self !== 'undefined' ? self : this);
