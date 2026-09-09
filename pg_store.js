// ============================================================
//   WS CHECKER v6 | pg_store.js
//   PostgreSQL document-store bridge (Railway Postgres / any PG)
// ------------------------------------------------------------
// The rest of the codebase talks to database.js purely through the
// JSON-document contract: getDB() reads the whole DB object and
// saveDB(db) persists the whole object. That synchronous contract
// cannot talk to Postgres directly, so this bridge keeps ONE
// in-memory copy of the DB and flushes every mutation to a single
// JSONB row inside Postgres:
//
//     table: app_state (schema_key TEXT PRIMARY KEY, data JSONB NOT NULL)
//     row:   schema_key = 'db'
//
// getDB()  -> returns the in-memory snapshot (same shape as users.json)
// saveDB() -> updates memory + queues a (debounced) async flush to PG
// syncPG() -> awaits all pending flushes (use before graceful shutdown)
// ============================================================

"use strict";

const { Pool } = require("pg");

const CONN = process.env.DATABASE_URL;
const enabled = !!(CONN && (CONN.startsWith("postgres://") || CONN.startsWith("postgresql://")));

// Railway Postgres has SSL enabled; keep verifying unless explicitly disabled.
const sslMode = String(process.env.PGSSLMODE || "prefer").toLowerCase();
const needsSsl = ["require", "verify-ca", "verify-full"].includes(sslMode);
const rejectUnauthorized = String(process.env.PGSSLROOTCERT || "").toLowerCase() !== "disable";

let pool = null;
if (enabled) {
    pool = new Pool({
        connectionString: CONN,
        max: 2,                     // one app instance only (Telegram long-polling)
        idleTimeoutMillis: 30_000,
        connectionTimeoutMillis: 15_000,
        ssl: needsSsl ? { rejectUnauthorized } : undefined,
    });
}

let memDB = null;       // in-memory master copy (whole document)
let _flushTimer = null;
let _pending = false;   // a flush is already queued
let _flushing = null;   // promise of the in-flight flush
let _booted = false;
let _bootError = null;

// ── Schema ──────────────────────────────────────────────────
async function ensureSchema() {
    await pool.query(`CREATE TABLE IF NOT EXISTS app_state (
        schema_key TEXT PRIMARY KEY,
        data JSONB NOT NULL,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )`);
}

// ── Boot ────────────────────────────────────────────────────
async function initPGStore({ migrateJsonPath = null } = {}) {
    if (!enabled) return false;
    try {
        await ensureSchema();
        const { rows } = await pool.query(`SELECT data FROM app_state WHERE schema_key = $1`, ["db"]);
        if (rows.length) {
            memDB = rows[0].data;
            console.log("🗄️ [PG] PostgreSQL store ready (loaded existing state)");
        } else {
            // Fresh Postgres: seed from an existing users.json if present
            // (one-time migration so nothing is lost when moving from file storage).
            if (migrateJsonPath) {
                const fs = require("fs");
                try {
                    if (fs.existsSync(migrateJsonPath)) {
                        const parsed = JSON.parse(fs.readFileSync(migrateJsonPath, "utf-8"));
                        if (parsed && typeof parsed === "object" && parsed.users) {
                            memDB = parsed;
                            console.log("🗄️ [PG] Seeded Postgres from existing users.json");
                        }
                    }
                } catch (e) { console.warn("⚠️ [PG] users.json migration skipped:", e.message); }
            }
            if (!memDB) memDB = {}; // database.js fills defaults + repairs
            await flushNow();
            console.log("🗄️ [PG] PostgreSQL store ready (initialized new state)");
        }
        _booted = true;
        return true;
    } catch (err) {
        _bootError = err;
        console.error("❌ [PG] PostgreSQL init failed:", err.message);
        console.error("   Falling back to file storage (users.json). Check DATABASE_URL / Postgres service.");
        return false;
    }
}

