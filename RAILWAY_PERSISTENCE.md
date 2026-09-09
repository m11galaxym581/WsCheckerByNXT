# Railway persistence — save ALL data in Railway PostgreSQL (recommended)

Railway's filesystem is **ephemeral**: every redeploy wipes anything the app
writes to disk. This app can persist **everything** — bot AND web — in
**Railway PostgreSQL**, no volume needed:

- Users, PRO/VIP tiers, vouchers, scan history
- **WhatsApp node sessions** (creds + signal keys live in Postgres rows —
  nodes stay connected across redeploys, no re-pairing)
- **Force-join channels**, system modes, limits, proxy flags
- Job/resume state and the proxy list

---

## Setup (one time, ~2 minutes)

1. On Railway: **New → Database → PostgreSQL** (add to the same project as the
   WS CHECKER service). Railway automatically injects `DATABASE_URL` into the
   service and redeploys it.
2. Done. On boot the app creates its table, imports any existing data and
   starts writing every piece of state into Postgres.

> Optional extra durability: a Volume mounted at `/data` still works as a
> second copy (and keeps backups locally). Not required for Postgres mode.

### Verify

```bash
curl https://wschecker.up.railway.app/api/public-status
```

Look for:

```json
"storage": { "backend": "postgres", "volumeMounted": false,
             "pgConnected": true, "dataRootDurable": false,
             "durable": true }
```

`"backend": "postgres"` + `"durable": true` = everything (users, sessions,
force-join, jobs) survives redeploys. The dashboard Status tab → PUBLIC STATUS
shows the same JSON.

---

## What the app stores in Postgres (implementation notes)

One `app_state` table, JSONB rows:

| Row key          | Contents                                              |
|------------------|-------------------------------------------------------|
| `db`             | the whole database document (users, tiers, vouchers, history, session metadata, stats, maintenance, web login devices) |
| `dynamic`        | full dynamic config = force-join channels, FREE/PRO/VIP limits, system mode, proxy settings (`dynamic_config.json` mirrored) |
| `wa:<sessionId>` | one WhatsApp node per row: creds + all signal keys (Baileys auth state, debounced flush) |
| `job:<uid>`      | resume state of a user's last job (`job_state/` mirrored) |
| `file:proxies.txt` | proxy list content mirror                           |

Flow per redeploy:

1. `initDB()` connects Postgres and loads the `db` row.
2. `pg_state.bootRestore()` rehydrates force-join config, proxies and jobs.
3. WhatsApp nodes are restored from their `wa:<id>` rows — same credentials,
   no QR re-pairing.
4. Every force-join / node / setting change is mirrored to Postgres live;
   on shutdown all pending session writes are flushed.

When `DATABASE_URL` is not set (local dev / offline), the app silently uses
the legacy file layout (`users.json`, `session_*` folders) — nothing changes
locally.

## One-time migration notes

- Already using file storage with a volume? Your `users.json`, session folders
  and force-join config are imported automatically on first Postgres boot
  (session folders under `/data` are imported into `wa:` rows).
- On Railway without a volume the files are already gone each deploy — the
  first Postgres boot simply starts clean. Re-add any nodes once; from then on
  they persist forever.

## Checking a test redeploy

1. Logs on boot: `🗄️ [PG] PostgreSQL store ready …`, `💾 [DB] Persistent
   storage OK — Postgres`, then `✅ [WA] Restored N auto-saved nodes (Postgres).`
2. A connected WhatsApp node survives redeploy without re-pairing.
3. Force-join channels still listed under Force Join settings.
4. `users.json` count unchanged (check the dashboard Users/Admin screen).

If instead the logs print `[STORAGE] DATA IS NOT PERSISTENT…`, `DATABASE_URL`
is not reaching the service — check Railway Variables / restart the service,
or fall back to the Volume option at the end of this file.

---

## Alternative: Volume at /data

If you prefer not to use Postgres, attach a Volume mounted at `/data`
(service → Volumes → New Volume → Mount path `/data`). File mode then
persists everything as plain files.
