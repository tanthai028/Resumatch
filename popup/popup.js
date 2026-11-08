/**
 * popup.js — grabs the job text from the current tab, runs the scoring
 * module, renders the result, and handles the Claude / log buttons.
 */
'use strict';

const $ = (id) => document.getElementById(id);

let config = null;   // parsed config.json
let page = {};       // what we read from the tab (url, title, selection, pageText...)
let jobText = '';    // text currently being analyzed
let result = null;   // last ResumeScoring.analyze() result
let source = null;   // 'selection' | 'page' | 'paste': where jobText came from
let confirmDuplicate = false; // second click on "Log" after a duplicate warning
let lastLoggedId = null;      // for "Undo"

const MIN_SELECTION = 50; // shorter selections are probably accidental

// Runs inside the job posting page (injected with chrome.scripting).
function pageGrabber() {
  const meta = (q) => {
    const el = document.querySelector(q);
    return el ? (el.getAttribute('content') || '').trim() : '';
  };
  const h1 = document.querySelector('h1');
  return {
    selection: String(window.getSelection ? window.getSelection() : '').trim(),
    pageText: document.body ? document.body.innerText : '',
    h1: h1 ? h1.innerText.trim() : '',
    ogTitle: meta('meta[property="og:title"]'),
    siteName: meta('meta[property="og:site_name"]'),
    docTitle: document.title,
    url: location.href
  };
}

async function grabPage(tab) {
  const [top] = await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: pageGrabber });
  const info = top.result;
  // The posting may live in an iframe; look there for a selection too.
  if (info.selection.length < MIN_SELECTION) {
    try {
      const frames = await chrome.scripting.executeScript({ target: { tabId: tab.id, allFrames: true }, func: pageGrabber });
      const best = frames.map((f) => f.result).filter(Boolean).sort((a, b) => b.selection.length - a.selection.length)[0];
      if (best && best.selection.length > info.selection.length) info.selection = best.selection;
    } catch (e) {
      // Cross-origin frames we can't access; ignore.
    }
  }
  return info;
}

// Best-effort job title: the page's <h1>, else og:title, else the tab title.
function rawTitle(p) {
  if (p.h1 && p.h1.length >= 3 && p.h1.length <= 120) return p.h1;
  return p.ogTitle || p.docTitle || '';
}

// Oracle Cloud career sites title postings "Company Words – Job Title".
function isOracleCloud(p) {
  try { return /oraclecloud\.com$/.test(new URL(p.url).hostname); } catch (e) { return false; }
}
function splitOracleTitle(p) {
  const parts = rawTitle(p).split(/\s[–—-]\s/);
  return parts.length >= 2 ? { company: parts[0].replace(/\s+early career$/i, '').trim(), title: parts.slice(1).join(' - ').trim() } : null;
}

function guessTitle(p) {
  const split = isOracleCloud(p) && splitOracleTitle(p);
  return split ? split.title : rawTitle(p);
}

