// מציאון: שרת קטן (Cloudflare Worker) שמחזיק את בוט הטלגרם המשותף ומעביר התראות.
// משתני סביבה: BOT_TOKEN (סוד), WEBHOOK_SECRET (סוד). חיבור KV בשם KV.
//
// זרימת חיבור:
// 1. התוסף מייצר מפתח פרטי אקראי (key) ופותח t.me/<bot>?start=<key>
// 2. המשתמש לוחץ Start, וטלגרם שולח לשרת (/telegram) את המפתח ואת ה-chat id, שנשמרים יחד
// 3. התראות נשלחות ל-/notify עם המפתח. ה-chat id לא יוצא מהשרת.
// התוסף לא צריך לקרוא את המפתח בחזרה, כי KV מתעדכן בין אזורים בעיכוב של עד דקה.
// /check משמש רק לאישור בממשק.

// כתובת ליצירת קשר שמופיעה במדיניות הפרטיות (/privacy). למלא לפני פרסום בחנות.
const CONTACT_EMAIL = '';

const KEY_RE = /^[A-Za-z0-9_-]{20,64}$/;
const MAX_PER_HOUR = 30;

const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-headers': 'content-type',
  'access-control-allow-methods': 'GET, POST, OPTIONS',
};
const json = (o, status = 200) => new Response(JSON.stringify(o), {
  status, headers: { 'content-type': 'application/json; charset=utf-8', ...CORS },
});

async function tg(env, method, body) {
  const r = await fetch(`https://api.telegram.org/bot${env.BOT_TOKEN}/${method}`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body || {}),
  });
  return r.json().catch(() => ({ ok: false, description: `HTTP ${r.status}` }));
}

