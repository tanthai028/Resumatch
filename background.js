/**
 * background.js — keeps the toolbar badge showing how many applications
 * are due for a follow-up. Recounts when the log changes, when Chrome
 * starts, and once an hour (so a job crosses the line without any click).
 */
'use strict';

importScripts('src/log-store.js');

async function updateBadge() {
  let days = 10;
  try {
    const config = await (await fetch(chrome.runtime.getURL('config.json'))).json();
    days = config.thresholds.followUpDays ?? days;
  } catch (e) { /* keep the default */ }
  const log = await LogStore.getLog();
  const due = log.filter((e) => LogStore.followUpDue(e, days)).length;
  await chrome.action.setBadgeText({ text: due ? String(due) : '' });
  await chrome.action.setBadgeBackgroundColor({ color: '#ffe74c' });
  await chrome.action.setBadgeTextColor({ color: '#111111' });
  await chrome.action.setTitle({ title: due ? `Match this job to a resume (${due} to follow up)` : 'Match this job to a resume' });
}

chrome.runtime.onInstalled.addListener(() => {
  chrome.alarms.create('badge', { periodInMinutes: 60 });
  updateBadge();
});
chrome.runtime.onStartup.addListener(updateBadge);
chrome.alarms.onAlarm.addListener(updateBadge);
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes.applications) updateBadge();
});
