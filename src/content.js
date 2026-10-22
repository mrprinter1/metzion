'use strict';
// מציאון: מסמן בדף התוצאות של יד 2 רכבים שמחירם נמוך מהמחירון.
(function () {
  const M = globalThis.Metzion;
  const MIN_SHOW = 10;       // מאיזה אחוז מתחת למחירון מופיעה מודעה ברשימה ובתגית
  const KM_THRESHOLD = 10;   // רק מועמדות כאלה מקבלות בקשה לדף המודעה (בשביל הק"מ)
  const FRESH_MIN = 60;      // "עלתה לאחרונה" = עד שעה
  const MAX_LOOKUPS = 30;    // מקסימום שילובי תת-דגם ושנה בעמוד אחד
  const GAP_MS = 400;        // מרווח מינימלי בין בקשות, כדי לא להעמיס
  const TTL = 24 * 3600e3;
  const NEG_TTL = 3 * 3600e3;
  const ITEM_TTL = 6 * 3600e3;

  const state = { sig: null, doneSig: null, running: false, decor: new Map(), blocked: false,
    vehiclesBuildId: null, plBuildId: null, plBuildTs: 0, counted: new Set() };

  const panel = { root: null, status: null, list: null };
  let sortMode = 'pct';
  function ensurePanel() {
    if (panel.root && panel.root.isConnected) return;
    const root = document.createElement('div');
    root.className = 'metzion-panel';
    const head = document.createElement('div');
    head.className = 'metzion-head';
    const title = document.createElement('strong');
    title.textContent = 'מציאון';
    const status = document.createElement('span');
    status.className = 'metzion-st';
    const toggle = document.createElement('button');
    toggle.textContent = '–';
    toggle.title = 'צמצום והרחבה';
    toggle.addEventListener('click', () => root.classList.toggle('metzion-collapsed'));
    head.append(title, status, toggle);
    const bar = document.createElement('div');
    bar.className = 'metzion-bar';
    for (const [mode, label] of [['pct', 'לפי הנחה'], ['new', 'הכי חדשות']]) {
      const b = document.createElement('button');
      b.textContent = label;
      b.dataset.mode = mode;
      b.addEventListener('click', () => { sortMode = mode; renderPanel(); });
      bar.append(b);
    }
    const list = document.createElement('div');
    list.className = 'metzion-list';
    root.append(head, bar, list);
    document.body.append(root);
    panel.root = root; panel.status = status; panel.list = list;
  }
  function setStatus(text) { ensurePanel(); panel.status.textContent = text; }

  function buildRow(token, i) {
    const row = document.createElement('div');
    row.className = 'metzion-row';
    if (i.fresh) row.classList.add('metzion-row-fresh');
    if (i.kmFlag === 'high') row.classList.add('metzion-row-warn');
    const l1 = document.createElement('div');
    l1.className = 'metzion-l1';
    l1.textContent = `${i.pct != null ? i.pct + '% מתחת' : 'חדשה'} · ${nf.format(i.price)} ₪`;
    const l2 = document.createElement('div');
    l2.className = 'metzion-l2';
    const parts = [i.year, i.hand ? `יד ${i.hand}` : null];
    if (i.km) parts.push(`${nf.format(i.km)} ק״מ${i.kmVerified ? ' ✓' : ''}${KM_TEXT[i.kmFlag] ? ' (' + KM_TEXT[i.kmFlag] + ')' : ''}`);
    if (i.fresh) parts.push(`לפני ${Math.max(1, Math.round(i.minutes))} דק׳`);
    l2.textContent = parts.filter(Boolean).join(' · ');
    const open = document.createElement('a');
    open.href = `/vehicles/item/${token}`;
    open.target = '_blank';
    open.rel = 'noopener';
    open.textContent = 'פתח ↗';
    open.addEventListener('click', (e) => e.stopPropagation());
    row.append(l1, l2, open);
    row.addEventListener('click', () => {
      const a = document.querySelector(`a[data-testid="${token}"]`);
      if (!a) { window.open(`/vehicles/item/${token}`, '_blank'); return; }
      a.scrollIntoView({ behavior: 'smooth', block: 'center' });
      a.classList.add('metzion-flash');
      setTimeout(() => a.classList.remove('metzion-flash'), 2200);
    });
    return row;
  }

  function renderPanel() {
    ensurePanel();
    const rows = [...state.decor.entries()].filter(([, i]) => (i.pct != null && i.pct >= MIN_SHOW) || i.fresh);
    const mins = (i) => (i.minutes == null ? Infinity : i.minutes);
    rows.sort(([, a], [, b]) => sortMode === 'new' ? mins(a) - mins(b) : (b.pct ?? -1) - (a.pct ?? -1));
    for (const b of panel.root.querySelectorAll('.metzion-bar button')) b.classList.toggle('on', b.dataset.mode === sortMode);
    panel.list.replaceChildren(...rows.map(([t, i]) => buildRow(t, i)));
    if (!rows.length) {
      const e = document.createElement('div');
      e.className = 'metzion-empty';
      e.textContent = 'אין כרגע מודעות שמחירן 10% ומעלה מתחת למחירון.';
      panel.list.append(e);
    }
  }

  function render() { applyBadges(); renderPanel(); }

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  let lastReq = 0;
  async function polite(fn) {
    const wait = Math.max(0, lastReq + GAP_MS - Date.now());
    lastReq = Date.now() + wait;
    if (wait) await sleep(wait);
    return fn();
  }
  const get = (url) => fetch(url, { credentials: 'same-origin', headers: { accept: 'application/json' } });
  const isBlock = (r) => r && (r.status === 403 || r.status === 429);

  async function cacheGet(key) {
    const o = await chrome.storage.local.get(key);
    const e = o[key];
    if (!e) return null;
    const ttl = key.startsWith('item:') ? ITEM_TTL : e.v == null ? NEG_TTL : TTL;
    return Date.now() - e.ts < ttl ? e : null;
  }
  const cacheSet = (key, v) => chrome.storage.local.set({ [key]: { v, ts: Date.now() } });

  // ה-buildId של המחירון משתנה בכל פריסה, ולכן קוראים אותו מהדף עצמו.
  async function plBuildId(force) {
    if (state.plBuildId && !force) return state.plBuildId;
    if (force && Date.now() - state.plBuildTs < 5 * 60e3) return state.plBuildId;
    const r = await polite(() => fetch('/price-list/', { credentials: 'same-origin' }));
    if (!r.ok) return state.plBuildId;
    const data = M.parseNextDataFromHtml(await r.text());
    state.plBuildTs = Date.now();
    state.plBuildId = (data && data.buildId) || state.plBuildId;
    return state.plBuildId;
  }

  async function fetchListPrice(smId, year) {
    const url = (bid) => `/price-list/_next/data/${bid}/sub-model/${smId}/${year}.json`;
    const bid = await plBuildId(false);
    let r = bid ? await polite(() => get(url(bid))) : null;
    if (!r || r.status === 404) {
      const bid2 = await plBuildId(true);
      if (bid2 && bid2 !== bid) r = await polite(() => get(url(bid2)));
    }
    if (isBlock(r)) { state.blocked = true; return undefined; }
    if (r && r.ok) return M.extractListPrice(await r.json());
    const h = await polite(() => fetch(`/price-list/sub-model/${smId}/${year}`, { credentials: 'same-origin' }));
    if (isBlock(h)) { state.blocked = true; return undefined; }
    return h.ok ? M.extractListPrice(M.parseNextDataFromHtml(await h.text())) : null;
  }

  async function listPrice(smId, year) {
    const key = `pl:${smId}:${year}`;
    const hit = await cacheGet(key);
    if (hit) return hit.v;
    let price;
    try { price = await fetchListPrice(smId, year); } catch (e) { console.debug('מציאון: מחירון', e); return null; }
    if (price !== undefined) await cacheSet(key, price);
    return price === undefined ? null : price;
  }

  async function itemInfo(token) {
    const key = `item:${token}`;
    const hit = await cacheGet(key);
    if (hit) return hit.v;
    let info = null;
    try {
      const bid = state.vehiclesBuildId;
      let r = bid ? await polite(() => get(`/vehicles/_next/data/${bid}/item/${token}.json`)) : null;
      if (isBlock(r)) { state.blocked = true; return null; }
      if (r && r.ok) info = M.extractItem(await r.json());
      if (!info) {
        r = await polite(() => fetch(`/vehicles/item/${token}`, { credentials: 'same-origin' }));
        if (isBlock(r)) { state.blocked = true; return null; }
        if (r.ok) info = M.extractItem(M.parseNextDataFromHtml(await r.text()));
      }
    } catch (e) { console.debug('מציאון: מודעה', e); return null; }
    await cacheSet(key, info);
    return info;
  }

  async function loadAds() {
    const el = document.getElementById('__NEXT_DATA__');
    let data = null;
    try { data = el ? JSON.parse(el.textContent) : null; } catch (e) { data = null; }
    if (!data || !M.pageMatchesUrl(data, location.search)) {
      const r = await polite(() => fetch(location.href, { credentials: 'same-origin' }));
      data = r.ok ? M.parseNextDataFromHtml(await r.text()) : null;
    }
    state.vehiclesBuildId = (data && data.buildId) || null;
    return M.extractAds(data);
  }

  const nf = new Intl.NumberFormat('he-IL');
  const KM_TEXT = { high: 'ק״מ גבוה', low: 'ק״מ נמוך', normal: '' };

  function buildBadge(info) {
    const b = document.createElement('div');
    b.className = 'metzion-badge';
    b.dataset.v = String(info.v);
    if (info.fresh) b.classList.add('metzion-fresh');
    const lines = [];
    if (info.pct != null && info.pct >= MIN_SHOW) {
      b.classList.add(info.pct >= 15 ? 'metzion-strong' : info.pct >= KM_THRESHOLD ? 'metzion-good' : 'metzion-mild');
      lines.push(`${info.pct}% מתחת למחירון`);
    }
    if (info.km) {
      const f = KM_TEXT[info.kmFlag] || '';
      lines.push(`${nf.format(info.km)} ק״מ${f ? ' · ' + f : ''}${info.kmVerified ? ' ✓' : ''}`);
      if (info.kmFlag === 'high') b.classList.add('metzion-warn');
    }
    if (info.fresh) lines.push(`עלתה לפני ${Math.max(1, Math.round(info.minutes))} דק׳`);
    for (const t of lines) { const s = document.createElement('div'); s.textContent = t; b.append(s); }
    if (info.listPrice) b.title = `מחירון יד 2: ${nf.format(info.listPrice)} ₪`;
    return b;
  }

  function applyBadges() {
    for (const a of document.querySelectorAll('a[data-testid]')) {
      const info = state.decor.get(a.dataset.testid);
      if (!info) continue;
      const old = a.querySelector(':scope > .metzion-badge');
      if (old && old.dataset.v === String(info.v)) continue;
      if (old) old.remove();
      if (getComputedStyle(a).position === 'static') a.style.position = 'relative';
      a.append(buildBadge(info));
    }
  }

  async function bumpStats(pct, token) {
    if (state.counted.has(token) || !(pct >= KM_THRESHOLD)) return;
    state.counted.add(token);
    const o = await chrome.storage.local.get('stats');
    const s = o.stats || { scans: 0, bargains: 0 };
    s.bargains += 1;
    await chrome.storage.local.set({ stats: s });
  }

  async function scan() {
    if (!/\/vehicles\/cars\/?$/.test(location.pathname) || state.running) return;
    const sig = location.href;
    if (state.sig !== sig) { state.sig = sig; state.decor.clear(); state.doneSig = null; }
    if (state.doneSig === sig) return;
    state.running = true;
    try {
      setStatus('סורק…');
      const ads = await loadAds();
      if (state.sig !== sig) return;
      setStatus(`נמצאו ${ads.length} מודעות, שולף מחירון…`);
      const now = Date.now();
      const bump = (o) => { const o2 = { ...o }; o2.v = (o.v || 0) + 1; return o2; };
      const cands = [];
      const lookups = new Map();
      for (const ad of ads) {
        const minutes = M.minutesSince(ad.createdAt, now);
        const fresh = minutes != null && minutes >= 0 && minutes <= FRESH_MIN;
        if (fresh) state.decor.set(ad.token, { v: 1, fresh: true, minutes, pct: null, price: ad.price, year: ad.year, hand: ad.hand });
        if (!ad.price || !ad.subModelId || !ad.year) continue;
        const k = `${ad.subModelId}/${ad.year}`;
        if (lookups.size >= MAX_LOOKUPS && !lookups.has(k)) continue;
        lookups.set(k, null);
        cands.push({ ad, k, fresh, minutes });
      }
      render();
      for (const k of lookups.keys()) {
        if (state.blocked || state.sig !== sig) break;
        const [sm, y] = k.split('/');
        lookups.set(k, await listPrice(sm, y));
      }
      const got = [...lookups.values()].filter((v) => v > 0).length;
      setStatus(`מחירון: ${got} מתוך ${lookups.size} שילובים${state.blocked ? ' · נחסם על ידי יד 2' : ''}`);
      const bargains = [];
      for (const c of cands) {
        const lp = lookups.get(c.k);
        const pct = M.discountPct(lp, c.ad.price);
        if (pct == null || (pct < MIN_SHOW && !c.fresh)) continue;
        const info = { v: 1, fresh: c.fresh, minutes: c.minutes, pct, listPrice: lp, year: c.ad.year, price: c.ad.price, hand: c.ad.hand };
        state.decor.set(c.ad.token, info);
        if (pct >= KM_THRESHOLD) bargains.push(c.ad.token);
      }
      render();
      for (const token of bargains) {
        if (state.blocked || state.sig !== sig) break;
        const info = state.decor.get(token);
        const it = await itemInfo(token);
        if (it && it.km) {
          state.decor.set(token, bump({ ...info, km: it.km, kmVerified: it.kmVerified,
            kmFlag: M.kmFlag(it.km, info.year, Date.now()) }));
          render();
        }
        bumpStats(info.pct, token);
      }
      state.doneSig = sig;
      setStatus(`הסתיים: ${state.decor.size} תגיות, ${bargains.length} מציאות (מ-${ads.length} מודעות)${state.blocked ? ' · נחסם' : ''}`);
    } catch (e) {
      console.debug('מציאון: שגיאה', e);
      setStatus('שגיאה: ' + (e && e.message ? e.message : e));
    } finally {
      state.running = false;
    }
  }

  let timer = null;
  new MutationObserver(() => {
    clearTimeout(timer);
    timer = setTimeout(() => { applyBadges(); if (location.href !== state.doneSig) scan(); }, 700);
  }).observe(document.body, { childList: true, subtree: true });
  scan();
})();
