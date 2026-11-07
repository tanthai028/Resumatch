#!/usr/bin/env node
/**
 * Runs the scoring module against saved job descriptions in tests/fixtures/
 * and checks the expectations in tests/cases.json.
 *
 *   node tests/run-tests.js        run all cases
 *   node tests/run-tests.js 1 6    run only cases 1 and 6
 *
 * Case fields:
 *   expectResume   name of the resume that should score highest
 *   notResume      name of a resume that must NOT be the top pick
 *   expectVerdict  "use" | "tailor" | "skip"
 *   expectFlags    substrings that must appear in a red flag (severity flag/warn), case-insensitive
 *
 * Fixtures still containing the placeholder text are reported as SKIP.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { analyze } = require('../src/scoring.js');

const config = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'config.json'), 'utf8'));
const cases = JSON.parse(fs.readFileSync(path.join(__dirname, 'cases.json'), 'utf8'));
const PLACEHOLDER = 'PASTE THE JOB DESCRIPTION HERE';

const only = process.argv.slice(2).map(Number).filter(Boolean);
const color = (code) => (s) => (process.stdout.isTTY ? `\x1b[${code}m${s}\x1b[0m` : s);
const green = color(32), red = color(31), yellow = color(33), dim = color(2);

let pass = 0, fail = 0, skip = 0;

for (const c of cases) {
  if (only.length && !only.includes(c.id)) continue;
  const header = `${c.id}. ${c.company} – ${c.title}`;
  const text = fs.readFileSync(path.join(__dirname, 'fixtures', c.file), 'utf8');

  if (text.includes(PLACEHOLDER)) {
    skip++;
    console.log(`${yellow('[SKIP]')} ${header} ${dim('(fixture not filled in: tests/fixtures/' + c.file + ')')}\n`);
    continue;
  }

  const r = analyze({ text, title: c.title, company: c.company, url: '' }, config);
  const errors = [];

  if (c.expectResume && r.top.name !== c.expectResume) errors.push(`expected top resume "${c.expectResume}", got "${r.top.name}"`);
  if (c.notResume && r.top.name === c.notResume) errors.push(`top resume must not be "${c.notResume}"`);
  if (c.expectVerdict && r.verdict.type !== c.expectVerdict) errors.push(`expected verdict "${c.expectVerdict}", got "${r.verdict.type}"`);
  const flagText = r.flags.filter((f) => f.severity === 'flag' || f.severity === 'warn').map((f) => f.text).join(' || ').toLowerCase();
  for (const want of c.expectFlags || []) {
    if (!flagText.includes(want.toLowerCase())) errors.push(`missing red flag containing "${want}"`);
  }

  if (errors.length) fail++; else pass++;
  console.log(`${errors.length ? red('[FAIL]') : green('[PASS]')} ${header}`);
  console.log('  Scores:  ' + r.scores.map((s) => `${s.name} ${s.score} ${dim('(raw ' + s.raw + (s.titleHit ? ', title bonus' : '') + ')')}`).join(' | '));
  console.log(`  Verdict: ${r.verdict.label} — ${r.verdict.reasons.join('; ')}`);
  console.log('  Top hits: ' + dim(r.top.hits.slice(0, 10).map((h) => `${h.term}×${h.count}`).join(', ')));
  console.log('  Matched: ' + (r.matched.join(', ') || '-'));
  console.log('  Missing: ' + (r.missing.join(', ') || '-'));
  console.log(`  Flags${r.foundRequiredSection ? '' : dim(' (no requirements heading found)')}:`);
  for (const f of r.flags) console.log(`    [${f.severity}] ${f.text}`);
  for (const e of errors) console.log(red('  ✗ ' + e));
  console.log('');
}

console.log(`${green(pass + ' passed')}, ${fail ? red(fail + ' failed') : '0 failed'}, ${skip ? yellow(skip + ' skipped') : '0 skipped'}`);
process.exit(fail ? 1 : 0);
