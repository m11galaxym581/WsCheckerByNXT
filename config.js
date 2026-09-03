// ============================================================
//   ⚡ BLAZE NXT — V4.0 GOD MODE | config.js
//   Advanced Dynamic Config Manager (Auto-Reloading)
// ============================================================

"use strict";

const fs = require("fs");
const path = require("path");

const ENV_PATH = path.join(__dirname, ".env");

// ── Railway / Cloud Detection ────────────────────────────────
// Railway (railway.app) auto-injects RAILWAY_* variables. When we detect them we
// automatically switch to cloud-friendly defaults (persistent data dir + public URL).
const RAILWAY_VARS = [
    "RAILWAY_PUBLIC_DOMAIN", "RAILWAY_PRIVATE_DOMAIN", "RAILWAY_SERVICE_NAME",
    "RAILWAY_SERVICE_ID", "RAILWAY_PROJECT_NAME", "RAILWAY_DEPLOYMENT_ID",
    "RAILWAY_ENVIRONMENT", "RAILWAY_ENVIRONMENT_NAME", "RAILWAY_VOLUME_MOUNT_PATH",
];
const isRailway = RAILWAY_VARS.some(k => process.env[k]);

// ── Persistent Data Root ─────────────────────────────────────
// Railway filesystem is ephemeral: every redeploy wipes files written next to the
// code. All persistent state (users.json, WhatsApp sessions, job_state, backups,
// dynamic_config.json) is therefore rooted at DATA_ROOT:
//   1. DATA_DIR env var          -> explicit override (any host)
//   2. RAILWAY_VOLUME_MOUNT_PATH -> Railway volume mount (auto when a volume is attached)
//   3. "/data" on Railway        -> default Railway volume mount point (created if absent)
//   4. project folder            -> legacy local-dev behaviour (unchanged)
function resolveDataRoot() {
    const explicit = String(process.env.DATA_DIR || "").trim();
    if (explicit) return path.resolve(explicit);
    if (process.env.RAILWAY_VOLUME_MOUNT_PATH) return process.env.RAILWAY_VOLUME_MOUNT_PATH;
    if (isRailway) return "/data";
    return __dirname;
}

let DATA_ROOT = resolveDataRoot();
try {
    fs.mkdirSync(DATA_ROOT, { recursive: true });
} catch (err) {
    // Read-only root (unexpected) — fall back to the project folder.
    DATA_ROOT = __dirname;
    console.warn(`⚠️ [Config] Could not use data dir "${resolveDataRoot()}", falling back to project folder. (${err.message})`);
}

const dataPath = (rel) => path.isAbsolute(rel) ? rel : path.join(DATA_ROOT, rel);

const DYN_CONFIG_PATH = dataPath("dynamic_config.json");