// ── Flush engine ────────────────────────────────────────────
function queueFlush() {
    if (_pending || !_booted) return;
    _pending = true;
    _flushTimer = setTimeout(() => { _pending = false; _flushTimer = null; flushNow().catch(() => {}); }, 250);
}

function flushNow() {
    const snapshot = memDB;
    if (!snapshot) return Promise.resolve();
    _flushing = pool.query(`INSERT INTO app_state (schema_key, data, updated_at)
        VALUES ($1, $2::jsonb, now())
        ON CONFLICT (schema_key) DO UPDATE SET data = EXCLUDED.data, updated_at = now()`,
        ["db", JSON.stringify(snapshot)])
        .catch(err => console.error("❌ [PG] Flush failed:", err.message));
    return _flushing;
}

// Last-write-wins save: swap memory + schedule one debounced flush.
function saveToPG(db) {
    memDB = db;
    queueFlush();
}

// ── Generic JSONB key-value rows (same app_state table) ──────
// Used for every piece of state that is NOT the main DB document:
//   dynamic config (force-join channels, limits, modes, proxy list),
//   WhatsApp session credentials, job-state files, proxies.txt mirror.
// Keys are namespaced: "dynamic", "wa:<sessionId>", "job:<uid>",
// "file:proxies.txt".

async function kvSet(key, value) {
    if (!enabled || !_booted) return false;
    try {
        await pool.query(`INSERT INTO app_state (schema_key, data, updated_at)
            VALUES ($1, $2::jsonb, now())
            ON CONFLICT (schema_key) DO UPDATE SET data = EXCLUDED.data, updated_at = now()`,
            [key, JSON.stringify(value)]);
        return true;
    } catch (e) {
        console.error("❌ [PG] kvSet failed:", key, e.message);
        return false;
    }
}

async function kvGet(key) {
    if (!enabled || !_booted) return null;
    try {
        const { rows } = await pool.query(`SELECT data FROM app_state WHERE schema_key = $1`, [key]);
        return rows.length ? rows[0].data : null;
    } catch (e) {
        console.error("❌ [PG] kvGet failed:", key, e.message);
        return null;
    }
}

async function kvList(prefix) {
    if (!enabled || !_booted) return [];
    try {
        const { rows } = await pool.query(
            `SELECT schema_key, data FROM app_state WHERE schema_key LIKE $1`,
            [prefix + "%"]);
        return rows.map(r => ({ key: r.schema_key, data: r.data }));
    } catch (e) {
        console.error("❌ [PG] kvList failed:", prefix, e.message);
        return [];
    }
}

async function kvDelete(key) {
    if (!enabled || !_booted) return false;
    try {
        await pool.query(`DELETE FROM app_state WHERE schema_key = $1`, [key]);
        return true;
    } catch (e) {
        console.error("❌ [PG] kvDelete failed:", key, e.message);
        return false;
    }
}

// Block until every queued write reached Postgres (graceful shutdown / tests)
async function syncPG(timeoutMs = 5000) {
    if (!enabled) return true;
    if (_flushTimer) { clearTimeout(_flushTimer); _flushTimer = null; _pending = false; }
    if (_flushing) { try { await _flushing; } catch (_) {} }
    if (memDB) {
        try {
            await Promise.race([
                flushNow(),
                new Promise((_, rej) => setTimeout(() => rej(new Error("flush timeout")), timeoutMs)),
            ]);
        } catch (e) { console.error("❌ [PG] Final flush failed:", e.message); return false; }
    }
    return true;
}

async function closePG() {
    if (!enabled) return;
    try { await syncPG(); } catch (_) {}
    try { await pool.end(); } catch (_) {}
}

// Test hook: swap the real connection pool for a fake one (in-memory driver)
function _setPoolForTest(fakePool) { pool = fakePool; }

module.exports = {
    initPGStore, syncPG, closePG, saveToPG, flushNow,
    kvSet, kvGet, kvList, kvDelete,
    getMemory: () => memDB,
    _setPoolForTest,
    get enabled() { return enabled; },
    get ready() { return _booted; },
    get bootError() { return _bootError; },
};
