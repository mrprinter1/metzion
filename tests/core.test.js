'use strict';
const test = require('node:test');
const assert = require('node:assert');
const M = require('../src/core.js');

// נתוני אמת מקוצרים, מתוך דפי יד 2 מ-22.10.2026.
const feed = {
  query: { manufacturer: '1', model: '10004', year: '2019-2019' },
  props: { pageProps: { dehydratedState: { queries: [{
    queryKey: ['feed-mix', 'vehicles', 'cars', { manufacturer: '1' }],
    state: { data: {
      ads: [
        { token: '3s3sedom', price: 68000, subModel: { id: 132362 }, vehicleDates: { yearOfProduction: 2019 },
          hand: { id: 3 }, createdAt: '2026-10-20T17:16:37', adType: 'private' },
        { token: 'ecz5cjds', price: 0, subModel: { id: 101244 }, vehicleDates: { yearOfProduction: 2019 } },
      ],
      platinum: [{ token: '3s3sedom', price: 68000 }, { token: 'atsr2isg', price: 69900, subModel: { id: 100009 },
        vehicleDates: { yearOfProduction: 2019 } }],
      solo: [], boost: [],
    } },
  }] } } },
};

test('extractAds מאחד כפילויות ושומר שדות', () => {
  const ads = M.extractAds(feed);
  assert.deepStrictEqual(ads.map((a) => a.token), ['3s3sedom', 'ecz5cjds', 'atsr2isg']);
  assert.strictEqual(ads[0].subModelId, 132362);
  assert.strictEqual(ads[0].year, 2019);
  assert.strictEqual(ads[1].price, 0);
});

test('discountPct: 68,000 מול מחירון 87,000', () => {
  assert.strictEqual(M.discountPct(87000, 68000), 21.8);
  assert.strictEqual(M.discountPct(87000, 96000), -10.3);
  assert.strictEqual(M.discountPct(null, 5), null);
  assert.strictEqual(M.discountPct(87000, 0), null);
});

test('extractListPrice מדף מחירון', () => {
  assert.strictEqual(M.extractListPrice({ pageProps: { subModel: { price: 87000 } } }), 87000);
  assert.strictEqual(M.extractListPrice({ props: { pageProps: { subModel: { price: 87000 } } } }), 87000);
  assert.strictEqual(M.extractListPrice({ pageProps: {} }), null);
});

test('extractItem מדף מודעה', () => {
  const item = { props: { pageProps: { dehydratedState: { queries: [
    { queryKey: ['vehicles', 'item', '34qiv60q'], state: { data: {
      km: 141000, kmInLastTest: 134571, isVerifiedByMt: { km: true }, dates: { createdAt: '2026-10-18T18:11:47' } } } },
  ] } } } };
  assert.deepStrictEqual(M.extractItem(item), {
    km: 141000, kmInLastTest: 134571, kmVerified: true, createdAt: '2026-10-18T18:11:47', description: '' });
  assert.strictEqual(M.extractItem({}), null);
});

test('parseNextDataFromHtml', () => {
  const html = '<html><script id="__NEXT_DATA__" type="application/json">{"buildId":"abc","query":{}}</script></html>';
  assert.strictEqual(M.parseNextDataFromHtml(html).buildId, 'abc');
  assert.strictEqual(M.parseNextDataFromHtml('<html></html>'), null);
  assert.strictEqual(M.parseNextDataFromHtml('<script id="__NEXT_DATA__">{bad</script>'), null);
});

test('pageMatchesUrl מזהה נתונים ישנים אחרי ניווט פנימי', () => {
  assert.ok(M.pageMatchesUrl(feed, '?manufacturer=1&model=10004&year=2019-2019'));
  assert.ok(!M.pageMatchesUrl(feed, '?manufacturer=1&model=10004&year=2020-2020'));
  assert.ok(!M.pageMatchesUrl(feed, '?manufacturer=1&model=10004&year=2019-2019&Order=3'));
});

test('kmFlag: 141,000 ק״מ ברכב מ-2019 (אוקטובר 2026) נחשב רגיל', () => {
  const now = Date.parse('2026-10-22T12:00:00');
  assert.strictEqual(M.kmFlag(141000, 2019, now), 'normal');
  assert.strictEqual(M.kmFlag(250000, 2019, now), 'high');
  assert.strictEqual(M.kmFlag(40000, 2019, now), 'low');
  assert.strictEqual(M.kmFlag(null, 2019, now), null);
});

test('minutesSince', () => {
  const now = Date.parse('2026-10-22T12:30:00');
  assert.strictEqual(M.minutesSince('2026-10-22T12:00:00', now), 30);
  assert.strictEqual(M.minutesSince('לא תאריך', now), null);
});

test('formatAge ו-formatDate', () => {
  assert.strictEqual(M.formatAge(5), 'לפני 5 דק׳');
  assert.strictEqual(M.formatAge(60), 'לפני שעה');
  assert.strictEqual(M.formatAge(180), 'לפני 3 שעות');
  assert.strictEqual(M.formatAge(1440), 'לפני יום');
  assert.strictEqual(M.formatAge(60 * 24 * 4), 'לפני 4 ימים');
  assert.strictEqual(M.formatAge(null), null);
  assert.strictEqual(M.formatDate('2026-10-20T17:16:37'), '20/10');
  assert.strictEqual(M.formatDate(undefined), null);
});

