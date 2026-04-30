/**
 * Casual Look Studio — Order Management Worker
 *
 * Endpoints:
 *   POST /order              — create order (saves to KV, pushes to LINE staff group)
 *   GET  /order?id=...&t=... — fetch order (magic-link token verify)
 *   POST /order/find         — recover order by id+phone last 4 digits
 *   POST /admin/login        — verify admin password, returns 200 if ok
 *   GET  /admin/list         — list all orders (admin auth required)
 *   POST /admin/status       — change order status (admin auth)
 *   GET  /health             — health check
 *
 * Required secrets (wrangler secret put ...):
 *   LINE_CHANNEL_ACCESS_TOKEN
 *   LINE_ADMIN_USER_ID         (groupId or userId — push target)
 *   PROMPTPAY_TARGET           (10-digit phone or 13-digit NID)
 *   IMGBB_API_KEY
 *   ADMIN_PASSWORD             (for /admin/* endpoints)
 *
 * Required KV binding in wrangler.toml:
 *   [[kv_namespaces]] binding = "ORDERS"
 *
 * Required vars in wrangler.toml [vars]:
 *   ALLOWED_ORIGIN
 */

const LINE_API = 'https://api.line.me/v2/bot/message/push';
const IMGBB_API = 'https://api.imgbb.com/1/upload';

const STATUSES = ['pending', 'production', 'shipping', 'delivered'];
const STATUS_LABELS = {
  pending: 'รอชำระเงิน',
  production: 'ระหว่างการผลิต',
  shipping: 'จัดส่ง',
  delivered: 'ได้รับสินค้า'
};

// ─────────────────────────────────────────
// Utils
// ─────────────────────────────────────────
function corsHeaders(origin) {
  return {
    'Access-Control-Allow-Origin': origin || '*',
    'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, X-Admin-Password',
    'Access-Control-Max-Age': '86400'
  };
}

function json(data, status, origin) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', ...corsHeaders(origin) }
  });
}

// random short id without confusing chars
function randomId(len) {
  const alphabet = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ'; // no 0/O/1/I/l
  const bytes = crypto.getRandomValues(new Uint8Array(len));
  let out = '';
  for (let i = 0; i < len; i++) out += alphabet[bytes[i] % alphabet.length];
  return out;
}

function genOrderId() { return 'CL-' + randomId(6); }
function genToken()   { return randomId(10).toLowerCase(); }

// ─────────────────────────────────────────
// PromptPay QR EMV-CO payload generator
// ─────────────────────────────────────────
function tlv(id, value) {
  const v = String(value);
  return id + v.length.toString().padStart(2, '0') + v;
}

function crc16ccitt(payload) {
  let crc = 0xFFFF;
  for (let i = 0; i < payload.length; i++) {
    crc ^= payload.charCodeAt(i) << 8;
    for (let j = 0; j < 8; j++) {
      crc = (crc & 0x8000) ? ((crc << 1) ^ 0x1021) : (crc << 1);
      crc &= 0xFFFF;
    }
  }
  return crc.toString(16).toUpperCase().padStart(4, '0');
}

function genPromptPayPayload(target, amount) {
  const acct = String(target).replace(/[^0-9]/g, '');
  let acctTag, acctValue;
  if (acct.length === 13) { acctTag = '02'; acctValue = acct; }
  else if (acct.length === 10) { acctTag = '01'; acctValue = '0066' + acct.substring(1); }
  else throw new Error('PromptPay target must be 10-digit phone or 13-digit NID');

  let merchant = tlv('00', 'A000000677010111') + tlv(acctTag, acctValue);

  let payload = '';
  payload += tlv('00', '01');
  payload += tlv('01', amount ? '12' : '11');
  payload += tlv('29', merchant);
  payload += tlv('53', '764');
  if (amount) payload += tlv('54', Number(amount).toFixed(2));
  payload += tlv('58', 'TH');
  payload += '6304';
  payload += crc16ccitt(payload);
  return payload;
}

// ─────────────────────────────────────────
// External integrations
// ─────────────────────────────────────────
async function uploadToImgBB(base64DataUrl, apiKey) {
  const base64 = base64DataUrl.replace(/^data:image\/\w+;base64,/, '');
  const fd = new FormData();
  fd.append('key', apiKey);
  fd.append('image', base64);
  fd.append('expiration', String(60 * 60 * 24 * 90)); // 90 days
  const r = await fetch(IMGBB_API, { method: 'POST', body: fd });
  if (!r.ok) throw new Error('imgbb upload failed: ' + r.status);
  const j = await r.json();
  if (!j.data?.url) throw new Error('imgbb no url in response');
  return { url: j.data.url, thumb: j.data.thumb?.url || j.data.url };
}

