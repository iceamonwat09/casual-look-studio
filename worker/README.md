# Casual Look — Order Worker

Cloudflare Worker ที่ทำหน้าที่ backend ของระบบสั่งสินค้า

## เก็บข้อมูลที่ไหน
- **KV namespace `ORDERS`** — เก็บออเดอร์ทุกตัว + index + session token
- **imgbb** — เก็บภาพดีไซน์ + สลิป (URL ถูก reference ใน KV)

## Endpoints

| Method | Path | Auth | คำอธิบาย |
|--------|------|------|---------|
| POST | `/orders` | — | ลูกค้าสั่งของใหม่ |
| GET | `/orders/:id?t=token` | magic link | ลูกค้าดูออเดอร์ตัวเอง |
| POST | `/orders/recover` | order id + last 4 phone | กู้ลิงก์ที่ลืม |
| POST | `/orders/:id/slip` | magic link | ลูกค้าอัปโหลดสลิป |
| POST | `/admin/login` | — | login ด้วย password |
| GET | `/admin/orders` | session | list + stats |
| GET | `/admin/orders/:id` | session | full order |
| PATCH | `/admin/orders/:id` | session | update status / tracking / note |
| GET | `/promptpay/qr?amount=` | — | QR PromptPay PNG |
| GET | `/health` | — | health check |

## Setup ครั้งแรก (Dashboard, ไม่ต้องใช้ CLI)

1. **สร้าง KV** — Storage & Databases → KV → Create namespace ชื่อ `ORDERS`
2. **Bind KV เข้า Worker** — Workers & Pages → casuallook-bot → Bindings → +Add → KV Namespace → variable name `ORDERS`
3. **Secrets** (Settings → Variables and Secrets → +Add → type: Secret)
   - `LINE_ACCESS_TOKEN` — Channel Access Token (Long-lived)
   - `LINE_GROUP_ID` — Group ID (เริ่มด้วย `C...`)
   - `PROMPTPAY_TARGET` — เบอร์ 10 หลัก หรือ Citizen ID 13 หลัก
   - `IMGBB_API_KEY` — จาก https://api.imgbb.com
   - `ADMIN_PASSWORD` — รหัสเข้า admin dashboard
4. **Deploy code** — กด Edit code มุมขวาบน → ลบโค้ดเดิม → paste จาก `worker.js` → Save and Deploy

## Setup ผ่าน CLI (ทางเลือก)

```bash
cd worker
wrangler kv:namespace create ORDERS         # copy id ใส่ใน wrangler.toml
wrangler secret put LINE_ACCESS_TOKEN
wrangler secret put LINE_GROUP_ID
wrangler secret put PROMPTPAY_TARGET
wrangler secret put IMGBB_API_KEY
wrangler secret put ADMIN_PASSWORD
wrangler deploy
```

## Status flow

```
pending  →  production  →  shipping  →  delivered
รอชำระ      ระหว่างผลิต     จัดส่ง        ได้รับสินค้า
```

ทุกครั้งที่ status เปลี่ยน — Worker push ข้อความเข้า LINE group อัตโนมัติ

## Test

```bash
# health check
curl https://casuallook-bot.iceamonwat.workers.dev/health

# admin login
curl -X POST https://casuallook-bot.iceamonwat.workers.dev/admin/login \
  -H 'Content-Type: application/json' \
  -d '{"password":"YOUR_PASSWORD"}'
```
