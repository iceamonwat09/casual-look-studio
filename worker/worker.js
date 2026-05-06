/**
 * Casual Look — Order System Worker
 *
 * Endpoints
 *   POST   /orders                    create order (public)
 *   GET    /orders/:id?t=token        customer view (magic-link)
 *   POST   /orders/recover            recover by orderId + phone last 4
 *   POST   /orders/:id/slip           customer upload payment slip
 *   POST   /admin/login               { password } -> { sessionToken }
 *   GET    /admin/orders              list (auth)
 *   GET    /admin/orders/:id          full detail (auth)
 *   PATCH  /admin/orders/:id          update status / tracking / note (auth)
 *   GET    /promptpay/qr?amount=&id=  PromptPay QR PNG (proxy)
 *   GET    /health                    healthcheck
 *   *      legacy LINE webhook is preserved at /webhook (optional)
 *
 * Storage (KV: ORDERS)
 *   order:<id>              full order JSON
 *   index:all               sorted set as JSON array of {id, createdAt}
 *   recover:<id>:<last4>    -> orderId   (for recovery lookup)
 *   session:<token>         -> "admin"   ttl 24h
 *
 * Status flow
 *   pending -> production -> shipping -> delivered
 *
 * Secrets required
 *   LINE_ACCESS_TOKEN, LINE_GROUP_ID, PROMPTPAY_TARGET, IMGBB_API_KEY, ADMIN_PASSWORD
 */

const ALLOWED_ORIGIN = 'https://iceamonwat09.github.io';
const STATUSES = ['pending', 'production', 'shipping', 'delivered'];
const STATUS_TH = {
  pending: 'รอชำระเงิน',
  production: 'ระหว่างการผลิต',
  shipping: 'จัดส่ง',
  delivered: 'ได้รับสินค้า',
};

// ─── helpers ────────────────────────────────────────────────────
const json = (data, init = {}) =>
  new Response(JSON.stringify(data), {
    ...init,
    headers: { 'Content-Type': 'application/json; charset=utf-8', ...corsHeaders(), ...(init.headers || {}) },
  });

const err = (status, message) => json({ ok: false, error: message }, { status });

function corsHeaders() {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET,POST,PATCH,DELETE,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Max-Age': '86400',
  };
}

function randomToken(bytes = 24) {
  const a = new Uint8Array(bytes);
  crypto.getRandomValues(a);
  return [...a].map(b => b.toString(16).padStart(2, '0')).join('');
}

function genOrderId() {
  const d = new Date();
  const pad = n => n.toString().padStart(2, '0');
  const yy = d.getUTCFullYear().toString().slice(-2);
  const rand = Math.floor(Math.random() * 1000).toString().padStart(3, '0');
  return `CL${yy}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}-${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${rand}`;
}

function timingSafeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  if (a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}

function sanitize(s, max = 500) {
  if (typeof s !== 'string') return '';
  return s.replace(/[\x00-\x1f\x7f]/g, ' ').trim().slice(0, max);
}

function sanitizePhone(s) {
  if (typeof s !== 'string') return '';
  return s.replace(/[^0-9+]/g, '').slice(0, 20);
}

function last4(phone) {
  const digits = (phone || '').replace(/\D/g, '');
  return digits.slice(-4);
}

// ─── PromptPay payload (EMVCo CRC16/XModem) ─────────────────────
function promptpayPayload(target, amount) {
  // target: phone (10 digits) or citizen ID (13 digits)
  const cleaned = String(target || '').replace(/\D/g, '');
  let acc;
  if (cleaned.length === 10) {
    // phone -> 0066 + last 9 (drop leading 0)
    acc = '0066' + cleaned.slice(1);
  } else if (cleaned.length === 13) {
    acc = cleaned;
  } else {
    acc = cleaned;
  }
  const f = (id, val) => id + String(val.length).padStart(2, '0') + val;
  const merchant = f('00', 'A000000677010111') + f('01', acc);
  let payload =
    f('00', '01') +                                  // payload format
    f('01', amount ? '12' : '11') +                  // dynamic vs static
    f('29', merchant) +                              // merchant account
    f('53', '764') +                                 // currency THB
    (amount ? f('54', Number(amount).toFixed(2)) : '') +
    f('58', 'TH') +                                  // country
    '6304';                                          // CRC tag + length
  payload += crc16(payload);
  return payload;
}

