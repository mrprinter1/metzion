'use strict';
// מציאון: בדיקה ברקע של חיפושים שמורים, והתראות (מחשב וטלגרם) על מציאות חדשות.
// רץ רק כשכרום פתוח. כשהמחשב כבוי או ישן לא נבדק כלום, ובהדלקה הבאה מתקבל מה שעלה בינתיים.
importScripts('core.js', 'net.js');

const M = globalThis.Metzion;
const BASE = 'https://www.yad2.co.il';
const MIN_SHOW = 10;
const MAX_SEARCHES = 3;
const BLOCK_PAUSE = 3600e3;
// התראות הן פיצ'ר פרימיום. בינתיים פתוח לכולם (תקופת ניסיון). כשיהיה שרת מנויים, הבדיקה תיכנס כאן.
const PREMIUM = { alerts: true };

const DEFAULT_SETTINGS = {
  intervalMin: 15,
  quiet: { enabled: false, from: '23:00', to: '07:00' },
  telegram: { enabled: false, token: '', chatId: '' },
};

async function getSettings() {
  const { settings } = await chrome.storage.local.get('settings');
  const s = settings || {};
  return {
    ...DEFAULT_SETTINGS, ...s,
    quiet: { ...DEFAULT_SETTINGS.quiet, ...(s.quiet || {}) },
    telegram: { ...DEFAULT_SETTINGS.telegram, ...(s.telegram || {}) },
  };
}

async function ensureAlarm() {
  const s = await getSettings();
  const period = Math.max(10, Number(s.intervalMin) || 15);
  const cur = await chrome.alarms.get('poll');
  if (!cur || cur.periodInMinutes !== period) chrome.alarms.create('poll', { periodInMinutes: period, delayInMinutes: 1 });
}

chrome.runtime.onInstalled.addListener(ensureAlarm);
chrome.runtime.onStartup.addListener(ensureAlarm);
chrome.storage.onChanged.addListener((changes) => { if (changes.settings) ensureAlarm(); });
chrome.alarms.onAlarm.addListener((a) => { if (a.name === 'poll') pollAll(false); });
chrome.action.onClicked.addListener(() => chrome.runtime.openOptionsPage());

// אם יש לשונית פתוחה של יד 2, הבקשה יוצאת דרכה (כמו בקשה רגילה מהדף). אחרת, ישירות מהרקע.
async function pickFetcher() {
  let tabs = [];
  try { tabs = await chrome.tabs.query({ url: `${BASE}/*` }); } catch (e) { tabs = []; }
  const tab = tabs.find((t) => t.status === 'complete') || tabs[0];
  return async (url, opts) => {
    if (tab) {
      try {
        const res = await chrome.tabs.sendMessage(tab.id, { type: 'mz-fetch', url, accept: opts.headers && opts.headers.accept });
        if (res) return new Response(res.body, { status: res.status || 500 });
      } catch (e) { /* אין סקריפט בלשונית, ממשיכים לבקשה ישירה */ }
    }
    return fetch(url, opts);
  };
}

let polling = false;

async function pollAll(force) {
  if (polling || !PREMIUM.alerts) return { ok: false, reason: polling ? 'busy' : 'premium' };
  polling = true;
  try {
    const s = await getSettings();
    const now = Date.now();
    if (!force && s.quiet.enabled && M.inQuietHours(new Date(), s.quiet.from, s.quiet.to)) return { ok: false, reason: 'quiet' };
    const o = await chrome.storage.local.get(['searches', 'pollBlockedUntil', 'marks']);
    if (!force && (o.pollBlockedUntil || 0) > now) return { ok: false, reason: 'blocked' };
    const searches = o.searches || [];
    const net = MetzionNet.create({ base: BASE, fetcher: await pickFetcher() });
    let hits = 0;
    for (const srch of searches) {
      if (!srch.enabled) continue;
      hits += await pollOne(net, srch, s, o.marks || {});
      if (net.st.blocked) break;
    }
    const patch = { searches };
    if (net.st.blocked) patch.pollBlockedUntil = now + BLOCK_PAUSE;
    await chrome.storage.local.set(patch);
    return { ok: !net.st.blocked, hits };
  } finally {
    polling = false;
  }
}