async function pushToLine(token, to, messages) {
  const r = await fetch(LINE_API, {
    method: 'POST',
    headers: { 'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json' },
    body: JSON.stringify({ to, messages })
  });
  if (!r.ok) {
    const errText = await r.text();
    throw new Error('LINE push failed [' + r.status + ']: ' + errText);
  }
}

function buildOrderText(order) {
  const c = order.customer;
  const i = order.items;
  const lines = [
    '🛒 ออเดอร์ใหม่ — Casual Look',
    'Order: ' + order.id,
    '━━━━━━━━━━━━━━━',
    '👤 ' + c.firstName + ' ' + c.lastName,
    '📱 ' + c.phone,
    '📦 ' + (c.address || '-'),
  ];
  if (c.note) lines.push('📝 ' + c.note);
  lines.push('━━━━━━━━━━━━━━━');
  lines.push('• Cardigan ฿' + i.shirt);
  if (i.s)     lines.push('• Small  × ' + i.s + '  ฿' + i.subS);
  if (i.m)     lines.push('• Medium × ' + i.m + '  ฿' + i.subM);
  if (i.l)     lines.push('• Large  × ' + i.l + '  ฿' + i.subL);
  if (i.chars) lines.push('• Text ' + i.chars + ' ตัวอักษร  ฿' + i.subT);
  lines.push('━━━━━━━━━━━━━━━');
  lines.push('💰 รวม ฿' + i.total.toLocaleString());
  return lines.join('\n');
}

// ─────────────────────────────────────────
// Auth helpers
// ─────────────────────────────────────────
function checkAdminAuth(request, env) {
  const pwd = request.headers.get('X-Admin-Password');
  return !!(env.ADMIN_PASSWORD && pwd && pwd === env.ADMIN_PASSWORD);
}

// ─────────────────────────────────────────
// Order operations
// ─────────────────────────────────────────
async function createOrder(env, body) {
  const { imageBase64, items, customer } = body || {};
  if (!items?.total || !customer?.firstName || !customer?.phone || !imageBase64) {
    throw new Error('invalid_payload');
  }

  const id = genOrderId();
  const token = genToken();

  // upload design image
  const img = await uploadToImgBB(imageBase64, env.IMGBB_API_KEY);

  // promptpay
  const promptpay = genPromptPayPayload(env.PROMPTPAY_TARGET, items.total);

  const now = Date.now();
  const order = {
    id, token,
    createdAt: now,
    updatedAt: now,
    status: 'pending',
    statusHistory: [{ status: 'pending', at: now }],
    customer,
    items,
    design: { imageUrl: img.url, thumbUrl: img.thumb },
    promptpay
  };

  await env.ORDERS.put('order:' + id, JSON.stringify(order));

  // index by phone last 4 for recovery
  const phoneTail = customer.phone.replace(/[^0-9]/g, '').slice(-4);
  if (phoneTail.length === 4) {
    const indexKey = 'phone:' + phoneTail;
    const existing = await env.ORDERS.get(indexKey, 'json') || { orders: [] };
    existing.orders = [id, ...(existing.orders || [])].slice(0, 50);
    await env.ORDERS.put(indexKey, JSON.stringify(existing));
  }

  // index for admin list (chronological)
  const allKey = 'index:all';
  const all = await env.ORDERS.get(allKey, 'json') || { orders: [] };
  all.orders = [{ id, createdAt: now, status: 'pending' }, ...(all.orders || [])].slice(0, 1000);
  await env.ORDERS.put(allKey, JSON.stringify(all));

  // push to LINE staff group
  try {
    await pushToLine(env.LINE_CHANNEL_ACCESS_TOKEN, env.LINE_ADMIN_USER_ID, [
      { type: 'image', originalContentUrl: img.url, previewImageUrl: img.thumb },
      { type: 'text', text: buildOrderText(order) }
    ]);
  } catch (e) {
    console.error('LINE push failed but order saved:', e.message);
  }

  return { id, token, promptpay, imageUrl: img.url };
}

async function getOrder(env, id, token) {
  const order = await env.ORDERS.get('order:' + id, 'json');
  if (!order) return null;
  if (token && order.token !== token) return 'forbidden';
  return order;
}

