// ============================================================
//   WS CHECKER v6 | config.js
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
    BRAND_NAME: "WS CHECKER",
    BRAND_VER: "v6.0.0",
    WA_BROWSER: ["Ubuntu", "Chrome", "20.0.04"],

    // ── Telegram Auto-Setup (zero-touch, runs on boot) ───────
    // Everything below is applied automatically via the Bot API token:
    // bot name/description, command list, Mini App menu button. No manual
    // BotFather work (except the one-time domain whitelist which Telegram
    // does not expose via any API).
    AUTO_SETUP: env("AUTO_SETUP", "true") === "true",
    BOT_NAME: env("BOT_NAME", "WS CHECKER"),
    BOT_DESCRIPTION: env("BOT_DESCRIPTION", "WhatsApp number checker with Telegram Mini App dashboard — checking, sessions, lists, jobs, API & webhooks."),
    BOT_SHORT_DESC: env("BOT_SHORT_DESC", "⚡ Number checker with Mini App dashboard"),
    BOT_COMMANDS: (() => {
        try { const v = JSON.parse(env("BOT_COMMANDS", "")); if (Array.isArray(v) && v.length) return v; } catch (_) {}
        return [
            { command: "start", description: "Open main menu" },
            { command: "app", description: "🚀 Open the Web App (auto login)" },
            { command: "mystats", description: "My usage stats" },
            { command: "queue", description: "My queued jobs" },
            { command: "redeem", description: "Redeem a voucher code" },
            { command: "reset", description: "Clear my active jobs" },
            { command: "setwebhook", description: "Set webhook URL" },
            { command: "language", description: "Change language" },
            { command: "help", description: "Help & commands" },
        ];
    })(),

    // ── Telegram Mini App (WebApp menu button) ────────────────
    // DASHBOARD_URL must be HTTPS. Telegram requires the domain to be
    // allow-listed once via @BotFather → /mybots → Bot Settings → Domain
    // (no Bot API method exists for that step — it is per-bot, universal).
    MENU_BUTTON_TEXT: env("MENU_BUTTON_TEXT", "🚀 Open App"),
    MENU_BUTTON_URL: env("MENU_BUTTON_URL", ""), // falls back to DASHBOARD_URL

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
            // Mirror into Postgres (fire-and-forget) so force-join channels,
            // limits and modes survive Railway redeploys even without a volume.
            try {
                require("./pg_state").saveDynamic(updated);
            } catch (e) { /* pg_state unavailable — file copy already written */ }
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
