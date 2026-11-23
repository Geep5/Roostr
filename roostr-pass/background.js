// Roostr Pass's service worker: runs a pass (pass.js) when Chrome starts,
// every minute while it is open, and a few seconds after a watched site's
// signed-in cookie changes (the person just signed in); the badge counts the
// logins waiting on the person.

import { runPass, siteOf, waitingOnYou } from "./pass.js";

const ALARM = "roostr-pass";
let running = null;
let again = false;

async function pass() {
  if (running) {
    again = true;
    return running;
  }
  running = (async () => {
    try {
      let result;
      do {
        again = false;
        result = await runPass();
      } while (again);
      await chrome.storage.session.set({ last: { ...result, at: Date.now() } });
      const count = waitingOnYou(result);
      await chrome.action.setBadgeBackgroundColor({ color: result.error ? "#888888" : "#d97706" });
      await chrome.action.setBadgeText({ text: result.error ? "!" : count > 0 ? String(count) : "" });
      return result;
    } finally {
      running = null;
    }
  })();
  return running;
}

chrome.runtime.onInstalled.addListener(() => {
  chrome.alarms.create(ALARM, { periodInMinutes: 1 });
  void pass();
});
chrome.runtime.onStartup.addListener(() => {
  chrome.alarms.create(ALARM, { periodInMinutes: 1 });
  void pass();
});
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === ALARM) void pass();
});

let cookieTimer = null;
chrome.cookies.onChanged.addListener(async ({ cookie, removed }) => {
  if (removed) return;
  const { last } = await chrome.storage.session.get("last");
  const watched = (last?.logins ?? []).some((l) => l.needs && l.cookie === cookie.name && cookie.domain.replace(/^\./, "").endsWith(siteOf(l)));
  if (!watched) return;
  // The site sets its other cookies right after the signed-in one.
  clearTimeout(cookieTimer);
  cookieTimer = setTimeout(() => void pass(), 3000);
});

chrome.runtime.onMessage.addListener((message, _sender, reply) => {
  if (message?.type === "pass") {
    pass().then(reply);
    return true;
  }
  return false;
});
