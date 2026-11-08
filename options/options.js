'use strict';
const $ = (id) => document.getElementById(id);
const DEFAULTS = { intervalMin: 15, quiet: { enabled: false, from: '23:00', to: '07:00' }, telegram: { enabled: false, key: '', name: '' } };
const SERVER = ((window.MetzionConfig && window.MetzionConfig.server) || '').replace(/\/+$/, '');
let settings = DEFAULTS;

function ago(ts) {
  if (!ts) return 'עוד לא נבדק';
  const m = Math.round((Date.now() - ts) / 60000);
  if (m < 1) return 'נבדק עכשיו';
  if (m < 60) return `נבדק לפני ${m} דק׳`;
  const h = Math.round(m / 60);
  return h < 24 ? `נבדק לפני ${h} שע׳` : `נבדק לפני ${Math.round(h / 24)} ימים`;
}
const STATUS = { blocked: 'יד 2 חסמה בקשות, ננסה שוב בעוד שעה', error: 'הבדיקה נכשלה, ננסה שוב בבדיקה הבאה' };

async function load() {
  const o = await chrome.storage.local.get(['settings', 'searches']);
  const s = o.settings || {};
  settings = { ...DEFAULTS, ...s, quiet: { ...DEFAULTS.quiet, ...(s.quiet || {}) }, telegram: { ...DEFAULTS.telegram, ...(s.telegram || {}) } };
  $('interval').value = String(settings.intervalMin);
  $('quietOn').checked = settings.quiet.enabled;
  $('quietFrom').value = settings.quiet.from;
  $('quietTo').value = settings.quiet.to;
  $('tgOn').checked = settings.telegram.enabled;
  syncDisabled();
  renderSearches(o.searches || []);
  const t = settings.telegram;
  if (SERVER && !t.key && t.pendingKey && Date.now() - (t.pendingAt || 0) < PENDING_TTL && !linking) watchLink();
  refreshLicense();
}

async function refreshLicense() {
  const badge = $('licBadge');
  const status = $('licStatus');
  const form = $('licForm');
  const msg = $('licMsg');
  if (!badge) return;
  const lic = await chrome.runtime.sendMessage({ type: 'getLicense' });
  form.hidden = false;
  if (lic && lic.key) $('licKey').value = lic.key;
  if (!lic || !lic.active) {
    badge.textContent = 'לא פעיל';
    badge.className = 'premium dim';
    const left = lic && lic.trialEnds ? Math.ceil((lic.trialEnds - Date.now()) / 864e5) : 0;
    status.textContent = left > 0
      ? `תקופת הניסיון הסתיימה. הזינו מפתח רישיון כדי להמשיך לקבל התראות.`
      : 'ההתראות דורשות מנוי. הזינו מפתח רישיון שקיבלתם אחרי התשלום.';
    msg.textContent = '';
    return;
  }
  if (lic.source === 'trial') {
    const left = Math.max(0, Math.ceil((lic.trialEnds - Date.now()) / 864e5));
    badge.textContent = `ניסיון · ${left} ימים`;
    badge.className = 'premium';
    status.textContent = `תקופת ניסיון פעילה (${left} ימים נותרים). אחריה צריך מפתח רישיון להתראות.`;
  } else {
    badge.textContent = 'מנוי פעיל';
    badge.className = 'premium ok';
    status.textContent = lic.expiresAt
      ? `מנוי פעיל עד ${new Date(lic.expiresAt).toLocaleDateString('he-IL')}.`
      : 'מנוי פעיל.';
  }
  msg.textContent = '';
}

$('licSave') && $('licSave').addEventListener('click', async () => {
  const key = ($('licKey').value || '').trim();
  $('licMsg').textContent = 'בודק…';
  const r = await chrome.runtime.sendMessage({ type: 'setLicenseKey', key });
  if (r && r.active) {
    $('licMsg').textContent = r.source === 'trial' ? 'נשמר (עדיין בתקופת ניסיון)' : 'רישיון פעיל ✓';
  } else {
    $('licMsg').textContent = key ? 'המפתח לא תקין או שפג תוקפו' : 'המפתח נמחק';
  }
  refreshLicense();
});

function syncDisabled() {
  $('quietTimes').classList.toggle('off', !$('quietOn').checked);
  const linked = !!settings.telegram.key;
  $('tgNoServer').hidden = !!SERVER;
  $('tgOff').hidden = !SERVER || linked;
  $('tgOnBox').hidden = !linked;
  $('tgSwitch').hidden = !linked;
  $('tgName').textContent = settings.telegram.name ? `(${settings.telegram.name})` : '';
}

async function save() {
  settings = {
    intervalMin: Number($('interval').value),
    quiet: { enabled: $('quietOn').checked, from: $('quietFrom').value || '23:00', to: $('quietTo').value || '07:00' },
    telegram: { ...settings.telegram, enabled: $('tgOn').checked },
  };
  await chrome.storage.local.set({ settings });
  syncDisabled();
}

