// ============================================================
//   WS CHECKER v6 | database.js
//   Advanced Database: VIP Tiers, Webhooks, Rotating Backups
// ============================================================

"use strict";

const fs   = require("fs");
const path = require("path");
const crypto = require("crypto");
const config = require("./config");
const pgStore = require("./pg_store");

const PG_ENABLED = pgStore.enabled;
const DB_PATH = config.dataPath(config.DB_FILE);

// ── Default Schema ──────────────────────────────────────────
function defaultDB() {
    return {
        admins: [config.OWNER_ID],
        subscribers: [], // Normal PRO users
        vips: [],        // NEW: VIP / Reseller users
        users: {},
        sessionMeta: {},
        history: {},
        banned: [],
        dailyStats: {},
        vouchers: {},
        starsPayments: {},    // Telegram Stars ledger: chargeId -> payment record
        meta: { 
            version: 4, 
            maintenance: false, 
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString()
        },
    };
}

// ── Schema repair / migrations (shared by file + PG paths) ──
// Returns { db, changed } — changed=true when a repair modified the document.
function repairDB(db) {
    let changed = false;
    const now = Date.now();
    if (!db.admins) { db.admins = [config.OWNER_ID]; changed = true; }
    if (!db.subscribers) { db.subscribers = []; changed = true; }
    if (!db.vips) { db.vips = []; changed = true; }
    if (!db.users) { db.users = {}; changed = true; }
    if (!db.sessionMeta) { db.sessionMeta = {}; changed = true; }
    if (!db.history) { db.history = {}; changed = true; }
    if (!db.banned) { db.banned = []; changed = true; }
    if (!db.vouchers) { db.vouchers = {}; changed = true; }
    if (!db.starsPayments) { db.starsPayments = {}; changed = true; }
    if (!db.dailyStats) { db.dailyStats = {}; changed = true; }
    if (!db.meta) { db.meta = {}; changed = true; }
    if (db.meta.maintenance === undefined) { db.meta.maintenance = false; changed = true; }
    if (!db.meta.version) { db.meta.version = 5; changed = true; }

    // Auto-Expire PRO Users
    const subsBefore = db.subscribers.length;
    db.subscribers = db.subscribers.filter(uid => {
        const u = db.users[uid];
        return !(u && u.proExpiry && u.proExpiry < now);
    });
    if (db.subscribers.length !== subsBefore) changed = true;

    // Auto-Expire VIP Users
    const vipsBefore = db.vips.length;
    db.vips = db.vips.filter(uid => {
        const u = db.users[uid];
        return !(u && u.vipExpiry && u.vipExpiry < now);
    });
    if (db.vips.length !== vipsBefore) changed = true;

    return { db, changed };
}

// ── Rotating Auto-Backup System (file backend only) ─────────
// Creates a backup every 6 hours. The 3 most recent backups are kept.
// With Postgres the DB itself is the durable store, so file rotation is skipped.
if (!PG_ENABLED) {
    setInterval(() => {
        try {
            if (!fs.existsSync(DB_PATH)) return;
            if (fs.existsSync(DB_PATH + '.bak2')) fs.copyFileSync(DB_PATH + '.bak2', DB_PATH + '.bak3');
            if (fs.existsSync(DB_PATH + '.bak1')) fs.copyFileSync(DB_PATH + '.bak1', DB_PATH + '.bak2');
            fs.copyFileSync(DB_PATH, DB_PATH + '.bak1');
            console.log("💾 [DB] Rotating Auto-Backup Completed.");
        } catch(e) { console.error("❌ [DB] Backup Failed:", e.message); }
    }, 6 * 60 * 60 * 1000);
}

// ── Core Read/Write ─────────────────────────────────────────
let _saveTimer = null, _pendingDB = null;

