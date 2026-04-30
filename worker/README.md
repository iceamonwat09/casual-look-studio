# Casual Look — Order Management System

ระบบจัดการ order ครบวงจร — Self-managed บน Cloudflare Worker + KV
ลูกค้าสั่งจากเว็บ → KV เก็บ order → push notify LINE staff group → ลูกค้าได้ลิงก์ track
แอดมินเข้า /admin จัดการสถานะ → ลูกค้าเห็น real-time

## 📐 Architecture

```
┌────────────────┐  POST /order   ┌──────────────────┐    push    ┌─────────────┐
│ index.html     │ ─────────────► │ Cloudflare       │ ─────────► │ LINE Staff  │
│ (studio)       │                │ Worker           │            │ Group       │
└────────────────┘                │  + KV (ORDERS)   │            └─────────────┘
                                  │  + ImgBB upload  │
┌────────────────┐  GET  /order   │                  │
│ track.html     │ ◄──────────────┤                  │
│ (customer)     │   magic-link   │                  │
└────────────────┘                │                  │
                                  │                  │
┌────────────────┐  GET  /admin/* │                  │
│ admin.html     │ ─────────────► │                  │
│ (shop)         │   X-Admin-Pwd  │                  │
└────────────────┘                └──────────────────┘
```

## 📋 Setup Checklist

1. ✅ **LINE Messaging API channel** — token + groupId/userId
2. ✅ **ImgBB API key** — for design image hosting
3. ✅ **PromptPay number** — phone (10 digits) or NID (13 digits)
4. ✅ **Admin password** — for /admin dashboard
5. ✅ **Cloudflare account** + Wrangler CLI
6. ✅ **KV namespace** — for order storage

## 🚀 Deploy Steps

### Step 1 — สมัคร service ที่ต้องใช้
ดู section "Service Setup" ด้านล่าง

### Step 2 — สร้าง KV namespace (ใหม่!)

```bash
cd worker
npm install -g wrangler  # ถ้ายังไม่มี
wrangler login

# สร้าง KV namespace
wrangler kv:namespace create ORDERS
```

จะได้ output ประมาณ:
```
🌀 Creating namespace with title "casuallook-bot-ORDERS"
✨ Success! Add the following to your configuration file in your kv_namespaces array:
[[kv_namespaces]]
binding = "ORDERS"
id = "abc123def456..."
```

**คัดลอก `id`** แล้ววางใน `wrangler.toml` แทน `REPLACE_WITH_KV_ID_AFTER_CREATE`

### Step 3 — ตั้ง secrets (5 ตัว)

```bash
wrangler secret put LINE_CHANNEL_ACCESS_TOKEN
# paste: DSdCa+4sZ...lFU=

wrangler secret put LINE_ADMIN_USER_ID
# paste: Ca353c2f59bd9c63b0455cd7f41d78ed4

wrangler secret put PROMPTPAY_TARGET
# paste: 0840407297

wrangler secret put IMGBB_API_KEY
# paste: cf4bc8bf7df553da76ca676c7e36eb08

wrangler secret put ADMIN_PASSWORD
# paste: !QAZXSW@ice
```

### Step 4 — Deploy

```bash
wrangler deploy
```

ได้ URL: `https://casuallook-bot.iceamonwat.workers.dev`

### Step 5 — ทดสอบ

```bash
curl https://casuallook-bot.iceamonwat.workers.dev/health
# → {"ok":true,"time":...}
```

## 🌐 Frontend Pages

หลัง deploy worker → push code ขึ้น GitHub Pages → 3 หน้าใช้งานได้:

| URL | หน้าที่ | Auth |
|---|---|---|
| `/` หรือ `/index.html` | Studio ออกแบบเสื้อ + สั่งซื้อ | Public |
| `/track.html?id=...&t=...` | ลูกค้าติดตามสถานะ | Magic link token |
| `/admin.html` | แอดมินจัดการ order | Password |

## 🔑 Service Setup

### LINE Messaging API

1. https://developers.line.biz/console/ → Create Messaging API Channel
2. **Messaging API tab** → Issue **Channel access token (long-lived)**
3. หา **Push target ID**:
   - **Group** (แนะนำ): สร้างกลุ่ม + invite bot → ส่งข้อความ → ดู `groupId` ใน webhook event
   - **User**: ใช้ Your user ID จาก Basic settings tab
4. **Bot ต้องอยู่ในกลุ่ม / เป็นเพื่อน** กับ target ID ก่อน ไม่งั้น push ล้มเหลว 403

### ImgBB

1. https://api.imgbb.com/ → Get API Key (ฟรี)
2. รูปจะอยู่บน server ImgBB **90 วัน** หลังสร้าง

### PromptPay

ใช้เบอร์มือถือ (10 หลัก) หรือเลขประชาชน (13 หลัก) ที่ผูกกับ PromptPay

## 🐛 Troubleshooting

| อาการ | สาเหตุ / แก้ |
|---|---|
| `LINE push failed [401]` | Token ผิด / expired → re-issue |
| `LINE push failed [403]` | Bot ไม่ได้อยู่ในกลุ่ม / ไม่เป็นเพื่อน |
| `imgbb upload failed` | API Key ผิด / quota เต็ม |
| `kv binding not configured` | ยังไม่ได้ใส่ `id` ใน wrangler.toml — ทำ Step 2 |
| Frontend CORS error | `ALLOWED_ORIGIN` ใน wrangler.toml ไม่ตรงกับ URL เว็บ |
| Admin login 401 | password ไม่ตรง — ตรวจ `wrangler secret list` |

## 💰 Cost (Free Tier)

| Service | Free Limit |
|---|---|
| Cloudflare Workers | 100,000 requests/day |
| Cloudflare KV | 100,000 reads + 1,000 writes/day, 1 GB storage |
| LINE Push | 200/month (Free), 5,000 (Light ฿1,200) |
| ImgBB | Unlimited (image lasts 90 days) |

100k request/day = ~3 ล้าน/เดือน → เพียงพอสำหรับ 10,000+ ออเดอร์/วัน

## 🔒 Security

- Secrets ทั้งหมดอยู่ใน Cloudflare Secrets (encrypted) ไม่อยู่ใน repo
- Magic link token = 10 ตัวอักษร random (~3.6 quadrillion combinations)
- Admin password ส่งใน header `X-Admin-Password` (ผ่าน HTTPS)
- KV ไม่มี public access — ผ่าน Worker เท่านั้น
- CORS lock ตาม `ALLOWED_ORIGIN`

## 🔄 Status Lifecycle

```
รอชำระเงิน  →  ระหว่างการผลิต  →  จัดส่ง  →  ได้รับสินค้า
  pending       production        shipping     delivered
```

Admin คลิกปุ่มใน admin.html → KV update → ลูกค้า refresh track.html เห็นทันที
