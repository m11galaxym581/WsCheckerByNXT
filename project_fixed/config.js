// ============================================================
//   ⚡ BLAZE NXT — V4.0 GOD MODE | config.js
//   Advanced Dynamic Config Manager (Auto-Reloading)
// ============================================================

"use strict";

const fs = require("fs");
const path = require("path");

const ENV_PATH = path.join(__dirname, ".env");
const DYN_CONFIG_PATH = path.join(__dirname, "dynamic_config.json");

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
    ENABLE_PROXY: false,       // NEW: Route WA traffic via proxies
    AUTO_RESPONDER: true,      // NEW: Bot replies if someone messages the node
    AUTO_RESPONDER_MSG: "Automated Node: I cannot read your messages.",
    ENABLE_WEBHOOKS: true      // NEW: Allow POSTing results to external servers
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
    DASHBOARD_URL: env("DASHBOARD_URL", `http://localhost:${env("PORT", "9812")}`),
    OWNER_ID: Number(env("OWNER_ID", "8708907310")),
    PORT: Number(env("PORT", "9812")),
    MAX_HISTORY: 50, // Increased history storage
    DB_FILE: "users.json",
    BRAND_NAME: "⚡ BLAZE NXT",
    BRAND_VER: "v5.01.49",
    WA_BROWSER: ["Ubuntu", "Chrome", "20.0.04"],

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
    process.exit(1);
}

console.log(`✅ [Config] Loaded — ${config.BRAND_NAME} ${config.BRAND_VER}`);

module.exports = config;
