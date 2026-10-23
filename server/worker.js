// מציאון: שרת קטן (Cloudflare Worker) שמחזיק את בוט הטלגרם המשותף ומעביר התראות.
// משתני סביבה: BOT_TOKEN (סוד), WEBHOOK_SECRET (סוד). חיבור KV בשם KV.
//
// זרימת חיבור:
// 1. התוסף מייצר מפתח פרטי אקראי (key) ופותח t.me/<bot>?start=<key>
// 2. המשתמש לוחץ Start, וטלגרם שולח לשרת (/telegram) את המפתח ואת ה-chat id, שנשמרים יחד
// 3. התראות נשלחות ל-/notify עם המפתח. ה-chat id לא יוצא מהשרת.
// התוסף לא צריך לקרוא את המפתח בחזרה, כי KV מתעדכן בין אזורים בעיכוב של עד דקה.
// /check משמש רק לאישור בממשק.

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

      return json({ ok: false, error: 'not found' }, 404);
    } catch (e) {
      return json({ ok: false, error: 'server error' }, 500);
    }
  },
};