function renderSearches(list) {
  const box = $('searches');
  box.replaceChildren();
  $('count').textContent = `(${list.length} מתוך 3)`;
  $('empty').hidden = list.length > 0;
  for (const s of list) {
    const row = document.createElement('div');
    row.className = 'search' + (s.enabled ? '' : ' paused');
    const info = document.createElement('div');
    info.className = 'info';
    const name = document.createElement('div');
    name.className = 'name';
    name.textContent = s.title || s.url;
    const meta = document.createElement('div');
    meta.className = 'meta';
    const parts = [s.enabled ? ago(s.lastRun) : 'מושהה', `${s.hits || 0} התראות`];
    meta.textContent = parts.join(' · ');
    if (s.enabled && STATUS[s.status]) {
      const bad = document.createElement('span');
      bad.className = 'bad';
      bad.textContent = ' · ' + STATUS[s.status];
      meta.append(bad);
    }
    info.append(name, meta);
    const open = document.createElement('a');
    open.className = 'icon-btn'; open.textContent = '↗'; open.title = 'פתיחת החיפוש'; open.href = s.url; open.target = '_blank';
    const pause = document.createElement('button');
    pause.className = 'icon-btn'; pause.textContent = s.enabled ? '⏸' : '▶'; pause.title = s.enabled ? 'השהיה' : 'המשך';
    pause.addEventListener('click', () => update(s.id, (x) => { x.enabled = !x.enabled; }));
    const del = document.createElement('button');
    del.className = 'icon-btn'; del.textContent = '✕'; del.title = 'מחיקה';
    del.addEventListener('click', () => update(s.id, null));
    row.append(info, open, pause, del);
    box.append(row);
  }
}

async function update(id, fn) {
  const { searches = [] } = await chrome.storage.local.get('searches');
  const i = searches.findIndex((x) => x.id === id);
  if (i < 0) return;
  if (fn) fn(searches[i]); else searches.splice(i, 1);
  await chrome.storage.local.set({ searches });
  renderSearches(searches);
}

for (const id of ['interval', 'quietOn', 'quietFrom', 'quietTo', 'tgOn']) $(id).addEventListener('change', save);

$('pollNow').addEventListener('click', async () => {
  $('pollNow').disabled = true;
  $('pollMsg').textContent = 'בודק…';
  const r = await chrome.runtime.sendMessage({ type: 'pollNow' });
  $('pollNow').disabled = false;
  const why = {
    busy: 'בדיקה כבר רצה',
    blocked: 'יד 2 חסמה בקשות, נסו בעוד שעה',
    premium: 'אין מנוי פעיל — הזינו מפתח רישיון למעלה או המתינו לסוף הניסיון',
    quiet: 'כרגע בשעות שקט',
  };
  $('pollMsg').textContent = r && r.ok ? (r.hits ? `נמצאו ${r.hits} מציאות חדשות` : 'אין מציאות חדשות כרגע') : (why[r && r.reason] || 'הבדיקה נכשלה');
  load();
});

// חיבור לטלגרם: התוסף מייצר מפתח ושולח אותו לבוט ב-Start. השרת שומר אותו,
// והדף בודק ב-/check עד שהחיבור מאושר. המפתח הממתין נשמר כדי שרענון לא יאבד אותו.
const PENDING_TTL = 60 * 60e3;
function randomKey() {
  const b = new Uint8Array(24);
  crypto.getRandomValues(b);
  return btoa(String.fromCharCode(...b)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

let linking = null;
let linkedAt = 0;

async function confirmLinked(name) {
  const key = settings.telegram.pendingKey;
  if (!key) return;
  settings.telegram = { enabled: true, key, name: name || '' };
  $('tgOn').checked = true;
  linkedAt = Date.now();
  await chrome.storage.local.set({ settings });
  stopLinking('');
}

function watchLink() {
  clearInterval(linking);
  $('tgWait').hidden = false;
  $('tgErr').hidden = true;
  const until = Date.now() + 5 * 60e3;
  const tick = async () => {
    const key = settings.telegram.pendingKey;
    if (!key || Date.now() > until) return stopLinking('לא התקבל אישור. אם הבוט ענה לכם, לחצו "הבוט ענה לי ✓", אחרת נסו שוב');
    const r = await fetch(`${SERVER}/check?key=${encodeURIComponent(key)}`).then((x) => x.json()).catch(() => null);
    if (r && r.linked) confirmLinked(r.name);
  };
  linking = setInterval(tick, 3000);
  tick();
}

$('tgConnect').addEventListener('click', async () => {
  $('tgConnect').disabled = true;
  try {
    const info = await fetch(`${SERVER}/info`).then((r) => r.json());
    if (!info.ok || !info.bot) throw new Error('no bot');
    const key = randomKey();
    settings.telegram = { enabled: false, key: '', name: '', pendingKey: key, pendingAt: Date.now() };
    await chrome.storage.local.set({ settings });
    window.open(`https://t.me/${info.bot}?start=${key}`, '_blank');
    watchLink();
  } catch (e) {
    stopLinking('אין חיבור לשרת של מציאון — בדקו את האינטרנט ונסו שוב');
  }
});

$('tgManual').addEventListener('click', () => confirmLinked(''));

function stopLinking(msg) {
  clearInterval(linking);
  linking = null;
  $('tgConnect').disabled = false;
  $('tgWait').hidden = true;
  $('tgErr').hidden = !msg;
  $('tgErr').textContent = msg;
  syncDisabled();
}

$('tgTest').addEventListener('click', async () => {
  $('tgMsg').textContent = 'שולח…';
  const r = await chrome.runtime.sendMessage({ type: 'telegramTest' });
  if (r && r.ok) $('tgMsg').textContent = 'נשלח, בדקו בטלגרם';
  else if (r && r.code === 'not_linked' && Date.now() - linkedAt < 2 * 60e3) $('tgMsg').textContent = 'החיבור עוד מתעדכן, נסו שוב בעוד דקה';
  else $('tgMsg').textContent = `לא נשלח: ${(r && r.error) || 'שגיאה'}`;
});

$('tgDisconnect').addEventListener('click', async () => {
  const key = settings.telegram.key;
  settings.telegram = { enabled: false, key: '', name: '' };
  await chrome.storage.local.set({ settings });
  syncDisabled();
  if (SERVER && key) fetch(`${SERVER}/unlink`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ key }) }).catch(() => {});
});

chrome.storage.onChanged.addListener((c) => { if (c.searches) renderSearches(c.searches.newValue || []); });
load();
