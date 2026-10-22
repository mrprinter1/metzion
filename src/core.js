'use strict';
// לוגיקה טהורה (בלי DOM ובלי רשת), כדי שאפשר יהיה לבדוק אותה ב-node.
(function (root) {
  function pageProps(data) {
    return (data && data.props && data.props.pageProps) || (data && data.pageProps) || null;
  }

  function findQuery(data, k0, k1) {
    const pp = pageProps(data);
    const qs = pp && pp.dehydratedState && pp.dehydratedState.queries;
    if (!qs) return null;
    return qs.find((q) => q.queryKey && q.queryKey[0] === k0 && (k1 === undefined || q.queryKey[1] === k1)) || null;
  }

  function parseNextDataFromHtml(html) {
    const m = /<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/.exec(html);
    if (!m) return null;
    try { return JSON.parse(m[1]); } catch (e) { return null; }
  }

  // בדף התוצאות המודעות מופיעות ב-ads, וחלקן גם ב-platinum/solo/boost (כפילויות).
  function extractAds(data) {
    const q = findQuery(data, 'feed-mix');
    const d = q && q.state && q.state.data;
    if (!d) return [];
    const seen = new Map();
    for (const list of [d.ads, d.platinum, d.boost, d.solo]) {
      for (const ad of list || []) {
        if (ad && ad.token && !seen.has(ad.token)) seen.set(ad.token, ad);
      }
    }
    return [...seen.values()].map((ad) => ({
      token: ad.token,
      price: Number(ad.price) || 0,
      subModelId: ad.subModel && ad.subModel.id,
      year: ad.vehicleDates && ad.vehicleDates.yearOfProduction,
      hand: ad.hand && ad.hand.id,
      createdAt: ad.createdAt,
      adType: ad.adType,
    }));
  }

  // דף מודעה בודדת: ק"מ, ק"מ בטסט האחרון, ואם משרד התחבורה אימת את הק"מ.
  function extractItem(data) {
    const q = findQuery(data, 'vehicles', 'item');
    const d = q && q.state && q.state.data;
    if (!d) return null;
    return {
      km: Number(d.km) || null,
      kmInLastTest: Number(d.kmInLastTest) || null,
      kmVerified: !!(d.isVerifiedByMt && d.isVerifiedByMt.km),
      createdAt: d.dates && d.dates.createdAt,
    };
  }

  // דף המחירון: מחיר אחד לכל תת-דגם ושנה.
  function extractListPrice(data) {
    const pp = pageProps(data);
    const p = pp && pp.subModel && pp.subModel.price;
    return p > 0 ? p : null;
  }

  // אחוז מתחת למחירון (חיובי = זול מהמחירון), עם ספרה אחת אחרי הנקודה.
  function discountPct(listPrice, price) {
    if (!(listPrice > 0) || !(price > 0)) return null;
    return Math.round(((listPrice - price) / listPrice) * 1000) / 10;
  }

  // הערכה גסה: 15,000 ק"מ לשנה. פרמטר לכיוונון, לא עובדה.
  function expectedKm(year, now, perYear) {
    const ageYears = Math.max(0.5, (now - new Date(year, 6, 1).getTime()) / (365.25 * 864e5));
    return ageYears * (perYear || 15000);
  }

  function kmFlag(km, year, now) {
    if (!(km > 0) || !year) return null;
    const r = km / expectedKm(year, now);
    return r > 1.3 ? 'high' : r < 0.7 ? 'low' : 'normal';
  }

  // התאריכים ביד 2 הם בלי אזור זמן, והם לפי שעון ישראל. בדפדפן בישראל זה נכון.
  function minutesSince(iso, now) {
    const t = Date.parse(iso);
    return Number.isNaN(t) ? null : (now - t) / 60000;
  }

  // ה-__NEXT_DATA__ בדף לא מתעדכן בניווט פנימי, לכן בודקים שהוא תואם לכתובת.
  function pageMatchesUrl(data, search) {
    const q = (data && data.query) || {};
    const sp = new URLSearchParams(search);
    const keys = new Set([...Object.keys(q), ...sp.keys()]);
    for (const k of keys) {
      if (String(q[k] === undefined ? '' : q[k]) !== (sp.get(k) || '')) return false;
    }
    return true;
  }

  const api = {
    parseNextDataFromHtml, extractAds, extractItem, extractListPrice,
    discountPct, expectedKm, kmFlag, minutesSince, pageMatchesUrl,
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.Metzion = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