// Best-effort company name from the site; always editable in the popup.
function guessCompany(p) {
  let url;
  try { url = new URL(p.url); } catch (e) { return ''; }
  const host = url.hostname.replace(/^www\./, '');
  const firstPath = url.pathname.split('/').filter(Boolean)[0] || '';
  const pretty = (s) => s.replace(/[-_]+/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());

  if (isOracleCloud(p)) {
    const split = splitOracleTitle(p);
    if (split) return split.company;
  }
  if (/myworkdayjobs\.com$/.test(host)) return pretty(host.split('.')[0]);
  if (/(greenhouse\.io|lever\.co|ashbyhq\.com)$/.test(host) && firstPath) return pretty(firstPath);
  // Job boards: titles usually look like "Title | Company | LinkedIn" or "Title - Company - Indeed".
  if (/(linkedin|indeed|glassdoor|ziprecruiter|joinhandshake)\./.test(host)) {
    const parts = (p.docTitle || '').split(/\s[|\-–]\s/).map((s) => s.trim()).filter(Boolean);
    return parts.length >= 3 ? parts[1] : '';
  }
  if (p.siteName) return p.siteName;
  const labels = host.split('.');
  return pretty(labels.length >= 2 ? labels[labels.length - 2] : host);
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

function el(tag, attrs, text) {
  const e = document.createElement(tag);
  Object.assign(e, attrs || {});
  if (text !== undefined) e.textContent = text;
  return e;
}

// Renders chips on one straight row; chips that don't fit fold into a "+N"
// button, and clicking it lets the row wrap to show them all.
// classOf(item) returns an extra CSS class for each chip.
function renderChipRow(container, items, classOf) {
  container.classList.remove('expanded');
  container.replaceChildren();
  const chip = (item) => el('span', { className: 'chip ' + (classOf ? classOf(item) : '') }, item);
  const chips = items.map(chip);
  container.append(...chips);

  // Measure children (scrollWidth can't see overflow on a right-aligned row).
  const gap = parseFloat(getComputedStyle(container).columnGap) || 0;
  const width = (nodes) => nodes.reduce((w, n) => w + n.offsetWidth, 0) + gap * Math.max(0, nodes.length - 1);
  if (width(chips) <= container.clientWidth) return;

  const more = el('button', { className: 'chip more' });
  more.addEventListener('click', () => {
    container.classList.add('expanded');
    more.replaceWith(...chips.slice(container.children.length - 1));
  });
  container.append(more);
  let visible = chips.length;
  while (visible > 1) {
    visible--;
    chips[visible].remove();
    more.textContent = `+${chips.length - visible}`;
    if (width([...chips.slice(0, visible), more]) <= container.clientWidth) break;
  }
}

// Which screen is showing: 'empty' (instructions), 'paste' (paste box) or 'results'.
function showScreen(name) {
  $('empty').hidden = name !== 'empty';
  $('paste').hidden = name !== 'paste';
  $('results').hidden = name !== 'results';
  if (name === 'paste') $('job-text').focus();
}

// One-line notice under the header (errors, "nothing highlighted", duplicates).
function notice(text) {
  $('notice').textContent = text || '';
  $('notice').hidden = !text;
}

// Footer: says where the analyzed text came from and offers the other source.
function renderSource() {
  const labels = { selection: 'From your highlighted text.', page: 'From the whole page.', paste: 'From pasted text.' };
  $('source-info').textContent = labels[source] || '';
  const sw = $('switch-source');
  sw.hidden = source === 'paste' && !page.pageText;
  sw.textContent = source === 'page' ? 'Use highlighted text' : 'Use whole page';
}

function render() {
  showScreen('results');

  // Verdict, with the match level; tailor/skip also say why in one line.
  const v = result.verdict;
  const level = ResumeScoring.matchLevel(result.top.score, config);
  $('verdict').className = 'verdict ' + v.type;
  $('verdict-label').textContent = v.label;
  // Dealbreakers and warnings only; tool/skill gaps are already chips.
  const inChips = new Set(['tools', 'minor-tools', 'skills', 'preferred']);
  const shownFlags = result.flags
    .filter((f) => (f.severity === 'flag' || f.severity === 'warn') && !inChips.has(f.type))
    .sort((a, b) => (a.severity === 'flag' ? 0 : 1) - (b.severity === 'flag' ? 0 : 1));
  const redCount = shownFlags.filter((f) => f.severity === 'flag').length;

  // A green "Use" must not hide red flags below it, so the reason points at them.
  const why = v.type === 'tailor' ? ' ' + v.reasons[0]
    : v.type === 'skip' ? ' Reason: ' + v.reasons.join(', ') + '.'
    : redCount ? ` But check the ${redCount === 1 ? 'flag' : redCount + ' flags'} below.` : '';
  $('verdict-reason').textContent = `${level} match.${why}`;
  $('tailor').hidden = v.type !== 'tailor';
  $('tailor').textContent = 'Copy prompt and open Claude';

  // Scores (top pick highlighted).
  const list = $('scores');
  list.replaceChildren();
  result.scores.forEach((s, i) => {
    const li = el('li', { className: i === 0 ? 'top ' + level.toLowerCase() : '' });
    const bar = el('div', { className: 'bar' });
    const fill = el('div', { className: 'fill' });
    fill.style.width = s.score + '%';
    bar.append(fill);
    li.append(el('span', { className: 'name' }, s.name), bar, el('span', { className: 'num' }, String(s.score)));
    list.append(li);
  });

  // Gaps: hidden entirely when there are none. Most serious first, so the
  // chips that stay visible on the single row are the ones that matter.
  const core = new Set(result.facts.missingRequiredTools);
  const soft = new Set([...result.facts.missingMinorTools, ...result.facts.missingRequiredSkills]);
  const kind = (t) => (core.has(t) ? 'core' : soft.has(t) ? 'soft' : 'mention');
  const rank = { core: 0, soft: 1, mention: 2 };
  const gaps = [...result.missing].sort((a, b) => rank[kind(a)] - rank[kind(b)]);
  $('gaps-row').hidden = !gaps.length;
  if (!gaps.length) $('gaps-legend').hidden = true;
  renderChipRow($('missing'), gaps, kind);

  const flags = $('flags');
  flags.replaceChildren();
  shownFlags.forEach((f) => flags.append(el('li', { className: f.severity }, f.text)));

  // Default "resume used" for the log.
  $('resume-used').value = v.type === 'tailor' ? 'Tailored (based on ' + result.top.name + ')' : result.top.name;
  resetLogButton();
  renderSource();
}

function fillResumeSelect() {
  const sel = $('resume-used');
  sel.replaceChildren();
  for (const r of config.resumes) sel.append(el('option', { value: r.name }, r.name));
  for (const r of config.resumes) {
    // Shorter label so it fits the select; the stored value keeps the full name.
    const name = 'Tailored (based on ' + r.name + ')';
    sel.append(el('option', { value: name }, 'Tailored: ' + r.name));
  }
}

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

// Returns false (and changes nothing) when there is no text to analyze.
function analyzeText(text, from) {
  const t = String(text || '').trim();
  if (!t) return false;
  jobText = t;
  if (from) source = from;
  $('job-text').value = jobText;
  notice('');
  result = ResumeScoring.analyze({ text: jobText, title: $('job-title').value, company: $('job-company').value, url: page.url }, config);
  render();
  checkDuplicates();
  return true;
}

async function checkDuplicates() {
  const log = await LogStore.getLog();
  const dups = LogStore.findDuplicates(log, { url: page.url, company: $('job-company').value, title: $('job-title').value, jobId: $('job-id').value })
    .filter((d) => d.id !== lastLoggedId);
  if (dups.length) {
    const d = dups[0];
    notice(`Already logged on ${d.date} with ${d.resume}.`);
  } else if ($('notice').textContent.startsWith('Already logged')) {
    notice('');
  }
  return dups;
}

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
  } catch (e) {
    // Fallback for when the async clipboard API is unavailable.
    const ta = el('textarea');
    ta.value = text;
    document.body.append(ta);
    ta.select();
    document.execCommand('copy');
    ta.remove();
  }
}