function getDB() {
    // PostgreSQL backend (active when DATABASE_URL is set AND connected)
    if (PG_ENABLED && pgStore.ready) {
        const live = pgStore.getMemory();
        if (live && typeof live === "object") {
            const { changed } = repairDB(live);
            if (changed) pgStore.saveToPG(live); // persist expiry cleanup once
            return live;
        }
    }
    // File fallback: no DATABASE_URL, PG still connecting, or PG init failed.
    try {
        if (!fs.existsSync(DB_PATH)) {
            fs.writeFileSync(DB_PATH, JSON.stringify(defaultDB(), null, 2), "utf-8");
        }
        const raw = fs.readFileSync(DB_PATH, "utf-8");
        const db = JSON.parse(raw);
        repairDB(db);
        return db;
    } catch (err) {
        console.error("⚠️ Database read error, loading default.", err.message);
        return defaultDB();
    }
}

function saveDB(db) {
    try {
        // A synchronous save carries the freshest state. Any older snapshot
        // still waiting in the debounce queue must be dropped — otherwise it
        // would fire ~50ms later and overwrite this newer write (this used to
        // silently revert plan grants: registerUser() queued a debounced save
        // with proExpiry:null, then extendPlanStack() wrote the new expiry,
        // and the stale snapshot clobbered it).
        _cancelPendingSave();
        if (!db.meta) db.meta = {};
        db.meta.updatedAt = new Date().toISOString();
        if (PG_ENABLED && pgStore.ready) {
            pgStore.saveToPG(db);
            return;
        }
        fs.writeFileSync(DB_PATH, JSON.stringify(db, null, 2), "utf-8");
    } catch (e) { console.error("❌ Save error:", e.message); }
}

function saveDBDebounced(db) {
    _pendingDB = db;
    if (_saveTimer) clearTimeout(_saveTimer);
    _saveTimer = setTimeout(() => {
        if (_pendingDB) saveDB(_pendingDB);
        _pendingDB = null; _saveTimer = null;
    }, 50);
}

// ── Boot hook: connect Postgres (if configured) before the app starts ──
async function initDB() {
    if (!PG_ENABLED) return "file";
    const ok = await pgStore.initPGStore({ migrateJsonPath: fs.existsSync(DB_PATH) ? DB_PATH : null });
    if (ok) {
        let live = pgStore.getMemory();
        if (!live) { live = defaultDB(); pgStore.saveToPG(live); }
        else {
            const { changed } = repairDB(live);
            if (changed) pgStore.saveToPG(live);
        }
        warnStorageIfEphemeral();
        return "postgres";
    }
    warnStorageIfEphemeral();
    return "file";
}

// Block until every queued DB write reached Postgres (graceful shutdown)
async function syncDB() {
    if (!PG_ENABLED) return true;
    return pgStore.syncPG();
}

// Which backend is effectively serving reads/writes right now?
function dbBackend() {
    return (PG_ENABLED && pgStore.ready) ? "postgres" : "file";
}

// One-stop storage-health summary (used by boot guard + /api endpoints).
// Railway's filesystem is ephemeral: data only survives redeploys when at
// least ONE durable layer is configured:
//   * Railway Volume (RAILWAY_VOLUME_MOUNT_PATH) — covers the file backend
//     AND the session folders; or
//   * PostgreSQL (DATABASE_URL) — the whole app state lives in Postgres:
//     DB document (users/tiers/vouchers/history/sessionMeta…), WhatsApp
//     node auth (wa:<id> rows), force-join channels + limits (dynamic),
//     job state, proxies.txt mirror — no files needed at all.
function storageInfo() {
    const volumeMounted = !!String(process.env.RAILWAY_VOLUME_MOUNT_PATH || "").trim();
    const pgConnected = pgStore.enabled && pgStore.ready;
    const dataRoot = config.DATA_ROOT;
    return {
        backend: dbBackend(),          // "postgres" | "file"
        dataRoot,
        volumeMounted,                 // Railway volume env detected
        pgConnected,                   // Postgres connected at boot
        dataRootDurable: volumeMounted || !config.isRailway,
        durable: volumeMounted || pgConnected || !config.isRailway,
    };
}

