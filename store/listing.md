# מציאון · חומרים לחנות של כרום

כל מה שצריך להדביק ב-[Developer Dashboard](https://chrome.google.com/webstore/devconsole). כל כותרת כאן היא שדה בטופס.

## חבילה

```sh
npm run pack      # יוצר dist/metzion-<version>.zip
```

מעלים את ה-ZIP הזה, לא את ה-ZIP של כל הריפו. בכל עדכון מעלים את הגרסה ב-`manifest.json` ואורזים מחדש.

## Store listing

**Name:** מציאון

**Summary** (נלקח מ-`manifest.json`, עד 132 תווים):
מוצא ביד 2 רכבים במחיר נמוך מהמחירון ומהשוק, מדרג לפי ק״מ ויד, ושולח התראות על מציאות חדשות

**Category:** Shopping
**Language:** Hebrew

**Description:**

```
מציאון עוזר למצוא רכב משומש במחיר טוב ביד 2, בלי לעבור על מאות מודעות.

בכל חיפוש רכבים ביד 2 נפתח פאנל קטן בצד המסך עם המודעות הכי משתלמות:
• השוואה למחירון של אותה רמת גימור, ולחציון המחירים בשוק
• השוואה לכל הרכבים מאותו דגם ושנה בחיפוש
• דירוג "הכי משתלם" שמשקלל מחיר, קילומטראז׳ ויד
• סימון קילומטראז׳ גבוה, וסימון ⚠ למודעות שכדאי לבדוק (למשל "תאונה" או "מקדמה" בתיאור)
• ירידות מחיר מאז הביקור הקודם, ותאריך פרסום של כל מודעה
• סינון לפי הנחה, ק״מ, יד וסוג מוכר
• לחיצה על שורה קופצת ישר למודעה

התראות על מציאות חדשות:
שומרים חיפוש בלחיצה על 🔔, ומציאון בודק אותו כל כמה דקות ושולח התראה למחשב, ואם רוצים גם לטלגרם. אפשר להגדיר שעות שקט. הבדיקות רצות כשהמחשב דולק וכרום פתוח.

פרטיות: ההגדרות, החיפושים והיסטוריית המחירים נשמרים רק במחשב שלכם. אין פרסומות ואין מעקב.

מציאון הוא כלי עצמאי ואינו קשור ליד 2.
```

**Screenshots** (1280×800): `store/screenshots/1-ranking.png`, `2-filters.png`, `3-alerts.png`
**Small promo tile** (440×280): `store/screenshots/tile-440x280.png`
**Icon** (128×128): `icons/icon128.png`

## Privacy practices

**Single purpose:**
מציאון מסמן בתוצאות החיפוש של יד 2 רכבים שמחירם נמוך מהמחירון ומהשוק, ושולח התראות על מודעות חדשות כאלה בחיפושים שהמשתמש שמר.

**Permission justifications:**

| הרשאה | הסבר (להדביק באנגלית) |
|---|---|
| storage | Stores the user's settings, saved searches, filters and price history locally. |
| alarms | Schedules the periodic check of the user's saved searches for new listings. |
| notifications | Shows a desktop notification when a new listing below the price list appears in a saved search. |
| Host: www.yad2.co.il | Reads search results, price-list pages and listing pages on Yad2 to compare prices. The extension only runs on Yad2. |
| Host: metzion.nivboros.workers.dev | The extension's own server, used only when the user opts in to Telegram alerts. |

**Remote code:** No, I am not using remote code.

**Data usage** (מה לסמן):
- ✓ Personally identifiable information: רק השם הפרטי בטלגרם ומזהה הצ'אט, ורק למי שמחבר טלגרם.
- ✓ Website content: פרטי הרכב שבהתראה עוברים לשרת כדי להישלח לטלגרם.
- כל השאר לא מסומן.
- לסמן את שלוש ההצהרות (לא מוכרים מידע, לא משתמשים בו למטרה אחרת, לא לצורך אשראי).

**Privacy policy URL:** `https://metzion.nivboros.workers.dev/privacy`

## Distribution

**Visibility:** Unlisted בהתחלה. רק מי שיש לו את הקישור יכול להתקין, וזה מתאים לבדיקה עם סוחרים. אחר כך משנים ל-Public באותו מקום, בלי הגשה חדשה.
**Regions:** Israel, או All regions.
