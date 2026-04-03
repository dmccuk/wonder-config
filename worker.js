// Wonder Device Messaging API — Cloudflare Worker
// KV binding: MESSAGES (bound to WONDER_MESSAGES namespace)

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, X-Device-Secret',
};

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', ...CORS_HEADERS },
  });
}

function generateCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no confusables (0/O, 1/I)
  let code = '';
  for (let i = 0; i < 6; i++) code += chars[Math.floor(Math.random() * chars.length)];
  return code;
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;

    // CORS preflight
    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: CORS_HEADERS });
    }

    // ── REGISTER DEVICE ──────────────────────────────────────────
    // POST /api/register { owner_name: "Dave" }
    // Returns: { ok: true, device_id: "K7X9M2", secret: "..." }
    if (path === '/api/register' && request.method === 'POST') {
      try {
        const body = await request.json();
        const owner = body.owner_name || 'Wonder Device';

        // Generate unique code
        let code;
        for (let attempt = 0; attempt < 10; attempt++) {
          code = generateCode();
          const existing = await env.MESSAGES.get(`device:${code}`);
          if (!existing) break;
        }

        // Generate secret
        const secret = crypto.randomUUID().replace(/-/g, '');

        // Store device
        await env.MESSAGES.put(`device:${code}`, JSON.stringify({
          owner: owner,
          secret: secret,
          created: new Date().toISOString(),
        }));

        // Init empty message store
        await env.MESSAGES.put(`msgs:${code}`, JSON.stringify({
          messages: [],
          replies: [],
        }));

        return json({ ok: true, device_id: code, secret: secret });
      } catch (e) {
        return json({ ok: false, error: e.message }, 400);
      }
    }

    // ── SEND MESSAGE (public — anyone with the URL) ──────────────
    // POST /api/msg/{device_id} { from: "Sarah", text: "Hello!", priority: "normal" }
    const sendMatch = path.match(/^\/api\/msg\/([A-Z0-9]{6})$/);
    if (sendMatch && request.method === 'POST') {
      const deviceId = sendMatch[1];
      try {
        const device = await env.MESSAGES.get(`device:${deviceId}`);
        if (!device) return json({ ok: false, error: 'Device not found' }, 404);

        const body = await request.json();
        const from = (body.from || 'Anonymous').substring(0, 30);
        const text = (body.text || '').substring(0, 280);
        const priority = body.priority === 'urgent' ? 'urgent' : 'normal';

        if (!text) return json({ ok: false, error: 'Empty message' }, 400);

        // Rate limit: check IP
        const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
        const rateKey = `rate:${deviceId}:${ip}`;
        const rateCount = parseInt(await env.MESSAGES.get(rateKey) || '0');
        if (rateCount >= 20) {
          return json({ ok: false, error: 'Rate limit exceeded (20/hour)' }, 429);
        }
        await env.MESSAGES.put(rateKey, String(rateCount + 1), { expirationTtl: 3600 });

        // Add message
        const store = JSON.parse(await env.MESSAGES.get(`msgs:${deviceId}`) || '{"messages":[],"replies":[]}');
        store.messages.push({
          id: Date.now().toString(36),
          from: from,
          text: text,
          priority: priority,
          time: new Date().toISOString(),
        });

        // Keep last 50 messages
        if (store.messages.length > 50) store.messages = store.messages.slice(-50);

        await env.MESSAGES.put(`msgs:${deviceId}`, JSON.stringify(store));

        const deviceData = JSON.parse(device);
        return json({ ok: true, owner: deviceData.owner });
      } catch (e) {
        return json({ ok: false, error: e.message }, 400);
      }
    }

    // ── GET MESSAGES (device polls this) ─────────────────────────
    // GET /api/msg/{device_id}  Headers: X-Device-Secret: token
    if (sendMatch && request.method === 'GET') {
      const deviceId = sendMatch[1];
      const device = await env.MESSAGES.get(`device:${deviceId}`);
      if (!device) return json({ ok: false, error: 'Device not found' }, 404);

      const deviceData = JSON.parse(device);
      const secret = request.headers.get('X-Device-Secret');

      // Public read (no secret) — returns messages + replies for web page
      // Device read (with secret) — same data, proves ownership
      const store = JSON.parse(await env.MESSAGES.get(`msgs:${deviceId}`) || '{"messages":[],"replies":[]}');

      return json({
        ok: true,
        owner: deviceData.owner,
        device_id: deviceId,
        messages: store.messages,
        replies: store.replies,
        is_owner: secret === deviceData.secret,
      });
    }

    // ── REPLY FROM DEVICE ────────────────────────────────────────
    // POST /api/msg/{device_id}/reply  Headers: X-Device-Secret: token
    //   { text: "See you at 8", in_reply_to: "msg_id" }
    const replyMatch = path.match(/^\/api\/msg\/([A-Z0-9]{6})\/reply$/);
    if (replyMatch && request.method === 'POST') {
      const deviceId = replyMatch[1];
      try {
        const device = await env.MESSAGES.get(`device:${deviceId}`);
        if (!device) return json({ ok: false, error: 'Device not found' }, 404);

        const deviceData = JSON.parse(device);
        const secret = request.headers.get('X-Device-Secret');
        if (secret !== deviceData.secret) {
          return json({ ok: false, error: 'Unauthorized' }, 401);
        }

        const body = await request.json();
        const text = (body.text || '').substring(0, 280);
        if (!text) return json({ ok: false, error: 'Empty reply' }, 400);

        const store = JSON.parse(await env.MESSAGES.get(`msgs:${deviceId}`) || '{"messages":[],"replies":[]}');
        store.replies.push({
          id: Date.now().toString(36),
          text: text,
          in_reply_to: body.in_reply_to || null,
          time: new Date().toISOString(),
        });

        if (store.replies.length > 50) store.replies = store.replies.slice(-50);

        await env.MESSAGES.put(`msgs:${deviceId}`, JSON.stringify(store));
        return json({ ok: true });
      } catch (e) {
        return json({ ok: false, error: e.message }, 400);
      }
    }

    // ── CLEAR MESSAGES (device owner only) ───────────────────────
    // DELETE /api/msg/{device_id}  Headers: X-Device-Secret: token
    const deleteMatch = path.match(/^\/api\/msg\/([A-Z0-9]{6})$/);
    if (deleteMatch && request.method === 'DELETE') {
      const deviceId = deleteMatch[1];
      const device = await env.MESSAGES.get(`device:${deviceId}`);
      if (!device) return json({ ok: false, error: 'Device not found' }, 404);

      const deviceData = JSON.parse(device);
      const secret = request.headers.get('X-Device-Secret');
      if (secret !== deviceData.secret) {
        return json({ ok: false, error: 'Unauthorized' }, 401);
      }

      await env.MESSAGES.put(`msgs:${deviceId}`, JSON.stringify({ messages: [], replies: [] }));
      return json({ ok: true, cleared: true });
    }

    // ── DEVICE INFO (public) ─────────────────────────────────────
    // GET /api/device/{device_id}
    const infoMatch = path.match(/^\/api\/device\/([A-Z0-9]{6})$/);
    if (infoMatch && request.method === 'GET') {
      const deviceId = infoMatch[1];
      const device = await env.MESSAGES.get(`device:${deviceId}`);
      if (!device) return json({ ok: false, error: 'Device not found' }, 404);
      const deviceData = JSON.parse(device);
      return json({ ok: true, owner: deviceData.owner, device_id: deviceId });
    }

    // ── HEALTH CHECK ─────────────────────────────────────────────
    if (path === '/api/health') {
      return json({ ok: true, service: 'Wonder Device Messaging', version: '1.0' });
    }

    // ── DEFAULT ──────────────────────────────────────────────────
    return json({
      service: 'Wonder Device Messaging API',
      endpoints: {
        'POST /api/register': 'Register a new device',
        'POST /api/msg/{id}': 'Send a message to a device',
        'GET /api/msg/{id}': 'Get messages for a device',
        'POST /api/msg/{id}/reply': 'Reply from device (auth required)',
        'DELETE /api/msg/{id}': 'Clear messages (auth required)',
        'GET /api/device/{id}': 'Get device info',
        'GET /api/health': 'Health check',
      },
    });
  },
};