// ── Durability guard (run after every PG init attempt) ─────────
// Shout clearly (logs + public status API) when a Railway deploy has no
// persistent layer configured, so an operator notices BEFORE the next
// redeploy silently wipes users/sessions/force-join/vouchers again.
function warnStorageIfEphemeral() {
    if (!config.isRailway) return;
    const sInfo = storageInfo();
    if (sInfo.durable) {
        console.log(`💾 [DB] Persistent storage OK — Postgres${sInfo.volumeMounted ? " + Volume" : ""}.`);
        return;
    }
    const bar = "=".repeat(70);
    console.warn(`\n${bar}`);
    console.warn("[STORAGE] DATA IS NOT PERSISTENT — EVERY REDEPLOY WIPES ALL DATA");
    console.warn(bar);
    console.warn(`Backend: ${sInfo.backend} | Data root: ${sInfo.dataRoot} | Volume: not detected | Postgres: not connected`);
    console.warn("");
    console.warn("Railway's filesystem is ephemeral. Restarts/redeploys currently destroy:");
    console.warn("users + PRO/VIP tiers, vouchers, history, WhatsApp node sessions,");
    console.warn("force-join channels, job state, proxy file and backups — web AND bot.");
    console.warn("");
    console.warn("FIX — do one of these:");
    console.warn("  A) Attach Railway PostgreSQL to this project (recommended): Railway");
    console.warn("     auto-injects DATABASE_URL. The app then stores EVERYTHING in");
    console.warn("     Postgres — users, sessions, force-join, jobs — no volume needed.");
    console.warn("  B) Attach a Volume to this service and mount it at: " + sInfo.dataRoot);
    console.warn("     Railway → your service → Volumes → New Volume → Mount path = " + sInfo.dataRoot);
    console.warn("");
    console.warn("Verify after deploying: GET /api/public-status → \"storage\" shows");
    console.warn('"durable": true.');
    console.warn(bar + "\n");
}

// Restore a full DB document (admin backup-restore). Works on both backends.
function restoreDatabase(obj) {
    const db = (obj && typeof obj === "object") ? obj : defaultDB();
    if (PG_ENABLED && pgStore.ready) { pgStore.saveToPG(db); return "postgres"; }
    fs.writeFileSync(DB_PATH, JSON.stringify(db, null, 2), "utf-8");
    return "file";
}

// ── User Management ─────────────────────────────────────────
function registerUser(from) {
    const db = getDB(); const uid = Number(from.id);
    if (!db.users[uid]) {
        db.users[uid] = { 
            id: uid, 
            username: from.username || "NoUser", 
            name: from.first_name || "Unknown", 
            count: 0, 
            banned: false, 
            web_pass: "", 
            apiKey: null, 
            webhookUrl: null, // NEW: Webhook logic
            lang: "en",
            proExpiry: null, 
            vipExpiry: null,
            joinedAt: new Date().toISOString(),
            lastSeen: new Date().toISOString()
        };
        saveDB(db);
    } else {
        db.users[uid].lastSeen = new Date().toISOString();
        if (from.first_name) db.users[uid].name = from.first_name;
        if (from.username) db.users[uid].username = from.username;
        saveDBDebounced(db);
    }
    return db;
}

// ── Support Desk Session (opt-in, persisted per user) ───────
// Records whether the user has an *open* support chat so that a
// redeploy/restart between tapping 💬 Support and typing a message
// never drops the user back to the generic handler.
function openSupport(uid) {
    const db = getDB(); uid = Number(uid);
    if (!db.users[uid]) db.users[uid] = { id: uid, username: "User", name: "User", count: 0, banned: false, lang: "en", joinedAt: new Date().toISOString() };
    db.users[uid].supportOpen = true;
    _cancelPendingSave(); // drop any older snapshot that could overwrite this
    saveDB(db); // sync — getDB() re-reads the store, so flush immediately
    return true;
}
function _cancelPendingSave() {
    if (_saveTimer) { clearTimeout(_saveTimer); _saveTimer = null; }
    _pendingDB = null;
}
function isSupportOpen(uid) {
    const u = getDB().users[Number(uid)];
    return !!(u && u.supportOpen);
}
function closeSupport(uid) {
    const db = getDB(); uid = Number(uid);
    if (db.users[uid] && db.users[uid].supportOpen) {
        delete db.users[uid].supportOpen;
        _cancelPendingSave(); // drop any older snapshot that could overwrite this
        saveDB(db); // sync flush
    }
    return true;
}

