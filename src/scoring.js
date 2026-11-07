/**
 * scoring.js — all matching, scoring, red-flag and verdict logic.
 *
 * Pure functions only: no DOM, no chrome.* APIs. That way the same file runs
 * in the extension popup (as window.ResumeScoring) and in Node for the tests
 * (via require). All tunable numbers live in config.json.
 *
 * Main entry point:  analyze({ text, title, company, url }, config)
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.ResumeScoring = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // ---------------------------------------------------------------------------
  // Text helpers
  // ---------------------------------------------------------------------------

  function escapeRegex(s) {
    return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  // Build a regex that finds `term` as a whole "word", even for terms with
  // symbols like "c#", ".net" or "ci/cd". Spaces/hyphens inside the term match
  // either ("on-call" == "on call"), and a trailing plural "s"/"es" is allowed.
  const regexCache = new Map();
  function termRegex(term) {
    let re = regexCache.get(term);
    if (!re) {
      const body = escapeRegex(term).replace(/[\s-]+/g, '[\\s\\-]+');
      const plural = /[a-z]$/.test(term) ? '(?:e?s)?' : '';
      re = new RegExp('(?<![a-z0-9])' + body + plural + '(?![a-z0-9])', 'g');
      regexCache.set(term, re);
    }
    re.lastIndex = 0;
    return re;
  }

  function countTerm(text, term) {
    if (!term) return 0;
    const m = text.match(termRegex(term));
    return m ? m.length : 0;
  }

  // Lowercase, tidy punctuation, then rewrite synonyms to their canonical term
  // (e.g. "amazon web services" -> "aws") so every later step sees one spelling.
  function makeNormalizer(config) {
    const pairs = [];
    for (const [canonical, variants] of Object.entries(config.synonyms || {})) {
      for (const v of variants) pairs.push([v.toLowerCase().trim(), canonical.toLowerCase().trim()]);
    }
    // Longest variants first so "sql server" is replaced before "sql".
    pairs.sort((a, b) => b[0].length - a[0].length);

    return function normalize(text) {
      let t = String(text || '')
        .toLowerCase()
        .replace(/[‘’]/g, "'")
        .replace(/[“”]/g, '"')
        .replace(/[–—]/g, '-')
        .replace(/ /g, ' ');
      for (const [variant, canonical] of pairs) t = t.replace(termRegex(variant), canonical);
      return t;
    };
  }

  // ---------------------------------------------------------------------------
  // Section detection: which lines are "required", "preferred", or other?
  // ---------------------------------------------------------------------------

  const HEADING = {
    preferred: /^(?:preferred|desired|nice[\s-]to[\s-]have|bonus|additional (?:qualifications|skills)|pluses)/,
    other: /^(?:(?:essential |key |primary |job )?(?:duties|responsibilities)|what you'?ll do|what you will do|the role|about the (?:role|job|position|team)|job (?:summary|description|overview)|position (?:summary|overview)|overview|summary|your impact|day[\s-]to[\s-]day|benefits|about (?:us|the company)|what we offer|compensation|pay (?:range|transparency)|salary|equal (?:employment )?opportunity|eeo|perks|why join|our culture|who we are|location|work (?:arrangement|schedule|environment))/,
    // Whole-line match for the generic words, so a short bullet like
    // "Experience with Jira" is not mistaken for a heading.
    required: /^(?:(?:minimum|basic|required|essential|key|must[\s-]have|job)\s+)?(?:(?:previous|relevant|required)\s+)?(?:qualifications?|requirements?|skills|experience|education)(?:\s*(?:&|and|\/|,)\s*(?:(?:previous|relevant|required)\s+)?(?:qualifications?|requirements?|skills|experience|education|certifications?|licenses?))*$|^what you(?:'ll| will)? (?:need|bring)|^who you are|^you have|^you(?:'ll| will) bring|^knowledge,? skills/
  };
  // A single line that says "preferred"/"a plus" is preferred even inside a required section.
  const INLINE_PREFERRED = /\b(?:preferred|a plus|nice to have|desired|bonus|is a plus|helpful)\b/;

  function classifyHeading(s) {
    const h = s.replace(/^[^a-z]+/, '').replace(/[:\s]+$/, '');
    if (!h || h.length > 50) return null;
    if (HEADING.preferred.test(h)) return 'preferred';
    if (HEADING.other.test(h)) return 'other';
    if (HEADING.required.test(h)) return 'required';
    return null;
  }

  // Returns [{ text, section, preferred }] for every non-empty line of the
  // normalized job text, plus whether any "required" heading was found.
  function splitSections(normText) {
    const out = [];
    let section = 'other';
    let foundRequired = false;
    for (const raw of normText.split(/\n+/)) {
      let line = raw.trim();
      if (!line) continue;
      // Heading on its own line ("Minimum Qualifications") ...
      let kind = line.length <= 60 ? classifyHeading(line) : null;
      // ... or inline heading ("Requirements: 3+ years of ...").
      if (!kind) {
        const m = line.match(/^([^:]{3,45}):\s*(.*)$/);
        if (m) {
          kind = classifyHeading(m[1]);
          if (kind) line = m[2];
        }
      }
      if (kind) {
        section = kind;
        if (kind === 'required') foundRequired = true;
        if (!line || (line.length <= 60 && classifyHeading(line))) continue;
      }
      out.push({ text: line, section, preferred: section === 'preferred' || INLINE_PREFERRED.test(line) });
    }
    return { lines: out, foundRequired };
  }

  // ---------------------------------------------------------------------------
  // Resume scoring
  // ---------------------------------------------------------------------------

  function scoreResumes(normText, normTitle, config, canon) {
    const W = config.weights;
    return config.resumes.map((resume) => {
      let raw = 0;
      const hits = [];
      const lists = [[resume.titleKeywords || {}, true], [resume.bodyKeywords || {}, false]];
      let titleHit = false;
      for (const [list, isTitleList] of lists) {
        for (const [term, weight] of Object.entries(list)) {
          const t = canon(term);
          const n = countTerm(normText, t);
          if (n > 0) {
            const pts = weight * (1 + W.repeatBonus * Math.min(n - 1, W.maxRepeats));
            raw += pts;
            hits.push({ term, count: n, points: Math.round(pts * 10) / 10 });
          }
          if (isTitleList && countTerm(normTitle, t) > 0) titleHit = true;
        }
      }
      // The job title helps, but only by a fixed bonus, so the responsibilities
      // text still decides (an "IT Analyst" full of BA words stays BA).
      if (titleHit) raw += W.jobTitleBonus;
      hits.sort((a, b) => b.points - a.points);
      return {
        id: resume.id,
        name: resume.name,
        filename: resume.filename,
        raw: Math.round(raw * 10) / 10,
        score: Math.min(100, Math.round((100 * raw) / W.fullScoreAt)),
        titleHit,
        hits
      };
    });
  }

  // ---------------------------------------------------------------------------
  // Matched / missing keywords for the top resume
  // ---------------------------------------------------------------------------

  function keywordReport(normText, topResume, config, canon) {
    const skillSet = new Set(config.candidate.skills.map(canon));
    const lacking = new Set(
      [...config.coreTools, ...(config.minorTools || []), ...(config.trackedSkills || [])].map(canon).filter((t) => !skillSet.has(t))
    );
    const topSet = new Set(
      Object.keys(Object.assign({}, topResume.titleKeywords, topResume.bodyKeywords)).map(canon)
    );

    // Vocabulary = every term we know about; remember a nice display label.
    // Low-weight resume keywords (generic words like "build", "platform") are
    // left out so the chips stay meaningful.
    const minWeight = config.weights.keywordReportMinWeight || 0;
    const display = new Map();
    const add = (label) => { const c = canon(label); if (c && !display.has(c)) display.set(c, label); };
    config.candidate.skills.forEach(add);
    config.coreTools.forEach(add);
    (config.minorTools || []).forEach(add);
    (config.trackedSkills || []).forEach(add);
    config.resumes.forEach((r) => {
      for (const [term, w] of Object.entries(Object.assign({}, r.titleKeywords, r.bodyKeywords))) if (w >= minWeight) add(term);
    });

    let found = [];
    for (const [c, label] of display) {
      const n = countTerm(normText, c);
      if (n > 0) found.push({ term: c, label, count: n });
    }
    // Drop terms contained in a longer found term ("root cause" vs "root cause analysis").
    found = found.filter((f) => !found.some((o) => o !== f && o.term.length > f.term.length && countTerm(o.term, f.term) > 0));
    found.sort((a, b) => b.count - a.count);

    // matched:     on the top resume or in your skills
    // missing:     tools/skills you don't have (real gaps, shown in the popup)
    // notOnResume: words from your other resumes that this one lacks
    //              (not shown; added to the Claude prompt as things to work in)
    const matched = [];
    const missing = [];
    const notOnResume = [];
    for (const f of found) {
      if (lacking.has(f.term)) missing.push(f.label);
      else if (topSet.has(f.term) || skillSet.has(f.term)) matched.push(f.label);
      else notOnResume.push(f.label);
    }
    return { matched, missing, notOnResume };
  }

  // ---------------------------------------------------------------------------
  // Red flags
  // ---------------------------------------------------------------------------

  const NUM_WORDS = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, twelve: 12, fifteen: 15 };
  const NUM = '(\\d+(?:\\.\\d+)?|one|two|three|four|five|six|seven|eight|nine|ten|twelve|fifteen)';
  const PAREN = '(?:\\s*\\(\\s*\\d+\\s*\\))?'; // "four (4) years"
  // Matches "3+ years", "3-6 years", "3 to 6 years", "minimum 1 year", "four (4) years".
  const YEARS_RE = new RegExp(NUM + PAREN + '\\s*(\\+|plus)?\\s*(?:(?:-|to)\\s*' + NUM + PAREN + '\\s*)?\\+?\\s*(?:years?|yrs?)\\b', 'g');
  const YEARS_CONTEXT = /experien|work|role|background|industry|professional|hands[\s-]on|minimum|at least|required|related|field/;
  const YEARS_IGNORE = /founded|history|\bold\b|\bage\b|\bago\b|anniversary|vest|401|tenure|pto/;

  function toNum(s) {
    return NUM_WORDS[s] !== undefined ? NUM_WORDS[s] : parseFloat(s);
  }

  // Finds the minimum years required. Returns { required, preferred, mentions }.
  function parseYears(sections) {
    let required = null;
    let preferred = null;
    const mentions = [];
    for (const line of sections.lines) {
      if (YEARS_IGNORE.test(line.text)) continue;
      if (!YEARS_CONTEXT.test(line.text) && line.section !== 'required') continue;
      YEARS_RE.lastIndex = 0;
      let m;
      while ((m = YEARS_RE.exec(line.text))) {
        const min = toNum(m[1]); // for ranges "3-6", the minimum is the first number
        if (!(min >= 0) || min > 20) continue;
        mentions.push({ min, text: m[0].trim(), preferred: line.preferred });
        if (line.preferred) preferred = Math.max(preferred || 0, min);
        else required = Math.max(required || 0, min);
      }
    }
    return { required, preferred, mentions };
  }

  const US_STATES = new Set('AL AK AZ AR CA CO CT DE DC FL GA HI ID IL IN IA KS KY LA ME MD MA MI MN MS MO MT NE NV NH NJ NM NY NC ND OH OK OR PA RI SC SD TN TX UT VT VA WA WV WI WY'.split(' '));

  // Words that start a multi-word city name ("St. Petersburg", "San Diego") or end one ("Kansas City").
  const CITY_PREFIX = /^(?:st\.?|saint|san|santa|los|las|new|fort|ft\.?|palm|port|el|la|north|south|east|west|lake|salt|grand|coral|cape|winter|pinellas|daytona|panama|key|bonita|delray|boca|pompano|plant)$/i;
  const CITY_SUFFIX = /^(?:city|beach|park|springs|falls|heights|harbor|lakes?|rock|hills?|grove|island|gardens|bay|point|village)$/i;

  // "Failure Analyst Phoenix" -> "Phoenix", "Saint Petersburg" stays whole.
  function trimCity(words) {
    let keep = 1;
    while (keep < words.length && (CITY_PREFIX.test(words[words.length - keep - 1]) || CITY_SUFFIX.test(words[words.length - keep]))) keep++;
    return words.slice(-keep).join(' ');
  }

  // Returns one "City, ST" string (or a raw "Location:" value), or null.
  // Whole-page captures include "similar jobs" lists, so a labeled Location
  // line wins, and otherwise only the first City, ST in the text is used.
  function findLocation(original) {
    const cityRe = /\b((?:[A-Z][a-zA-Z.]*\s){0,3}[A-Z][a-zA-Z.]+),\s*(Florida|[A-Z]{2})\b/g;
    const firstCity = (s) => {
      cityRe.lastIndex = 0;
      let m;
      while ((m = cityRe.exec(s))) {
        if (m[2] === 'Florida' || US_STATES.has(m[2])) return trimCity(m[1].split(/\s+/)) + ', ' + m[2];
      }
      return null;
    };
    const lines = original.split(/\n/).map((l) => l.trim());
    for (let i = 0; i < lines.length; i++) {
      // "Location: X" or a bare "Locations" heading (not "Location flexibility is...").
      const m = /^(?:job |work |primary )?locations?(?:\s*[:\-]\s*(.*)|\s*)$/i.exec(lines[i]);
      if (!m) continue;
      // Value on the same line, or on the next non-empty line ("Locations\nPhoenix, AZ").
      let value = m[1] || '';
      for (let j = i + 1; !value && j < lines.length && j <= i + 3; j++) value = lines[j];
      if (!value) continue;
      const city = firstCity(value);
      if (city) return { text: city, isCity: true };
      if (/multiple|various|several/i.test(value)) return { text: 'Multiple locations', isCity: false };
      if (/remote/i.test(value)) return { text: 'Remote', isCity: false };
      return { text: value.split(/[.;|]/)[0].slice(0, 40).trim(), isCity: false };
    }
    const city = firstCity(original);
    return city ? { text: city, isCity: true } : null;
  }

  // Each flag: { type, severity: 'flag' | 'warn' | 'info' | 'plus', text }
  function findRedFlags(job, normText, sections, config, canon) {
    const flags = [];
    const facts = { yearsRequired: null, yearsGap: null, seniorTitle: null, missingRequiredTools: [], missingMinorTools: [], missingRequiredSkills: [] };
    const T = config.thresholds;
    const exp = config.candidate.experienceYears;

    // 1. Years of experience.
    const years = parseYears(sections);
    if (years.required) { // 0 ("0-2 years") is entry level, nothing to report
      facts.yearsRequired = years.required;
      facts.yearsGap = Math.round((years.required - exp) * 10) / 10;
      const said = [...new Set(years.mentions.filter((m) => !m.preferred).map((m) => m.text))];
      const quoted = said.length === 1 && said[0] === `${years.required}+ years` ? '' : ` ("${said.join('", "')}")`;
      const msg = `Requires ${years.required}+ years${quoted}; you have ~${exp}`;
      if (facts.yearsGap > T.flagYearsGap) flags.push({ type: 'years', severity: 'flag', text: msg });
      else flags.push({ type: 'years', severity: 'info', text: `Meets ${years.required}+ years` });
    }
    if (years.preferred !== null && (years.required === null || years.preferred > years.required)) {
      flags.push({ type: 'years', severity: 'info', text: `Prefers ${years.preferred}+ yrs` });
    }

    // 2. Seniority words in the title.
    const title = String(job.title || '').toLowerCase();
    for (const word of config.seniorityWords) {
      if (countTerm(title, word.toLowerCase()) > 0) {
        facts.seniorTitle = word;
        flags.push({ type: 'senior', severity: 'flag', text: `Senior-level title ("${word}")` });
        break;
      }
    }

    // 3. Required tools/skills Tan doesn't have.
    const skillSet = new Set(config.candidate.skills.map(canon));
    // Use the required section if we found one; otherwise the whole posting.
    const reqText = sections.lines.filter((l) => !l.preferred && (!sections.foundRequired || l.section === 'required')).map((l) => l.text).join('\n');
    const allNonPreferred = sections.lines.filter((l) => !l.preferred).map((l) => l.text).join('\n');
    const prefText = sections.lines.filter((l) => l.preferred).map((l) => l.text).join('\n');
    const where = sections.foundRequired ? 'requirements' : 'posting (no requirements section found)';
    const preferredMissing = [];
    for (const tool of config.coreTools) {
      const c = canon(tool);
      if (skillSet.has(c)) continue;
      if (countTerm(reqText, c) > 0) facts.missingRequiredTools.push(tool);
      else if (countTerm(prefText, c) > 0) preferredMissing.push(tool);
    }
    // Minor tools (Excel, Visio, SharePoint...) are quick to learn: warn only.
    for (const tool of config.minorTools || []) {
      const c = canon(tool);
      if (skillSet.has(c)) continue;
      if (countTerm(reqText, c) > 0) facts.missingMinorTools.push(tool);
      else if (countTerm(prefText, c) > 0) preferredMissing.push(tool);
    }
    for (const skill of config.trackedSkills || []) {
      const c = canon(skill);
      if (skillSet.has(c)) continue;
      // Experience areas can hide in the duties list too, so scan all non-preferred text.
      if (countTerm(allNonPreferred, c) > 0) facts.missingRequiredSkills.push(skill);
      else if (countTerm(prefText, c) > 0) preferredMissing.push(skill);
    }
    if (facts.missingRequiredTools.length) {
      flags.push({ type: 'tools', severity: 'flag', text: `Tools in ${where} you don't list: ${facts.missingRequiredTools.join(', ')}` });
    }
    if (facts.missingMinorTools.length) {
      flags.push({ type: 'minor-tools', severity: 'warn', text: `Minor tools you don't list (learnable): ${facts.missingMinorTools.join(', ')}` });
    }
    if (facts.missingRequiredSkills.length) {
      flags.push({ type: 'skills', severity: 'warn', text: `Experience asked for that you don't list: ${facts.missingRequiredSkills.join(', ')}` });
    }
    if (preferredMissing.length) {
      flags.push({ type: 'preferred', severity: 'info', text: `Preferred (not required): ${preferredMissing.join(', ')}` });
    }

    // 4. Citizenship / clearance / sponsorship.
    const clearance = /\b(?:security clearance|secret clearance|top secret|ts\/sci|active clearance|clearance (?:is )?required|obtain (?:and maintain )?(?:a |an )?(?:security |government )?clearance|public trust)\b/.exec(normText);
    if (clearance) flags.push({ type: 'clearance', severity: 'flag', text: `Security clearance mentioned ("${clearance[0]}")` });
    const citizen = /\b(?:u\.?s\.? citizen(?:ship)?|united states citizen(?:ship)?|citizenship (?:is )?required|u\.?s\.? persons?|itar|export[\s-]controll?ed)\b/.exec(normText);
    if (citizen) {
      const sev = config.candidate.usCitizen ? 'plus' : 'flag';
      flags.push({ type: 'citizenship', severity: sev, text: config.candidate.usCitizen ? 'U.S. citizenship required (you qualify)' : 'U.S. citizenship required' });
    }
    // Sponsorship/visa text is not reported: it never matters for a U.S. citizen.
    if (!config.candidate.usCitizen && /\b(?:no|not|unable to)\b[^.]{0,40}\bsponsor/.test(normText)) {
      flags.push({ type: 'sponsorship', severity: 'flag', text: 'No visa sponsorship' });
    }

    // 5. Work arrangement and location (short: shown on one summary line).
    const days = /\b(\d|one|two|three|four|five)(?:\s*\(\d\))?\s*days?\s*(?:a|per|\/|each|of the)?\s*week\b/.exec(normText);
    const hybrid = /\bhybrid\b/.test(normText);
    const arrangement = [];
    if (hybrid) arrangement.push('Hybrid');
    else if (/\b(?:on[\s-]?site|in[\s-]office|in[\s-]person|in the office)\b/.test(normText)) arrangement.push('On-site');
    if (/\b(?:fully remote|100% remote|remote)\b/.test(normText)) arrangement.push('Remote mentioned');
    if (days) arrangement.push(`${toNum(days[1])} days/wk in office`);
    if (arrangement.length) flags.push({ type: 'arrangement', severity: 'info', text: arrangement.join(', ') });

    const location = findLocation(String(job.text || ''));
    if (location) {
      const near = config.candidate.nearbyAreas.map((a) => a.toLowerCase());
      const local = near.some((a) => location.text.toLowerCase().includes(a));
      // Only warn when we found a real "City, ST" that is far away.
      const far = location.isCity && !local;
      flags.push({
        type: 'location',
        severity: far ? 'warn' : 'info',
        text: far ? `${location.text} — not near ${config.candidate.location}` : location.text
      });
    }

    return { flags, facts };
  }

  // ---------------------------------------------------------------------------
  // Verdict
  // ---------------------------------------------------------------------------

  function decideVerdict(sorted, facts, config) {
    const T = config.thresholds;
    const top = sorted[0];
    const second = sorted[1] || { score: 0 };
    const reasons = [];

    if (facts.yearsGap !== null && facts.yearsGap > T.skipYearsGap) reasons.push(`needs ${facts.yearsRequired}+ years`);
    if (facts.missingRequiredTools.length >= T.skipMissingRequiredTools) reasons.push(`${facts.missingRequiredTools.length} required tools missing`);
    if (facts.seniorTitle) reasons.push('senior-level title');
    if (reasons.length) return { type: 'skip', label: 'Likely skip', reasons };

    if (top.score < T.tailorBelowScore) {
      return { type: 'tailor', label: 'Tailor on Claude', reasons: ['No resume fits well enough to send as is.'] };
    }
    if (top.score - second.score <= T.closeScoreGap) {
      return { type: 'tailor', label: 'Tailor on Claude', reasons: [`${top.name} and ${second.name} fit about equally.`] };
    }
    return { type: 'use', label: `Use ${top.name}`, reasons: [`Attach ${top.filename} · ${top.score - second.score} pts ahead of ${second.name}`] };
  }

  // ---------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------

  /**
   * Analyze one job posting.
   * @param {{text: string, title?: string, company?: string, url?: string}} job
   * @param {object} config parsed config.json
   */
  function analyze(job, config) {
    const normalize = makeNormalizer(config);
    const canon = (term) => normalize(term).trim();
    const normText = normalize(job.text);
    const normTitle = normalize(job.title);

    const scores = scoreResumes(normText, normTitle, config, canon).sort((a, b) => b.score - a.score || b.raw - a.raw);
    const top = scores[0];
    const topResume = config.resumes.find((r) => r.id === top.id);
    const keywords = keywordReport(normText, topResume, config, canon);
    const sections = splitSections(normText);
    const { flags, facts } = findRedFlags(job, normText, sections, config, canon);
    const verdict = decideVerdict(scores, facts, config);

    return { scores, top, verdict, matched: keywords.matched, missing: keywords.missing, notOnResume: keywords.notOnResume, flags, facts, foundRequiredSection: sections.foundRequired };
  }

  // Fill config.claudePromptTemplate for the "Tailor on Claude" button.
  function buildClaudePrompt(result, jobText, config) {
    const serious = result.flags.filter((f) => f.severity === 'flag' || f.severity === 'warn').map((f) => f.text);
    // Function replacers so "$" in the job text (salaries) is inserted literally.
    return config.claudePromptTemplate
      .replace('{resume}', () => result.top.name)
      .replace('{missing}', () => {
        const all = [...result.missing, ...(result.notOnResume || [])];
        return all.length ? all.join(', ') : 'none found';
      })
      .replace('{flags}', () => (serious.length ? serious.join('; ') : 'none'))
      .replace('{jobText}', () => String(jobText || '').trim());
  }

  return { analyze, buildClaudePrompt, _internal: { termRegex, countTerm, makeNormalizer, splitSections, parseYears } };
});
