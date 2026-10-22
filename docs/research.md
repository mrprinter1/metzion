# שלב 1: חקר יד 2 (בוצע ב-22.10.2026)

הכול נבדק בכרום במחשב, בלי התחברות. ייתכן שיד 2 תשנה דברים בלי הודעה, ולכן כל סעיף כאן הוא "נכון למועד הבדיקה".

## מחירון (price-list)

- הדף לכל תת-דגם ושנה: `https://www.yad2.co.il/price-list/sub-model/{subModelId}/{year}`
  - דוגמה: `/price-list/sub-model/132362/2019` מציג 87,000 ₪ (אאודי A3 Limited אוט׳ 2.0, 2019).
- המחיר בדף נבנה בשרת (Next.js) ומוטמע ב-`__NEXT_DATA__`: `props.pageProps.subModel.price`.
- אותם נתונים כ-JSON בלי HTML:
  `GET /price-list/_next/data/{buildId}/sub-model/{subModelId}/{year}.json` ← `pageProps.subModel.price`
  - אומת ב-Console: מחזיר `87000`.
  - ה-`buildId` משתנה בכל פריסה. את הערך הנוכחי קוראים מ-`__NEXT_DATA__.buildId` של `/price-list/`.
- רשימות הבחירה (כולן `GET`, JSON): `gw.yad2.co.il/price-list/search-options/manufacturers`,
  `.../{manufacturerId}/models`, `.../{modelId}/sub-models`.
  - ל-A3 (`10004`) יש עשרות תתי-דגמים. המחיר הוא לפי **תת-דגם ושנה**, לא לפי דגם ושנה.
- מחיר אחד, לא טווח.

## דף התוצאות (`/vehicles/cars?manufacturer=..&model=..&year=..`)

- המודעות ב-`#__NEXT_DATA__` תחת `props.pageProps.dehydratedState.queries[]` עם `queryKey[0] === "feed-mix"`:
  `state.data.ads` (וגם `platinum`, `solo`, `boost`, עם כפילויות).
- שדות במודעה: `token`, `price` (0 = לא צוין), `subModel.id`, `model.id`, `manufacturer.id`,
  `vehicleDates.yearOfProduction`, `hand.id`, `createdAt`, `adType`, `priceBeforeTag` (מחיר קודם כשהוזל).
- **`subModel.id` של המודעה זהה למזהה שבכתובת המחירון** (`modelMaster.id`). זה מה שמאפשר התאמה בלי ניחושים.
- **אין ק"מ ברשימת התוצאות.**
- `__NEXT_DATA__` בדף לא מתעדכן בניווט פנימי. צריך לבדוק ש-`query` שבו תואם לכתובת, ואם לא, לטעון את הדף מחדש.
- בכרטיס ב-DOM: `a[data-testid="{token}"]`.

## דף מודעה (`/vehicles/item/{token}`)

- `queries[]` עם `queryKey = ["vehicles","item",token]`, ובו `state.data`:
  `km`, `kmInLastTest`, `isVerifiedByMt.km` (אימות ק"מ), `dates.createdAt`, `dates.rebouncedAt`, `hand`, `subModel`.
- `createdAt` הוא הזמן המקורי. `rebouncedAt` מתעדכן בקידום, ולכן לא משתמשים בו ל"עלה לאחרונה".
- נתיב ה-JSON `/vehicles/_next/data/{buildId}/item/{token}.json` **לא נבדק**. הקוד נופל חזרה לטעינת ה-HTML.

## הגנת בוטים

- ביד 2 פועלת Radware Bot Manager (עוגיות `__uzm*`, בקשות טלמטריה ל-UUID). לכן:
  - קוראים נתונים מתוך הדף הפתוח, ולא סורקים.
  - מטמון לכל שילוב, מרווח בין בקשות, ועצירה כשמתקבל 403 או 429.
- תנאי השימוש של יד 2 אוסרים שימוש אוטומטי. זה נשאר סיכון פתוח.

## ממצאים לדוגמה (A3, 2019, תת-דגם 132362, מחירון 87,000)

| מודעה | מחיר | מול המחירון |
|---|---|---|
| 3s3sedom | 68,000 | 21.8% מתחת |
| ml5q6345 | 91,000 | 4.6% מעל |
| 668g2rwh | 96,000 | 10.3% מעל |

## לא נבדק עדיין

- האם לכל תת-דגם ושנה יש מחיר מחירון (ייתכן 404).
- כמה בקשות לפני חסימה.
- דף 2 ומעלה, וטעינה בגלילה.
- פייסבוק מרקטפלייס.
