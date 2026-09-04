# Railway persistence (do this once — REQUIRED)

Railway's filesystem is **ephemeral**: every redeploy/restart wipes anything the
app writes to disk unless it is inside an attached **Volume** (or Postgres).

Without persistent storage the following are lost on every deploy — on the bot
AND on the web dashboard:

- Users + PRO/VIP tiers, vouchers, scan history
- **WhatsApp node sessions** (nodes must be re-paired every time!)
- **Force-join channels** and system/limits settings (`dynamic_config.json`)
- Job state, proxy list (`proxies.txt`), backups

---

## Fix — attach a Volume (recommended, covers everything)

1. Open your project on https://railway.app → your **WS CHECKER service**.
2. Go to the **Volumes** tab → **New Volume**.
3. Mount path: **`/data`**  (this is the app's data root on Railway — see `config.js`).
4. Deploy/restart the service once (any new push or **Redeploy**).

That's it. From now on `users.json`, the `session_*` WhatsApp credentials,
force-join config, proxies and backups all live on the volume and survive
redeploys.

> If a `DATA_DIR` variable is set on the service, the volume must be mounted at
> that path instead (or delete `DATA_DIR` and use the default `/data`).

### Verify

```bash
curl https://wschecker.up.railway.app/api/public-status
```

Look for:

```json
"storage": { "backend": "file", "volumeMounted": true, "dataRootDurable": true }
```

`dataRootDurable: true` = everything persists. You can also open the dashboard
**Status** tab → PUBLIC STATUS and see the same fields.

---

## Optional extra — Postgres for the database document

Attach a Railway **PostgreSQL** service to the project; Railway injects
`DATABASE_URL`. On next boot the whole DB document (users, subscriptions,
vouchers, history, session metadata, stats, maintenance state) is imported into
a `app_state` table and kept there.

Postgres alone is **not enough**: WhatsApp node credentials, force-join
channels and job state are still plain files, so **also attach the Volume
above**. Recommended setup: Volume at `/data` **plus** Postgres.

---

## What to check after a test redeploy

1. Logs show: `💾 [DB] Persistent storage OK — data root on Volume`.
2. A connected WhatsApp node survives redeploy (Sessions page still shows it
   Connected without re-pairing).
3. Force-join channels are still listed under Force Join settings.
4. `users.json` + `session_*` folders exist under the data root.

If instead you see the boot warning

```
[STORAGE] DATA IS NOT PERSISTENT — EVERY REDEPLOY WIPES ALL DATA
```

the volume is not mounted at the data root yet — re-check the mount path.
