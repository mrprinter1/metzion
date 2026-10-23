'use strict';
const $ = (id) => document.getElementById(id);
const DEFAULTS = { intervalMin: 15, quiet: { enabled: false, from: '23:00', to: '07:00' }, telegram: { enabled: false, token: '', chatId: '' } };
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
  $('tgToken').value = settings.telegram.token;
  $('tgStatus').textContent = settings.telegram.chatId ? 'מחובר ✓' : '';
  syncDisabled();
  renderSearches(o.searches || []);
}

function syncDisabled() {
  $('quietTimes').classList.toggle('off', !$('quietOn').checked);
  $('tgTest').disabled = !settings.telegram.chatId;
}

async function save() {
  settings = {
    intervalMin: Number($('interval').value),
    quiet: { enabled: $('quietOn').checked, from: $('quietFrom').value || '23:00', to: $('quietTo').value || '07:00' },
    telegram: { ...settings.telegram, enabled: $('tgOn').checked, token: $('tgToken').value.trim() },
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
$('tgToken').addEventListener('change', async () => {
  settings.telegram.chatId = '';
  $('tgStatus').textContent = '';
  await save();
});

$('pollNow').addEventListener('click', async () => {
  $('pollNow').disabled = true;
  $('pollMsg').textContent = 'בודק…';
  const r = await chrome.runtime.sendMessage({ type: 'pollNow' });
  $('pollNow').disabled = false;
  const why = { busy: 'בדיקה כבר רצה', blocked: 'יד 2 חסמה בקשות, נסו בעוד שעה' };
  $('pollMsg').textContent = r && r.ok ? (r.hits ? `נמצאו ${r.hits} מציאות חדשות` : 'אין מציאות חדשות כרגע') : (why[r && r.reason] || 'הבדיקה נכשלה');
  load();
});

$('tgConnect').addEventListener('click', async () => {
  await save();
  if (!settings.telegram.token) { $('tgStatus').textContent = 'הדביקו קודם את הטוקן'; return; }
  $('tgStatus').textContent = 'מתחבר…';
  const r = await chrome.runtime.sendMessage({ type: 'telegramConnect', token: settings.telegram.token });
  if (r && r.ok) {
    settings.telegram.chatId = r.chatId;
    settings.telegram.enabled = true;
    $('tgOn').checked = true;
    await chrome.storage.local.set({ settings });
    $('tgStatus').textContent = `מחובר ✓${r.name ? ' (' + r.name + ')' : ''}`;
  } else {
    $('tgStatus').textContent = (r && r.error) || 'החיבור נכשל';
  }
  syncDisabled();
});

$('tgTest').addEventListener('click', async () => {
  $('tgTestMsg').textContent = 'שולח…';
  const r = await chrome.runtime.sendMessage({ type: 'telegramTest' });
  $('tgTestMsg').textContent = r && r.ok ? 'נשלח, בדקו בטלגרם' : `לא נשלח: ${(r && r.error) || 'שגיאה'}`;
});

chrome.storage.onChanged.addListener((c) => { if (c.searches) renderSearches(c.searches.newValue || []); });
load();