async function onTailor() {
  const prompt = ResumeScoring.buildClaudePrompt(result, jobText, config);
  await copyText(prompt);
  $('tailor').textContent = 'Copied. Opening Claude…';
  // Opening a tab closes the popup, so copy first; the short pause lets the label show.
  setTimeout(() => chrome.tabs.create({ url: 'https://claude.ai/new' }), 400);
}

function resetLogButton() {
  confirmDuplicate = false;
  $('log-btn').textContent = 'Log it';
  $('log-btn').disabled = false;
  $('log-note').hidden = true;
}

function logNote(text, canUndo) {
  $('log-msg').textContent = text;
  $('undo-log').hidden = !canUndo;
  $('log-note').hidden = false;
}

async function onLog() {
  const dups = await checkDuplicates();
  if (dups.length && !confirmDuplicate) {
    confirmDuplicate = true;
    $('log-btn').textContent = 'Log again?';
    logNote('You already logged this job. Click again to log it anyway.', false);
    return;
  }
  const date = LogStore.today();
  // The file to re-download later: the chosen resume, or the base of a tailored one.
  const used = $('resume-used').value;
  const base = config.resumes.find((r) => used === r.name || used === 'Tailored (based on ' + r.name + ')');
  lastLoggedId = await LogStore.addEntry({
    company: $('job-company').value.trim(),
    title: $('job-title').value.trim(),
    jobId: $('job-id').value.trim(),
    url: page.url || '',
    date,
    resume: used,
    resumeFile: base ? base.filename : '',
    verdict: result.verdict.label,
    score: result.top.score,
    match: ResumeScoring.matchLevel(result.top.score, config),
    status: 'Applied'
  });
  confirmDuplicate = false;
  $('log-btn').textContent = 'Logged';
  $('log-btn').disabled = true;
  logNote(`Saved to your log as ${$('resume-used').value}.`, true);
}

