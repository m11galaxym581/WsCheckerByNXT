// ============================================================
//   WS CHECKER v6 | pg_state.js
//   Full PostgreSQL persistence for EVERYTHING that used to be
//   plain files (Railway filesystem is ephemeral).
// ------------------------------------------------------------
//   Rows live in the shared `app_state` JSONB table (see pg_store):
//     dynamic:<none>  -> "dynamic"      full dynamic config (force-join
//                                       channels, limits, system mode,
//                                       proxy list/flags) = the file
//                                       dynamic_config.json mirrored
//     wa:<sessionId>  -> WhatsApp node auth (creds + signal keys),
//                                       no files on disk at all
//     job:<uid>       -> job_state/<uid>.json mirrored
//     file:proxies.txt-> content mirror of the proxy list file
//
//   When DATABASE_URL is NOT set (or Postgres is down) every function
//   here is a safe no-op and the app keeps its legacy file behaviour.
// ============================================================

"use strict";

const fs = require("fs");
const path = require("path");

const pgStore = require("./pg_store");
const { proto, BufferJSON, initAuthCreds } = require("@whiskeysockets/baileys");

// Postgres is the active persistent layer once the store booted.
function active() {
    return pgStore.enabled && pgStore.ready;
}

// ── BufferJSON-safe doc encode/decode (mirrors Baileys file store) ──
function encDoc(doc) {
    // Serialize once with BufferJSON.replacer, then hand PG a pure-JSON tree.
    return JSON.parse(JSON.stringify(doc, BufferJSON.replacer));
}
function decDoc(obj) {
    if (!obj) return null;
    return JSON.parse(JSON.stringify(obj), BufferJSON.reviver);
}

// ============================================================
//   WHATSAPP NODE SESSIONS — fully Postgres-backed auth state
// ============================================================
// Replicates the contract of Baileys useMultiFileAuthState() but keeps the
// whole session (creds + every signal key) in one JSONB row per session,
// debounced, so a redeploy loses nothing and no session_* folder is needed.

const reg = new Map(); // sessionId -> { doc:{creds,keys}, dirty, timer }

async function makeWAAuth(sessionId) {
    if (!active()) return null;
    let e = reg.get(sessionId);
    if (!e) {
        const row = await pgStore.kvGet("wa:" + sessionId);
        e = {
            doc: row ? decDoc(row) : { creds: initAuthCreds(), keys: {} },
            dirty: false,
            timer: null,
        };
        reg.set(sessionId, e);
    }
    if (!e.doc.creds) e.doc.creds = initAuthCreds();
    if (!e.doc.keys) e.doc.keys = {};

    const state = {
        creds: e.doc.creds,
        keys: {
            get: async (type, ids) => {
                const out = {};
                for (const id of ids || []) {
                    let value = (e.doc.keys[type] && e.doc.keys[type][id]) || null;
                    if (type === "app-state-sync-key" && value) {
                        try { value = proto.Message.AppStateSyncKeyData.fromObject(value); } catch (_) {}
                    }
                    out[id] = value;
                }
                return out;
            },
            set: async (data) => {
                for (const category in data) {
                    for (const id in data[category]) {
                        const value = data[category][id];
                        if (!e.doc.keys[category]) e.doc.keys[category] = {};
                        if (value == null) delete e.doc.keys[category][id];
                        else e.doc.keys[category][id] = value;
                    }
                }
                scheduleFlush(sessionId, e, 1200);
            },
        },
    };
    const saveCreds = async () => scheduleFlush(sessionId, e, 30);
    return { state, saveCreds };
}

function scheduleFlush(sessionId, e, ms) {
    e.dirty = true;
    if (e.timer) return;
    e.timer = setTimeout(() => {
        e.timer = null;
        if (!e.dirty) return;
        e.dirty = false;
        const snap = encDoc(e.doc);
        pgStore.kvSet("wa:" + sessionId, snap).catch(() => {});
    }, ms);
}

// Immediate flush (pairing completed / graceful shutdown).
async function flushSession(sessionId) {
    const e = reg.get(sessionId);
    if (!e || !e.dirty) return;
    if (e.timer) { clearTimeout(e.timer); e.timer = null; }
    e.dirty = false;
    try { await pgStore.kvSet("wa:" + sessionId, encDoc(e.doc)); }
    catch (err) { console.error("❌ [PG] WA session flush failed:", sessionId, err.message); }
}

async function listWASessions() {
    if (!active()) return [];
    const rows = await pgStore.kvList("wa:");
    return rows.map(r => r.key.slice(3));
}

async function dropWA(sessionId) {
    const e = reg.get(sessionId);
    if (e && e.timer) { clearTimeout(e.timer); e.timer = null; }
    reg.delete(sessionId);
    if (active()) await pgStore.kvDelete("wa:" + sessionId);
}

async function flushAllWA() {
    for (const sid of reg.keys()) await flushSession(sid);
}

