'use strict';
// מאפשר לרקע של התוסף לשלוח בקשה ליד 2 דרך לשונית פתוחה, כמו בקשה רגילה מהדף.
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || msg.type !== 'mz-fetch') return false;
  const url = new URL(msg.url, location.origin);
  if (url.origin !== location.origin) { sendResponse(null); return false; }
  fetch(url, { credentials: 'same-origin', headers: msg.accept ? { accept: msg.accept } : {} })
    .then(async (r) => sendResponse({ status: r.status, body: await r.text() }))
    .catch(() => sendResponse(null));
  return true;
});
