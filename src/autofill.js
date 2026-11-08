/**
 * autofill.js — fills a job application form from your profile. Injected into
 * the page by the popup (chrome.scripting), then called as
 *   window.__resumeMatcherAutofill(profile, resume)  ->  report
 *
 * Built for Workday, but works from labels, so it is fairly generic:
 * - Each field's label comes from aria-label, <label>, the Workday formField
 *   wrapper, the fieldset legend and data-automation-id.
 * - Rules map label words to profile values. Fields that already have a value
 *   are never overwritten, so clicking Autofill twice is safe.
 * - Work experience and education are filled block by block; missing blocks
 *   are added with the section's "Add" button.
 * - Dropdowns (Workday listbox buttons, search prompts, <select>), radio
 *   groups and single-choice checkbox groups pick the closest option text.
 * - It never clicks Next, Submit, or consent / terms checkboxes.
 *
 * Returns { filled: [labels], left: [required labels still empty], uploaded }.
 */
(function () {
  'use strict';
  if (window.__resumeMatcherAutofill) return; // already injected on this page

  // --- Small helpers ---------------------------------------------------------------

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  async function waitFor(fn, timeout = 2500) {
    const end = Date.now() + timeout;
    while (Date.now() < end) {
      const v = fn();
      if (v) return v;
      await sleep(100);
    }
    return null;
  }

  // Lowercase, punctuation to spaces: "Legal First Name*" -> "legal first name".
  const norm = (s) => String(s || '').toLowerCase().replace(/[’']/g, "'").replace(/[^a-z0-9+' ]+/g, ' ').replace(/\s+/g, ' ').trim();
  const textOf = (node) => (node ? node.textContent.replace(/\s+/g, ' ').trim() : '');
  const visible = (el) => Boolean(el && el.isConnected && el.getClientRects().length);
  const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

  // Every piece of text that describes a control, joined.
  function labelOf(el) {
    const parts = [];
    const add = (s) => { if (s) parts.push(s); };
    add(el.getAttribute('aria-label'));
    const ids = el.getAttribute('aria-labelledby');
    if (ids) ids.split(/\s+/).forEach((id) => add(textOf(document.getElementById(id))));
    if (el.id) add(textOf(document.querySelector(`label[for="${CSS.escape(el.id)}"]`)));
    add(textOf(el.closest('label')));
    const field = el.closest('[data-automation-id^="formField"]');
    if (field) {
      add(textOf(field.querySelector('label, legend')));
      add(field.getAttribute('data-automation-id'));
    }
    const fs = el.closest('fieldset');
    if (fs) add(textOf(fs.querySelector('legend')));
    add(el.getAttribute('data-automation-id'));
    add(el.getAttribute('name'));
    add(el.getAttribute('placeholder'));
    return parts.join(' | ');
  }

  // A short human label for the report: "Phone Device Type".
  function shortLabel(el) {
    const raw = (labelOf(el).split(' | ')[0] || '').replace(/\*|\brequired\b|select one/gi, '').replace(/\s+/g, ' ').trim();
    return raw.length > 40 ? raw.slice(0, 39) + '…' : raw;
  }

  // Index of the option text that best matches `answer`, or -1.
  function bestOption(texts, answer) {
    const a = norm(answer);
    if (!a) return -1;
    const T = texts.map(norm);
    if (a === 'decline') return T.findIndex((t) => /decline|not wish|prefer not|don't wish|do not want|choose not|not to (answer|disclose|self identify)/.test(t));
    let i = T.indexOf(a);
    if (i >= 0) return i;
    i = T.findIndex((t) => t.startsWith(a + ' '));
    if (i >= 0) return i;
    i = T.findIndex((t) => (' ' + t + ' ').includes(' ' + a + ' '));
    if (i >= 0) return i;
    i = T.findIndex((t) => t.length > 2 && (' ' + a + ' ').includes(' ' + t + ' '));
    if (i >= 0) return i;
    // Word overlap as a last resort ("Bachelors" vs "Bachelor's Degree" won't get here; "BS Computer Science" might).
    const words = new Set(a.split(' ').filter((w) => w.length > 2));
    let best = -1;
    let score = 0;
    T.forEach((t, j) => {
      const tw = t.split(' ').filter((w) => w.length > 2);
      const s = tw.filter((w) => words.has(w)).length / Math.max(words.size, tw.length, 1);
      if (s > score) { score = s; best = j; }
    });
    return score >= 0.5 ? best : -1;
  }

  const digits = (phone) => {
    const d = String(phone || '').replace(/\D/g, '');
    return d.length === 11 && d[0] === '1' ? d.slice(1) : d; // Workday has a separate country code
  };

  // --- Setting values (React-controlled inputs need the native setter + events) ---

  function setValue(el, value) {
    const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    el.focus();
    Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, value);
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    el.dispatchEvent(new FocusEvent('focusout', { bubbles: true }));
    el.blur();
  }

  const visibleOptions = () => {
    const o = [...document.querySelectorAll('[role="option"]')].filter(visible);
    return o.length ? o : null;
  };
  const closePopup = () => document.activeElement && document.activeElement.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', keyCode: 27, bubbles: true }));

  // Workday dropdown: a button that opens a listbox of [role=option].
  const listboxEmpty = (btn) => /^(select one|select|choose one|)$/.test(norm(textOf(btn)));
  async function chooseListbox(btn, answer) {
    btn.click();
    const options = await waitFor(visibleOptions, 2000);
    if (!options) return false;
    const i = bestOption(options.map(textOf), answer);
    if (i < 0) { closePopup(); await sleep(150); return false; }
    options[i].click();
    await sleep(300);
    return true;
  }

  // Workday search prompt ("How did you hear about us?", School, Field of study).
  const promptHasValue = (input) => {
    const box = input.closest('[data-automation-id="multiSelectContainer"], [data-automation-id^="formField"]');
    return Boolean(box && box.querySelector('[data-automation-id="selectedItem"], [data-automation-id="selectedItemList"] li'));
  };
  async function choosePrompt(input, answer) {
    input.click();
    setValue(input, answer);
    input.focus();
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, bubbles: true }));
    // Some prompts are two levels deep (category, then item); try twice.
    for (let level = 0; level < 2; level++) {
      const options = await waitFor(visibleOptions, 2000);
      if (!options) break;
      const i = bestOption(options.map(textOf), answer);
      if (i < 0) break;
      options[i].click();
      await sleep(400);
      if (promptHasValue(input)) { closePopup(); return true; }
    }
    // No match: close the list and clear the search text we typed.
    closePopup();
    if (!promptHasValue(input) && input.value) setValue(input, '');
    return promptHasValue(input);
  }

  function chooseSelect(select, answer) {
    const i = bestOption([...select.options].map((o) => o.textContent), answer);
    if (i < 0) return false;
    select.value = select.options[i].value;
    select.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  }

  // --- Finding controls -------------------------------------------------------------

  const isPrompt = (el) => el.tagName === 'INPUT' && (el.getAttribute('data-automation-id') === 'searchBox' || (el.getAttribute('role') === 'combobox' && el.getAttribute('aria-autocomplete')));
  const dateKind = (el) => {
    const id = el.getAttribute('data-automation-id') || '';
    return /dateSectionMonth/.test(id) ? 'month' : /dateSectionDay/.test(id) ? 'day' : /dateSectionYear/.test(id) ? 'year' : '';
  };

  // Text inputs, textareas, selects, Workday listbox buttons and prompts.
  function controls(root) {
    return [...root.querySelectorAll('input, textarea, select, button[aria-haspopup="listbox"]')].filter((el) => {
      if (!visible(el) || el.disabled) return false;
      if (el.tagName !== 'INPUT') return true;
      return !/^(hidden|submit|button|reset|image|file|radio|checkbox)$/i.test(el.type);
    });
  }

  // Radio groups and single-choice checkbox groups, each with its question text.
  function choiceGroups(root) {
    const groups = [];
    const seen = new Set();
    root.querySelectorAll('fieldset, [role="radiogroup"], [role="group"]').forEach((g) => {
      const inputs = [...g.querySelectorAll('input[type="radio"], input[type="checkbox"]')].filter((i) => visible(i) || visible(i.parentElement));
      if (inputs.length < 2 || inputs.some((i) => seen.has(i))) return;
      // Nested groups: only take the innermost one that owns these inputs.
      if ([...g.querySelectorAll('fieldset, [role="radiogroup"]')].some((inner) => inner.querySelector('input[type="radio"], input[type="checkbox"]'))) return;
      inputs.forEach((i) => seen.add(i));
      const question = [g.getAttribute('aria-label'), textOf(g.querySelector('legend')), (g.getAttribute('aria-labelledby') || '').split(/\s+/).map((id) => textOf(document.getElementById(id))).join(' '),
        textOf(g.closest('[data-automation-id^="formField"]') && g.closest('[data-automation-id^="formField"]').querySelector('label, legend'))].filter(Boolean).join(' | ');
      groups.push({ el: g, inputs, question });
    });
    return groups;
  }

  const optionLabel = (input) => textOf(input.id && document.querySelector(`label[for="${CSS.escape(input.id)}"]`)) || textOf(input.closest('label')) || input.value;

  // --- Rules ----------------------------------------------------------------------------

  const R = (re, get) => ({ re, get });

  function pageRules(p) {
    const own = (p.answers || []).filter((x) => x.q && x.a).map((x) => R(new RegExp(escapeRe(norm(x.q))), () => x.a));
    return own.concat([
      // Questions first: their long labels can contain words like "country".
      R(/sponsor/, () => p.sponsorship),
      R(/authori[sz]ed to work|legally (eligible|authorized|able|permitted) to work|eligib\w* to work|work authori|right to work/, () => p.authorized),
      R(/hispanic|latino/, () => p.eeo.hispanic),
      R(/ethnicit|\brace\b/, () => p.eeo.ethnicity),
      R(/gender|\bsex\b/, () => p.eeo.gender),
      R(/veteran/, () => p.eeo.veteran),
      R(/disabilit/, () => p.eeo.disability),
      // Contact and address.
      R(/middle name|preferred name|preferredname|suffix|prefix|title honorific/, () => ''),
      R(/\bfirst name|firstname|given name/, () => p.first),
      R(/\blast name|lastname|family name|surname/, () => p.last),
      R(/e ?mail/, () => p.email),
      R(/phone (device )?type|phonetype|phone device|device type/, () => p.phoneType),
      R(/country phone code|countryphonecode|phone code|dialing code/, () => p.country),
      R(/extension/, () => ''),
      R(/phone|mobile number/, () => digits(p.phone)),
      R(/address line 1|addressline1|street/, () => p.address1),
      R(/address line 2|addressline2|apartment|suite/, () => p.address2),
      R(/\bcity\b|\btown\b/, () => p.city),
      R(/postal|\bzip\b/, () => p.zip),
      R(/\bstate\b|province|countryregion|country region/, () => p.state),
      R(/\bcountry\b/, () => p.country),
      R(/linkedin/, () => p.linkedin),
      R(/github/, () => p.github),
      R(/website|portfolio|personal url|\bblog\b/, () => p.website)
    ]);
  }

  const jobRules = [
    R(/job title|jobtitle/, (j) => j.title),
    R(/company|employer/, (j) => j.company),
    R(/location/, (j) => j.location),
    R(/description|responsibilit/, (j) => j.description)
  ];
  const schoolRules = [
    R(/school|university|institution|college/, (s) => s.school),
    R(/degree/, (s) => s.degree),
    R(/field of study|fieldofstudy|major|discipline/, (s) => s.field),
    R(/\bgpa\b|overall result|grade average/, (s) => s.gpa)
  ];

  // --- Filling one control -----------------------------------------------------------------

  // Returns true if it set something.
  async function fill(el, value) {
    if (value === undefined || value === null || value === '') return false;
    if (el.tagName === 'BUTTON') return listboxEmpty(el) && chooseListbox(el, value);
    if (el.tagName === 'SELECT') return !el.value && chooseSelect(el, value);
    if (isPrompt(el)) return !promptHasValue(el) && choosePrompt(el, value);
    if (el.value) return false; // never overwrite
    setValue(el, String(value));
    return true;
  }

  // Month/day/year boxes of a Workday date field, from a "YYYY-MM" or "YYYY" value.
  async function fillDate(boxes, value) {
    const [y, m, d] = String(value || '').split('-');
    let did = false;
    for (const el of boxes) {
      const v = { month: m, day: d, year: y }[dateKind(el)];
      if (v && !el.value) { setValue(el, v); did = true; await sleep(80); }
    }
    return did;
  }

  // --- Work experience / education blocks ------------------------------------------------------

  // One block per anchor field (job title / school): the largest ancestor that
  // holds only that anchor. Workday's per-block role="group" wins when present.
  function blocksOf(anchorRe, otherRe) {
    const all = controls(document);
    const anchors = all.filter((el) => anchorRe.test(norm(labelOf(el))));
    const others = all.filter((el) => otherRe.test(norm(labelOf(el))));
    return anchors.map((a) => {
      const group = a.closest('[role="group"][aria-labelledby], [data-automation-id^="workExperience-"], [data-automation-id^="education-"]');
      if (group && anchors.filter((x) => group.contains(x)).length === 1) return group;
      let b = a;
      while (b.parentElement && b.parentElement !== document.body) {
        const p = b.parentElement;
        if (anchors.some((x) => x !== a && p.contains(x)) || others.some((x) => p.contains(x))) break;
        b = p;
      }
      return b;
    });
  }

  // The "Add" / "Add Another" button of a section whose heading contains `title`.
  function addButtonFor(title) {
    return [...document.querySelectorAll('button')].filter(visible).find((btn) => {
      const words = norm(textOf(btn) + ' ' + (btn.getAttribute('aria-label') || ''));
      if (!/^add( another)?\b/.test(words)) return false;
      if (words.includes(title)) return true;
      // Otherwise look for the nearest heading above the button.
      for (let n = btn.parentElement; n && n !== document.body; n = n.parentElement) {
        const h = n.querySelector('h2, h3, h4, [role="heading"], legend');
        if (h) return norm(textOf(h)).includes(title);
      }
      return false;
    });
  }

  async function fillBlocks(items, anchorRe, otherRe, title, rules, report, claimed) {
    if (!items.length) return;
    let blocks = blocksOf(anchorRe, otherRe);
    // Add blocks until there is one per item (at most 10 clicks).
    for (let guard = 0; blocks.length < items.length && guard < 10; guard++) {
      const add = addButtonFor(title);
      if (!add) break;
      const before = blocks.length;
      add.click();
      await waitFor(() => blocksOf(anchorRe, otherRe).length > before, 2500);
      blocks = blocksOf(anchorRe, otherRe);
      if (blocks.length <= before) break;
    }
    for (let i = 0; i < Math.min(blocks.length, items.length); i++) {
      const block = blocks[i];
      const item = items[i];
      // "I currently work here" checkbox.
      const current = [...block.querySelectorAll('input[type="checkbox"]')].find((c) => /currently|current/.test(norm(labelOf(c))));
      if (current) {
        claimed.add(current);
        if (Boolean(item.current) !== current.checked) { current.click(); await sleep(250); report.filled.push('Currently work here'); }
      }
      // Dates: group the month/year boxes by their field (From / To).
      const boxes = controls(block).filter(dateKind);
      boxes.forEach((b) => claimed.add(b));
      const startBoxes = boxes.filter((b) => /start|from|first year/.test(norm(labelOf(b))));
      const endBoxes = boxes.filter((b) => !startBoxes.includes(b) && /end|\bto\b|last year/.test(norm(labelOf(b))));
      if (await fillDate(startBoxes, item.start)) report.filled.push(`${title} ${i + 1} start date`);
      if (!item.current && await fillDate(endBoxes, item.end)) report.filled.push(`${title} ${i + 1} end date`);
      // Everything else in the block.
      for (const el of controls(block)) {
        if (claimed.has(el) || dateKind(el)) continue;
        const key = norm(labelOf(el));
        const rule = rules.find((r) => r.re.test(key));
        if (!rule) continue;
        claimed.add(el);
        if (await fill(el, rule.get(item))) report.filled.push(`${shortLabel(el)} (${title} ${i + 1})`);
      }
    }
  }

  // --- The rest of the page -------------------------------------------------------------------------

  async function fillPage(p, report, claimed) {
    const rules = pageRules(p);
    const fullName = `${p.first} ${p.last}`.trim();
    for (const el of controls(document)) {
      if (claimed.has(el) || !el.isConnected) continue;
      const key = norm(labelOf(el));
      // Signature-style "Name" and "Today's date" on self-identification forms.
      if (/^(your |full )?name$/.test(norm(shortLabel(el)))) {
        if (await fill(el, fullName)) report.filled.push(shortLabel(el));
        continue;
      }
      if (dateKind(el)) {
        if (/today|signed|date signed/.test(key)) {
          const t = new Date();
          const v = { month: String(t.getMonth() + 1).padStart(2, '0'), day: String(t.getDate()).padStart(2, '0'), year: String(t.getFullYear()) }[dateKind(el)];
          if (!el.value) { setValue(el, v); report.filled.push("Today's date"); }
        }
        continue;
      }
      const rule = rules.find((r) => r.re.test(key));
      if (!rule) continue;
      if (await fill(el, rule.get())) report.filled.push(shortLabel(el));
    }

    // Yes/No questions and single-choice checkbox groups.
    for (const g of choiceGroups(document)) {
      if (g.inputs.some((i) => claimed.has(i)) || g.inputs.some((i) => i.checked)) continue;
      const key = norm(g.question + ' ' + g.inputs.map((i) => labelOf(i)).join(' '));
      if (/agree|consent|terms|acknowledge|certify/.test(key)) continue; // yours to accept
      const rule = rules.find((r) => r.re.test(norm(g.question))) || rules.find((r) => r.re.test(key));
      const answer = rule && rule.get();
      if (!answer) continue;
      const i = bestOption(g.inputs.map(optionLabel), answer);
      if (i < 0) continue;
      g.inputs[i].click();
      await sleep(200);
      report.filled.push((g.question.split(' | ')[0] || 'Question').slice(0, 40));
    }
  }

  // --- Resume upload ---------------------------------------------------------------------------------

  async function uploadResume(resume) {
    const inputs = [...document.querySelectorAll('input[type="file"]')];
    if (!inputs.length) return '';
    if (document.body.innerText.includes(resume.name)) return 'already';
    const input = inputs.find((i) => /resume|cv/.test(norm(labelOf(i)))) || inputs[0];
    const bytes = Uint8Array.from(atob(resume.base64), (c) => c.charCodeAt(0));
    const dt = new DataTransfer();
    dt.items.add(new File([bytes], resume.name, { type: 'application/pdf' }));
    input.files = dt.files;
    input.dispatchEvent(new Event('change', { bubbles: true }));
    input.dispatchEvent(new Event('input', { bubbles: true }));
    await sleep(500);
    return 'uploaded';
  }

  // --- Leftovers: required fields still empty, so you know where to look ------------------------------

  function leftovers() {
    const required = (el) => el.getAttribute('aria-required') === 'true' || el.required || /\*/.test(labelOf(el).split(' | ')[0] || '');
    const empty = (el) => (el.tagName === 'BUTTON' ? listboxEmpty(el) : isPrompt(el) ? !promptHasValue(el) : !el.value);
    const left = controls(document).filter((el) => required(el) && empty(el)).map(shortLabel);
    choiceGroups(document).forEach((g) => {
      if (!g.inputs.some((i) => i.checked) && /\*|required/i.test(g.question)) left.push(g.question.split(' | ')[0].replace(/\*/g, '').trim().slice(0, 40));
    });
    return [...new Set(left.filter(Boolean))];
  }

  // --- Entry point ------------------------------------------------------------------------------------

  window.__resumeMatcherAutofill = async function (profile, resume) {
    const report = { filled: [], left: [], uploaded: '' };
    const claimed = new Set();
    try {
      if (resume) report.uploaded = await uploadResume(resume);
      const jobsRe = /job title|jobtitle/;
      const schoolRe = /school|university|institution|college/;
      await fillBlocks(profile.jobs || [], jobsRe, schoolRe, 'work experience', jobRules, report, claimed);
      await fillBlocks(profile.schools || [], schoolRe, jobsRe, 'education', schoolRules, report, claimed);
      await fillPage(profile, report, claimed);
    } catch (e) {
      report.error = e.message;
    }
    report.left = leftovers();
    return report;
  };
})();
