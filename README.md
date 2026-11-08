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

1. Open a job posting and highlight the job description.
2. Click the extension icon. A highlighted selection is analyzed right away; otherwise click
   **Analyze whole page**, or **or paste text** for pages Chrome won't let extensions read
   (PDFs, `chrome://` pages, the Web Store).
3. Check the title, company and job ID the popup filled in. They look like plain text but
   are editable; changing the title re-runs the analysis.
4. Read the verdict:
   - **Use [resume]**: send that resume.
   - **Tailor on Claude**: click **Copy prompt and open Claude**, then paste into the new chat.
   - **Likely skip**: the reason is shown under the verdict.
5. Pick the resume you sent and click **Log it**. **Undo** removes it again. If the URL,
   company + title, or company + job ID is already logged, the button asks **Log again?**.
6. **View log** opens the log page: date, company, role (links to the posting), job ID,
   resume sent (links to the PDF) and match level (High / Medium / Low). Filter with `/`,
   remove rows or clear all (both undoable for 10 seconds), and **Export CSV**.
7. **Status** is Applied, Interview, Offer or Rejected. Rejected rows fade back.
8. **Follow-ups:** an application still marked Applied after `thresholds.followUpDays`
   (default 10) shows **Follow up** in its Status cell. After you follow up, click **Done**
   to restart the count. The toolbar icon shows how many are due.
9. **Click a row** to open its details: change the status, mark a follow-up, and keep
   notes (recruiter, salary, interview dates). Notes save as you type and are searchable
   with the filter.

To make the resume links work, copy your PDFs into `resumes/` (see `resumes/README.md`).
They are ignored by git.

## Autofill (Workday)

1. Click **Profile** in the popup (or the extension's Options) and fill in your contact
   details, work history, education, voluntary disclosures and other answers. It saves
   as you type, in this browser only. **Download profile** makes a backup.
2. On a Workday application page (`…myworkdayjobs.com/…/apply/…`), open the popup. It
   shows **Autofill** instead of a match. Pick the resume to upload (it defaults to the
   one you logged for this job), then click **Autofill**.
3. It fills empty fields only, adds Work Experience / Education blocks as needed, and
   lists any required fields still empty. It never clicks Next, Submit, or terms/consent
   boxes. Check the page, click Next, and run Autofill again on each page.

Questions it doesn't know: add them under **Other answers** (e.g. "salary" → "Open to
discuss"). Workday sites vary, so if a field is missed, fill it by hand.

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
background.js        toolbar badge: count of applications due for a follow-up
src/scoring.js       scoring, red flags, verdict (runs in browser and Node)
src/log-store.js     application log in chrome.storage.local, CSV export
src/profile-store.js autofill profile in chrome.storage.local
src/autofill.js      form filler injected into Workday application pages
settings/            profile page (Options)
popup/               popup UI
log/                 log page
tests/               Node test runner, cases, fixtures
icons/               extension icons (regenerate with `node tools/make-icons.js`)
resumes/             your resume PDFs, linked from the log (git-ignored)
```