function randomKey() {
  const b = new Uint8Array(24);
  crypto.getRandomValues(b);
  return btoa(String.fromCharCode(...b)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

async function onUpdate(env, update) {
  const m = update && update.message;
  if (!m || typeof m.text !== 'string' || !m.chat) return;
  const start = /^\/start(?:\s+(\S+))?/.exec(m.text.trim());
  if (start && start[1] && KEY_RE.test(start[1])) {
    try {
      await env.KV.put(`user:${start[1]}`, JSON.stringify({ chatId: m.chat.id, name: m.chat.first_name || '', createdAt: Date.now() }));
    } catch (e) {
      await tg(env, 'sendMessage', { chat_id: m.chat.id, text: '⚠️ תקלה בשרת של מציאון (מאגר הנתונים לא מחובר). נסו שוב מאוחר יותר.' });
      return;
    }
    await tg(env, 'sendMessage', { chat_id: m.chat.id, text: '✅ מחובר למציאון.\nאפשר לחזור לכרום. מעכשיו תקבלו כאן התראה כשעולה מציאה בחיפושים השמורים.' });
  } else {
    await tg(env, 'sendMessage', { chat_id: m.chat.id, text: 'כדי להתחבר, לחצו על "חיבור לטלגרם" בהגדרות של תוסף מציאון בכרום.' });
  }
}

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    if (req.method === 'OPTIONS') return new Response(null, { headers: CORS });
    try {
      if (url.pathname === '/health') return json({ ok: true });
      if (url.pathname === '/privacy') {
        return new Response(PRIVACY_HTML.replace('{{CONTACT}}', CONTACT_EMAIL ? `<a href="mailto:${CONTACT_EMAIL}">${CONTACT_EMAIL}</a>` : 'דרך עמוד התוסף בחנות של כרום'), {
          headers: { 'content-type': 'text/html; charset=utf-8' },
        });
      }

      // מחזיר את שם המשתמש של הבוט, כדי שהתוסף יידע איזה קישור לפתוח
      if (url.pathname === '/info') {
        const me = await tg(env, 'getMe');
        return json({ ok: !!me.ok, bot: me.ok ? me.result.username : null });
      }

      // הגדרה חד-פעמית: מחבר את הבוט לשרת. פותחים בדפדפן /setup?key=<WEBHOOK_SECRET>
      if (url.pathname === '/setup') {
        if (!env.WEBHOOK_SECRET || url.searchParams.get('key') !== env.WEBHOOK_SECRET) return json({ ok: false, error: 'wrong key' }, 403);
        const r = await tg(env, 'setWebhook', { url: `${url.origin}/telegram`, secret_token: env.WEBHOOK_SECRET, allowed_updates: ['message'] });
        return json({ ok: !!r.ok, telegram: r.description || '' });
      }

      // אבחון: /status?key=<WEBHOOK_SECRET>. לא מחזיר סודות.
      if (url.pathname === '/status') {
        if (!env.WEBHOOK_SECRET || url.searchParams.get('key') !== env.WEBHOOK_SECRET) {
          return json({ ok: false, webhookSecretSet: !!env.WEBHOOK_SECRET, error: env.WEBHOOK_SECRET ? 'wrong key' : 'WEBHOOK_SECRET חסר' }, 403);
        }
        const me = env.BOT_TOKEN ? await tg(env, 'getMe') : { ok: false, description: 'BOT_TOKEN חסר' };
        const wh = me.ok ? await tg(env, 'getWebhookInfo') : null;
        let kv = 'לא מחובר (צריך Binding בשם KV)';
        if (env.KV) {
          try { await env.KV.put('status:test', '1', { expirationTtl: 60 }); kv = 'תקין'; } catch (e) { kv = 'מחובר אבל נכשל: ' + e.message; }
        }
        const expected = `${url.origin}/telegram`;
        const w = wh && wh.result;
        return json({
          bot: me.ok ? `תקין (@${me.result.username})` : `לא תקין: ${me.description || ''}`,
          webhook: !w ? '?' : w.url === expected ? 'מחובר לשרת' : w.url ? `מחובר לכתובת אחרת: ${w.url}` : 'לא מחובר. פתחו /setup?key=...',
          webhookLastError: (w && w.last_error_message) || '',
          pendingUpdates: w ? w.pending_update_count : null,
          kv,
        });
      }

      if (url.pathname === '/telegram' && req.method === 'POST') {
        if (req.headers.get('x-telegram-bot-api-secret-token') !== env.WEBHOOK_SECRET) return new Response('', { status: 403 });
        await onUpdate(env, await req.json());
        return new Response('ok');
      }

      if (url.pathname === '/check' && req.method === 'GET') {
        const key = url.searchParams.get('key') || '';
        if (!KEY_RE.test(key)) return json({ ok: false, error: 'bad key' }, 400);
        const v = await env.KV.get(`user:${key}`, { type: 'json', cacheTtl: 30 });
        return json({ ok: true, linked: !!v, name: v ? v.name : '' });
      }

      if (url.pathname === '/notify' && req.method === 'POST') {
        const body = await req.json().catch(() => ({}));
        if (!KEY_RE.test(body.key || '') || typeof body.text !== 'string' || !body.text.trim()) return json({ ok: false, error: 'bad request' }, 400);
        const user = await env.KV.get(`user:${body.key}`, 'json');
        if (!user) return json({ ok: false, error: 'not_linked' }, 404);
        const rk = `rate:${body.key}:${Math.floor(Date.now() / 3600e3)}`;
        const n = Number(await env.KV.get(rk)) || 0;
        if (n >= MAX_PER_HOUR) return json({ ok: false, error: 'rate_limited' }, 429);
        await env.KV.put(rk, String(n + 1), { expirationTtl: 7200 });
        const r = await tg(env, 'sendMessage', { chat_id: user.chatId, text: body.text.slice(0, 3500) });
        return json({ ok: !!r.ok, error: r.ok ? '' : (r.description || 'telegram error') }, r.ok ? 200 : 502);
      }

      if (url.pathname === '/unlink' && req.method === 'POST') {
        const body = await req.json().catch(() => ({}));
        if (KEY_RE.test(body.key || '')) await env.KV.delete(`user:${body.key}`);
        return json({ ok: true });
      }

      // ---------- רישיונות ----------
      // מפתח רישיון: אותיות/ספרות/-/_ באורך 12–64
      const LIC_RE = /^[A-Za-z0-9_-]{12,64}$/;

      // בדיקת רישיון (מהתוסף)
      if (url.pathname === '/license/check' && req.method === 'GET') {
        const key = url.searchParams.get('key') || '';
        if (!LIC_RE.test(key)) return json({ ok: false, active: false, error: 'bad key' }, 400);
        const lic = await env.KV.get(`license:${key}`, 'json');
        if (!lic || !lic.active) return json({ ok: true, active: false });
        if (lic.expiresAt && Number(lic.expiresAt) < Date.now()) {
          return json({ ok: true, active: false, expired: true, expiresAt: lic.expiresAt });
        }
        return json({
          ok: true,
          active: true,
          name: lic.name || '',
          expiresAt: lic.expiresAt || null,
          plan: lic.plan || 'premium',
        });
      }

      // הפעלת/ביטול רישיון (רק עם WEBHOOK_SECRET) — לשימוש ידני אחרי תשלום בביט
      // POST /license/activate  { secret, key, name?, days?, plan? }
      // POST /license/revoke    { secret, key }
      if (url.pathname === '/license/activate' && req.method === 'POST') {
        const body = await req.json().catch(() => ({}));
        if (!env.WEBHOOK_SECRET || body.secret !== env.WEBHOOK_SECRET) return json({ ok: false, error: 'forbidden' }, 403);
        let key = String(body.key || '').trim();
        if (!key) {
          const b = new Uint8Array(18);
          crypto.getRandomValues(b);
          key = btoa(String.fromCharCode(...b)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
        }
        if (!LIC_RE.test(key)) return json({ ok: false, error: 'bad key' }, 400);
        const days = Math.max(0, Number(body.days) || 0);
        const expiresAt = days > 0 ? Date.now() + days * 864e5 : null;
        const rec = {
          active: true,
          name: String(body.name || '').slice(0, 80),
          plan: String(body.plan || 'premium').slice(0, 32),
          expiresAt,
          activatedAt: Date.now(),
          note: String(body.note || '').slice(0, 200),
        };
        await env.KV.put(`license:${key}`, JSON.stringify(rec));
        return json({ ok: true, key, ...rec });
      }

      if (url.pathname === '/license/revoke' && req.method === 'POST') {
        const body = await req.json().catch(() => ({}));
        if (!env.WEBHOOK_SECRET || body.secret !== env.WEBHOOK_SECRET) return json({ ok: false, error: 'forbidden' }, 403);
        const key = String(body.key || '').trim();
        if (!LIC_RE.test(key)) return json({ ok: false, error: 'bad key' }, 400);
        await env.KV.delete(`license:${key}`);
        return json({ ok: true });
      }

      return json({ ok: false, error: 'not found' }, 404);
    } catch (e) {
      return json({ ok: false, error: 'server error' }, 500);
    }
  },
};

const PRIVACY_HTML = `<!doctype html>
<html lang="he" dir="rtl"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>מציאון · מדיניות פרטיות</title>
<style>body{font:16px/1.6 system-ui,-apple-system,"Segoe UI",Arial,sans-serif;color:#1d1d1f;background:#f6f7f9;margin:0;padding:24px 16px}
main{max-width:720px;margin:0 auto;background:#fff;border:1px solid #e3e5ea;border-radius:14px;padding:28px}
h1{font-size:26px;margin:0 0 4px}h2{font-size:18px;margin:28px 0 6px}p,li{color:#33363d}.muted{color:#6b6f78;font-size:14px}</style></head>
<body><main>
<h1>מדיניות פרטיות · מציאון</h1>
<p class="muted">עודכן לאחרונה: אוקטובר 2026</p>
<p>מציאון הוא תוסף לכרום שמסמן ביד 2 רכבים שמחירם נמוך מהמחירון ומהשוק, ושולח התראות על מודעות חדשות בחיפושים ששמרתם. מציאון אינו קשור ליד 2.</p>

<h2>מה נשמר במחשב שלכם בלבד</h2>
<ul>
<li>ההגדרות שלכם, החיפושים השמורים והסינונים.</li>
<li>היסטוריית מחירים של מודעות שראיתם, וסימוני "נבדק" ו"הוסתר".</li>
<li>מטמון של מחירונים ופרטי מודעות, כדי לא לטעון אותם שוב.</li>
</ul>
<p>המידע הזה נשמר באחסון של התוסף בדפדפן, לא נשלח אלינו ונמחק כשמסירים את התוסף.</p>

<h2>הפניות ליד 2</h2>
<p>התוסף קורא את דפי התוצאות, המחירון והמודעות ישירות מאתר יד 2, מהדפדפן שלכם, כמו שהייתם גולשים בהם בעצמכם. הבקשות לא עוברות דרכנו.</p>

<h2>התראות בטלגרם (רשות)</h2>
<p>רק אם תבחרו לחבר טלגרם, השרת של מציאון שומר:</p>
<ul>
<li>מפתח אקראי שהתוסף יצר, ומזהה הצ'אט שלכם בטלגרם.</li>
<li>השם הפרטי שמופיע בחשבון הטלגרם שלכם, כדי להציג "מחובר" בהגדרות.</li>
<li>מונה הודעות לשעה, שנמחק אחרי שעתיים, כדי למנוע שליחה מוגזמת.</li>
</ul>
<p>תוכן ההתראה (פרטי הרכב והקישור למודעה) עובר דרך השרת אל טלגרם ולא נשמר אצלנו. לחיצה על "ניתוק" בהגדרות מוחקת את החיבור מהשרת.</p>

<h2>מה אנחנו לא עושים</h2>
<ul>
<li>לא אוספים היסטוריית גלישה, ולא קוראים אתרים אחרים מלבד יד 2.</li>
<li>לא משתמשים בכלי מעקב או אנליטיקה, ולא מציגים פרסומות.</li>
<li>לא מוכרים ולא מעבירים מידע לאף גורם. המידע משמש רק להפעלת התוסף.</li>
</ul>

<h2>יצירת קשר</h2>
<p>שאלות על הפרטיות: {{CONTACT}}.</p>
</main></body></html>`;
