'use strict';
// מציאון: מסמן בדף התוצאות של יד 2 רכבים שמחירם נמוך מהמחירון או מהשוק.
(function () {
  const M = globalThis.Metzion;
  const MIN_SHOW = 10;       // מאיזה אחוז מתחת למחירון/לשוק מודעה נחשבת מועמדת
  const FRESH_MIN = 60;      // "עלתה לאחרונה" = עד שעה
  const MAX_LOOKUPS = 45;    // מקסימום שילובי תת-דגם ושנה חדשים בכל סריקה
  const MORE_PAGES = 3;      // כמה עמודים נוספים נסרקים בכל לחיצה
  const GAP_MS = 400;        // מרווח מינימלי בין בקשות, כדי לא להעמיס
  const TTL = 24 * 3600e3;
  const NEG_TTL = 3 * 3600e3;
  const ITEM_TTL = 6 * 3600e3;

  const state = {
    sig: null, doneSig: null, running: false, blocked: false,
    ads: new Map(),      // token -> מודעה מכל העמודים שנסרקו
    lp: new Map(),       // "תת-דגם/שנה" -> מחיר מחירון (או null)
    decor: new Map(),    // token -> מידע לתצוגה
    kmTried: new Set(), counted: new Set(),
    pagination: null, nextPage: 2,
    vehiclesBuildId: null, plBuildId: null, plBuildTs: 0,
  };
  const filters = { minPct: MIN_SHOW, maxKm: 0, maxHand: 0, seller: 'all' };

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
    return { ads: M.extractAds(data), pagination: M.extractPagination(data) };
  }

  // ---------- תצוגה ----------
  const nf = new Intl.NumberFormat('he-IL');
  const KM_TEXT = { high: 'ק״מ גבוה', low: 'ק״מ נמוך', normal: '' };
  const panel = {};

  const bestPct = (i) => {
    const v = Math.max(i.pct == null ? -Infinity : i.pct, i.mp == null ? -Infinity : i.mp);
    return v === -Infinity ? null : v;
  };
  const below = (p) => `${Math.abs(p)}% ${p >= 0 ? 'מתחת' : 'מעל'}`;

  function publishedText(i) {
    const age = M.formatAge(i.minutes);
    if (!age) return null;
    const d = M.formatDate(i.createdAt);
    return `פורסם ${age}${d ? ' (' + d + ')' : ''}`;
  }

  function passes(i) {
    const best = bestPct(i);
    if (!i.fresh && !(best != null && best >= filters.minPct)) return false;
    if (filters.maxKm && i.km && i.km > filters.maxKm) return false;
    if (filters.maxHand && i.hand && i.hand > filters.maxHand) return false;
    if (filters.seller !== 'all' && i.adType && i.adType !== filters.seller) return false;
    return true;
  }

  function mkSelect(label, key, options) {
    const wrap = document.createElement('label');
    wrap.textContent = label;
    const sel = document.createElement('select');
    for (const [v, t] of options) { const o = document.createElement('option'); o.value = String(v); o.textContent = t; sel.append(o); }
    sel.addEventListener('change', () => {
      filters[key] = key === 'seller' ? sel.value : Number(sel.value);
      chrome.storage.local.set({ filters });
      renderPanel();
    });
    panel.selects[key] = sel;
    wrap.append(sel);
    return wrap;
  }

  function ensurePanel() {
    if (panel.root && panel.root.isConnected) return;
    panel.selects = {};
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

    const prog = document.createElement('div');
    prog.className = 'metzion-progress';
    const fill = document.createElement('i');
    prog.append(fill);

    const bar = document.createElement('div');
    bar.className = 'metzion-bar';
    for (const [mode, label] of [['pct', 'לפי הנחה'], ['new', 'הכי חדשות']]) {
      const b = document.createElement('button');
      b.textContent = label;
      b.dataset.mode = mode;
      b.addEventListener('click', () => { panel.sort = mode; renderPanel(); });
      bar.append(b);
    }

    const fl = document.createElement('div');
    fl.className = 'metzion-filters';
    fl.append(
      mkSelect('הנחה מינימלית', 'minPct', [[10, '10%'], [15, '15%'], [20, '20%'], [25, '25%']]),
      mkSelect('ק״מ מקסימלי', 'maxKm', [[0, 'הכול'], [80000, '80 אלף'], [120000, '120 אלף'], [160000, '160 אלף'], [200000, '200 אלף']]),
      mkSelect('יד', 'maxHand', [[0, 'הכול'], [1, 'יד 1'], [2, 'עד יד 2'], [3, 'עד יד 3']]),
      mkSelect('מוכר', 'seller', [['all', 'הכול'], ['private', 'פרטי'], ['commercial', 'סוחר']]),
    );

    const list = document.createElement('div');
    list.className = 'metzion-list';
    const more = document.createElement('button');
    more.className = 'metzion-more';
    more.addEventListener('click', () => scanMore());

    root.append(head, prog, bar, fl, list, more);
    document.body.append(root);
    Object.assign(panel, { root, status, fill, prog, list, more });
    panel.sort = panel.sort || 'pct';
    for (const [k, sel] of Object.entries(panel.selects)) sel.value = String(filters[k]);
  }

  function setStatus(text) { ensurePanel(); panel.status.textContent = text; }
  function setProgress(frac, text) {
    ensurePanel();
    panel.prog.classList.add('on');
    panel.fill.style.width = `${Math.max(2, Math.min(100, Math.round(frac * 100)))}%`;
    if (text) panel.status.textContent = text;
  }
  function endProgress(text) {
    ensurePanel();
    panel.fill.style.width = '100%';
    setTimeout(() => panel.prog.classList.remove('on'), 500);
    if (text) panel.status.textContent = text;
  }

  function buildRow(token, i) {
    const row = document.createElement('div');
    row.className = 'metzion-row';
    if (i.fresh) row.classList.add('metzion-row-fresh');
    if (i.kmFlag === 'high') row.classList.add('metzion-row-warn');
    const price = i.price > 0 ? `${nf.format(i.price)} ₪` : 'ללא מחיר';
    const l1 = document.createElement('div');
    l1.className = 'metzion-l1';
    l1.textContent = `${i.pct != null ? below(i.pct) + ' למחירון' : i.mp != null ? below(i.mp) + ' לשוק' : 'חדשה'} · ${price}`;
    row.append(l1);
    if (i.pct != null && i.mp != null) {
      const lm = document.createElement('div');
      lm.className = 'metzion-l2';
      lm.textContent = `מול השוק: ${below(i.mp)} לחציון ${nf.format(i.median)} ₪ (${i.mn} מודעות)`;
      row.append(lm);
    }
    const l2 = document.createElement('div');
    l2.className = 'metzion-l2';
    const parts = [i.year, i.hand ? `יד ${i.hand}` : null, i.adType === 'private' ? 'פרטי' : i.adType === 'commercial' ? 'סוחר' : null];
    if (i.km) parts.push(`${nf.format(i.km)} ק״מ${i.kmVerified ? ' ✓' : ''}${KM_TEXT[i.kmFlag] ? ' (' + KM_TEXT[i.kmFlag] + ')' : ''}`);
    const pub = publishedText(i);
    if (pub) parts.push(pub);
    l2.textContent = parts.filter(Boolean).join(' · ');
    const open = document.createElement('a');
    open.href = `/vehicles/item/${token}`;
    open.target = '_blank';
    open.rel = 'noopener';
    open.textContent = 'פתח ↗';
    open.addEventListener('click', (e) => e.stopPropagation());
    row.append(l2, open);
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
    const rows = [...state.decor.entries()].filter(([, i]) => passes(i));
    const mins = (i) => (i.minutes == null ? Infinity : i.minutes);
    rows.sort(([, a], [, b]) => panel.sort === 'new' ? mins(a) - mins(b) : (bestPct(b) ?? -1) - (bestPct(a) ?? -1));
    for (const b of panel.root.querySelectorAll('.metzion-bar button')) b.classList.toggle('on', b.dataset.mode === panel.sort);
    panel.list.replaceChildren(...rows.map(([t, i]) => buildRow(t, i)));
    if (!rows.length) {
      const e = document.createElement('div');
      e.className = 'metzion-empty';
      e.textContent = state.running ? 'טוען מודעות…' : 'אין כרגע מודעות שעומדות בסינון.';
      panel.list.append(e);
    }
    const left = state.pagination ? state.pagination.pages - state.nextPage + 1 : 0;
    panel.more.hidden = !(left > 0);
    panel.more.disabled = state.running;
    panel.more.textContent = `סרוק עוד עמודים (נותרו ${left})`;
  }

  function buildBadge(info) {
    const b = document.createElement('div');
    b.className = 'metzion-badge';
    b.dataset.v = String(info.v);
    if (info.fresh) b.classList.add('metzion-fresh');
    const best = bestPct(info);
    const lines = [];
    if (best != null && best >= MIN_SHOW) {
      b.classList.add(info.kmFlag === 'high' ? 'metzion-orange' : best >= 15 ? 'metzion-strong' : 'metzion-good');
    }
    if (info.pct != null && info.pct >= MIN_SHOW) lines.push(`${info.pct}% מתחת למחירון`);
    if (info.mp != null && info.mp >= MIN_SHOW) lines.push(`${info.mp}% מתחת לשוק`);
    if (info.km) {
      const f = KM_TEXT[info.kmFlag] || '';
      lines.push(`${nf.format(info.km)} ק״מ${f ? ' · ' + f : ''}${info.kmVerified ? ' ✓' : ''}`);
    }
    const pub = publishedText(info);
    if (pub) lines.push(pub);
    for (const t of lines) { const s = document.createElement('div'); s.textContent = t; b.append(s); }
    if (info.listPrice) b.title = `מחירון יד 2: ${nf.format(info.listPrice)} ₪`;
    return b;
  }

  function applyBadges() {
    for (const a of document.querySelectorAll('a[data-testid]')) {
      const info = state.decor.get(a.dataset.testid);
      if (!info || !passes(info)) { const o = a.querySelector(':scope > .metzion-badge'); if (o) o.remove(); continue; }
      const old = a.querySelector(':scope > .metzion-badge');
      if (old && old.dataset.v === String(info.v)) continue;
      if (old) old.remove();
      if (getComputedStyle(a).position === 'static') a.style.position = 'relative';
      a.append(buildBadge(info));
    }
  }
  function render() { applyBadges(); renderPanel(); }

  // ---------- חישוב ----------
  function rebuildDecor() {
    const now = Date.now();
    const market = M.marketStats([...state.ads.values()]);
    for (const [token, ad] of state.ads) {
      const prev = state.decor.get(token) || {};
      const minutes = M.minutesSince(ad.createdAt, now);
      const fresh = minutes != null && minutes >= 0 && minutes <= FRESH_MIN;
      const k = ad.subModelId && ad.year ? `${ad.subModelId}/${ad.year}` : null;
      const lp = k ? state.lp.get(k) : null;
      const ms = k ? market.get(k) : null;
      const pct = M.discountPct(lp, ad.price);
      const mp = ms ? M.discountPct(ms.median, ad.price) : null;
      const best = Math.max(pct == null ? -Infinity : pct, mp == null ? -Infinity : mp);
      if (!(best >= MIN_SHOW) && !fresh) { state.decor.delete(token); continue; }
      state.decor.set(token, {
        v: (prev.v || 0) + 1, fresh, minutes, createdAt: ad.createdAt, pct, listPrice: lp,
        mp, mn: ms ? ms.n : null, median: ms ? ms.median : null,
        year: ad.year, price: ad.price, hand: ad.hand, adType: ad.adType,
        km: prev.km, kmVerified: prev.kmVerified, kmFlag: prev.kmFlag,
      });
    }
  }

  async function bumpStats(token) {
    if (state.counted.has(token)) return;
    state.counted.add(token);
    const o = await chrome.storage.local.get('stats');
    const s = o.stats || { bargains: 0 };
    s.bargains += 1;
    await chrome.storage.local.set({ stats: s });
  }

  // p0..p1 = טווח ההתקדמות שמוקצה לקבוצת המודעות הזו במד הטעינה
  async function processAds(newAds, sig, p0, p1) {
    for (const ad of newAds) state.ads.set(ad.token, ad);
    const span = p1 - p0;
    const need = [];
    for (const ad of newAds) {
      if (!ad.price || !ad.subModelId || !ad.year) continue;
      const k = `${ad.subModelId}/${ad.year}`;
      if (!state.lp.has(k) && !need.includes(k)) need.push(k);
    }
    const todo = need.slice(0, MAX_LOOKUPS);
    rebuildDecor();
    render();
    for (let n = 0; n < todo.length; n++) {
      if (state.blocked || state.sig !== sig) break;
      const [sm, y] = todo[n].split('/');
      state.lp.set(todo[n], await listPrice(sm, y));
      setProgress(p0 + span * 0.6 * ((n + 1) / todo.length), `שולף מחירון ${n + 1} מתוך ${todo.length}…`);
      if ((n + 1) % 4 === 0) { rebuildDecor(); render(); }
    }
    rebuildDecor();
    render();

    const kmTodo = [...state.decor.entries()].filter(([t, i]) => (bestPct(i) ?? 0) >= MIN_SHOW && !i.km && !state.kmTried.has(t));
    for (let n = 0; n < kmTodo.length; n++) {
      if (state.blocked || state.sig !== sig) break;
      const [token] = kmTodo[n];
      state.kmTried.add(token);
      setProgress(p0 + span * (0.6 + 0.4 * ((n + 1) / kmTodo.length)), `בודק ק״מ ${n + 1} מתוך ${kmTodo.length}…`);
      const it = await itemInfo(token);
      const cur = state.decor.get(token);
      if (it && it.km && cur) {
        state.decor.set(token, { ...cur, v: cur.v + 1, km: it.km, kmVerified: it.kmVerified,
          kmFlag: M.kmFlag(it.km, cur.year, Date.now()) });
        render();
      }
      bumpStats(token);
    }
  }

  function summary() {
    const shown = [...state.decor.values()].filter(passes).length;
    return `${shown} מודעות מתאימות, מתוך ${state.ads.size} שנסרקו${state.blocked ? ' · נחסם על ידי יד 2' : ''}`;
  }

  async function scan() {
    if (!/\/vehicles\/cars\/?$/.test(location.pathname) || state.running) return;
    const sig = location.href;
    if (state.sig !== sig) {
      Object.assign(state, { sig, doneSig: null, pagination: null });
      state.ads.clear(); state.decor.clear(); state.lp.clear(); state.kmTried.clear();
    }
    if (state.doneSig === sig) return;
    state.running = true;
    try {
      setProgress(0.03, 'טוען מודעות…');
      renderPanel();
      const { ads, pagination } = await loadAds();
      if (state.sig !== sig) return;
      state.pagination = pagination;
      state.nextPage = (Number(new URLSearchParams(location.search).get('page')) || 1) + 1;
      setProgress(0.12, `נמצאו ${ads.length} מודעות`);
      await processAds(ads, sig, 0.12, 1);
      state.doneSig = sig;
      endProgress(summary());
    } catch (e) {
      console.debug('מציאון: שגיאה', e);
      endProgress('שגיאה: ' + (e && e.message ? e.message : e));
    } finally {
      state.running = false;
      renderPanel();
    }
  }

  async function scanMore() {
    if (state.running || !state.pagination) return;
    const sig = state.sig;
    state.running = true;
    renderPanel();
    try {
      const first = state.nextPage;
      const last = Math.min(state.pagination.pages, first + MORE_PAGES - 1);
      const count = last - first + 1;
      for (let pg = first; pg <= last; pg++) {
        if (state.blocked || state.sig !== sig) break;
        const base = (pg - first) / count;
        setProgress(base, `סורק עמוד ${pg} מתוך ${state.pagination.pages}…`);
        const url = new URL(location.href);
        url.searchParams.set('page', String(pg));
        const r = await polite(() => fetch(url, { credentials: 'same-origin' }));
        if (isBlock(r)) { state.blocked = true; break; }
        if (!r.ok) break;
        await processAds(M.extractAds(M.parseNextDataFromHtml(await r.text())), sig, base, base + 1 / count);
        state.nextPage = pg + 1;
      }
      endProgress(summary());
    } catch (e) {
      console.debug('מציאון: שגיאה', e);
      endProgress('שגיאה: ' + (e && e.message ? e.message : e));
    } finally {
      state.running = false;
      renderPanel();
    }
  }

  chrome.storage.local.get('filters').then((o) => {
    Object.assign(filters, o.filters || {});
    if (panel.selects) for (const [k, sel] of Object.entries(panel.selects)) sel.value = String(filters[k]);
    if (panel.root) render();
  });

  let timer = null;
  new MutationObserver(() => {
    clearTimeout(timer);
    timer = setTimeout(() => { applyBadges(); if (location.href !== state.doneSig) scan(); }, 700);
  }).observe(document.body, { childList: true, subtree: true });
  scan();
})();
