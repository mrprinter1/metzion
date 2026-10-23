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
      modelId: ad.model && ad.model.id,
      year: ad.vehicleDates && ad.vehicleDates.yearOfProduction,
      hand: ad.hand && ad.hand.id,
      createdAt: ad.createdAt,
      adType: ad.adType,
      priceBefore: Number(ad.metaData && ad.metaData.priceBeforeTag) || null,
      name: [ad.manufacturer && ad.manufacturer.text, ad.model && ad.model.text].filter(Boolean).join(' '),
      subModelText: (ad.subModel && ad.subModel.text) || '',
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
      description: (d.metaData && d.metaData.description) || '',
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

  // ציון "הכי משתלם": ההנחה הטובה מבין מחירון/שוק, מתוקנת לפי ק"מ ויד.
  // ק"מ כפול מהצפוי מוריד 20 נקודות, חצי מהצפוי מוסיף 10. כל יד מעל הראשונה מורידה 1.5.
  // המשקלות הם הערכה לכיוונון, לא נוסחה מבוססת.
  // הציון מורכב משני מבטים על המחיר:
  // ערך: כמה הרכב זול ביחס לרמת הגימור שלו (מחירון או חציון של אותו תת-דגם).
  // דומים: כמה הוא זול ביחס לכל הרכבים מאותו דגם ושנה בחיפוש, בלי קשר לגימור.
  // בלי המבט השני, גימור יקר עם הנחה יפה עוקף רכב זול יותר בגימור בסיסי.
  function scoreParts(i, now) {
    const val = Math.max(i.pct == null ? -Infinity : i.pct, i.mp == null ? -Infinity : i.mp);
    const hasVal = val !== -Infinity;
    const hasPeer = i.pp != null;
    if (!hasVal && !hasPeer) return null;
    const base = hasVal && hasPeer ? 0.6 * val + 0.4 * i.pp : hasVal ? val : i.pp;
    let km = 0;
    if (i.km > 0 && i.year) {
      const r = Math.min(2.5, Math.max(0.3, i.km / expectedKm(i.year, now)));
      km = 20 * (1 - r);
    }
    const hand = i.hand > 1 ? -1.5 * (i.hand - 1) : 0;
    const suspect = i.suspect ? -10 : 0;
    const r1 = (x) => Math.round(x * 10) / 10;
    return { base: r1(base), km: r1(km), hand: r1(hand), suspect, total: r1(base + km + hand + suspect) };
  }
  function dealScore(i, now) {
    const p = scoreParts(i, now);
    return p ? p.total : null;
  }

  // מילים בתיאור שמרמזות על בעיה. neg = לבדוק שלא כתוב לפניהן "ללא", "לא עבר" וכו'.
  const RED_FLAGS = [
    { re: /תאונ/, why: 'תאונה', neg: true },
    { re: /(פגיע|נזק)\S*\s+(ב?שלדה)/, why: 'פגיעת שלדה', neg: true },
    { re: /ירידת ערך/, why: 'ירידת ערך', neg: true },
    { re: /מקדמה|החזר חודשי|מחיר סמלי/, why: 'ייתכן שהמחיר הוא מקדמה' },
    { re: /(ללא|בלי|אין)\s+טסט/, why: 'בלי טסט' },
    { re: /לא מניע|לא נוסע|לחלקים|תקלה|הצפה|מוצף|פגוע/, why: 'תקלה או נזק', neg: true },
  ];
  const NEGATION = /(ללא|בלי|אין|לא עבר|לא עברה|לא היו|לא היה|אפס)\s*$/;

  function redFlags(text) {
    const out = [];
    const t = String(text || '');
    for (const f of RED_FLAGS) {
      const re = new RegExp(f.re.source, 'g');
      let m;
      while ((m = re.exec(t))) {
        if (f.neg && NEGATION.test(t.slice(Math.max(0, m.index - 12), m.index))) continue;
        if (!out.includes(f.why)) out.push(f.why);
        break;
      }
    }
    return out;
  }

  // סיבות לחשד: הנחה חריגה (30%+) או מילים בעייתיות בתיאור.
  function suspicion(bestPct, description) {
    const out = bestPct >= 30 ? ['הנחה חריגה, כדאי לברר למה'] : [];
    return out.concat(redFlags(description));
  }

  // ירידת מחיר: לפי היסטוריה שנשמרה ([{p, t}]) או לפי המחיר הקודם שיד 2 מציגה.
  function priceDrop(history, price, priceBefore) {
    if (!(price > 0)) return null;
    const prev = (history || []).map((h) => h.p).filter((p) => p > 0);
    const max = Math.max(priceBefore || 0, ...prev, 0);
    const amount = max - price;
    if (amount < 1000) return null;
    const last = (history || []).filter((h) => h.p === price)[0];
    return { amount, at: last && prev.length > 1 ? last.t : null };
  }

  // שעות שקט, כולל טווח שעובר את חצות (למשל 23:00 עד 07:00).
  function inQuietHours(date, from, to) {
    const p = (s) => { const [h, m] = String(s || '0:0').split(':').map(Number); return (h || 0) * 60 + (m || 0); };
    const now = date.getHours() * 60 + date.getMinutes();
    const a = p(from);
    const b = p(to);
    if (a === b) return false;
    return a < b ? now >= a && now < b : now >= a || now < b;
  }

  function formatAge(minutes) {
    if (minutes == null) return null;
    if (minutes < 60) return `לפני ${Math.max(1, Math.round(minutes))} דק׳`;
    if (minutes < 1440) {
      const h = Math.round(minutes / 60);
      return h === 1 ? 'לפני שעה' : h === 2 ? 'לפני שעתיים' : `לפני ${h} שעות`;
    }
    const d = Math.round(minutes / 1440);
    return d === 1 ? 'לפני יום' : d === 2 ? 'לפני יומיים' : `לפני ${d} ימים`;
  }

  // "2026-10-20T17:16:37" -> "20/10"
  function formatDate(iso) {
    const m = /^\d{4}-(\d{2})-(\d{2})/.exec(iso || '');
    return m ? `${m[2]}/${m[1]}` : null;
  }

  function median(nums) {
    if (!nums.length) return null;
    const a = [...nums].sort((x, y) => x - y);
    const m = a.length >> 1;
    return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
  }

  // חציון מחירים לכל תת-דגם ושנה בין המודעות שנסרקו. דורש לפחות minN מודעות.
  function marketStats(ads, minN) {
    const groups = new Map();
    for (const ad of ads) {
      if (!(ad.price > 0) || !ad.subModelId || !ad.year) continue;
      const k = `${ad.subModelId}/${ad.year}`;
      if (!groups.has(k)) groups.set(k, []);
      groups.get(k).push(ad.price);
    }
    const out = new Map();
    for (const [k, v] of groups) if (v.length >= (minN || 3)) out.set(k, { median: median(v), n: v.length });
    return out;
  }

  // חציון מחירים לכל דגם ושנה, בלי קשר לתת-הדגם.
  function peerStats(ads, minN) {
    return marketStats(ads.map((a) => ({ price: a.price, subModelId: a.modelId, year: a.year })), minN);
  }

  function extractPagination(data) {
    const q = findQuery(data, 'feed-mix');
    const p = q && q.state && q.state.data && q.state.data.pagination;
    return p ? { pages: p.pages || 1, total: p.total || 0, perPage: p.perPage || 0 } : null;
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
    discountPct, expectedKm, kmFlag, minutesSince, pageMatchesUrl, formatAge, formatDate, median, marketStats, peerStats, extractPagination, dealScore, scoreParts, redFlags, suspicion, priceDrop, inQuietHours,
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.Metzion = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