// One-time migration: import a legacy session_<id> folder into Postgres.
const FILE_CATEGORIES = ["app-state-sync-key", "app-state-sync-version", "sender-key", "session", "pre-key"];
async function importSessionDir(sessionId, dir) {
    if (!active()) return false;
    try {
        let creds = null;
        const keys = {};
        const files = fs.readdirSync(dir);
        for (const f of files) {
            if (!f.endsWith(".json")) continue;
            const raw = fs.readFileSync(path.join(dir, f), "utf-8");
            if (f === "creds.json") {
                creds = JSON.parse(raw, BufferJSON.reviver);
                continue;
            }
            const stem = f.slice(0, -5); // strip .json
            let cat = null, id = null;
            for (const c of FILE_CATEGORIES) {
                if (stem.startsWith(c + "-")) { cat = c; id = stem.slice(c.length + 1); break; }
            }
            if (!cat || !id) continue;
            if (!keys[cat]) keys[cat] = {};
            keys[cat][id] = JSON.parse(raw, BufferJSON.reviver);
        }
        const doc = { creds: creds || initAuthCreds(), keys };
        await pgStore.kvSet("wa:" + sessionId, encDoc(doc));
        return true;
    } catch (err) {
        console.warn(`⚠️ [PG] Could not import session folder ${sessionId}: ${err.message}`);
        return false;
    }
}

// ============================================================
//   FILE-STATE MIRRORS (dynamic config, jobs, proxies.txt)
// ============================================================

// config.setDynamicConfig() calls this after writing dynamic_config.json.
async function saveDynamic(fullConfigObj) {
    if (!active()) return;
    try { await pgStore.kvSet("dynamic", fullConfigObj); }
    catch (e) { console.error("❌ [PG] dynamic mirror failed:", e.message); }
}

// checker.js saveJobState() calls this after writing job_state/<uid>.json.
async function saveJob(uid, data) {
    if (!active()) return;
    try { await pgStore.kvSet("job:" + uid, data); }
    catch (e) { console.error("❌ [PG] job mirror failed:", e.message); }
}

// ── Boot restore ─────────────────────────────────────────────
// Called once from index.js right after the DB layer is up, BEFORE the web
// server and WhatsApp restores start. Re-hydrates everything a redeploy
// wiped from disk.
async function bootRestore() {
    if (!active()) {
        console.log("💾 [PG] File-state mirroring off (no Postgres) — using local files.");
        return;
    }
    const config = require("./config");

    // 1. dynamic_config.json (force-join channels, limits, system mode, proxy list)
    try {
        const dyn = await pgStore.kvGet("dynamic");
        if (dyn && typeof dyn === "object") {
            config.setDynamicConfig(dyn); // writes the local file too
            console.log("🗄️ [PG] Restored dynamic config (force-join, limits, modes) from Postgres.");
        }
    } catch (e) { console.error("❌ [PG] dynamic restore failed:", e.message); }

    // 2. proxies.txt content mirror
    try {
        const row = await pgStore.kvGet("file:proxies.txt");
        const dyn = config.dynamic;
        const file = config.dataPath(process.env.PROXY_FILE || dyn.PROXY_FILE || "proxies.txt");
        if (row && typeof row.content === "string") {
            if (!fs.existsSync(file) || (row.updatedAt && fs.statSync(file).mtimeMs < Date.parse(row.updatedAt))) {
                fs.writeFileSync(file, row.content, "utf-8");
                console.log("🗄️ [PG] Restored proxies.txt from Postgres.");
            }
        } else if (fs.existsSync(file)) {
            // First PG boot with an existing proxy file: mirror it up once.
            await pgStore.kvSet("file:proxies.txt", { content: fs.readFileSync(file, "utf-8"), updatedAt: new Date().toISOString() });
        }
    } catch (e) { console.error("❌ [PG] proxies restore failed:", e.message); }

    // 3. job_state/<uid>.json files (resume-last-job)
    try {
        const jobs = await pgStore.kvList("job:");
        let n = 0;
        for (const j of jobs) {
            const uid = j.key.slice(4);
            const fp = path.join(config.DATA_ROOT, "job_state", `${uid}.json`);
            if (!fs.existsSync(fp)) {
                fs.mkdirSync(path.dirname(fp), { recursive: true });
                fs.writeFileSync(fp, JSON.stringify(j.data, null, 2), "utf-8");
                n++;
            }
        }
        if (n) console.log(`🗄️ [PG] Restored ${n} job-state file(s) from Postgres.`);
    } catch (e) { console.error("❌ [PG] job-state restore failed:", e.message); }

    // 4. One-time import of any legacy session_* folders that still exist
    //    (only relevant when moving from a volume/files setup to Postgres).
    try {
        const existing = new Set(await listWASessions());
        let imported = 0;
        const entries = fs.readdirSync(config.DATA_ROOT);
        for (const entry of entries) {
            if (!entry.startsWith("session_")) continue;
            const p = path.join(config.DATA_ROOT, entry);
            if (!fs.lstatSync(p).isDirectory()) continue;
            const sid = entry.replace("session_", "");
            if (existing.has(sid)) continue;
            if (await importSessionDir(sid, p)) imported++;
        }
        if (imported) console.log(`🗄️ [PG] Imported ${imported} legacy WhatsApp session folder(s) into Postgres.`);
    } catch (_) {}
}

// Flush everything pending (called before graceful shutdown, after syncDB).
async function flushAll() {
    if (!active()) return;
    try { await flushAllWA(); } catch (e) { console.error("❌ [PG] WA flush failed:", e.message); }
}

module.exports = {
    active,
    makeWAAuth,
    flushSession,
    listWASessions,
    dropWA,
    flushAll,
    importSessionDir,
    saveDynamic,
    saveJob,
    bootRestore,
};
