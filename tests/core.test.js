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
    km: 141000, kmInLastTest: 134571, kmVerified: true, createdAt: '2026-10-18T18:11:47' });
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