// ── Read Static .env Fallbacks ──────────────────────────────
function readEnvFile() {
    if (!fs.existsSync(ENV_PATH)) return {};
    return fs.readFileSync(ENV_PATH, "utf-8").split("\n").reduce((acc, line) => {
        const t = line.trim();
        if (t && !t.startsWith("#") && t.includes("=")) {
            const [k, ...v] = t.split("=");
            acc[k.trim()] = v.join("=").trim().replace(/^["']|["']$/g, "");
        }
        return acc;
    }, {});
}

const ENV = readEnvFile();
const env = (key, fallback) => process.env[key] || ENV[key] || fallback;

// ── Default Dynamic Settings ────────────────────────────────
const defaultDynamicConfig = {
    MAX_PARALLEL: 5,           // Max simultaneous jobs across server
    FREE_LIMIT: 20,            // Limit for free users
    PRO_LIMIT: 5000,           // Limit for PRO users
    VIP_LIMIT: 10000,          // NEW: Limit for VIP users
    SYSTEM_MODE: "subscription", // "free" = everyone can use full system, "subscription" = enforce tiers
    RECONNECT_DELAY: 5000,     // Delay before reconnecting dead node
    PROGRESS_UPDATE_EVERY: 5,  // Telegram edit message frequency
    ENABLE_PROXY: false,       // Route WA traffic via proxies
    PROXY_MODE: "pool",        // "pool" = use proxies.txt, "single" = use PROXY_URL
    PROXY_FILE: "proxies.txt", // one proxy per line
    PROXY_STICKY: true,        // keep same proxy assigned to session
    AUTO_RESPONDER: true,      // NEW: Bot replies if someone messages the node
    AUTO_RESPONDER_MSG: "Automated Node: I cannot read your messages.",
    ENABLE_WEBHOOKS: true,     // Allow POSTing results to external servers
    FORCE_JOIN_ENABLED: false,
    FORCE_JOIN_CHANNELS: []    // [{ title:"Channel", chatId:"@channel", url:"https://t.me/channel" }]
};

// ── Auto-Create Dynamic Config File ─────────────────────────
if (!fs.existsSync(DYN_CONFIG_PATH)) {
    fs.writeFileSync(DYN_CONFIG_PATH, JSON.stringify(defaultDynamicConfig, null, 2), "utf-8");
}

// ── Core Config Object ──────────────────────────────────────
const config = {
    // Hardcoded System Constants (Requires Restart to change)
    TG_TOKEN: env("TG_TOKEN", ""),
    WEB_SECRET: env("WEB_SECRET", env("TG_TOKEN", "change-me-web-secret")),
    DASHBOARD_URL: env("DASHBOARD_URL", process.env.RAILWAY_PUBLIC_DOMAIN ? `https://${process.env.RAILWAY_PUBLIC_DOMAIN}` : `http://localhost:${env("PORT", "9812")}`),
    OWNER_ID: Number(env("OWNER_ID", "8708907310")),
    PORT: (() => { const p = Number(env("PORT", "9812")); return Number.isFinite(p) && p > 0 ? p : 9812; })(),
    MAX_HISTORY: 50, // Increased history storage
    DB_FILE: env("DB_FILE", "users.json"),
    BRAND_NAME: "⚡ BLAZE NXT",
    BRAND_VER: "v5.01.49",
    WA_BROWSER: ["Ubuntu", "Chrome", "20.0.04"],

    // ── Platform / Storage Helpers ────────────────────────────
    DATA_ROOT,          // where all persistent state lives
    dataPath,           // resolve a filename inside DATA_ROOT
    isRailway,          // true when running on Railway

    // Dynamic Getters (Fetches live from JSON without restart)
    get dynamic() {
        try {
            const data = fs.readFileSync(DYN_CONFIG_PATH, "utf-8");
            return { ...defaultDynamicConfig, ...JSON.parse(data) };
        } catch (e) {
            return defaultDynamicConfig;
        }
    },

    // Dynamic Setters (For Web Admin Panel to save live settings)
    setDynamicConfig(newSettings) {
        try {
            const current = this.dynamic;
            const updated = { ...current, ...newSettings };
            fs.writeFileSync(DYN_CONFIG_PATH, JSON.stringify(updated, null, 2), "utf-8");
            return true;
        } catch (e) {
            return false;
        }
    }
};

// Validation at boot
if (!config.TG_TOKEN || config.TG_TOKEN.length < 20) {
    console.error("❌ [Config] Telegram Token Missing!");
    console.error("   Set TG_TOKEN in your environment (Railway → Variables, or a local .env file).");
    console.error("   Get a token from @BotFather and your numeric ID from @userinfobot.");
    process.exit(1);
}

console.log(`✅ [Config] Loaded — ${config.BRAND_NAME} ${config.BRAND_VER}`);
console.log(`💾 [Config] Data directory: ${DATA_ROOT}`);
if (isRailway) console.log(`🚂 [Config] Railway detected — persistent storage: ${DATA_ROOT} (attach a volume to keep it)`);

module.exports = config;
