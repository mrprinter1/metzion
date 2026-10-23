'use strict';
// בקשות ליד 2 מתוך הרקע של התוסף (service worker). המטמון משותף עם הדף (chrome.storage.local).
// fetcher מוזרק, כדי שאפשר יהיה לשלוח את הבקשה דרך לשונית פתוחה של יד 2 כשיש כזו.
(function (root) {
  const M = root.Metzion;
  const TTL = 24 * 3600e3;
  const NEG_TTL = 3 * 3600e3;
  const ITEM_TTL = 6 * 3600e3;

  function create(opts) {
    const base = opts.base || '';
    const gap = opts.gap || 400;
    const fetcher = opts.fetcher || ((url, o) => fetch(url, o));
    const st = { lastReq: 0, blocked: false, plBuildId: null, plBuildTs: 0, vehiclesBuildId: null };

    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    async function polite(fn) {
      const wait = Math.max(0, st.lastReq + gap - Date.now());
      st.lastReq = Date.now() + wait;
      if (wait) await sleep(wait);
      return fn();
    }
    const isBlock = (r) => r && (r.status === 403 || r.status === 429);
    const req = (path, json) => polite(() => fetcher(base + path, {
      credentials: 'include', headers: json ? { accept: 'application/json' } : {},
    }));

    async function cacheGet(key) {
      const o = await chrome.storage.local.get(key);
      const e = o[key];
      if (!e) return null;
      const ttl = key.startsWith('item:') ? ITEM_TTL : e.v == null ? NEG_TTL : TTL;
      return Date.now() - e.ts < ttl ? e : null;
    }
    const cacheSet = (key, v) => chrome.storage.local.set({ [key]: { v, ts: Date.now() } });

    async function fetchText(path) {
      const r = await req(path, false);
      if (isBlock(r)) st.blocked = true;
      return { status: r.status, ok: r.ok, text: r.ok ? await r.text() : '' };
    }

    async function plBuildId(force) {
      if (st.plBuildId && !force) return st.plBuildId;
      if (force && Date.now() - st.plBuildTs < 5 * 60e3) return st.plBuildId;
      const r = await fetchText('/price-list/');
      const data = r.ok ? M.parseNextDataFromHtml(r.text) : null;
      st.plBuildTs = Date.now();
      st.plBuildId = (data && data.buildId) || st.plBuildId;
      return st.plBuildId;
    }

    async function fetchListPrice(smId, year) {
      const path = (bid) => `/price-list/_next/data/${bid}/sub-model/${smId}/${year}.json`;
      const bid = await plBuildId(false);
      let r = bid ? await req(path(bid), true) : null;
      if (!r || r.status === 404) {
        const bid2 = await plBuildId(true);
        if (bid2 && bid2 !== bid) r = await req(path(bid2), true);
      }
      if (isBlock(r)) { st.blocked = true; return undefined; }
      if (r && r.ok) return M.extractListPrice(await r.json());
      const h = await fetchText(`/price-list/sub-model/${smId}/${year}`);
      if (st.blocked) return undefined;
      return h.ok ? M.extractListPrice(M.parseNextDataFromHtml(h.text)) : null;
    }

    async function listPrice(smId, year) {
      const key = `pl:${smId}:${year}`;
      const hit = await cacheGet(key);
      if (hit) return hit.v;
      let price;
      try { price = await fetchListPrice(smId, year); } catch (e) { return null; }
      if (price !== undefined) await cacheSet(key, price);
      return price === undefined ? null : price;
    }

    async function itemInfo(token) {
      const key = `item:${token}`;
      const hit = await cacheGet(key);
      if (hit) return hit.v;
      let info = null;
      try {
        if (st.vehiclesBuildId) {
          const r = await req(`/vehicles/_next/data/${st.vehiclesBuildId}/item/${token}.json`, true);
          if (isBlock(r)) { st.blocked = true; return null; }
          if (r.ok) info = M.extractItem(await r.json());
        }
        if (!info) {
          const h = await fetchText(`/vehicles/item/${token}`);
          if (st.blocked) return null;
          if (h.ok) info = M.extractItem(M.parseNextDataFromHtml(h.text));
        }
      } catch (e) { return null; }
      await cacheSet(key, info);
      return info;
    }

    return { st, fetchText, listPrice, itemInfo };
  }

  root.MetzionNet = { create };
})(globalThis);