function crc16(str) {
  let crc = 0xffff;
  for (let i = 0; i < str.length; i++) {
    crc ^= str.charCodeAt(i) << 8;
    for (let j = 0; j < 8; j++) {
      crc = (crc & 0x8000) ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff;
    }
  }
  return crc.toString(16).toUpperCase().padStart(4, '0');
}

// ─── LINE notify ────────────────────────────────────────────────
async function linePush(env, messages) {
  if (!env.LINE_ACCESS_TOKEN || !env.LINE_GROUP_ID) {
    console.warn('LINE credentials missing — skip push');
    return;
  }
  try {
    const r = await fetch('https://api.line.me/v2/bot/message/push', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${env.LINE_ACCESS_TOKEN}`,
      },
      body: JSON.stringify({ to: env.LINE_GROUP_ID, messages }),
    });
    if (!r.ok) console.error('LINE push failed', r.status, await r.text());
  } catch (e) {
    console.error('LINE push error', e);
  }
}

function lineOrderCreatedMessage(order) {
  const itemLines = (order.items || []).map(it => `• ${it.label} ฿${it.amount}`).join('\n');
  return [
    {
      type: 'text',
      text:
        `🛍 ออเดอร์ใหม่ ${order.id}\n` +
        `━━━━━━━━━━━━━━━\n` +
        `${itemLines || '—'}\n` +
        `━━━━━━━━━━━━━━━\n` +
        `รวม ฿${order.total.toLocaleString()}\n\n` +
        `👤 ${order.customer.name}\n` +
        `📞 ${order.customer.phone}\n` +
        `🏠 ${order.customer.address}\n` +
        (order.customer.note ? `📝 ${order.customer.note}\n` : '') +
        `\nสถานะ: ${STATUS_TH[order.status]}`,
    },
    order.designUrl
      ? { type: 'image', originalContentUrl: order.designUrl, previewImageUrl: order.designUrl }
      : null,
  ].filter(Boolean);
}

function lineSlipMessage(order, slipUrl) {
  return [
    { type: 'text', text: `💳 สลิปชำระเงิน — ${order.id}\nลูกค้า: ${order.customer.name}\nยอด ฿${order.total.toLocaleString()}` },
    { type: 'image', originalContentUrl: slipUrl, previewImageUrl: slipUrl },
  ];
}

function lineStatusUpdateMessage(order, prev) {
  return [
    {
      type: 'text',
      text:
        `🔄 อัปเดตสถานะ ${order.id}\n` +
        `${STATUS_TH[prev]} → ${STATUS_TH[order.status]}\n` +
        (order.tracking ? `📦 Tracking: ${order.tracking}\n` : '') +
        `ลูกค้า: ${order.customer.name}`,
    },
  ];
}

// ─── imgbb upload ───────────────────────────────────────────────
async function imgbbUpload(env, dataUrlOrBase64, filename) {
  if (!env.IMGBB_API_KEY) throw new Error('IMGBB_API_KEY missing');
  const base64 = String(dataUrlOrBase64).replace(/^data:image\/[a-zA-Z0-9.+-]+;base64,/, '');
  const fd = new FormData();
  fd.append('key', env.IMGBB_API_KEY);
  fd.append('image', base64);
  if (filename) fd.append('name', filename);
  const r = await fetch('https://api.imgbb.com/1/upload', { method: 'POST', body: fd });
  if (!r.ok) throw new Error(`imgbb http ${r.status}`);
  const j = await r.json();
  if (!j.success) throw new Error('imgbb upload failed');
  return j.data.url;
}

// ─── KV helpers ─────────────────────────────────────────────────
async function getOrder(env, id) {
  const raw = await env.ORDERS.get(`order:${id}`);
  return raw ? JSON.parse(raw) : null;
}

async function putOrder(env, order) {
  await env.ORDERS.put(`order:${order.id}`, JSON.stringify(order));
}

async function appendIndex(env, order) {
  const raw = await env.ORDERS.get('index:all');
  const arr = raw ? JSON.parse(raw) : [];
  arr.unshift({ id: order.id, createdAt: order.createdAt });
  // cap at 5000 entries to keep KV value small (well below 25MB)
  await env.ORDERS.put('index:all', JSON.stringify(arr.slice(0, 5000)));
}

async function getIndex(env) {
  const raw = await env.ORDERS.get('index:all');
  return raw ? JSON.parse(raw) : [];
}

// Device-based history (per-browser device id, stored in customer's localStorage)
async function appendDeviceIndex(env, deviceId, summary) {
  if (!deviceId) return;
  const key = `device:${deviceId}`;
  const raw = await env.ORDERS.get(key);
  const arr = raw ? JSON.parse(raw) : [];
  // de-dup by id
  const idx = arr.findIndex(x => x.id === summary.id);
  if (idx >= 0) arr.splice(idx, 1);
  arr.unshift(summary);
  await env.ORDERS.put(key, JSON.stringify(arr.slice(0, 50)));
}

async function updateDeviceIndexStatus(env, deviceId, orderId, patch) {
  if (!deviceId) return;
  const key = `device:${deviceId}`;
  const raw = await env.ORDERS.get(key);
  if (!raw) return;
  const arr = JSON.parse(raw);
  const idx = arr.findIndex(x => x.id === orderId);
  if (idx < 0) return;
  arr[idx] = { ...arr[idx], ...patch };
  await env.ORDERS.put(key, JSON.stringify(arr));
}

async function checkAdminSession(env, request) {
  const auth = request.headers.get('Authorization') || '';
  const m = auth.match(/^Bearer\s+(.+)$/);
  if (!m) return false;
  const token = m[1].trim();
  const v = await env.ORDERS.get(`session:${token}`);
  return v === 'admin';
}

// ─── handlers ───────────────────────────────────────────────────
async function handleCreateOrder(request, env) {
  let body;
  try { body = await request.json(); } catch { return err(400, 'invalid json'); }

  const name = sanitize(body.name, 100);
  const phone = sanitizePhone(body.phone);
  const address = sanitize(body.address, 500);
  const note = sanitize(body.note || '', 300);
  const items = Array.isArray(body.items) ? body.items.slice(0, 50).map(it => ({
    label: sanitize(it.label || '', 120),
    amount: Math.max(0, Math.floor(Number(it.amount) || 0)),
  })) : [];
  const total = Math.max(0, Math.floor(Number(body.total) || 0));
  const designDataUrl = typeof body.designDataUrl === 'string' ? body.designDataUrl : '';
  const deviceId = sanitize(body.deviceId || '', 64);

  if (!name) return err(400, 'name required');
  if (!phone || phone.replace(/\D/g, '').length < 9) return err(400, 'phone invalid');
  if (!address) return err(400, 'address required');
  if (!items.length || total <= 0) return err(400, 'items/total invalid');

  const id = genOrderId();
  const token = randomToken(20);

  // 1. Upload design image (best effort)
  let designUrl = '';
  if (designDataUrl) {
    try {
      designUrl = await imgbbUpload(env, designDataUrl, id);
    } catch (e) {
      console.error('design upload failed', e);
    }
  }

  const now = Date.now();
  const order = {
    id,
    token,
    status: 'pending',
    customer: { name, phone, address, note },
    items,
    total,
    designUrl,
    slipUrl: '',
    tracking: '',
    adminNote: '',
    deviceId,
    history: [{ at: now, status: 'pending', by: 'system' }],
    createdAt: now,
    updatedAt: now,
  };

  await putOrder(env, order);
  await appendIndex(env, order);
  await env.ORDERS.put(`recover:${id}:${last4(phone)}`, id);
  await appendDeviceIndex(env, deviceId, {
    id, token, total, status: 'pending',
    itemCount: items.length,
    designUrl,
    createdAt: now,
  });

  // LINE notify (don't block response on failure)
  await linePush(env, lineOrderCreatedMessage(order));

  return json({ ok: true, id, token, status: order.status });
}

async function handleByDevice(request, env) {
  const url = new URL(request.url);
  const did = sanitize(url.searchParams.get('did') || '', 64);
  if (!did) return err(400, 'did required');
  const raw = await env.ORDERS.get(`device:${did}`);
  const orders = raw ? JSON.parse(raw) : [];
  return json({ ok: true, orders });
}

async function handleGetOrderPublic(request, env, id) {
  const url = new URL(request.url);
  const token = url.searchParams.get('t') || '';
  const order = await getOrder(env, id);
  if (!order) return err(404, 'not found');
  if (!timingSafeEqual(token, order.token)) return err(403, 'invalid token');
  return json({ ok: true, order: redactForCustomer(order) });
}

function redactForCustomer(o) {
  // Customer can see everything they submitted + status + admin tracking
  const { token, ...rest } = o; // hide token
  return rest;
}

async function handleRecover(request, env) {
  let body;
  try { body = await request.json(); } catch { return err(400, 'invalid json'); }
  const id = sanitize(body.id || '', 30).toUpperCase();
  const l4 = sanitize(body.last4 || '', 4);
  if (!id || l4.length !== 4) return err(400, 'id and last4 required');
  const oid = await env.ORDERS.get(`recover:${id}:${l4}`);
  if (!oid) return err(404, 'no match');
  const order = await getOrder(env, oid);
  if (!order) return err(404, 'no match');
  return json({ ok: true, id: order.id, token: order.token });
}

async function handleUploadSlip(request, env, id) {
  let body;
  try { body = await request.json(); } catch { return err(400, 'invalid json'); }
  const token = sanitize(body.token || '', 64);
  const slipDataUrl = typeof body.slipDataUrl === 'string' ? body.slipDataUrl : '';
  if (!slipDataUrl) return err(400, 'slipDataUrl required');

  const order = await getOrder(env, id);
  if (!order) return err(404, 'not found');
  if (!timingSafeEqual(token, order.token)) return err(403, 'invalid token');

  let slipUrl;
  try {
    slipUrl = await imgbbUpload(env, slipDataUrl, `${id}-slip`);
  } catch (e) {
    return err(502, 'upload failed');
  }
  order.slipUrl = slipUrl;
  order.updatedAt = Date.now();
  order.history.push({ at: order.updatedAt, status: order.status, by: 'customer', event: 'slip_uploaded' });
  await putOrder(env, order);
  await linePush(env, lineSlipMessage(order, slipUrl));

  return json({ ok: true, slipUrl });
}

async function handleAdminLogin(request, env) {
  let body;
  try { body = await request.json(); } catch { return err(400, 'invalid json'); }
  const password = String(body.password || '');
  if (!env.ADMIN_PASSWORD) return err(500, 'admin not configured');
  if (!timingSafeEqual(password, env.ADMIN_PASSWORD)) {
    // small artificial delay to slow brute force
    await new Promise(r => setTimeout(r, 600));
    return err(401, 'invalid password');
  }
  const sessionToken = randomToken(32);
  await env.ORDERS.put(`session:${sessionToken}`, 'admin', { expirationTtl: 86400 });
  return json({ ok: true, sessionToken, expiresInSec: 86400 });
}

async function handleAdminListOrders(request, env) {
  const url = new URL(request.url);
  const status = url.searchParams.get('status') || '';
  const q = (url.searchParams.get('q') || '').toLowerCase();
  const limit = Math.min(500, Math.max(1, parseInt(url.searchParams.get('limit') || '200', 10)));

  const idx = await getIndex(env);
  const slice = idx.slice(0, limit);
  const orders = [];
  // KV reads in parallel
  const reads = await Promise.all(slice.map(e => env.ORDERS.get(`order:${e.id}`)));
  for (const raw of reads) {
    if (!raw) continue;
    const o = JSON.parse(raw);
    if (status && o.status !== status) continue;
    if (q) {
      const hay = `${o.id} ${o.customer.name} ${o.customer.phone} ${o.customer.address}`.toLowerCase();
      if (!hay.includes(q)) continue;
    }
    orders.push(stripOrderForList(o));
  }
  // stats from full index (count by status)
  const statsReads = await Promise.all(idx.slice(0, 1000).map(e => env.ORDERS.get(`order:${e.id}`)));
  const stats = { total: 0, pending: 0, production: 0, shipping: 0, delivered: 0, revenuePaid: 0, revenueAll: 0, todayCount: 0 };
  const startOfToday = new Date(); startOfToday.setHours(0, 0, 0, 0);
  for (const raw of statsReads) {
    if (!raw) continue;
    const o = JSON.parse(raw);
    stats.total++;
    if (stats[o.status] !== undefined) stats[o.status]++;
    stats.revenueAll += o.total || 0;
    if (o.status !== 'pending') stats.revenuePaid += o.total || 0;
    if (o.createdAt >= startOfToday.getTime()) stats.todayCount++;
  }

  return json({ ok: true, orders, stats });
}

function stripOrderForList(o) {
  return {
    id: o.id,
    status: o.status,
    total: o.total,
    customer: { name: o.customer.name, phone: o.customer.phone },
    designUrl: o.designUrl,
    slipUrl: o.slipUrl,
    tracking: o.tracking,
    createdAt: o.createdAt,
    updatedAt: o.updatedAt,
  };
}

async function handleAdminGetOrder(request, env, id) {
  const order = await getOrder(env, id);
  if (!order) return err(404, 'not found');
  const { token, ...safe } = order;
  return json({ ok: true, order: safe, customerLink: `/track.html?id=${order.id}&t=${order.token}` });
}

async function handleAdminPatchOrder(request, env, id) {
  let body;
  try { body = await request.json(); } catch { return err(400, 'invalid json'); }
  const order = await getOrder(env, id);
  if (!order) return err(404, 'not found');
  const prev = order.status;

  if (body.status && STATUSES.includes(body.status)) order.status = body.status;
  if (typeof body.tracking === 'string') order.tracking = sanitize(body.tracking, 120);
  if (typeof body.adminNote === 'string') order.adminNote = sanitize(body.adminNote, 1000);

  order.updatedAt = Date.now();
  order.history.push({ at: order.updatedAt, status: order.status, by: 'admin', tracking: order.tracking });
  await putOrder(env, order);

  // Keep device-history index in sync for the customer's home page
  if (order.deviceId) {
    await updateDeviceIndexStatus(env, order.deviceId, order.id, {
      status: order.status,
      tracking: order.tracking,
      updatedAt: order.updatedAt,
    });
  }

  if (body.status && body.status !== prev) {
    await linePush(env, lineStatusUpdateMessage(order, prev));
  }
  const { token, ...safe } = order;
  return json({ ok: true, order: safe });
}

async function handlePromptPayQr(request, env) {
  const url = new URL(request.url);
  const amount = Number(url.searchParams.get('amount') || 0);
  const target = env.PROMPTPAY_TARGET || '';
  if (!target) return err(500, 'promptpay not configured');
  const payload = promptpayPayload(target, amount);
  // proxy a known-good QR generator -> PNG
  const qrUrl = `https://api.qrserver.com/v1/create-qr-code/?size=400x400&margin=8&data=${encodeURIComponent(payload)}`;
  const r = await fetch(qrUrl);
  if (!r.ok) return err(502, 'qr fetch failed');
  return new Response(r.body, {
    headers: {
      'Content-Type': 'image/png',
      'Cache-Control': 'public, max-age=600',
      ...corsHeaders(),
    },
  });
}

// ─── router ─────────────────────────────────────────────────────
export default {
  async fetch(request, env, ctx) {
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders() });
    }
    const url = new URL(request.url);
    const path = url.pathname.replace(/\/+$/, '') || '/';

    try {
      // public
      if (path === '/health') return json({ ok: true, ts: Date.now() });
      if (path === '/promptpay/qr' && request.method === 'GET') return handlePromptPayQr(request, env);

      if (path === '/orders' && request.method === 'POST') return handleCreateOrder(request, env);
      if (path === '/orders/recover' && request.method === 'POST') return handleRecover(request, env);
      if (path === '/orders/by-device' && request.method === 'GET') return handleByDevice(request, env);

      let m = path.match(/^\/orders\/([A-Z0-9-]{4,40})$/);
      if (m && request.method === 'GET') return handleGetOrderPublic(request, env, m[1]);

      m = path.match(/^\/orders\/([A-Z0-9-]{4,40})\/slip$/);
      if (m && request.method === 'POST') return handleUploadSlip(request, env, m[1]);

      // admin
      if (path === '/admin/login' && request.method === 'POST') return handleAdminLogin(request, env);

      if (path.startsWith('/admin/')) {
        const ok = await checkAdminSession(env, request);
        if (!ok) return err(401, 'unauthorized');
      }
      if (path === '/admin/orders' && request.method === 'GET') return handleAdminListOrders(request, env);

      m = path.match(/^\/admin\/orders\/([A-Z0-9-]{4,40})$/);
      if (m && request.method === 'GET') return handleAdminGetOrder(request, env, m[1]);
      if (m && request.method === 'PATCH') return handleAdminPatchOrder(request, env, m[1]);

      // legacy LINE webhook (no-op 200 so existing config doesn't error)
      if (path === '/webhook') return new Response('ok');

      return err(404, 'not found');
    } catch (e) {
      console.error('unhandled', e);
      return err(500, 'internal error');
    }
  },
};
