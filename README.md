# resumatch — Resume Matcher Chrome extension

Picks which of 4 resumes to send for a job posting, flags dealbreakers, and tells you
when none fit well enough so you should get a tailored version from Claude.
Manifest V3, plain JavaScript, no build step, no external API calls.

## Install

1. Open `chrome://extensions` in Chrome.
2. Turn on **Developer mode** (top-right toggle).
3. Click **Load unpacked** and select this folder (the one containing `manifest.json`).
4. Optional: click the puzzle-piece icon in the toolbar and pin **Resume Matcher**.

After editing `config.json` or any code, click the reload icon on the extension's card in
`chrome://extensions`, then reopen the popup.

## Use

1. Open a job posting and highlight the job description (or skip highlighting).
2. Click the extension icon. A highlighted selection is analyzed right away; otherwise click
   **Use whole page**.
3. Check the title/company the popup guessed and fix them if needed. Changing the title
   re-runs the analysis.
4. Read the verdict:
   - **Use [resume]**: send that resume.
   - **Tailor on Claude**: click **Copy prompt & open Claude**, then paste into the new chat.
   - **Likely skip**: the reasons are listed under the verdict.
5. Pick the resume you used and click **Log this application**. If the URL or
   company + title is already in the log, you get a warning; click again to log anyway.
6. **View log** opens the log page (filter, delete, clear, **Export CSV**).

Pages Chrome won't let extensions read (PDFs, `chrome://` pages, the Web Store) show a
message. Paste the text into **Job text** at the bottom of the popup and click **Re-analyze**.

## How scoring works (`src/scoring.js`)

- Job text is lowercased and synonyms are rewritten (`"Amazon Web Services"` → `aws`).
- Each resume earns points for every keyword found: its weight, plus `repeatBonus` per
  extra occurrence (up to `maxRepeats`).
- If one of a resume's `titleKeywords` is in the posting title, it gets a flat
  `jobTitleBonus`. The title helps but cannot decide alone: an "IT Analyst" posting full of
  automation/dashboard/stakeholder words still goes to Business Analyst.
- Score = `min(100, 100 × points / fullScoreAt)`.

Red flags:

| Check | Effect |
|---|---|
| Years required ("3+ years", "3-6 years", "minimum one year", "four (4) years") | Flag if more than `flagYearsGap` above `experienceYears`; skip if more than `skipYearsGap` |
| Senior title (`seniorityWords`) | Skip |
| `coreTools` in the required section that are not in `candidate.skills` | Flag; `skipMissingRequiredTools` or more means skip |
| `minorTools` (Excel, Visio, SharePoint...) in the required section that are not in your skills | Warning only |
| `trackedSkills` (e.g. vendor management) asked for and not in your skills | Warning only |
| Security clearance | Flag |
| U.S. citizenship / ITAR | Shown as a plus |
| Hybrid/on-site/remote, days per week | Info (sponsorship text is ignored for U.S. citizens) |
| Location outside `nearbyAreas` (a "Location:" line wins, else the first "City, ST") | Warning |

The required section is found from headings such as "Qualifications", "Requirements" and
"What you'll need". Lines under "Preferred" headings, or that say "preferred" or "a plus",
don't count as required. If no requirements heading is found, the whole posting is scanned.

Verdict order: **Likely skip** rules first. Then **Tailor on Claude** if the top score is
below `tailorBelowScore` or the top two are within `closeScoreGap` points. Otherwise
**Use [top resume]**.

## Tuning (`config.json`)

All weights, keyword lists, skills, synonyms, tools, thresholds and the Claude prompt
template live in `config.json`. Keys starting with `_` are notes and are ignored.

I added a few keywords beyond the starter lists so each resume has enough distinct signal,
for example `laptops`, `printers` and `deskside` (IT Support), `outage` and `batch`
(Tech Support), `user stories` and `power automate` (Business Analyst). "Requirements" was
split into `requirements gathering` and `business requirements`, because almost every
posting has a "Requirements" heading.

## Tests

```bash
node tests/run-tests.js
```

1. Paste each job description into its file in `tests/fixtures/`, replacing the
   placeholder. A case is skipped while its placeholder is still there.
2. Expectations live in `tests/cases.json` (`expectResume`, `notResume`, `expectVerdict`,
   `expectFlags`).
3. The runner prints pass/fail, every resume's score and raw points, the top resume's
   keyword hits, matched/missing keywords and all flags. Adjust `config.json` and re-run.

Run single cases with `node tests/run-tests.js 1 6`.

## Files

```
manifest.json        extension manifest (MV3)
config.json          resumes, keywords, skills, synonyms, thresholds
src/scoring.js       scoring, red flags, verdict (runs in browser and Node)
src/log-store.js     application log in chrome.storage.local, CSV export
popup/               popup UI
log/                 log page
tests/               Node test runner, cases, fixtures
```
