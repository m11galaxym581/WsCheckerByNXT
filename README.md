# WS CHECKER — BlazeNXT v5.01.49

A Telegram bot + web dashboard for WhatsApp number checking, sessions/nodes management, result exports, saved lists, jobs/queue, API keys, webhooks, proxy pool, and admin tools.

> Current package/version: **v5.01.49**

---

## 1. Requirements

- Node.js **20+** (Node 22 recommended)
- A Telegram bot token from **@BotFather**
- Your numeric Telegram user ID from **@userinfobot**
- Public domain/URL recommended for production
- Optional: residential proxies for WhatsApp nodes

---

## 2. Install

```bash
cd project_fixed
npm install
```

Start:

```bash
npm start
```

---

## 3. Deploy on Railway (one-click)

This repo is Railway-ready (`nixpacks.toml` + portable config included). Railway
detects the Node.js app automatically, runs `npm ci`, and starts it with `npm start`.

### Option A — From GitHub

1. Push this repo to GitHub.
2. On [railway.app](https://railway.app) → **New Project** → **Deploy from GitHub repo** → pick this repo.
3. Go to **Variables** and add the secrets below.
4. Deploy. Railway provisions the app and generates a public `*.up.railway.app` URL.

### Option B — From CLI

```bash
npm i -g @railway/cli
railway login
railway init
railway up
```

### Required variables (Railway → Variables)

| Variable | Required | Description |
| --- | --- | --- |
| `TG_TOKEN` | ✅ | Telegram bot token from @BotFather |
| `OWNER_ID` | ✅ | Your numeric Telegram user ID (owner/admin) |
| `DASHBOARD_URL` | ⬜ | Public panel URL, e.g. `https://your-app.up.railway.app`. When unset it is auto-detected from `RAILWAY_PUBLIC_DOMAIN` |
| `WEB_SECRET` | ⬜ | Long random secret; defaults to `TG_TOKEN` |
| `NODE_ENV` | ⬜ | Set `production` for Secure cookies (panel is HTTPS on Railway) |

`PORT` is injected by Railway automatically — the server binds `0.0.0.0:$PORT`.

### Persistent storage (recommended — WhatsApp nodes & users)

Railway's filesystem is **ephemeral**: files written next to the code are wiped on
every redeploy. To keep your database (`users.json`), WhatsApp sessions, job state
and backups across redeploys:

1. In the service → **Volumes** → **Add Volume**, mount it at `/data`.
2. Redeploy once.

The app automatically detects the Railway volume (`RAILWAY_VOLUME_MOUNT_PATH`)
and stores everything there — no code or extra variables needed. To override on any
host, set `DATA_DIR` to a writable directory.

### PostgreSQL (optional, recommended)

Instead of (or alongside) a volume, all app data can live in PostgreSQL:

1. In the project canvas → **+ New** → **Database** → **Add PostgreSQL**.
2. Railway automatically injects `DATABASE_URL` into the app service in the same
   project — no variables to copy, no code to change.
3. Redeploy the app once.

On boot the app detects `DATABASE_URL` and switches the whole data layer to
Postgres (single JSONB document store, table `app_state` — auto-created, no
migrations to run):

- Users, subscriptions, VIPs, vouchers, history, session metadata, stats and
  maintenance state are stored in Postgres and survive redeploys with zero setup.
- An existing `users.json` is **imported once** into Postgres on first boot, so
  nothing is lost when switching.
- Without `DATABASE_URL` the app falls back to the original `users.json` file —
  fully backwards compatible for local runs.

> WhatsApp login credentials (`session_*` folders) are encrypted files, not DB
> rows, so still attach a `/data` volume if you want nodes to survive redeploys.
> `job_state/` and `tmp_results/` also stay on the filesystem.

> Only ever run **one** instance per Telegram bot token (long-polling bots conflict
> with a second instance, Telegram error 409).

---

## 4. `.env` setup

> Local development only. On Railway/Hosted deploys set these as environment
> variables (Railway → Variables) — there is no `.env` file on the server.

Create `.env` in the project root (see `.env.example`):

```env
# Telegram Bot
TG_TOKEN=PASTE_YOUR_TELEGRAM_BOT_TOKEN_HERE
OWNER_ID=PASTE_YOUR_TELEGRAM_NUMERIC_ID_HERE

# Web Server
PORT=9812
DASHBOARD_URL=https://your-domain.com

# Security secret — generate a long random value
WEB_SECRET=change-this-to-a-long-random-secret

# Production cookie mode
NODE_ENV=production

# Optional proxy pool file
PROXY_FILE=proxies.txt
```

Generate `WEB_SECRET`:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

For local testing:

```env
DASHBOARD_URL=http://localhost:9812
NODE_ENV=development
```

---

## 5. Login flow

Captcha/human verification has been removed.

Login uses:

- Telegram numeric user ID
- Web password generated from bot
- Secure auth cookie
- CSRF token for protected web actions

From Telegram bot:

```txt
/start -> Login to Dashboard
```

The bot gives your web password. Use that password on the dashboard login page.

If login does not work after an update:

1. Clear browser cookies/site data for the dashboard domain.
2. Generate a fresh web password from the bot.
3. Try login again.

---

## 6. Main web routes

```txt
/dashboard
/checker
/history
/sessions
/profile
/jobs
/lists
/templates
/files
/webhooks
/docs
/settings
/admin
/audit
/vouchers
/branding
/proxies
```

---

## 7. Telegram bot commands

Common:

```txt
/start
/help
/reset
/redeem <code>
/setwebhook <url>
```

Admin:

```txt
/admin
/stats
/sessions
/warmup
/genvoucher PRO 30 1
/addpro <uid> <days>
/rempro <uid>
/addvip <uid> <days>
/remvip <uid>
/ban <uid>
/unban <uid>
/broadcast <message>
```

Owner:

```txt
/owner
/addadmin <uid>
/remadmin <uid>
/maintenance on
/maintenance off
/systemmode free
/systemmode subscription
```

---

## 8. System modes

Owner can set:

```txt
Free Mode
Subscription Mode
```

Bot command:

```txt
/systemmode free
/systemmode subscription
```

Web:

```txt
/admin -> System Mode section
```

---

## 9. Proxy pool setup

For residential proxies, create:

```txt
proxies.txt
```

Example:

```txt
http://username:password@gateway.provider.com:8000
http://username-session-node2:password@gateway.provider.com:8000
socks5://username:password@gateway.provider.com:1080
```

Then enable proxy pool from:

```txt
/proxies
```

Or set in `dynamic_config.json`:

```json
"ENABLE_PROXY": true,
"PROXY_MODE": "pool",
"PROXY_FILE": "proxies.txt",
"PROXY_STICKY": true
```

Recommended:

```txt
1 WhatsApp node/session = 1 sticky residential proxy
```

---

## 10. API examples

Single check:

```bash
curl "https://your-domain.com/api/v1/check?key=API_KEY&number=919999999999"
```

Batch check:

```bash
curl -X POST "https://your-domain.com/api/v1/batch-check" \
  -H "Content-Type: application/json" \
  -d '{"key":"API_KEY","numbers":["919999999999","918888888888"]}'
```

---

## 11. Webhook

Set webhook from dashboard or bot:

```txt
/setwebhook https://your-domain.com/receive
```

Test from dashboard:

```txt
/webhooks -> SEND TEST WEBHOOK
```

Webhook logs:

```txt
/webhooks
```

---

## 12. Result exports

Results support:

- TXT export
- CSV export
- Registered numbers
- Unregistered numbers
- Failed/Unknown numbers
- Business data
- Bio/status
- DP link
- Email/website when available

Telegram bot also sends TXT + CSV after bot-based scan completion.

---

## 13. Admin pages

```txt
/admin       Main admin console
/audit       Audit logs
/vouchers    Voucher manager
/branding    White-label branding
/proxies     Proxy pool manager
```

---

## 14. Security notes

Implemented:

- HTTP-only auth cookie
- CSRF token for protected actions
- SameSite strict cookies
- Login failure lockout
- API key endpoints
- Webhook unsafe host validation
- Encrypted DB backup endpoint

Captcha/human verification is removed as requested.

---

## 15. Important files

```txt
.env                  private environment config
users.json            JSON database (file backend; auto-imported into Postgres once)
pg_store.js           PostgreSQL bridge (used when DATABASE_URL is set)
proxies.txt           private proxy list, ignored by git
proxies.example.txt   proxy format example
dynamic_config.json   runtime config (stored under DATA_DIR)
job_state/            resumable job state files (stored under DATA_DIR)
tmp_results/          temporary result files (stored under DATA_DIR)
```

Database backends (auto-selected at boot):

| Backend | When | Where data lives |
| --- | --- | --- |
| `postgres` | `DATABASE_URL` set (Railway Postgres) | Postgres table `app_state` (JSONB), auto-created |
| `file` | no `DATABASE_URL` | `users.json` in `DATA_DIR` / project folder |

---

## 16. Troubleshooting

### Bot says Telegram token missing
Check the environment variable / `.env`:

```env
TG_TOKEN=...
```

### App still uses users.json instead of Postgres
- Confirm `DATABASE_URL` is set on the app service (Railway: add a PostgreSQL
  service to the project — the variable is injected automatically, check the
  deployment log for `[DB] Storage backend: postgres`).
- If Postgres is unreachable the app intentionally falls back to `users.json`
  and logs `[PG] PostgreSQL init failed`.

### Dashboard login fails
- Clear site cookies/localStorage
- Generate fresh web password from bot
- Confirm `DASHBOARD_URL` is correct
- Confirm server time is correct

### CSRF error
Clear site cookies and login again.

### Proxy not used
- Set `ENABLE_PROXY=true` in `dynamic_config.json`
- Add valid proxies in `proxies.txt`
- Install dependencies with `npm install`
- Check `/proxies` page

### WhatsApp session disconnects often
- Use sticky residential proxies
- Use one proxy per node
- Lower speed profile
- Avoid too many deep scans

---

## 17. Validation commands

```bash
node --check *.js
node --check sw.js
node -e "JSON.parse(require('fs').readFileSync('package.json','utf8'))"

# Storage layer tests (Postgres bridge + file fallback, in-memory driver)
npm test
```

---

## 18. New advanced upgrade modules

### White-label branding
Route:

```txt
/branding
```

Owner can configure:

- app name
- powered by text
- support username
- custom domain field
- footer text
- primary color field
- logo upload as data URL

Backend:

```txt
GET  /api/whitelabel
POST /api/admin/whitelabel
```

### Voucher manager
Route:

```txt
/vouchers
```

Features:

- single voucher generation
- bulk generation up to 500 codes
- CSV export
- disable voucher
- expiry date field
- copy voucher code

Backend:

```txt
GET  /api/admin/vouchers
POST /api/admin/voucher
POST /api/admin/vouchers/bulk
POST /api/admin/vouchers/:code/disable
GET  /api/admin/vouchers-export
```

### User CRM
Admin can view CRM-style user details and add notes/payments/reset web password:

```txt
GET  /api/admin/user/:uid
POST /api/admin/user/:uid/notes
POST /api/admin/user/:uid/payment
POST /api/admin/user/:uid/reset-pass
POST /api/admin/user/:uid/ban-toggle
```

### Interactive API docs
Route:

```txt
/docs
```

Includes:

- API key input
- number input
- try request
- response viewer
- curl / Node.js / Python / PHP snippets
- batch API example

### API key expiry
API keys can be generated with:

```txt
Never
7 days
30 days
```

Backend stores expiry and rejects expired keys.

### Bot features
Added commands:

```txt
/mystats
/queue
/mylists
/runlist <list_id>
/retryfailed
```

After bot scan completion, a Retry Failed button is also available.

### Security center
Route:

```txt
/security
```

Backend:

```txt
GET /api/admin/security-center
GET /api/admin/feature-flags
POST /api/admin/feature-flags
POST /api/admin/security
```

### Backup scheduler / encrypted backup / restore foundation

```txt
POST /api/admin/backup-encrypted
POST /api/admin/backup-schedule
POST /api/admin/backup-restore
```

### Public share page UI
Shared result links open directly at:

```txt
/share/:id
```

### Status / Help / Changelog pages

```txt
/status
/help
/changelog
```

Public status API:

```txt
GET /api/public-status
```

---

## 19. Force Join + Multi-language Bot/Web

### Force Join System

Web route:

```txt
/force-join
```

Bot admin commands:

```txt
/forcejoin on
/forcejoin off
/forcejoin_add Title|@channel|https://t.me/channel
/forcejoin_list
```

Web APIs:

```txt
GET  /api/force-join
POST /api/admin/force-join
```

Users must join required channels before using bot/web when force join is enabled.

### Multi-language Bot + Web Sync

Bot command:

```txt
/language
```

Supported:

- English
- Hindi
- Arabic
- Spanish
- Portuguese
- Indonesian

Web language changes sync to bot via:

```txt
POST /api/user/language
```

---

## 20. UI / Navigation Upgrade

Latest UI includes:

- public landing page
- separate login page
- access/signup instruction page
- cleaned professional sidebar navigation
- mobile checker layout fixes
- result tabs stack correctly on small screens
- improved header and cards

Routes:

```txt
/
/login
/signup
/dashboard
/checker
```

---

## 21. UI Cleanup v20

Changes:

- Referral system removed from bot, web, backend APIs and README.
- New public landing page, login page and signup/access guide retained.
- Mobile checker layout fixed for result tabs and copy buttons.
- Sidebar navigation cleaned and grouped.
- Bot menu simplified and cleaned.
