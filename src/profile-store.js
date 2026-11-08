/**
 * profile-store.js — your autofill profile, kept in chrome.storage.local only
 * (never in git, never sent anywhere). Edited on the settings page, read by
 * the popup when you click Autofill.
 *
 * Dates use the browser's month format "YYYY-MM"; school dates are years.
 * Every answer is plain text that autofill matches against the site's options,
 * so "No" picks "No", "Asian" picks "Asian (Not Hispanic or Latino)", etc.
 */
(function (root) {
  'use strict';

  const KEY = 'profile';

  function emptyProfile() {
    return {
      first: '', last: '', email: '', phone: '', phoneType: 'Mobile',
      address1: '', address2: '', city: '', state: '', zip: '', country: 'United States of America',
      linkedin: '', github: '', website: '',
      authorized: 'Yes', sponsorship: 'No',
      jobs: [],     // { title, company, location, start: 'YYYY-MM', end: 'YYYY-MM', current, description }
      schools: [],  // { school, degree, field, start: 'YYYY', end: 'YYYY', gpa }
      eeo: { gender: '', hispanic: '', ethnicity: '', veteran: '', disability: '' },
      // Other questions: if a question's label contains `q`, answer with `a`.
      answers: [
        { q: 'how did you hear', a: 'LinkedIn' },
        { q: 'previously worked', a: 'No' },
        { q: 'previously been employed', a: 'No' },
        { q: '18 years', a: 'Yes' },
        { q: 'non-compete', a: 'No' }
      ]
    };
  }

  // Fill in fields added in later versions so old saved profiles still work.
  function withDefaults(p) {
    const base = emptyProfile();
    const out = Object.assign(base, p || {});
    out.eeo = Object.assign(emptyProfile().eeo, (p && p.eeo) || {});
    for (const k of ['jobs', 'schools', 'answers']) if (!Array.isArray(out[k])) out[k] = base[k];
    return out;
  }

  async function getProfile() {
    const data = await chrome.storage.local.get(KEY);
    return withDefaults(data[KEY]);
  }

  async function saveProfile(p) {
    await chrome.storage.local.set({ [KEY]: withDefaults(p) });
  }

  // Enough to be worth autofilling: a name and an email.
  const isSetUp = (p) => Boolean(p && p.first && p.last && p.email);

  root.ProfileStore = { getProfile, saveProfile, emptyProfile, withDefaults, isSetUp };
})(typeof self !== 'undefined' ? self : this);
