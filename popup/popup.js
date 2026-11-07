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
let confirmDuplicate = false; // second click on "Log" after a duplicate warning

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
function guessTitle(p) {
  if (p.h1 && p.h1.length >= 3 && p.h1.length <= 120) return p.h1;
  return p.ogTitle || p.docTitle || '';
}

// Best-effort company name from the site; always editable in the popup.
function guessCompany(p) {
  let url;
  try { url = new URL(p.url); } catch (e) { return ''; }
  const host = url.hostname.replace(/^www\./, '');
  const firstPath = url.pathname.split('/').filter(Boolean)[0] || '';
  const pretty = (s) => s.replace(/[-_]+/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());

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

// Shows the first `max` chips; the rest collapse into a "+N" chip (hover to see them).
function renderChips(container, items, max) {
  container.replaceChildren();
  if (!items.length) container.append(el('span', { className: 'none' }, 'None'));
  for (const item of items.slice(0, max)) container.append(el('span', { className: 'chip' }, item));
  if (items.length > max) {
    const more = el('span', { className: 'chip more' }, `+${items.length - max}`);
    more.title = items.slice(max).join(', ');
    container.append(more);
  }
}

function render() {
  $('empty').hidden = true;
  $('results').hidden = false;

  // Verdict
  const v = result.verdict;
  $('verdict').className = 'verdict ' + v.type;
  $('verdict-label').textContent = v.label;
  $('verdict-reason').textContent = v.reasons.join('; ');
  $('tailor').hidden = v.type !== 'tailor';
  $('tailor-status').hidden = true;

  // Scores (top pick highlighted; hover shows which keywords earned points)
  const list = $('scores');
  list.replaceChildren();
  result.scores.forEach((s, i) => {
    const li = el('li', { className: i === 0 ? 'top' : '' });
    li.title = s.hits.map((h) => `${h.term} ×${h.count} (+${h.points})`).join('\n') || 'No keyword hits';
    const bar = el('div', { className: 'bar' });
    const fill = el('div', { className: 'fill' });
    fill.style.width = s.score + '%';
    bar.append(fill);
    li.append(el('span', { className: 'name' }, s.name), bar, el('span', { className: 'num' }, String(s.score)));
    list.append(li);
  });

  // Keywords for the top pick (capped so the popup doesn't need to scroll)
  renderChips($('matched'), result.matched, 10);
  renderChips($('missing'), result.missing, 8);

  // Red flags, most serious first
  const order = { flag: 0, warn: 1, plus: 2, info: 3 };
  const flags = $('flags');
  flags.replaceChildren();
  if (!result.flags.length) flags.append(el('li', { className: 'info' }, 'No red flags found.'));
  [...result.flags].sort((a, b) => order[a.severity] - order[b.severity])
    .forEach((f) => flags.append(el('li', { className: f.severity }, f.text)));

  // Default "resume used" for the log
  const sel = $('resume-used');
  sel.value = v.type === 'tailor' ? 'Tailored (based on ' + result.top.name + ')' : result.top.name;
  $('log-status').textContent = '';
  confirmDuplicate = false;
}

function fillResumeSelect() {
  const sel = $('resume-used');
  sel.replaceChildren();
  for (const r of config.resumes) sel.append(el('option', { value: r.name }, r.name));
  for (const r of config.resumes) {
    const name = 'Tailored (based on ' + r.name + ')';
    sel.append(el('option', { value: name }, name));
  }
}

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

function analyzeText(text, sourceLabel) {
  jobText = String(text || '').trim();
  $('job-text').value = jobText;
  if (!jobText) {
    $('results').hidden = true;
    $('empty').hidden = false;
    return;
  }
  if (sourceLabel) $('source-info').textContent = `${sourceLabel} (${jobText.length.toLocaleString()} chars)`;
  result = ResumeScoring.analyze({ text: jobText, title: $('job-title').value, company: $('job-company').value, url: page.url }, config);
  render();
}

async function checkDuplicates() {
  const log = await LogStore.getLog();
  const dups = LogStore.findDuplicates(log, { url: page.url, company: $('job-company').value, title: $('job-title').value });
  const box = $('dup-warning');
  box.hidden = !dups.length;
  if (dups.length) {
    const d = dups[0];
    box.textContent = `Already logged on ${d.date}: ${d.title} at ${d.company} (used ${d.resume}).`;
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
  $('tailor-status').textContent = 'Prompt copied — paste it into Claude.';
  $('tailor-status').hidden = false;
  // Opening a tab closes the popup, so copy first.
  chrome.tabs.create({ url: 'https://claude.ai/new' });
}

async function onLog() {
  const dups = await checkDuplicates();
  if (dups.length && !confirmDuplicate) {
    confirmDuplicate = true;
    $('log-status').textContent = 'Looks like a duplicate. Click again to log anyway.';
    return;
  }
  const now = new Date();
  const date = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
  await LogStore.addEntry({
    company: $('job-company').value.trim(),
    title: $('job-title').value.trim(),
    url: page.url || '',
    date,
    resume: $('resume-used').value,
    verdict: result.verdict.label,
    score: result.top.score
  });
  confirmDuplicate = false;
  $('log-status').textContent = 'Logged ✓';
  checkDuplicates();
}

// ---------------------------------------------------------------------------
// Startup
// ---------------------------------------------------------------------------

async function init() {
  config = await fetch(chrome.runtime.getURL('config.json')).then((r) => r.json());
  fillResumeSelect();

  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  try {
    page = await grabPage(tab);
  } catch (e) {
    // chrome:// pages, the Web Store, PDFs, etc. can't be scripted.
    page = { url: tab && tab.url, docTitle: tab && tab.title, selection: '', pageText: '' };
    $('source-info').textContent = "Can't read this page. Paste the text below.";
    $('text-box').open = true;
  }

  $('job-title').value = guessTitle(page);
  $('job-company').value = guessCompany(page);

  if (page.selection && page.selection.length >= MIN_SELECTION) analyzeText(page.selection, 'Using highlighted text');
  checkDuplicates();

  $('use-page').addEventListener('click', () => analyzeText(page.pageText, 'Using whole page'));
  $('use-selection').addEventListener('click', async () => {
    try { page = Object.assign(page, await grabPage(tab)); } catch (e) { /* keep old */ }
    if (page.selection && page.selection.length >= MIN_SELECTION) analyzeText(page.selection, 'Using highlighted text');
    else $('source-info').textContent = 'No text highlighted on the page.';
  });
  $('reanalyze').addEventListener('click', () => analyzeText($('job-text').value, 'Using edited text'));
  $('job-title').addEventListener('change', () => { if (jobText) analyzeText(jobText); checkDuplicates(); });
  $('job-company').addEventListener('change', checkDuplicates);
  $('tailor').addEventListener('click', onTailor);
  $('log-btn').addEventListener('click', onLog);
  $('open-log').addEventListener('click', () => chrome.tabs.create({ url: chrome.runtime.getURL('log/log.html') }));
}

init().catch((e) => {
  $('empty').textContent = 'Error: ' + e.message;
  console.error(e);
});
