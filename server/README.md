# השרת של מציאון (Cloudflare Worker)

השרת מחזיק את בוט הטלגרם המשותף ומעביר התראות מהתוסף לטלגרם. הוא חינמי עד עשרות אלפי בקשות ביום.
הקוד: `worker.js`. ההקמה כולה דרך האתר של Cloudflare, בלי טרמינל.

> **לעולם אל תשלחו את הטוקן של הבוט בצ'אט, במייל או בקוד.** הוא נכנס רק להגדרות הסודיות ב-Cloudflare.

## 1. יצירת הבוט (פעם אחת, בטלגרם)
1. בטלגרם, חפשו **@BotFather** ופתחו איתו שיחה.
2. שלחו `/newbot`.
3. שם לבוט: `מציאון`.
4. שם משתמש (באנגלית, חייב להסתיים ב-bot), למשל `MetzionAlertsBot`.
5. BotFather ישלח **טוקן** (נראה כמו `123456789:AAH...`). שמרו אותו בצד לשלב 4.

## 2. חשבון Cloudflare
1. היכנסו ל-https://dash.cloudflare.com/sign-up ופתחו חשבון חינמי.

## 3. יצירת ה-Worker
1. בתפריט: **Workers & Pages** ← **Create** ← **Create Worker** (או "Start with Hello World").
2. שם: `metzion` ← **Deploy**.
3. **Edit code**. מחקו את כל הקוד שם, הדביקו את כל התוכן של `server/worker.js` ← **Deploy**.
4. רשמו את הכתובת של ה-Worker, למשל `https://metzion.<השם-שלכם>.workers.dev`.

## 4. הגדרות סודיות
ב-Worker: **Settings** ← **Variables and Secrets** ← **Add**:
| שם | סוג | ערך |
|---|---|---|
| `BOT_TOKEN` | Secret | הטוקן מ-BotFather |
| `WEBHOOK_SECRET` | Secret | רצף אקראי של אותיות ומספרים באנגלית, לפחות 20 תווים, בלי רווחים |

שמרו (**Deploy**).

## 5. מאגר נתונים (KV)
1. בתפריט: **Storage & Databases** ← **KV** ← **Create** ← שם `metzion` ← **Add**.
2. חזרה ל-Worker: **Settings** ← **Bindings** ← **Add** ← **KV namespace**.
3. Variable name: `KV` (באותיות גדולות, בדיוק כך). Namespace: `metzion`. שמרו.

## 6. חיבור הבוט לשרת
פתחו בדפדפן (עם הכתובת והסוד שלכם):
```
https://metzion.<השם-שלכם>.workers.dev/setup?key=<WEBHOOK_SECRET>
```
אמור להופיע `{"ok":true,...}`.

בדיקה: `https://metzion.<השם-שלכם>.workers.dev/info` צריך להחזיר את שם המשתמש של הבוט.

## 7. חיבור התוסף לשרת
בקובץ `src/config.js` שימו את כתובת ה-Worker בשדה `server`, ורעננו את התוסף בכרום.

## מגבלות החינם
- Workers: 100,000 בקשות ביום.
- KV: 1,000 כתיבות ביום (כל התראה בטלגרם היא כתיבה אחת). מספיק לבדיקה עם עשרות משתמשים. מעבר לזה, Workers Paid עולה 5$ לחודש.