async function pollOne(net, srch, settings, marks) {
  const now = Date.now();
  const url = new URL(srch.url);
  url.searchParams.delete('page');
  url.searchParams.set('Order', '1'); // הכי חדשות קודם
  const r = await net.fetchText(url.pathname + url.search);
  srch.lastRun = now;
  if (net.st.blocked) { srch.status = 'blocked'; return 0; }
  const data = r.ok ? M.parseNextDataFromHtml(r.text) : null;
  if (!data) { srch.status = 'error'; return 0; }
  net.st.vehiclesBuildId = data.buildId || null;
  const ads = M.extractAds(data);

  // בפעם הראשונה רק זוכרים מה כבר קיים, כדי לא להציף בהתראות על מודעות ישנות.
  if (!srch.seeded) {
    srch.seen = ads.map((a) => a.token);
    srch.seeded = true;
    srch.status = 'ok';
    return 0;
  }

  const seen = new Set(srch.seen || []);
  const market = M.marketStats(ads);
  const f = srch.filters || {};
  const minPct = Math.max(MIN_SHOW, Number(f.minPct) || MIN_SHOW);
  const found = [];
  for (const ad of ads) {
    if (seen.has(ad.token)) continue;
    seen.add(ad.token);
    if (marks[ad.token] === 'hidden') continue;
    if (!(ad.price > 0) || !ad.subModelId || !ad.year) continue;
    if (f.maxHand && ad.hand && ad.hand > f.maxHand) continue;
    if (f.seller && f.seller !== 'all' && ad.adType && ad.adType !== f.seller) continue;
    const lp = await net.listPrice(ad.subModelId, ad.year);
    if (net.st.blocked) break;
    const ms = market.get(`${ad.subModelId}/${ad.year}`);
    const pct = M.discountPct(lp, ad.price);
    const mp = ms ? M.discountPct(ms.median, ad.price) : null;
    const best = Math.max(pct == null ? -Infinity : pct, mp == null ? -Infinity : mp);
    if (!(best >= minPct)) continue;
    const it = await net.itemInfo(ad.token);
    if (net.st.blocked) break;
    if (f.maxKm && it && it.km && it.km > f.maxKm) continue;
    found.push({
      ad, pct, mp, km: it && it.km,
      kmFlag: it && it.km ? M.kmFlag(it.km, ad.year, now) : null,
      flags: M.suspicion(best, it && it.description),
    });
  }
  srch.seen = [...seen].slice(-500);
  srch.status = net.st.blocked ? 'blocked' : 'ok';
  srch.hits = (srch.hits || 0) + found.length;
  if (found.length) srch.lastHit = now;
  for (const hit of found) await notify(hit, srch, settings);
  return found.length;
}

// ---------- התראות ----------
const nf = new Intl.NumberFormat('he-IL');
const kmShort = (km) => (km >= 1000 ? `${nf.format(Math.round(km / 1000))} אלף ק״מ` : `${nf.format(km)} ק״מ`);

function describe(hit) {
  const { ad, pct, mp } = hit;
  const deal = pct != null && pct >= MIN_SHOW ? `${pct}% מתחת למחירון` : `${mp}% מתחת לשוק`;
  const title = `${ad.name || 'רכב'} ${ad.year}${ad.hand ? ' · יד ' + ad.hand : ''}`;
  const line = `${nf.format(ad.price)} ₪ · ${deal}`;
  const km = hit.km ? kmShort(hit.km) + (hit.kmFlag === 'high' ? ' (גבוה)' : '') : '';
  return { title, line, km, url: `${BASE}/vehicles/item/${ad.token}` };
}