async function onUndo() {
  if (lastLoggedId) await LogStore.deleteEntry(lastLoggedId);
  lastLoggedId = null;
  resetLogButton();
  checkDuplicates();
}

// ---------------------------------------------------------------------------
// Autofill (Workday application pages)
// ---------------------------------------------------------------------------

// The application form itself: ".../job/.../apply/applyManually" on a Workday site.
function isWorkdayApply(url) {
  try {
    const u = new URL(url);
    return /(^|\.)(myworkdayjobs|myworkdaysite)\.com$/.test(u.hostname) && /\/apply(\/|$)/.test(u.pathname);
  } catch (e) { return false; }
}

// The log entry for this posting: its URL is the start of the apply URL.
function loggedEntryFor(log, url) {
  const base = LogStore.normalizeUrl(String(url).replace(/\/apply(\/.*)?$/, ''));
  return log.find((e) => e.url && base.startsWith(LogStore.normalizeUrl(e.url)));
}

async function setUpAutofill(tab) {
  showScreen('none');
  $('autofill').hidden = false;
  const sel = $('af-resume');
  sel.append(el('option', { value: '' }, "Don't upload a resume"));
  for (const r of config.resumes) sel.append(el('option', { value: r.filename }, r.name));

  // Default to the resume you logged for this job; a tailored one you upload yourself.
  const entry = loggedEntryFor(await LogStore.getLog(), page.url || tab.url);
  if (entry && entry.resumeFile && !/^Tailored\b/.test(entry.resume || '')) sel.value = entry.resumeFile;
  else if (entry && /^Tailored\b/.test(entry.resume || '')) afNote('You sent a tailored resume for this job, so upload that file yourself.');

  const profile = await ProfileStore.getProfile();
  if (!ProfileStore.isSetUp(profile)) {
    $('af-run').textContent = 'Set up profile';
    $('af-run').addEventListener('click', openProfile);
    afNote('Add your name and email in your profile first.');
    return;
  }
  $('af-run').addEventListener('click', () => onAutofill(tab, profile));
}

function afNote(text, leftList) {
  const note = $('af-note');
  note.replaceChildren(text);
  if (leftList && leftList.length) {
    note.append(el('div', { className: 'af-left' }, 'Still empty: ' + leftList.slice(0, 6).join(', ') + (leftList.length > 6 ? `, +${leftList.length - 6} more` : '') + '.'));
  }
  note.hidden = false;
}

function toBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