// ── Free Trial (one-time, per user) ─────────────────────────
// Marks that the user has already consumed their single 1-day trial so
// the cheap trial offer disappears from the Upgrade shop afterwards.
function markTrialUsed(uid) {
    const db = getDB(); uid = Number(uid);
    if (!db.users[uid]) db.users[uid] = { id: uid, username: "User", name: "User", count: 0, banned: false, lang: "en", joinedAt: new Date().toISOString() };
    db.users[uid].trialUsed = true;
    db.users[uid].trialUsedAt = new Date().toISOString();
    _cancelPendingSave();
    saveDB(db); // sync flush so the offer disappears immediately
    return true;
}
function hasUsedTrial(uid) {
    const u = getDB().users[Number(uid)];
    return !!(u && u.trialUsed);
}

// ── Webhook Management ──────────────────────────────────────
function setWebhook(uid, url) {
    const db = getDB(); uid = Number(uid);
    if (db.users[uid]) { db.users[uid].webhookUrl = url; saveDB(db); return true; }
    return false;
}

// ── Voucher System (Promo Codes) ────────────────────────────
// Type: 'PRO' or 'VIP'
function createVoucher(type, days, count = 1, opts = {}) {
    const db = getDB(); 
    const code = opts.code || ("BLAZE" + type + "-" + crypto.randomBytes(4).toString("hex").toUpperCase());
    db.vouchers[code] = { type, days, uses: count, usedBy: [], disabled: false, createdAt: new Date().toISOString(), expiresAt: opts.expiresAt || null }; 
    saveDB(db); 
    return code;
}

function redeemVoucher(uid, code) {
    const db = getDB(); uid = Number(uid);
    if (!db.vouchers[code] || db.vouchers[code].uses <= 0 || db.vouchers[code].usedBy.includes(uid)) return null;
    const v = db.vouchers[code];
    if (v.disabled || (v.expiresAt && Date.now() > Number(v.expiresAt))) return null;
    
    v.uses--; 
    v.usedBy.push(uid); 
    saveDB(db);
    
    if (v.type === 'VIP') addVIP(uid, v.days);
    else addSubscriber(uid, v.days);
    
    return { type: v.type, days: v.days };
}

// ── Analytics ───────────────────────────────────────────────
function updateDailyStats(t, r, u) {
    const db = getDB(); const d = new Date().toISOString().split("T")[0];
    if (!db.dailyStats[d]) db.dailyStats[d] = { total: 0, reg: 0, unreg: 0 };
    db.dailyStats[d].total += t; db.dailyStats[d].reg += r; db.dailyStats[d].unreg += u;
    saveDB(db);
}

function appendHistory(uid, res) {
    const db = getDB();
    if (!db.history[uid]) db.history[uid] = [];
    db.history[uid].unshift({ 
        date: new Date().toLocaleString("en-IN", { timeZone: "Asia/Kolkata" }), 
        total: res.total, reg: res.reg, unreg: res.unreg, failed: res.failed || 0, isBiz: res.bizCount || 0 
    });
    if (db.history[uid].length > config.MAX_HISTORY) db.history[uid] = db.history[uid].slice(0, config.MAX_HISTORY);

    // Update daily stats on the same DB object to avoid overwriting by stale saves.
    const d = new Date().toISOString().split("T")[0];
    if (!db.dailyStats[d]) db.dailyStats[d] = { total: 0, reg: 0, unreg: 0 };
    db.dailyStats[d].total += res.total;
    db.dailyStats[d].reg += res.reg;
    db.dailyStats[d].unreg += res.unreg;
    saveDB(db);
}

