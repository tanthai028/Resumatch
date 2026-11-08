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
 * - Searchable dropdowns (Select2, Chosen, custom comboboxes) are filled
 *   through their hidden <select> when it has the option, else by opening
 *   the widget, typing in its search box and clicking the match.
 * - Native month/date pickers get dates from the profile.
 * - Filled fields get a green outline, required fields still empty a red
 *   dashed one; each clears when you click into it, all after 20 seconds.
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

  // Searchable dropdown libraries hide the real <select> and draw their own widget
  // right after it. These map between the two.
  const WIDGET = '.select2-container, .select2, .chosen-container, .selectize-control, .choices, .nice-select, .bootstrap-select, .ts-wrapper';
  function widgetOf(select) {
    const next = select.nextElementSibling;
    if (next && next.matches(WIDGET)) return next;
    const wrap = select.closest('.choices, .bootstrap-select');
    return wrap && wrap !== select ? wrap : null;
  }
  function nativeSelectOf(el) {
    if (el.tagName === 'SELECT') return null;
    const widget = el.closest(WIDGET);
    if (!widget) return null;
    const prev = widget.previousElementSibling;
    return prev && prev.tagName === 'SELECT' ? prev : widget.querySelector('select');
  }
  // The clickable part of a widget (Select2's role=combobox span, Chosen's link...).
  const comboIn = (widget) => widget.querySelector('[role="combobox"], .select2-selection, .chosen-single, .selectize-input, .choices__inner, .dropdown-toggle') || widget;

  // Every piece of text that describes a control, joined.
  function labelOf(el) {
    const parts = [];
    const add = (s) => { if (s) parts.push(s); };
    // A custom dropdown built on a hidden <select> is described by that select's label.
    const native = nativeSelectOf(el);
    if (native) add(labelOf(native));
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

  const OPTION = '[role="option"], [role="treeitem"], .select2-results__option, .chosen-results li.active-result, .selectize-dropdown .option, .choices__list--dropdown .choices__item--selectable';
  const visibleOptions = () => {
    const o = [...document.querySelectorAll(OPTION)].filter((x) => visible(x) && x.getAttribute('aria-disabled') !== 'true' && !/loading|message|no results|searching/i.test(x.className + ' ' + textOf(x).slice(0, 20)));
    return o.length ? o : null;
  };
  // "Select One", "Select an option", "-- Please select --", "Choose...": a dropdown with nothing picked.
  const isPlaceholder = (text) => /^(please )?(select|choose|pick)( (one|an option|a value|an item|from the list))?$|^$/.test(norm(text));
  // Press like a real mouse; some widgets (Select2) open on mousedown, not click.
  function press(el) {
    for (const type of ['pointerdown', 'mousedown', 'pointerup', 'mouseup']) el.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, view: window, button: 0 }));
    el.click();
  }
  const closePopup = () => document.activeElement && document.activeElement.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', keyCode: 27, bubbles: true }));

  // Workday dropdown: a button that opens a listbox of [role=option].
  const listboxEmpty = (btn) => isPlaceholder(textOf(btn));
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

  const selectEmpty = (select) => !select.value || select.selectedIndex < 0 || isPlaceholder(select.options[select.selectedIndex].textContent);
  function chooseSelect(select, answer) {
    const opts = [...select.options];
    const i = bestOption(opts.map((o) => (isPlaceholder(o.textContent) ? '' : o.textContent)), answer);
    if (i < 0) return false;
    select.value = opts[i].value;
    for (const type of ['input', 'change', 'chosen:updated']) select.dispatchEvent(new Event(type, { bubbles: true }));
    return true;
  }

  // Custom dropdown: open it, type into its search box if it has one, click the match.
  async function chooseCombo(el, answer) {
    press(el);
    await sleep(200);
    const active = document.activeElement;
    const search = [...document.querySelectorAll('.select2-search__field, .chosen-search input, .selectize-input input, .choices__input--cloned, [role="searchbox"], input[aria-autocomplete="list"]')]
      .find((x) => visible(x) && x !== el) || (active && active.tagName === 'INPUT' && active !== el ? active : null);
    if (search) {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(search, answer);
      search.dispatchEvent(new Event('input', { bubbles: true }));
      search.dispatchEvent(new KeyboardEvent('keyup', { key: 'a', bubbles: true }));
    }
    // Long lists (schools) load as you type, so wait for a matching option.
    const matching = () => { const o = visibleOptions(); return o && bestOption(o.map(textOf), answer) >= 0 ? o : null; };
    const options = await waitFor(matching, search ? 3500 : 2000);
    if (!options) { closePopup(); await sleep(150); return false; }
    const opt = options[bestOption(options.map(textOf), answer)];
    opt.dispatchEvent(new MouseEvent('mouseenter', { bubbles: true }));
    press(opt);
    await sleep(300);
    return true;
  }
  const comboEmpty = (el) => { const native = nativeSelectOf(el); return native ? selectEmpty(native) : isPlaceholder(textOf(el)); };

  // --- Finding controls -------------------------------------------------------------

  const isPrompt = (el) => el.tagName === 'INPUT' && (el.getAttribute('data-automation-id') === 'searchBox' || (el.getAttribute('role') === 'combobox' && el.getAttribute('aria-autocomplete')));
  const dateKind = (el) => {
    const id = el.getAttribute('data-automation-id') || '';
    return /dateSectionMonth/.test(id) ? 'month' : /dateSectionDay/.test(id) ? 'day' : /dateSectionYear/.test(id) ? 'year' : '';
  };

  // Text inputs, textareas, selects, Workday listbox buttons and prompts.
  // Hidden <select>s count when a dropdown widget stands in for them.
  // Custom comboboxes count unless a <select> backs them (the select is filled instead).
  const isCombo = (el) => !/^(INPUT|SELECT|BUTTON)$/.test(el.tagName) && el.getAttribute('role') === 'combobox';
  function controls(root) {
    return [...root.querySelectorAll('input, textarea, select, button[aria-haspopup="listbox"], [role="combobox"]')].filter((el) => {
      if (el.disabled) return false;
      if (el.tagName === 'SELECT') return visible(el) || Boolean(widgetOf(el) && visible(widgetOf(el)));
      if (!visible(el)) return false;
      if (isCombo(el)) return !nativeSelectOf(el);
      if (el.tagName !== 'INPUT') return true;
      if (el.closest(WIDGET)) return false; // a widget's own search box
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
      // Preferred first name: same as your first name (often required).
      R(/preferred first name|first name preferred|preferred name|preferredname/, () => p.first),
      R(/middle name|suffix|prefix|title honorific/, () => ''),
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
    R(/degree|education level|level of education|highest education/, (s) => s.degree),
    R(/field of study|fieldofstudy|major|discipline/, (s) => s.field),
    R(/\bgpa\b|overall result|grade average/, (s) => s.gpa)
  ];

  // --- Filling one control -----------------------------------------------------------------

  // Returns true if it set something.
  async function fill(el, value) {
    if (value === undefined || value === null || value === '') return false;
    if (el.tagName === 'BUTTON') return listboxEmpty(el) && chooseListbox(el, value);
    if (el.tagName === 'SELECT') {
      if (!selectEmpty(el)) return false;
      if (chooseSelect(el, value)) return true;
      // The option may not be loaded yet (schools): search through the widget.
      const widget = widgetOf(el);
      return Boolean(widget) && chooseCombo(comboIn(widget), value);
    }
    if (isCombo(el)) return comboEmpty(el) && chooseCombo(el, value);
    if (isPrompt(el)) return !promptHasValue(el) && choosePrompt(el, value);
    if (/^(month|date)$/.test(el.type)) return false; // dates are handled per block
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
    return [...document.querySelectorAll('button, a, [role="button"]')].filter(visible).find((btn) => {
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
        if (Boolean(item.current) !== current.checked) { current.click(); await sleep(250); mark(current.closest('label') || current, 'filled'); report.filled.push('Currently work here'); }
      }
      // Dates: group the month/year boxes by their field (From / To).
      const boxes = controls(block).filter(dateKind);
      boxes.forEach((b) => claimed.add(b));
      const startBoxes = boxes.filter((b) => /start|from|first year/.test(norm(labelOf(b))));
      const endBoxes = boxes.filter((b) => !startBoxes.includes(b) && /end|\bto\b|last year/.test(norm(labelOf(b))));
      if (await fillDate(startBoxes, item.start)) { startBoxes.forEach((b) => b.value && mark(b, 'filled')); report.filled.push(`${title} ${i + 1} start date`); }
      if (!item.current && await fillDate(endBoxes, item.end)) { endBoxes.forEach((b) => b.value && mark(b, 'filled')); report.filled.push(`${title} ${i + 1} end date`); }
      // Native month / date pickers ("Start Date" with a calendar icon). Only
      // values with a month (jobs) are used; school years alone would mean guessing.
      for (const picker of controls(block).filter((x) => x.tagName === 'INPUT' && /^(month|date)$/.test(x.type))) {
        claimed.add(picker);
        const key = norm(labelOf(picker));
        const v = /start|from|began|first/.test(key) ? item.start : (/end|\bto\b|finish|last|graduat/.test(key) && !item.current ? item.end : '');
        if (!/^\d{4}-\d{2}$/.test(v || '') || picker.value) continue;
        setValue(picker, picker.type === 'date' ? v + '-01' : v);
        if (picker.value) { mark(picker, 'filled'); report.filled.push(`${shortLabel(picker)} (${title} ${i + 1})`); }
      }
      // Everything else in the block.
      for (const el of controls(block)) {
        if (claimed.has(el) || dateKind(el)) continue;
        const key = norm(labelOf(el));
        const rule = rules.find((r) => r.re.test(key));
        if (!rule) continue;
        claimed.add(el);
        if (await fill(el, rule.get(item))) { mark(el, 'filled'); report.filled.push(`${shortLabel(el)} (${title} ${i + 1})`); }
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
        if (await fill(el, fullName)) { mark(el, 'filled'); report.filled.push(shortLabel(el)); }
        continue;
      }
      if (dateKind(el)) {
        if (/today|signed|date signed/.test(key)) {
          const t = new Date();
          const v = { month: String(t.getMonth() + 1).padStart(2, '0'), day: String(t.getDate()).padStart(2, '0'), year: String(t.getFullYear()) }[dateKind(el)];
          if (!el.value) { setValue(el, v); mark(el, 'filled'); report.filled.push("Today's date"); }
        }
        continue;
      }
      const rule = rules.find((r) => r.re.test(key));
      if (!rule) continue;
      if (await fill(el, rule.get())) { mark(el, 'filled'); report.filled.push(shortLabel(el)); }
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
      mark(g.el, 'filled');
      report.filled.push((g.question.split(' | ')[0] || 'Question').slice(0, 40));
    }
  }

  // --- Highlighting -------------------------------------------------------------------------------------
  // Green outline = filled by autofill; red dashed = required and still empty.
  // A mark clears when you click into that field; all clear after 20 seconds.

  const MARK = 'data-resume-matcher';
  function ensureMarkStyle() {
    if (document.getElementById('resume-matcher-marks')) return;
    const style = document.createElement('style');
    style.id = 'resume-matcher-marks';
    style.textContent = `
      [${MARK}="filled"] { outline: 2px solid #2da44e !important; outline-offset: 2px !important; box-shadow: 0 0 0 5px rgba(166, 235, 143, .55) !important; }
      [${MARK}="empty"] { outline: 2px dashed #d92d20 !important; outline-offset: 2px !important; box-shadow: 0 0 0 5px rgba(255, 196, 204, .6) !important; }`;
    document.head.append(style);
  }
  // Mark what you see: a hidden <select>'s widget, a radio group's box.
  function mark(el, kind) {
    const target = el.tagName === 'SELECT' ? widgetOf(el) || el : el;
    if (!target || (kind === 'empty' && target.getAttribute(MARK) === 'filled')) return;
    ensureMarkStyle();
    target.setAttribute(MARK, kind);
    const clear = () => target.removeAttribute(MARK);
    target.addEventListener('focusin', clear, { once: true });
    target.addEventListener('mousedown', clear, { once: true });
  }
  function clearMarksLater() {
    clearTimeout(window.__resumeMatcherMarkTimer);
    window.__resumeMatcherMarkTimer = setTimeout(() => document.querySelectorAll(`[${MARK}]`).forEach((n) => n.removeAttribute(MARK)), 20000);
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
    const empty = (el) => (el.tagName === 'BUTTON' ? listboxEmpty(el) : el.tagName === 'SELECT' ? selectEmpty(el) : isCombo(el) ? comboEmpty(el) : isPrompt(el) ? !promptHasValue(el) : !el.value);
    const missing = controls(document).filter((el) => required(el) && empty(el));
    missing.forEach((el) => mark(el, 'empty'));
    const left = missing.map(shortLabel);
    choiceGroups(document).forEach((g) => {
      if (!g.inputs.some((i) => i.checked) && /\*|required/i.test(g.question)) {
        mark(g.el, 'empty');
        left.push(g.question.split(' | ')[0].replace(/\*/g, '').trim().slice(0, 40));
      }
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
    clearMarksLater();
    return report;
  };
})();