async function onAutofill(tab, profile) {
  const btn = $('af-run');
  btn.disabled = true;
  btn.textContent = 'Filling…';
  try {
    let resume = null;
    const file = $('af-resume').value;
    if (file) {
      const res = await fetch(chrome.runtime.getURL('resumes/' + file));
      if (!res.ok) throw new Error(`${file} isn't in the resumes folder.`);
      resume = { name: file, base64: toBase64(await res.arrayBuffer()) };
    }
    await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['src/autofill.js'] });
    const [out] = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: (p, r) => window.__resumeMatcherAutofill(p, r),
      args: [profile, resume]
    });
    const r = out.result || { filled: [], left: [] };
    const n = r.filled.length;
    const up = r.uploaded === 'uploaded' ? ' Uploaded your resume.' : '';
    afNote((n ? `Filled ${n} field${n === 1 ? '' : 's'}.` : 'Nothing new to fill on this page.') + up + (r.error ? ` Stopped early: ${r.error}` : ''), r.left);
  } catch (e) {
    afNote("Couldn't fill this page: " + e.message);
  }
  btn.disabled = false;
  btn.textContent = 'Autofill again';
}

const openProfile = () => chrome.tabs.create({ url: chrome.runtime.getURL('settings/settings.html') });

// ---------------------------------------------------------------------------
// Startup
// ---------------------------------------------------------------------------

async function init() {
  config = await fetch(chrome.runtime.getURL('config.json')).then((r) => r.json());
  fillResumeSelect();

  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  let readable = true;
  try {
    page = await grabPage(tab);
  } catch (e) {
    // chrome:// pages, the Web Store, PDFs, etc. can't be scripted.
    readable = false;
    page = { url: tab && tab.url, docTitle: tab && tab.title, selection: '', pageText: '' };
  }

  $('job-title').value = guessTitle(page);
  $('job-company').value = guessCompany(page);
  $('job-id').value = ResumeScoring.findJobId(page.pageText || page.selection, page.url);

  if (readable && isWorkdayApply(page.url)) {
    // An application form, not a posting: offer autofill instead of a match.
    await setUpAutofill(tab);
  } else if (page.selection && page.selection.length >= MIN_SELECTION) {
    analyzeText(page.selection, 'selection');
  } else if (!readable) {
    showScreen('paste');
    notice("Chrome won't let extensions read this page. Paste the job description instead.");
  } else {
    showScreen('empty');
    checkDuplicates();
  }

  $('empty-page').addEventListener('click', () => analyzeText(page.pageText, 'page') || notice('This page has no readable text.'));
  $('show-paste').addEventListener('click', () => showScreen('paste'));
  $('reanalyze').addEventListener('click', () => analyzeText($('job-text').value, 'paste') || notice('Paste the job description first.'));
  $('switch-source').addEventListener('click', async () => {
    if (source !== 'page') return analyzeText(page.pageText, 'page');
    try { page = Object.assign(page, await grabPage(tab)); } catch (e) { /* keep old */ }
    if (!(page.selection && page.selection.length >= MIN_SELECTION && analyzeText(page.selection, 'selection'))) {
      notice('Nothing is highlighted on the page. Highlight the description, then reopen this popup.');
    }
  });
  $('job-title').addEventListener('change', () => { if (jobText) analyzeText(jobText); });
  $('job-company').addEventListener('change', checkDuplicates);
  $('job-id').addEventListener('change', checkDuplicates);
  $('gaps-help').addEventListener('click', () => {
    const open = $('gaps-legend').hidden;
    $('gaps-legend').hidden = !open;
    $('gaps-help').setAttribute('aria-expanded', String(open));
  });
  $('tailor').addEventListener('click', onTailor);
  $('log-btn').addEventListener('click', onLog);
  $('undo-log').addEventListener('click', onUndo);
  $('open-log').addEventListener('click', () => chrome.tabs.create({ url: chrome.runtime.getURL('log/log.html') }));
  $('open-profile').addEventListener('click', openProfile);
}

init().catch((e) => {
  notice("Couldn't start: " + e.message);
  console.error(e);
});