// ── Permissions & Roles ─────────────────────────────────────
const isAdmin = (uid) => getDB().admins.includes(Number(uid));
const isFreeMode = () => String(config.dynamic.SYSTEM_MODE || "subscription").toLowerCase() === "free";
// Admin/Owner keep full access rights. Free Mode makes every user eligible.
const isVIP = (uid) => { const db = getDB(); return db.vips.includes(Number(uid)) || db.admins.includes(Number(uid)); };
const isSub = (uid) => {
    if (isFreeMode()) return true;
    const db = getDB();
    return db.subscribers.includes(Number(uid)) || isVIP(uid);
};
const isBanned = (uid) => getDB().users[Number(uid)]?.banned === true;
const isOwner = (uid) => Number(uid) === config.OWNER_ID;

// ── Role Management ─────────────────────────────────────────
function addAdmin(uid) { const db = getDB(); uid = Number(uid); if (!db.admins.includes(uid)) { db.admins.push(uid); saveDB(db); } }
function removeAdmin(uid) { const db = getDB(); uid = Number(uid); if (uid !== config.OWNER_ID) { db.admins = db.admins.filter(i => i !== uid); saveDB(db); } }

// NOTE: grants STACK on any remaining time (matching extendPlanStack and the
// shop's "renewals stack" promise). These used to do an absolute
// `Date.now() + days`, so redeeming a voucher or running /addpro on a user who
// still had time left could silently SHORTEN their paid plan.
function addSubscriber(uid, days = 30) {
    const db = getDB(); uid = Number(uid); if (!db.users[uid]) return false;
    const now = Date.now();
    const cur = Number(db.users[uid].proExpiry) || 0;
    const base = cur > now ? cur : now;
    db.users[uid].proExpiry = base + Number(days) * 86400000;
    if (!db.subscribers.includes(uid)) db.subscribers.push(uid);
    saveDB(db); return true;
}

// Subtract time from a plan (used by refunds). Only drops the tier once the
// remaining time actually runs out — refunding ONE of several stacked
// purchases must not erase the rest of the user's paid access.
function revokePlanDays(uid, tier, days) {
    const db = getDB(); uid = Number(uid);
    if (!db.users[uid]) return null;
    const now = Date.now();
    const isVip = String(tier).toUpperCase() === "VIP";
    const field = isVip ? "vipExpiry" : "proExpiry";
    const cur = Number(db.users[uid][field]) || 0;
    const next = cur - Number(days) * 86400000;
    if (next > now) {
        db.users[uid][field] = next;
    } else {
        db.users[uid][field] = null;
        if (isVip) db.vips = db.vips.filter(i => i !== uid);
        else db.subscribers = db.subscribers.filter(i => i !== uid);
    }
    saveDB(db);
    return db.users[uid][field];
}
function removeSubscriber(uid) {
    const db = getDB(); uid = Number(uid);
    db.subscribers = db.subscribers.filter(i => i !== uid);
    if(db.users[uid]) db.users[uid].proExpiry = null; saveDB(db);
}

// NEW: VIP Management  (stacks on remaining time — see addSubscriber note)
function addVIP(uid, days = 30) {
    const db = getDB(); uid = Number(uid); if (!db.users[uid]) return false;
    const now = Date.now();
    const cur = Number(db.users[uid].vipExpiry) || 0;
    const base = cur > now ? cur : now;
    db.users[uid].vipExpiry = base + Number(days) * 86400000;
    if (!db.vips.includes(uid)) db.vips.push(uid);
    saveDB(db); return true;
}
function removeVIP(uid) {
    const db = getDB(); uid = Number(uid);
    db.vips = db.vips.filter(i => i !== uid);
    if(db.users[uid]) db.users[uid].vipExpiry = null; saveDB(db);
}