async function findByPhone(env, id, phoneLast4) {
  const order = await env.ORDERS.get('order:' + id, 'json');
  if (!order) return null;
  const tail = order.customer.phone.replace(/[^0-9]/g, '').slice(-4);
  if (tail !== phoneLast4) return 'mismatch';
  return order;
}

async function updateStatus(env, id, newStatus) {
  if (!STATUSES.includes(newStatus)) throw new Error('invalid_status');
  const order = await env.ORDERS.get('order:' + id, 'json');
  if (!order) return null;
  if (order.status === newStatus) return order;

  const now = Date.now();
  order.status = newStatus;
  order.updatedAt = now;
  order.statusHistory = [...(order.statusHistory || []), { status: newStatus, at: now }];
  await env.ORDERS.put('order:' + id, JSON.stringify(order));

  // sync index
  const allKey = 'index:all';
  const all = await env.ORDERS.get(allKey, 'json') || { orders: [] };
  const idx = all.orders.findIndex(o => o.id === id);
  if (idx >= 0) {
    all.orders[idx].status = newStatus;
    await env.ORDERS.put(allKey, JSON.stringify(all));
  }
  return order;
}

async function listOrders(env, filter) {
  const all = await env.ORDERS.get('index:all', 'json') || { orders: [] };
  let list = all.orders;
  if (filter && STATUSES.includes(filter)) {
    list = list.filter(o => o.status === filter);
  }
  // hydrate top 100 with full data
  list = list.slice(0, 100);
  const full = await Promise.all(list.map(async o => {
    const full = await env.ORDERS.get('order:' + o.id, 'json');
    return full;
  }));
  return full.filter(Boolean);
}

// ─────────────────────────────────────────
// Worker entrypoint
// ─────────────────────────────────────────
export default {
  async fetch(request, env) {
    const origin = env.ALLOWED_ORIGIN || '*';
    const url = new URL(request.url);
    const path = url.pathname;

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders(origin) });
    }

    try {
      // ── public ──
      if (path === '/health') {
        return json({ ok: true, time: Date.now() }, 200, origin);
      }

      if (path === '/order' && request.method === 'POST') {
        const body = await request.json();
        const result = await createOrder(env, body);
        return json({ success: true, ...result }, 200, origin);
      }

      if (path === '/order' && request.method === 'GET') {
        const id = url.searchParams.get('id');
        const t = url.searchParams.get('t');
        if (!id) return json({ error: 'missing_id' }, 400, origin);
        const order = await getOrder(env, id, t);
        if (!order) return json({ error: 'not_found' }, 404, origin);
        if (order === 'forbidden') return json({ error: 'invalid_token' }, 403, origin);
        // strip token before returning to client
        const { token, ...safe } = order;
        return json({ success: true, order: safe }, 200, origin);
      }

      if (path === '/order/find' && request.method === 'POST') {
        const { id, phoneLast4 } = await request.json();
        if (!id || !phoneLast4) return json({ error: 'missing_fields' }, 400, origin);
        const result = await findByPhone(env, id, phoneLast4);
        if (!result) return json({ error: 'not_found' }, 404, origin);
        if (result === 'mismatch') return json({ error: 'phone_mismatch' }, 403, origin);
        return json({ success: true, id: result.id, token: result.token }, 200, origin);
      }

      // ── admin ──
      if (path === '/admin/login' && request.method === 'POST') {
        const { password } = await request.json();
        if (password === env.ADMIN_PASSWORD) {
          return json({ success: true }, 200, origin);
        }
        return json({ error: 'invalid_password' }, 401, origin);
      }

      if (path.startsWith('/admin/')) {
        if (!checkAdminAuth(request, env)) {
          return json({ error: 'unauthorized' }, 401, origin);
        }

        if (path === '/admin/list' && request.method === 'GET') {
          const filter = url.searchParams.get('status') || '';
          const orders = await listOrders(env, filter);
          return json({ success: true, orders }, 200, origin);
        }

        if (path === '/admin/status' && request.method === 'POST') {
          const { id, status } = await request.json();
          if (!id || !status) return json({ error: 'missing_fields' }, 400, origin);
          const updated = await updateStatus(env, id, status);
          if (!updated) return json({ error: 'not_found' }, 404, origin);
          return json({ success: true, order: updated }, 200, origin);
        }
      }

      return json({ error: 'not_found' }, 404, origin);

    } catch (err) {
      console.error('Worker error:', err);
      return json({
        error: 'processing_failed',
        message: String(err.message || err)
      }, 500, origin);
    }
  }
};