async function notify(hit, srch, settings) {
  const d = describe(hit);
  chrome.notifications.create(`mz:${hit.ad.token}:${Date.now()}`, {
    type: 'basic',
    iconUrl: chrome.runtime.getURL('icons/icon128.png'),
    title: `מציאון · ${d.title}`,
    message: [d.line, d.km].filter(Boolean).join(' · '),
    contextMessage: hit.flags.length ? `⚠ ${hit.flags[0]}` : srch.title || '',
    priority: 2,
  });
  if (settings.telegram.enabled && settings.telegram.token && settings.telegram.chatId) {
    const text = [
      '🚗 מציאון: מציאה חדשה',
      d.title,
      d.line,
      d.km,
      hit.ad.subModelText,
      hit.flags.length ? `⚠ ${hit.flags.join(' · ')}` : '',
      d.url,
    ].filter(Boolean).join('\n');
    await sendTelegram(settings.telegram, text);
  }
}

chrome.notifications.onClicked.addListener((id) => {
  const m = /^mz:([^:]+):/.exec(id);
  if (m) chrome.tabs.create({ url: `${BASE}/vehicles/item/${m[1]}` });
  chrome.notifications.clear(id);
});

async function sendTelegram(tg, text) {
  try {
    const r = await fetch(`https://api.telegram.org/bot${tg.token}/sendMessage`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ chat_id: tg.chatId, text }),
    });
    const j = await r.json().catch(() => ({}));
    return { ok: !!j.ok, error: j.description || (r.ok ? '' : `HTTP ${r.status}`) };
  } catch (e) {
    return { ok: false, error: 'אין חיבור לטלגרם' };
  }
}

// מוצא את ה-chat id מההודעה האחרונה שנשלחה לבוט.
async function telegramConnect(token) {
  try {
    const r = await fetch(`https://api.telegram.org/bot${token}/getUpdates`);
    const j = await r.json();
    if (!j.ok) return { ok: false, error: j.description || 'הטוקן לא תקין' };
    const last = [...(j.result || [])].reverse().find((u) => u.message && u.message.chat);
    if (!last) return { ok: false, error: 'לא נמצאה הודעה. שלחו לבוט הודעה כלשהי ונסו שוב' };
    return { ok: true, chatId: String(last.message.chat.id), name: last.message.chat.first_name || last.message.chat.title || '' };
  } catch (e) {
    return { ok: false, error: 'אין חיבור לטלגרם' };
  }
}

// ---------- הודעות מהפאנל ומעמוד ההגדרות ----------
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  const reply = (p) => { Promise.resolve(p).then(sendResponse, (e) => sendResponse({ ok: false, error: String(e) })); return true; };
  switch (msg && msg.type) {
    case 'openOptions': chrome.runtime.openOptionsPage(); return false;
    case 'pollNow': return reply(pollAll(true));
    case 'telegramConnect': return reply(telegramConnect(msg.token));
    case 'telegramTest': return reply(getSettings().then((s) => sendTelegram({ ...s.telegram, ...(msg.telegram || {}) },
      '✅ מציאון מחובר. מכאן תגיע התראה כשתעלה מציאה בחיפושים השמורים.')));
    case 'saveSearch': return reply(saveSearch(msg.search));
    default: return false;
  }
});

async function saveSearch(search) {
  const { searches = [] } = await chrome.storage.local.get('searches');
  const i = searches.findIndex((x) => x.url === search.url);
  if (i >= 0) { searches.splice(i, 1); await chrome.storage.local.set({ searches }); return { ok: true, saved: false }; }
  if (searches.length >= MAX_SEARCHES) return { ok: false, error: `אפשר לשמור עד ${MAX_SEARCHES} חיפושים. נהלו אותם בהגדרות` };
  searches.push({ ...search, id: String(Date.now()), enabled: true, createdAt: Date.now(), seeded: (search.seen || []).length > 0 });
  await chrome.storage.local.set({ searches });
  ensureAlarm();
  return { ok: true, saved: true };
}