// Ensure a numeric uid exists in db.users (minimal record). Returns the user
// row AND persists, so it is safe to use standalone (single getDB under the hood).
// For multi-field mutations prefer extendPlanStack (self-contained on one db).
function ensureUserRow(uid) {
    const db = getDB(); uid = Number(uid);
    if (!db.users[uid]) {
        db.users[uid] = {
            id: uid, username: "NoUser", name: "User", count: 0, banned: false,
            web_pass: "", apiKey: null, webhookUrl: null, lang: "en",
            proExpiry: null, vipExpiry: null,
            joinedAt: new Date().toISOString(), lastSeen: new Date().toISOString()
        };
        saveDB(db);
    }
    return db.users[uid];
}

// ⭐ Stars plan activation with STACKING: if the user already has an active
// expiry on the same tier, the purchased days are added on top of it instead of
// resetting the clock. tier = "PRO" | "VIP". Returns the new expiry timestamp.
// Self-contained on ONE db snapshot so all mutations land in the same save.
function extendPlanStack(uid, tier, days) {
    const db = getDB(); uid = Number(uid);
    if (!db.users[uid]) {
        db.users[uid] = {
            id: uid, username: "NoUser", name: "User", count: 0, banned: false,
            web_pass: "", apiKey: null, webhookUrl: null, lang: "en",
            proExpiry: null, vipExpiry: null,
            joinedAt: new Date().toISOString(), lastSeen: new Date().toISOString()
        };
    }
    const u = db.users[uid];
    const ms = Number(days) * 86400000;
    const now = Date.now();
    let expiry;
    if (String(tier).toUpperCase() === "VIP") {
        const base = (u.vipExpiry && Number(u.vipExpiry) > now) ? Number(u.vipExpiry) : now;
        expiry = base + ms;
        u.vipExpiry = expiry;
        if (!db.vips.includes(uid)) db.vips.push(uid);
    } else {
        const base = (u.proExpiry && Number(u.proExpiry) > now) ? Number(u.proExpiry) : now;
        expiry = base + ms;
        u.proExpiry = expiry;
        if (!db.subscribers.includes(uid)) db.subscribers.push(uid);
    }
    saveDB(db);
    return expiry;
}

// ⭐ Telegram Stars payment ledger (chargeId keyed — needed for refunds).
function logStarsPayment(rec) {
    const db = getDB(); if (!db.starsPayments) db.starsPayments = {};
    const cid = rec && rec.chargeId;
    if (!cid) return null;
    db.starsPayments[cid] = { ...rec, chargeId: cid, at: rec.at || new Date().toISOString() };
    saveDB(db);
    return db.starsPayments[cid];
}
function getStarsPayment(chargeId) {
    const db = getDB(); return (db.starsPayments || {})[chargeId] || null;
}
function listStarsPayments() {
    const db = getDB();
    return Object.values(db.starsPayments || {})
        .sort((a, b) => String(b.at || "").localeCompare(String(a.at || "")));
}
// Most-recent-first payments for one buyer (used by /refundstars <user_id>).
function listStarsPaymentsByUid(uid) {
    uid = Number(uid);
    return listStarsPayments().filter(r => Number(r.uid) === uid);
}
function removeStarsPayment(chargeId) {
    const db = getDB(); if (db.starsPayments && db.starsPayments[chargeId]) {
        delete db.starsPayments[chargeId]; saveDB(db); return true;
    }
    return false;
}

function banUser(uid) { const db = getDB(); uid = Number(uid); if (db.users[uid]) db.users[uid].banned = true; if (!db.banned.includes(uid)) db.banned.push(uid); saveDB(db); }
function unbanUser(uid) { const db = getDB(); uid = Number(uid); if (db.users[uid]) db.users[uid].banned = false; db.banned = db.banned.filter(i => i !== uid); saveDB(db); }

function saveSessionMeta(sid, o, t, extra = {}) {
    const db = getDB();
    const previous = db.sessionMeta[sid] || {};
    db.sessionMeta[sid] = { ...previous, owner: o, type: t, connectedAt: new Date().toISOString(), ...extra };
    saveDB(db);
}
function deleteSessionMeta(sid) { const db = getDB(); delete db.sessionMeta[sid]; saveDB(db); }