test('median ו-marketStats', () => {
  assert.strictEqual(M.median([3, 1, 2]), 2);
  assert.strictEqual(M.median([4, 1, 2, 3]), 2.5);
  assert.strictEqual(M.median([]), null);
  const ads = [
    { price: 90000, subModelId: 1, year: 2019 }, { price: 80000, subModelId: 1, year: 2019 },
    { price: 100000, subModelId: 1, year: 2019 }, { price: 0, subModelId: 1, year: 2019 },
    { price: 50000, subModelId: 2, year: 2019 }, { price: 60000, subModelId: 2, year: 2019 },
  ];
  const m = M.marketStats(ads);
  assert.deepStrictEqual(m.get('1/2019'), { median: 90000, n: 3 });
  assert.strictEqual(m.has('2/2019'), false);
});

test('extractPagination', () => {
  const d = { props: { pageProps: { dehydratedState: { queries: [
    { queryKey: ['feed-mix'], state: { data: { pagination: { pages: 7, perPage: 40, total: 270 } } } }] } } } };
  assert.deepStrictEqual(M.extractPagination(d), { pages: 7, total: 270, perPage: 40 });
  assert.strictEqual(M.extractPagination({}), null);
});

test('dealScore מעדיף הנחה עם ק״מ סביר על הנחה גדולה עם ק״מ גבוה', () => {
  const now = Date.parse('2026-10-22T12:00:00');
  const highKm = M.dealScore({ pct: 21.8, km: 192000, year: 2019, hand: 3 }, now);
  const okKm = M.dealScore({ pct: 23.2, km: 130000, year: 2019, hand: 2 }, now);
  const noKm = M.dealScore({ pct: 15, year: 2019, hand: 1 }, now);
  assert.ok(okKm > highKm, `${okKm} > ${highKm}`);
  assert.strictEqual(noKm, 15);
  assert.strictEqual(M.dealScore({ year: 2019 }, now), null);
  assert.ok(M.dealScore({ pct: 12, km: 40000, year: 2019, hand: 1 }, now) > 12);
});

test('redFlags מזהה בעיות ומתעלם משלילה', () => {
  assert.deepStrictEqual(M.redFlags('הרכב עבר תאונה קלה מאחור'), ['תאונה']);
  assert.deepStrictEqual(M.redFlags('ללא תאונות, שמור מאוד'), []);
  assert.deepStrictEqual(M.redFlags('לא עבר תאונה'), []);
  assert.deepStrictEqual(M.redFlags('התחייבות מלאה בבדיקה אפשרות מימון וטרייד אין'), []);
  assert.deepStrictEqual(M.redFlags('המחיר אחרי מקדמה של 20%'), ['ייתכן שהמחיר הוא מקדמה']);
  assert.deepStrictEqual(M.redFlags('נמכר ללא טסט'), ['בלי טסט']);
  assert.deepStrictEqual(M.redFlags('נזק בשלדה מתוקן'), ['פגיעת שלדה']);
  assert.deepStrictEqual(M.redFlags(''), []);
});

test('suspicion ו-dealScore עם חשד', () => {
  assert.deepStrictEqual(M.suspicion(37.3, ''), ['הנחה חריגה, כדאי לברר למה']);
  assert.deepStrictEqual(M.suspicion(15, 'ללא תאונות'), []);
  const now = Date.parse('2026-10-22T12:00:00');
  assert.strictEqual(M.dealScore({ pct: 30, suspect: true }, now), 20);
});

test('priceDrop', () => {
  assert.deepStrictEqual(M.priceDrop([], 69900, 74900), { amount: 5000, at: null });
  assert.strictEqual(M.priceDrop([{ p: 70000, t: 1 }], 70000, null), null);
  assert.deepStrictEqual(M.priceDrop([{ p: 75000, t: 1 }, { p: 70000, t: 2 }], 70000, null), { amount: 5000, at: 2 });
  assert.strictEqual(M.priceDrop([], 0, 80000), null);
  assert.strictEqual(M.priceDrop([], 70000, 70500), null);
});

test('inQuietHours כולל מעבר חצות', () => {
  const at = (h, m) => new Date(2026, 9, 22, h, m);
  assert.strictEqual(M.inQuietHours(at(23, 30), '23:00', '07:00'), true);
  assert.strictEqual(M.inQuietHours(at(3, 0), '23:00', '07:00'), true);
  assert.strictEqual(M.inQuietHours(at(7, 0), '23:00', '07:00'), false);
  assert.strictEqual(M.inQuietHours(at(12, 0), '23:00', '07:00'), false);
  assert.strictEqual(M.inQuietHours(at(14, 0), '13:00', '15:00'), true);
  assert.strictEqual(M.inQuietHours(at(14, 0), '10:00', '10:00'), false);
});

test('extractAds כולל שם רכב', () => {
  const d = { props: { pageProps: { dehydratedState: { queries: [{ queryKey: ['feed-mix'], state: { data: { ads: [
    { token: 't1', price: 1, manufacturer: { text: 'שברולט' }, model: { text: 'ספארק' }, subModel: { id: 5, text: 'LT Plus' } }] } } }] } } } };
  const [ad] = M.extractAds(d);
  assert.strictEqual(ad.name, 'שברולט ספארק');
  assert.strictEqual(ad.subModelText, 'LT Plus');
});
