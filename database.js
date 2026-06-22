// ============================================================
//   ⚡ BLAZE NXT — V4.0 GOD MODE | database.js
//   Advanced Database: VIP Tiers, Webhooks, Rotating Backups
// ============================================================

"use strict";

const fs   = require("fs");
const path = require("path");
const crypto = require("crypto");
const config = require("./config");

const DB_PATH = path.resolve(__dirname, config.DB_FILE);

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
        meta: { 
            version: 4, 
            maintenance: false, 
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString()
        },
    };
}

// Init if not exists
if (!fs.existsSync(DB_PATH)) {
    fs.writeFileSync(DB_PATH, JSON.stringify(defaultDB(), null, 2), "utf-8");
}

// ── Rotating Auto-Backup System ─────────────────────────────
// Har 6 ghante me backup banega. Purane 3 backups save rahenge.
setInterval(() => {
    try {
        if (fs.existsSync(DB_PATH + '.bak2')) fs.copyFileSync(DB_PATH + '.bak2', DB_PATH + '.bak3');
        if (fs.existsSync(DB_PATH + '.bak1')) fs.copyFileSync(DB_PATH + '.bak1', DB_PATH + '.bak2');
        fs.copyFileSync(DB_PATH, DB_PATH + '.bak1');
        console.log("💾 [DB] Rotating Auto-Backup Completed.");
    } catch(e) { console.error("❌ [DB] Backup Failed:", e.message); }
}, 6 * 60 * 60 * 1000);

// ── Core Read/Write ─────────────────────────────────────────
let _saveTimer = null, _pendingDB = null;

function getDB() {
    try {
        const raw = fs.readFileSync(DB_PATH, "utf-8");
        const db = JSON.parse(raw);
        
        // Schema migrations / repair for old or partial DB files
        if (!db.admins) db.admins = [config.OWNER_ID];
        if (!db.subscribers) db.subscribers = [];
        if (!db.vips) db.vips = [];
        if (!db.users) db.users = {};
        if (!db.sessionMeta) db.sessionMeta = {};
        if (!db.history) db.history = {};
        if (!db.banned) db.banned = [];
        if (!db.vouchers) db.vouchers = {};
        if (!db.dailyStats) db.dailyStats = {};
        if (!db.meta) db.meta = {};
        if (db.meta.maintenance === undefined) db.meta.maintenance = false;
        if (!db.meta.version) db.meta.version = 5;
        
        const now = Date.now();
        
        // Auto-Expire PRO Users
        db.subscribers = db.subscribers.filter(uid => {
            const u = db.users[uid];
            return !(u && u.proExpiry && u.proExpiry < now);
        });

        // Auto-Expire VIP Users
        db.vips = db.vips.filter(uid => {
            const u = db.users[uid];
            return !(u && u.vipExpiry && u.vipExpiry < now);
        });

        return db;
    } catch (err) {
        console.error("⚠️ Database read error, loading default.", err.message);
        return defaultDB(); 
    }
}

function saveDB(db) {
    try {
        db.meta.updatedAt = new Date().toISOString();
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

function addSubscriber(uid, days = 30) {
    const db = getDB(); uid = Number(uid); if (!db.users[uid]) return false;
    db.users[uid].proExpiry = Date.now() + (days * 86400000);
    if (!db.subscribers.includes(uid)) db.subscribers.push(uid);
    saveDB(db); return true;
}
function removeSubscriber(uid) {
    const db = getDB(); uid = Number(uid);
    db.subscribers = db.subscribers.filter(i => i !== uid);
    if(db.users[uid]) db.users[uid].proExpiry = null; saveDB(db);
}

// NEW: VIP Management
function addVIP(uid, days = 30) {
    const db = getDB(); uid = Number(uid); if (!db.users[uid]) return false;
    db.users[uid].vipExpiry = Date.now() + (days * 86400000);
    if (!db.vips.includes(uid)) db.vips.push(uid);
    saveDB(db); return true;
}
function removeVIP(uid) {
    const db = getDB(); uid = Number(uid);
    db.vips = db.vips.filter(i => i !== uid);
    if(db.users[uid]) db.users[uid].vipExpiry = null; saveDB(db);
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
    setMaintenance, saveSessionMeta, deleteSessionMeta, generateWebPass, verifyWebPass, getStats
};