function generateApiKey(uid, expiresInDays = null) {
    const db = getDB(); uid = Number(uid); if (!db.users[uid]) return null;
    const key = "B3AST-" + crypto.randomBytes(24).toString("base64url").toUpperCase();
    db.users[uid].apiKey = key;
    db.users[uid].apiKeyCreatedAt = new Date().toISOString();
    db.users[uid].apiKeyExpiry = expiresInDays ? Date.now() + Number(expiresInDays) * 86400000 : null;
    saveDB(db); return key;
}
function getUidByApiKey(k) {
    const db = getDB();
    for (let id of Object.keys(db.users)) {
        const u = db.users[id];
        if (u.apiKey === k) {
            if (u.apiKeyExpiry && Date.now() > Number(u.apiKeyExpiry)) return null;
            return Number(id);
        }
        if (Array.isArray(u.apiKeys)) {
            const extra = u.apiKeys.find(x => x.key === k && x.active !== false && (!x.expiresAt || Date.now() <= Number(x.expiresAt)));
            if (extra) return Number(id);
        }
    }
    return null;
}
function hashWebPass(pass) {
    const salt = crypto.randomBytes(16).toString("hex");
    const hash = crypto.createHash("sha256").update(`${salt}:${pass}`).digest("hex");
    return `sha256$${salt}$${hash}`;
}

function verifyWebPass(stored, input) {
    if (!stored || !input) return false;
    const pass = String(input).trim().toUpperCase();
    // Backward compatibility for legacy plaintext web_pass values.
    if (!String(stored).startsWith("sha256$")) return stored === pass;
    const [, salt, hash] = String(stored).split("$");
    if (!salt || !hash) return false;
    const candidate = crypto.createHash("sha256").update(`${salt}:${pass}`).digest("hex");
    try { return crypto.timingSafeEqual(Buffer.from(hash, "hex"), Buffer.from(candidate, "hex")); }
    catch (_) { return false; }
}

function generateWebPass(uid) {
    const db = getDB(); uid = Number(uid);
    const pass = crypto.randomBytes(4).toString("hex").toUpperCase();
    if (db.users[uid]) { db.users[uid].web_pass = hashWebPass(pass); saveDB(db); }
    return pass;
}

function setUserLang(uid, lang = "en") {
    const db = getDB(); uid = Number(uid);
    if (!db.users[uid]) return false;
    db.users[uid].lang = lang;
    saveDB(db);
    return true;
}
function getUserLang(uid) {
    const db = getDB();
    return db.users[Number(uid)]?.lang || "en";
}

function setMaintenance(s) { const db = getDB(); db.meta.maintenance = s; saveDB(db); }


function getStats() {
    const db = getDB();
    return {
        totalUsers: Object.keys(db.users).length,
        totalAdmins: db.admins.length,
        totalPro: db.subscribers.length,
        totalVIP: db.vips.length, // Added VIP stat
        totalBanned: Object.values(db.users).filter(u => u.banned).length,
        sessions: Object.keys(db.sessionMeta).length,
        graph: db.dailyStats
    };
}

module.exports = {
    getDB, saveDB, saveDBDebounced, registerUser, appendHistory, 
    isAdmin, isSub, isVIP, isFreeMode, isBanned, isOwner, 
    addAdmin, removeAdmin, addSubscriber, removeSubscriber, addVIP, removeVIP, 
    banUser, unbanUser, createVoucher, redeemVoucher, 
    generateApiKey, getUidByApiKey, setWebhook, setUserLang, getUserLang,
    setMaintenance, saveSessionMeta, deleteSessionMeta, generateWebPass, verifyWebPass, getStats,
    ensureUserRow, extendPlanStack, revokePlanDays, openSupport, isSupportOpen, closeSupport,
    markTrialUsed, hasUsedTrial,
    logStarsPayment, getStarsPayment, listStarsPayments, listStarsPaymentsByUid, removeStarsPayment,
    initDB, syncDB, dbBackend, storageInfo, warnStorageIfEphemeral, restoreDatabase
};
