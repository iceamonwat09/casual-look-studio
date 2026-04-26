/**
 * Casual Look Studio — Cloudflare Worker
 *
 * Endpoints:
 *   POST /order  — receives order from frontend, pushes to LINE OA admin chat,
 *                  returns success + PromptPay QR payload
 *   GET  /health — health check
 *
 * Required secrets (wrangler secret put ...):
 *   LINE_CHANNEL_ACCESS_TOKEN  — long-lived token from LINE Developers Console
 *   LINE_ADMIN_USER_ID         — userId of shop admin who receives orders
 *                                (push target — get this by chatting with bot
 *                                once and reading webhook event payload)
 *   PROMPTPAY_TARGET           — mobile number (10 digits, e.g. 0812345678)
 *                                or NID (13 digits) for QR generation
 *   IMGBB_API_KEY              — free key from api.imgbb.com (for image upload)
 *
 * Required vars in wrangler.toml [vars]:
 *   ALLOWED_ORIGIN             — e.g. https://iceamonwat09.github.io
 */

const LINE_API = 'https://api.line.me/v2/bot/message/push';
const IMGBB_API = 'https://api.imgbb.com/1/upload';

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
  if (acct.length === 13) {
    acctTag = '02';
    acctValue = acct;
  } else if (acct.length === 10) {
    acctTag = '01';
    acctValue = '0066' + acct.substring(1); // strip leading 0, prefix 0066
  } else {
    throw new Error('PromptPay target must be 10-digit phone or 13-digit NID');
  }

  let merchant = tlv('00', 'A000000677010111') + tlv(acctTag, acctValue);

  let payload = '';
  payload += tlv('00', '01');                           // payload format
  payload += tlv('01', amount ? '12' : '11');           // POI (12 = dynamic w/amount)
  payload += tlv('29', merchant);                       // merchant info
  payload += tlv('53', '764');                          // currency THB
  if (amount) payload += tlv('54', Number(amount).toFixed(2));
  payload += tlv('58', 'TH');                           // country
  payload += '6304';                                    // CRC field id+len placeholder
  payload += crc16ccitt(payload);
  return payload;
}

// ─────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────
function corsHeaders(origin) {
  return {
    'Access-Control-Allow-Origin': origin || '*',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age': '86400'
  };
}

function json(data, status, origin) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', ...corsHeaders(origin) }
  });
}

async function uploadToImgBB(base64DataUrl, apiKey) {
  const base64 = base64DataUrl.replace(/^data:image\/\w+;base64,/, '');
  const fd = new FormData();
  fd.append('key', apiKey);
  fd.append('image', base64);
  fd.append('expiration', String(60 * 60 * 24 * 30)); // 30 days
  const r = await fetch(IMGBB_API, { method: 'POST', body: fd });
  if (!r.ok) throw new Error('imgbb upload failed: ' + r.status);
  const j = await r.json();
  if (!j.data?.url) throw new Error('imgbb no url in response');
  return j.data.url;
}

async function pushToLine(token, to, messages) {
  const r = await fetch(LINE_API, {
    method: 'POST',
    headers: {
      'Authorization': 'Bearer ' + token,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ to, messages })
  });
  if (!r.ok) {
    const errText = await r.text();
    throw new Error('LINE push failed [' + r.status + ']: ' + errText);
  }
  return r;
}

function buildOrderText(order) {
  const lines = [];
  lines.push('🛒 ออเดอร์ใหม่ — Casual Look');
  lines.push('Order: ' + order.id);
  lines.push('━━━━━━━━━━━━━━━');
  lines.push('• Cardigan ฿' + order.shirt);
  if (order.s)     lines.push('• Small  × ' + order.s + '  ฿' + order.subS);
  if (order.m)     lines.push('• Medium × ' + order.m + '  ฿' + order.subM);
  if (order.l)     lines.push('• Large  × ' + order.l + '  ฿' + order.subL);
  if (order.chars) lines.push('• Text ' + order.chars + ' ตัวอักษร  ฿' + order.subT);
  lines.push('━━━━━━━━━━━━━━━');
  lines.push('💰 รวม ฿' + order.total.toLocaleString());
  lines.push('');
  lines.push('ลูกค้ารอ scan QR ชำระเงินอยู่');
  return lines.join('\n');
}

// ─────────────────────────────────────────
// Worker entrypoint
// ─────────────────────────────────────────
export default {
  async fetch(request, env) {
    const origin = env.ALLOWED_ORIGIN || '*';
    const url = new URL(request.url);

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders(origin) });
    }

    if (url.pathname === '/health') {
      return json({ ok: true, time: Date.now() }, 200, origin);
    }

    if (url.pathname !== '/order' || request.method !== 'POST') {
      return json({ error: 'not_found' }, 404, origin);
    }

    try {
      const body = await request.json();
      const { imageBase64, order } = body || {};
      if (!order?.id || !order?.total || !imageBase64) {
        return json({ error: 'invalid_payload' }, 400, origin);
      }

      // 1. PromptPay QR payload (string for QR)
      const ppPayload = genPromptPayPayload(env.PROMPTPAY_TARGET, order.total);

      // 2. Upload canvas image to ImgBB so LINE can display it
      const imageUrl = await uploadToImgBB(imageBase64, env.IMGBB_API_KEY);

      // 3. Push to LINE admin chat
      await pushToLine(env.LINE_CHANNEL_ACCESS_TOKEN, env.LINE_ADMIN_USER_ID, [
        {
          type: 'image',
          originalContentUrl: imageUrl,
          previewImageUrl: imageUrl
        },
        {
          type: 'text',
          text: buildOrderText(order)
        }
      ]);

      return json({
        success: true,
        orderId: order.id,
        promptpay: ppPayload,
        imageUrl
      }, 200, origin);

    } catch (err) {
      return json({
        error: 'processing_failed',
        message: String(err.message || err)
      }, 500, origin);
    }
  }
};
