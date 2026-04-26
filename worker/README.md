# Casual Look — Cloudflare Worker (LINE Payment Integration)

Backend serverless function ที่:
1. รับออเดอร์จากเว็บ (POST /order)
2. อัพโหลดรูปดีไซน์ไปยัง ImgBB
3. Push ออเดอร์ + รูปเข้า LINE OA ของร้าน
4. สร้าง PromptPay QR payload ส่งกลับให้เว็บแสดง QR ให้ลูกค้าสแกนชำระเงิน

---

## 📋 สิ่งที่ต้องเตรียม (ก่อนเริ่ม Setup)

| # | สิ่งที่ต้องมี | หาได้จาก |
|---|---|---|
| 1 | LINE Channel Access Token | https://developers.line.biz/console/ |
| 2 | LINE Admin User ID | ดูวิธีหาด้านล่าง |
| 3 | PromptPay หมายเลข | เบอร์มือถือ 10 หลัก หรือเลขประชาชน 13 หลัก |
| 4 | ImgBB API Key | https://api.imgbb.com/ (free) |
| 5 | Cloudflare Account | https://dash.cloudflare.com/sign-up |
| 6 | Node.js 18+ + Wrangler CLI | `npm i -g wrangler` |

---

## 🔧 Step-by-Step Setup

### Step 1 — สร้าง LINE Messaging API Channel

1. เข้า https://developers.line.biz/console/
2. Login ด้วย LINE account
3. Create new Provider → ตั้งชื่อ "Casual Look"
4. ใต้ Provider นั้น → **Create Messaging API Channel**
   - Channel name: `Casual Look Studio`
   - Channel description: ออเดอร์ตกแต่งเสื้อ
   - Category / Subcategory: เลือกตามจริง
5. ที่หน้า Channel → tab **Messaging API**:
   - หา **Channel access token (long-lived)** → กด Issue → **คัดลอกเก็บ** (จะใช้ใน Step 4)
6. ที่ tab **Basic settings**:
   - หา **Bot basic ID** (เช่น `@1234abcd`) → นี่คือ ID ที่ลูกค้าใช้ Add Friend

### Step 2 — หา Admin User ID

User ID ของแอดมินคือ userId ของบัญชี LINE ที่จะรับ notify ออเดอร์

**วิธีหา (เลือกวิธีใดก็ได้):**

**วิธีที่ 1 — ผ่าน LINE Developers Console (ง่ายสุด):**
- ที่หน้า Channel → tab **Basic settings** → เลื่อนลงหา **Your user ID**
- คัดลอกค่า (ขึ้นต้นด้วย `U` ตามด้วย 32 ตัวอักษร เช่น `Uabc123...`)

**วิธีที่ 2 — Add bot เป็นเพื่อน + ส่งข้อความ:**
- Scan QR code ของ bot → Add Friend
- ส่งข้อความอะไรก็ได้
- ดู Webhook event log ใน Console → จะเห็น `userId`

### Step 3 — สมัคร ImgBB API Key

1. https://api.imgbb.com/ → Get API Key
2. Sign up หรือ Login
3. คัดลอก API Key (32 ตัวอักษร)

### Step 4 — Deploy Worker

```bash
# ติดตั้ง wrangler (ครั้งแรก)
npm install -g wrangler

# Login Cloudflare
wrangler login

# เข้าโฟลเดอร์ worker
cd worker

# ตั้ง secrets (4 ตัว)
wrangler secret put LINE_CHANNEL_ACCESS_TOKEN
# (paste token จาก Step 1)

wrangler secret put LINE_ADMIN_USER_ID
# (paste user ID จาก Step 2)

wrangler secret put PROMPTPAY_TARGET
# (เบอร์มือถือ 10 หลัก เช่น 0812345678)

wrangler secret put IMGBB_API_KEY
# (paste API key จาก Step 3)

# Deploy
wrangler deploy
```

หลัง deploy จะได้ URL ประมาณ:
```
https://casual-look-line.<your-subdomain>.workers.dev
```

### Step 5 — แก้ Frontend ให้ชี้ไปที่ Worker

เปิด `index.html` หา constant `WORKER_URL`:

```javascript
const WORKER_URL = 'https://casual-look-line.YOUR-SUBDOMAIN.workers.dev';
```

แทน `YOUR-SUBDOMAIN` ด้วย subdomain จริงของคุณที่ได้จาก Step 4

---

## ✅ ทดสอบ

```bash
# health check
curl https://casual-look-line.YOUR-SUBDOMAIN.workers.dev/health
# → {"ok":true,"time":...}
```

หรือเปิดเว็บ → ออกแบบเสื้อ → กด Save → ยืนยัน
- ✓ ในเว็บจะมี QR PromptPay โผล่
- ✓ ใน LINE chat ของแอดมินจะเห็นรูปเสื้อ + รายละเอียดออเดอร์

---

## 💰 ค่าใช้จ่าย (Free Tier)

| Service | Free Limit |
|---|---|
| Cloudflare Workers | 100,000 requests/day |
| LINE Messaging API (Free) | 200 push messages/month |
| ImgBB | Unlimited uploads (รูปอยู่ 30 วัน) |

**ถ้า > 200 ออเดอร์/เดือน:** อัพเกรด LINE OA เป็น Light (~฿1,200/เดือน, 5,000 push)

---

## 🐛 Troubleshooting

| อาการ | สาเหตุ / วิธีแก้ |
|---|---|
| `LINE push failed [401]` | Token ผิด หรือ expired → re-issue |
| `LINE push failed [403]` | Bot ยังไม่ได้เป็นเพื่อนกับ admin → admin ต้อง Add bot ก่อน |
| `imgbb upload failed` | API Key ผิด / quota เต็ม |
| Frontend error CORS | ตรวจ `ALLOWED_ORIGIN` ใน wrangler.toml ตรงกับ URL เว็บ |
| QR สแกนแล้ว amount ไม่ตรง | ตรวจ `PROMPTPAY_TARGET` เบอร์ถูกไหม |

---

## 🔒 Security Notes

- ไม่มี secret อยู่ในโค้ด — ทั้งหมดเก็บใน Cloudflare Workers Secrets (encrypted)
- CORS จำกัด origin ตาม `ALLOWED_ORIGIN` — กัน website อื่นเรียก API
- ImgBB upload จำกัด 30 วันแล้วลบ — ลด digital footprint
