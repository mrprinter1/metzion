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
    marks: {},           // token -> 'seen' | 'hidden'
    prevTokens: null,    // מודעות שנראו בביקור הקודם באותו חיפוש
    drops: new Map(),    // token -> ירידת מחיר
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
  const DEFAULT_FILTERS = { minPct: MIN_SHOW, maxKm: 0, maxHand: 0, seller: 'all' };
  const panel = {};

  const el = (tag, cls, text) => {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  };
  const bestPct = (i) => {
    const v = Math.max(i.pct == null ? -Infinity : i.pct, i.mp == null ? -Infinity : i.mp, i.pp == null ? -Infinity : i.pp);
    return v === -Infinity ? null : v;
  };
  // הנחה ביחס לאותה רמת גימור בלבד (מחירון או חציון התת-דגם). משמשת לזיהוי הנחה חריגה.
  const valuePct = (i) => {
    const v = Math.max(i.pct == null ? -Infinity : i.pct, i.mp == null ? -Infinity : i.mp);
    return v === -Infinity ? null : v;
  };
  const kmShort = (km) => (km >= 1000 ? `${nf.format(Math.round(km / 1000))} אלף ק״מ` : `${nf.format(km)} ק״מ`);
  const signPct = (p) => (Math.abs(p) < 0.05 ? "0%" : `${p > 0 ? "−" : "+"}${Math.abs(p)}%`);

  // מה מוצג כ"כותרת" של המודעה: הנחה מהמחירון, ואם אין, הנחה מהשוק.
  function headline(i) {
    if (i.pct != null && i.pct >= MIN_SHOW) return { value: `${i.pct}%`, label: 'מתחת למחירון', src: 'list' };
    if (i.mp != null && i.mp >= MIN_SHOW) return { value: `${i.mp}%`, label: 'מתחת לשוק', src: 'market' };
    if (i.pp != null && i.pp >= MIN_SHOW) return { value: `${i.pp}%`, label: 'מתחת לדומים', src: 'peer' };
    return { value: 'חדש', label: M.formatAge(i.minutes) || '', src: 'fresh' };
  }
  function tone(i) {
    const best = bestPct(i);
    if (!(best >= MIN_SHOW)) return 'fresh';
    if (i.kmFlag === 'high') return 'warn';
    return best >= 20 ? 'strong' : 'good';
  }

  function passes(i) {
    if (i.hidden && !panel.showHidden) return false;
    const best = bestPct(i);
    if (!i.fresh && !(best != null && best >= filters.minPct)) return false;
    if (filters.maxKm && i.km && i.km > filters.maxKm) return false;
    if (filters.maxHand && i.hand && i.hand > filters.maxHand) return false;
    if (filters.seller !== 'all' && i.adType && i.adType !== filters.seller) return false;
    return true;
  }
  const activeFilters = () => Object.keys(DEFAULT_FILTERS).filter((k) => filters[k] !== DEFAULT_FILTERS[k]).length;

  function saveFilters() { chrome.storage.local.set({ filters }); render(); }

  function mkSelect(label, key, options) {
    const wrap = el('label', 'mz-field');
    wrap.append(el('span', null, label));
    const sel = el('select');
    for (const [v, t] of options) { const o = el('option', null, t); o.value = String(v); sel.append(o); }
    sel.addEventListener('change', () => {
      filters[key] = key === 'seller' ? sel.value : Number(sel.value);
      saveFilters();
    });
    panel.selects[key] = sel;
    wrap.append(sel);
    return wrap;
  }
  function syncSelects() {
    if (!panel.selects) return;
    for (const [k, sel] of Object.entries(panel.selects)) sel.value = String(filters[k]);
  }

  function ensurePanel() {
    if (panel.root && panel.root.isConnected) return;
    panel.selects = {};
    const root = el('div', 'mz-panel');
    root.dir = 'rtl';

    const head = el('div', 'mz-head');
    const brand = el('div', 'mz-brand');
    brand.append(el('span', 'mz-logo'), el('strong', null, 'מציאון'));
    const count = el('span', 'mz-count', '0');
    const spacer = el('span', 'mz-spacer');
    const bell = el('button', 'mz-icon mz-bell', '🔔');
    bell.title = 'התראה על מציאות חדשות בחיפוש הזה';
    bell.addEventListener('click', () => toggleSavedSearch());
    const gear = el('button', 'mz-icon', '⚙');
    gear.title = 'הגדרות והתראות';
    gear.addEventListener('click', () => chrome.runtime.sendMessage({ type: 'openOptions' }));
    const filterBtn = el('button', 'mz-btn mz-filter-btn', 'סינון');
    const dot = el('span', 'mz-dot');
    filterBtn.append(dot);
    filterBtn.addEventListener('click', () => root.classList.toggle('mz-open-filters'));
    const collapse = el('button', 'mz-icon', '–');
    collapse.title = 'צמצום והרחבה';
    collapse.addEventListener('click', () => root.classList.toggle('mz-collapsed'));
    head.append(brand, count, spacer, bell, filterBtn, gear, collapse);

    const prog = el('div', 'mz-progress');
    const fill = el('i');
    prog.append(fill);

    const seg = el('div', 'mz-seg');
    for (const [mode, label] of [['score', 'הכי משתלם'], ['pct', 'הנחה גדולה'], ['new', 'חדשות']]) {
      const b = el('button', null, label);
      b.dataset.mode = mode;
      b.addEventListener('click', () => { panel.sort = mode; renderPanel(); });
      seg.append(b);
    }

    const fl = el('div', 'mz-filters');
    const grid = el('div', 'mz-grid');
    grid.append(
      mkSelect('הנחה מינימלית', 'minPct', [[10, '10%'], [15, '15%'], [20, '20%'], [25, '25%']]),
      mkSelect('ק״מ עד', 'maxKm', [[0, 'הכול'], [80000, '80 אלף'], [120000, '120 אלף'], [160000, '160 אלף'], [200000, '200 אלף']]),
      mkSelect('יד', 'maxHand', [[0, 'הכול'], [1, 'יד 1'], [2, 'עד יד 2'], [3, 'עד יד 3']]),
      mkSelect('מוכר', 'seller', [['all', 'הכול'], ['private', 'פרטי'], ['commercial', 'סוחר']]),
    );
    const reset = el('button', 'mz-link', 'איפוס סינון');
    reset.addEventListener('click', () => { Object.assign(filters, DEFAULT_FILTERS); syncSelects(); saveFilters(); });
    fl.append(grid, reset);

    const list = el('div', 'mz-list');
    const foot = el('div', 'mz-foot');
    const status = el('span', 'mz-status');
    const hiddenLink = el('button', 'mz-link mz-hidden-link');
    hiddenLink.addEventListener('click', () => { panel.showHidden = !panel.showHidden; render(); });
    const more = el('button', 'mz-btn mz-more');
    more.addEventListener('click', () => scanMore());
    foot.append(status, hiddenLink, more);

    root.append(head, prog, seg, fl, list, foot);
    document.body.append(root);
    Object.assign(panel, { root, count, dot, status, fill, prog, list, more, hiddenLink, bell });
    refreshBell();
    panel.sort = panel.sort || 'score';
    syncSelects();
  }

  // ---------- חיפוש שמור (התראות) ----------
  function searchUrl() {
    const u = new URL(location.href);
    u.searchParams.delete('page');
    return u.origin + u.pathname + (u.searchParams.toString() ? '?' + u.searchParams.toString() : '');
  }
  async function refreshBell() {
    if (!panel.bell) return;
    const { searches = [] } = await chrome.storage.local.get('searches');
    const on = searches.some((x) => x.url === searchUrl());
    panel.bell.classList.toggle('on', on);
    panel.bell.title = on ? 'התראות פעילות לחיפוש הזה (לחיצה מבטלת)' : 'התראה על מציאות חדשות בחיפוש הזה';
  }
  async function toggleSavedSearch() {
    const h1 = document.querySelector('h1');
    const title = ((h1 && h1.textContent) || document.title || '').trim().slice(0, 80);
    const r = await chrome.runtime.sendMessage({ type: 'saveSearch', search: {
      url: searchUrl(), title, filters: { ...filters }, seen: [...state.ads.keys()],
    } });
    if (!r || !r.ok) { setStatus((r && r.error) || 'השמירה נכשלה'); return; }
    setStatus(r.saved ? 'התראות הופעלו. מציאות חדשות יגיעו כהתראה (המחשב צריך להישאר דולק)' : 'ההתראות לחיפוש הזה בוטלו');
    refreshBell();
  }

  function setStatus(text) { ensurePanel(); panel.status.textContent = text; }
  function setProgress(frac, text) {
    ensurePanel();
    panel.prog.classList.add('on');
    panel.fill.style.width = `${Math.max(3, Math.min(100, Math.round(frac * 100)))}%`;
    if (text) panel.status.textContent = text;
  }
  function endProgress(text) {
    ensurePanel();
    panel.fill.style.width = '100%';
    setTimeout(() => panel.prog.classList.remove('on'), 500);
    if (text) panel.status.textContent = text;
  }

  function buildRow(token, i, isTop) {
    const row = el('div', `mz-row mz-${tone(i)}`);
    const h = headline(i);
    const pill = el('div', 'mz-pill');
    pill.append(el('b', null, h.value), el('small', null, h.label));

    const main = el('div', 'mz-main');
    const top = el('div', 'mz-top');
    top.append(el('span', 'mz-price', i.price > 0 ? `${nf.format(i.price)} ₪` : 'ללא מחיר'));
    if (i.listPrice) top.append(el('span', 'mz-ref', `מחירון ${nf.format(i.listPrice)}`));
    const meta = [i.year, i.hand ? `יד ${i.hand}` : null, i.km ? kmShort(i.km) + (i.kmVerified ? ' ✓' : '') : null];
    const metaEl = el('div', 'mz-meta', meta.filter(Boolean).join(' · '));
    const age = M.formatAge(i.minutes);
    const seller = i.adType === 'private' ? 'פרטי' : i.adType === 'commercial' ? 'סוחר' : null;
    const sub = el('div', 'mz-sub', [seller, h.src !== 'fresh' && age ? `פורסם ${age}` : null].filter(Boolean).join(' · '));

    // תגיות רק למה שצריך לבלוט, לפי סדר חשיבות, ולכל היותר 2 (השאר בחלונית המידע)
    const tags = [];
    if (isTop) tags.push(['★ הכי משתלם', 'mz-tag-top']);
    if (i.flags && i.flags.length) tags.push(['⚠ לבדוק', 'mz-tag-bad']);
    if ((i.fresh || i.newVisit) && h.src !== 'fresh') tags.push(['חדש', 'mz-tag-new']);
    if (i.kmFlag === 'high') tags.push(['ק״מ גבוה', 'mz-tag-warn']);
    if (i.drop) tags.push([`ירד ${nf.format(i.drop.amount)} ₪`, 'mz-tag-good']);
    if (h.src === 'list' && i.mp != null && Math.abs(i.mp) >= MIN_SHOW) {
      const m = Math.round(i.mp);
      tags.push([m > 0 ? `${m}% מתחת לשוק` : `${-m}% מעל השוק`, m >= MIN_SHOW ? 'mz-tag-good' : null]);
    }
    main.append(top, metaEl, sub);
    if (tags.length) {
      const box = el('div', 'mz-tags');
      for (const [text, cls] of tags.slice(0, 2)) box.append(el('span', `mz-tag${cls ? ' ' + cls : ''}`, text));
      main.append(box);
    }

    // פעולות: מופיעות רק במעבר עכבר
    const actions = el('div', 'mz-actions');
    const act = (glyph, title, fn) => {
      const b = el('button', 'mz-act', glyph);
      b.title = title;
      b.addEventListener('click', (e) => { e.stopPropagation(); fn(); });
      actions.append(b);
      return b;
    };
    const open = el('a', 'mz-act', '↗');
    open.href = `/vehicles/item/${token}`;
    open.target = '_blank';
    open.rel = 'noopener';
    open.title = 'פתיחה בלשונית חדשה';
    open.addEventListener('click', (e) => { e.stopPropagation(); setMark(token, 'seen'); });
    actions.append(open);
    act(i.seen ? '↺' : '✓', i.seen ? 'סימון כלא נבדקה' : 'סימון כנבדקה', () => setMark(token, i.seen ? null : 'seen'));
    act(i.hidden ? '↺' : '✕', i.hidden ? 'החזרה לרשימה' : 'הסתרה', () => setMark(token, i.hidden ? null : 'hidden'));
    if (i.seen) row.classList.add('mz-seen');
    if (i.hidden) row.classList.add('mz-is-hidden');

    const tip = [`מחיר ${i.price > 0 ? nf.format(i.price) + ' ₪' : 'לא צוין'}`];
    if (i.listPrice) tip.push(`מחירון יד 2: ${nf.format(i.listPrice)} ₪ (${signPct(i.pct)})`);
    if (i.median) tip.push(`חציון השוק: ${nf.format(i.median)} ₪ מ-${i.mn} מודעות (${signPct(i.mp)})`);
    if (i.peerMedian) tip.push(`חציון הדגם בשנה הזו (כל הגימורים): ${nf.format(i.peerMedian)} ₪ מ-${i.pn} מודעות (${signPct(i.pp)})`);
    if (i.km) tip.push(`${nf.format(i.km)} ק״מ${i.kmVerified ? ', מאומת במשרד התחבורה' : ''}`);
    if (i.drop) {
      const when = i.drop.at ? ` (${M.formatAge((Date.now() - i.drop.at) / 60000)})` : '';
      tip.push(`המחיר ירד ב-${nf.format(i.drop.amount)} ₪${when}`);
    }
    if (i.flags && i.flags.length) tip.push(`⚠ ${i.flags.join(' · ')}`);
    const d = M.formatDate(i.createdAt);
    if (d) tip.push(`פורסם ${d}`);
    const sc = M.scoreParts(i, Date.now());
    if (sc) {
      const sg = (x) => (x >= 0 ? `+${x}` : `${x}`);
      const parts = [`מחיר ${sg(sc.base)}`];
      if (i.km) parts.push(`ק״מ ${sg(sc.km)}`); else parts.push('ק״מ לא ידוע');
      if (sc.hand) parts.push(`יד ${sg(sc.hand)}`);
      if (sc.suspect) parts.push(`חשד ${sc.suspect}`);
      tip.push(`ציון משתלמות: ${sc.total} (${parts.join(', ')})`);
    }
    row.title = tip.join('\n');

    row.append(pill, main, actions);
    row.addEventListener('click', () => {
      const a = document.querySelector(`a[data-testid="${token}"]`);
      if (!a) { window.open(`/vehicles/item/${token}`, '_blank'); return; }
      a.scrollIntoView({ behavior: 'smooth', block: 'center' });
      a.classList.add('mz-flash');
      setTimeout(() => a.classList.remove('mz-flash'), 2200);
    });
    return row;
  }

  function renderPanel() {
    ensurePanel();
    const rows = [...state.decor.entries()].filter(([, i]) => passes(i));
    const mins = (i) => (i.minutes == null ? Infinity : i.minutes);
    const now = Date.now();
    const score = (i) => M.dealScore(i, now) ?? -Infinity;
    rows.sort(([, a], [, b]) => panel.sort === 'new' ? mins(a) - mins(b)
      : panel.sort === 'score' ? score(b) - score(a)
        : (bestPct(b) ?? -1) - (bestPct(a) ?? -1));
    for (const b of panel.root.querySelectorAll('.mz-seg button')) b.classList.toggle('on', b.dataset.mode === panel.sort);
    panel.list.replaceChildren(...rows.map(([t, i], n) => buildRow(t, i, panel.sort === 'score' && n === 0 && score(i) > -Infinity)));
    if (!rows.length) {
      const e = el('div', 'mz-empty', state.running ? 'מחפש מציאות…' : 'אין כרגע מודעות שעומדות בסינון');
      panel.list.append(e);
    }
    panel.count.textContent = String(rows.filter(([, i]) => !i.hidden).length);
    const hiddenCount = [...state.decor.values()].filter((i) => i.hidden).length;
    panel.hiddenLink.hidden = !hiddenCount;
    panel.hiddenLink.textContent = panel.showHidden ? 'הסתרת המוסתרות' : `${hiddenCount} מוסתרות`;
    const n = activeFilters();
    panel.dot.textContent = n ? String(n) : '';
    panel.dot.hidden = !n;
    const left = state.pagination ? state.pagination.pages - state.nextPage + 1 : 0;
    panel.more.hidden = !(left > 0);
    panel.more.disabled = state.running;
    panel.more.textContent = `עוד עמודים (${left})`;
  }

  function buildBadge(info) {
    const t = tone(info);
    const b = el('div', `mz-badge mz-${t}`);
    b.dataset.v = String(info.v);
    const h = headline(info);
    b.append(el('div', 'mz-b1', h.src === 'fresh' ? `חדש · ${h.label}` : `${h.value} ${h.label}`));
    const second = [];
    if (info.flags && info.flags.length) second.push('⚠ לבדוק');
    if (info.km) second.push(kmShort(info.km) + (info.kmFlag === 'high' ? ' · גבוה' : ''));
    if (second.length) b.append(el('div', 'mz-b2', second.join(' · ')));
    if (info.seen) b.classList.add('mz-dim');
    if (info.listPrice) b.title = `מחירון יד 2: ${nf.format(info.listPrice)} ₪`;
    return b;
  }

  function applyBadges() {
    for (const a of document.querySelectorAll('a[data-testid]')) {
      const info = state.decor.get(a.dataset.testid);
      const old = a.querySelector(':scope > .mz-badge');
      if (!info || info.hidden || !passes(info)) { if (old) old.remove(); continue; }
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
    const peers = M.peerStats([...state.ads.values()]);
    for (const [token, ad] of state.ads) {
      const prev = state.decor.get(token) || {};
      const minutes = M.minutesSince(ad.createdAt, now);
      const fresh = minutes != null && minutes >= 0 && minutes <= FRESH_MIN;
      const k = ad.subModelId && ad.year ? `${ad.subModelId}/${ad.year}` : null;
      const lp = k ? state.lp.get(k) : null;
      const ms = k ? market.get(k) : null;
      const pct = M.discountPct(lp, ad.price);
      const mp = ms ? M.discountPct(ms.median, ad.price) : null;
      const ps = ad.modelId && ad.year ? peers.get(`${ad.modelId}/${ad.year}`) : null;
      const pp = ps ? M.discountPct(ps.median, ad.price) : null;
      const best = Math.max(pct == null ? -Infinity : pct, mp == null ? -Infinity : mp, pp == null ? -Infinity : pp);
      if (!(best >= MIN_SHOW) && !fresh) { state.decor.delete(token); continue; }
      const flags = M.suspicion(Math.max(pct ?? -Infinity, mp ?? -Infinity), prev.desc);
      const mark = state.marks[token];
      state.decor.set(token, {
        v: (prev.v || 0) + 1, fresh, minutes, createdAt: ad.createdAt, pct, listPrice: lp,
        mp, mn: ms ? ms.n : null, median: ms ? ms.median : null,
        pp, pn: ps ? ps.n : null, peerMedian: ps ? ps.median : null,
        year: ad.year, price: ad.price, hand: ad.hand, adType: ad.adType,
        km: prev.km, kmVerified: prev.kmVerified, kmFlag: prev.kmFlag, desc: prev.desc,
        flags, suspect: flags.length > 0,
        drop: state.drops.get(token) || null,
        newVisit: !!(state.prevTokens && !state.prevTokens.has(token)),
        seen: mark === 'seen', hidden: mark === 'hidden',
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

  // שומרים את המחיר של כל מודעה שראינו, כדי לזהות ירידות מחיר בין ביקורים.
  async function updatePriceHistory(ads) {
    const withPrice = ads.filter((a) => a.price > 0);
    if (!withPrice.length) return;
    const keys = withPrice.map((a) => `ph:${a.token}`);
    const stored = await chrome.storage.local.get(keys);
    const changed = {};
    for (const ad of withPrice) {
      const key = `ph:${ad.token}`;
      const hist = (stored[key] && stored[key].v) || [];
      const last = hist[hist.length - 1];
      if (!last || last.p !== ad.price) {
        hist.push({ p: ad.price, t: Date.now() });
        changed[key] = { v: hist.slice(-10), ts: Date.now() };
      }
      const drop = M.priceDrop(hist, ad.price, ad.priceBefore);
      if (drop) state.drops.set(ad.token, drop); else state.drops.delete(ad.token);
    }
    if (Object.keys(changed).length) await chrome.storage.local.set(changed);
  }

  // "ראיתי" / "הסתר"
  async function setMark(token, mark) {
    if (mark) state.marks[token] = mark; else delete state.marks[token];
    await chrome.storage.local.set({ marks: state.marks });
    rebuildDecor();
    render();
  }

  // מפתח לחיפוש בלי מספר עמוד, כדי לזהות "חדש מאז הביקור הקודם"
  function visitKey() {
    const u = new URL(location.href);
    u.searchParams.delete('page');
    return `visit:${u.pathname}?${u.searchParams.toString()}`;
  }
  async function loadVisit() {
    const k = visitKey();
    const o = await chrome.storage.local.get(k);
    state.prevTokens = o[k] && o[k].v ? new Set(o[k].v) : null;
  }
  async function saveVisit() {
    const k = visitKey();
    const all = new Set([...(state.prevTokens || []), ...state.ads.keys()]);
    await chrome.storage.local.set({ [k]: { v: [...all].slice(-600), ts: Date.now() } });
  }

  // p0..p1 = טווח ההתקדמות שמוקצה לקבוצת המודעות הזו במד הטעינה
  async function processAds(newAds, sig, p0, p1) {
    for (const ad of newAds) state.ads.set(ad.token, ad);
    await updatePriceHistory(newAds);
    const span = p1 - p0;
    const need = [];
    for (const ad of state.ads.values()) {
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
        const flags = M.suspicion(valuePct(cur), it.description);
        state.decor.set(token, { ...cur, v: cur.v + 1, km: it.km, kmVerified: it.kmVerified,
          kmFlag: M.kmFlag(it.km, cur.year, Date.now()), desc: it.description, flags, suspect: flags.length > 0 });
        render();
      }
      bumpStats(token);
    }
  }

  function summary() {
    const shown = [...state.decor.values()].filter(passes).length;
    return state.blocked ? 'יד 2 חסמה בקשות, נסו מאוחר יותר' : `${state.ads.size} מודעות נסרקו`;
  }

  async function scan() {
    if (!/\/vehicles\/cars\/?$/.test(location.pathname) || state.running) return;
    const sig = location.href;
    if (state.sig !== sig) {
      Object.assign(state, { sig, doneSig: null, pagination: null });
      state.ads.clear(); state.decor.clear(); state.lp.clear(); state.kmTried.clear(); state.drops.clear();
    }
    if (state.doneSig === sig) return;
    state.running = true;
    try {
      setProgress(0.03, 'קורא מודעות…');
      renderPanel();
      if (!state.prevTokens || state.visitFor !== visitKey()) { await loadVisit(); state.visitFor = visitKey(); }
      const { ads, pagination } = await loadAds();
      if (state.sig !== sig) return;
      state.pagination = pagination;
      state.nextPage = (Number(new URLSearchParams(location.search).get('page')) || 1) + 1;
      setProgress(0.12, `נמצאו ${ads.length} מודעות`);
      await processAds(ads, sig, 0.12, 1);
      state.doneSig = sig;
      await saveVisit();
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
      await saveVisit();
      endProgress(summary());
    } catch (e) {
      console.debug('מציאון: שגיאה', e);
      endProgress('שגיאה: ' + (e && e.message ? e.message : e));
    } finally {
      state.running = false;
      renderPanel();
    }
  }

  chrome.storage.local.get(['filters', 'marks']).then((o) => {
    Object.assign(filters, o.filters || {});
    state.marks = o.marks || {};
    rebuildDecor();
    syncSelects();
    if (panel.root) render();
  });

  let timer = null;
  new MutationObserver(() => {
    clearTimeout(timer);
    timer = setTimeout(() => { applyBadges(); if (location.href !== state.doneSig) scan(); }, 700);
  }).observe(document.body, { childList: true, subtree: true });
  scan();
})();
