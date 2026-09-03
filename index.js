// ============================================================
//   ⚡ BLAZE NXT — V4.0 ULTRA BEAST | index.js
//   Main Entry Point — Indestructible Core & Memory Watchdog
// ============================================================

"use strict";

// Increase max listeners to prevent memory leak warnings on high load
require("events").EventEmitter.defaultMaxListeners = 100;

const fs          = require("fs");

const config      = require("./config");
const { initDB, syncDB } = require("./database");
const { loadSavedSessions } = require("./whatsapp");
const { startServer }       = require("./web_server");
const state                 = require("./state");

let bot = null; // created inside main() after the DB layer is ready

// ── 🚀 Boot Banner ────────────────────────────────────────────
console.log(`
██████╗ ██╗      █████╗ ███████╗███████╗    ███╗   ██╗██╗  ██╗████████╗
██╔══██╗██║     ██╔══██╗╚══███╔╝██╔════╝    ████╗  ██║╚██╗██╔╝╚══██╔══╝
██████╔╝██║     ███████║  ███╔╝ █████╗      ██╔██╗ ██║ ╚███╔╝    ██║   
██╔══██╗██║     ██╔══██║ ███╔╝  ██╔══╝      ██║╚██╗██║ ██╔██╗    ██║   
██████╔╝███████╗██║  ██║███████╗███████╗    ██║ ╚████║██╔╝ ██╗   ██║   
╚═════╝ ╚══════╝╚═╝  ╚═╝╚══════╝╚══════╝    ╚═╝  ╚═══╝╚═╝  ╚═╝   ╚═╝   
                                            
      🔥 V5.0 ULTRA BEAST MODE INITIALIZED 🔥
      Owner: @firstoget | Port: ${config.PORT}
`);

// ── 🛡️ PROCESS GUARDS (Anti-Crash Shields) ───────────────────
process.on("uncaughtException", (err) => {
    console.error("💥 [Process Shield] Blocked Fatal Exception:", err.message);
    // Don't exit — keep the engine running!
});

process.on("unhandledRejection", (reason) => {
    console.error("💥 [Process Shield] Blocked Unhandled Rejection:", reason);
});

// ── 🧠 RAM WATCHDOG (Auto-Cleanup) ────────────────────────────
setInterval(() => {
    const memUsage = process.memoryUsage().heapUsed / 1024 / 1024; // in MB
    if (memUsage > 500) { // If RAM crosses 500MB
        console.warn(`⚠️ [Watchdog] High RAM Usage detected: ${memUsage.toFixed(1)} MB. Initiating cleanup...`);
        state.processingUsers.clear(); // Clear stuck jobs
        // Force garbage collection if V8 exposes it
        if (global.gc) {
            try { global.gc(); console.log("🧹 [Watchdog] V8 Garbage Collection complete."); } catch (e) {}
        }
    }
}, 15 * 60 * 1000); // Check every 15 minutes

// ── 🚀 MAIN BOOT SEQUENCE ─────────────────────────────────────
async function main() {
    // 0. DB layer first: connect PostgreSQL when DATABASE_URL is set,
    //    otherwise fall back to file storage (users.json). The whole app
    //    (bot handlers + web API) starts only after this resolves.
    const backend = await initDB();
    console.log(`🗄️  [DB] Storage backend: ${backend}`);

    // ── 🤖 TELEGRAM BOT INITIALIZATION ────────────────────────
    bot = new (require("node-telegram-bot-api"))(config.TG_TOKEN, {
        polling: {
            interval: 300,
            autoStart: true,
            params: { timeout: 10 },
        },
        request: {
            agentOptions: { keepAlive: true },
        },
    });

    // Fetch & Store Bot Profile
    bot.getMe()
        .then(info => {
            state.BOT_INFO = info;
            console.log(`✅ [Telegram] Link Established: @${info.username} (${info.first_name})`);
        })
        .catch(err => {
            console.error("❌ [Telegram] Failed to fetch bot info:", err.message);
        });

    // Telegram Error Handling
    bot.on("polling_error", (err) => {
        if (err.code === "ETELEGRAM" && err.message?.includes("409")) {
            console.warn("⚠️ [Telegram] 409 Conflict — Another instance might be running!");
        } else {
            console.error("❌ [Telegram] Polling error:", err.message);
        }
    });
    bot.on("error", (err) => { console.error("❌ [Telegram] General error:", err.message); });

    // ── 🛜 TELEGRAM MINI APP MENU BUTTON ──────────────────────
    // Puts a permanent "Open App" button on the chat input bar that launches
    // the dashboard as a fullscreen Telegram Mini App (also enables the
    // https://t.me/<bot>/app deep link).
    const miniAppUrl = config.MENU_BUTTON_URL || config.DASHBOARD_URL;
    bot.setChatMenuButton({
        menu_button: { type: "web_app", text: config.MENU_BUTTON_TEXT, url: miniAppUrl },
    })
        .then(() => console.log(`✅ [Telegram] Mini App menu button set → ${miniAppUrl}`))
        .catch(err => {
            let hint = "";
            try { hint = ` (whitelist ${new URL(miniAppUrl).host} in @BotFather → Bot Settings → Domain)`; } catch (_) {}
            console.error(`❌ [Telegram] Mini App menu button failed${hint}:`, err.message);
        });

    // ── 🌐 START WEB SERVER ───────────────────────────────────
    startServer(bot);

    // ── 🔌 RESTORE WHATSAPP SESSIONS ──────────────────────────
    try {
        console.log("⏳ [WhatsApp] Restoring saved nodes...");
        await loadSavedSessions(bot);
    } catch (err) {
        console.error("❌ [WhatsApp] Node restore failed:", err.message);
    }

    // ── 🪝 ATTACH BOT HANDLERS ────────────────────────────────
    require("./bot_commands")(bot);
    require("./bot_callbacks")(bot);
    require("./bot_messages")(bot);

    // ── 🔄 LIVE PROGRESS HOOK (Sync Telegram Edits to Web) ────
    const _origEdit = bot.editMessageText.bind(bot);
    bot.editMessageText = async function (text, options) {
        if (typeof text === "string" && (text.includes("𝗟𝗜𝗩𝗘 𝗘𝗡𝗚𝗜𝗡𝗘") || text.includes("𝗚𝗢𝗗 𝗠𝗢𝗗𝗘"))) {
            const uid = options?.chat_id;
            const progMatch = text.match(/Progress:\s*(\d+)\/(\d+)/);
            if (progMatch && uid) {
                // Failsafe sync in case Web polling misses a beat
                state.updateWebState(uid, {
                    current: parseInt(progMatch[1]),
                    total: parseInt(progMatch[2]),
                    status: "Checking",
                });
            }
        }
        return _origEdit(text, options).catch(() => {}); // Catch 429 Too Many Requests silently
    };

    // ── 🛑 GRACEFUL SHUTDOWN SEQUENCE ─────────────────────────
    async function shutdown(signal) {
        console.log(`\n🛑 [${signal}] Initiating Ultra Beast Shutdown Sequence...`);

        // Failsafe: never block a restart/redeploy longer than 8s
        // (Telegram API may be unreachable while the process is being stopped).
        setTimeout(() => { console.log("⚡ [Shutdown] Failsafe — forcing exit."); process.exit(0); }, 8000).unref();

        try {
            // 1. Stop Telegram Polling
            await bot.stopPolling().catch(() => {});
            console.log("✅ [Shutdown] Telegram connection terminated.");

            // 2. Force a final database backup / flush
            const dbPath = config.dataPath(config.DB_FILE);
            if (fs.existsSync(dbPath)) {
                fs.copyFileSync(dbPath, dbPath + '.bak_shutdown');
                console.log("✅ [Shutdown] Final DB Backup created (.bak_shutdown).");
            }
            await syncDB();
            console.log("✅ [Shutdown] Database writes flushed.");

            // 3. Alert Owner
            await bot.sendMessage(config.OWNER_ID,
                `╭━━━[ 🛑 *𝗦𝗬𝗦𝗧𝗘𝗠 𝗢𝗙𝗙𝗟𝗜𝗡𝗘* ]━━━╮\n` +
                `┣ The Engine has been shut down.\n` +
                `┣ ⚙️ Signal: \`${signal}\`\n` +
                `┣ 💾 Database backed up successfully.\n` +
                `╰━━━━━━━━━━━━━━━━━━━━━━╯`,
                { parse_mode: "Markdown" }
            ).catch(() => {});

        } catch (err) {
            console.error("❌ [Shutdown] Error during shutdown:", err.message);
        }

        console.log("⚡ [Shutdown] Goodbye.");
        process.exit(0);
    }

    process.on("SIGINT",  () => shutdown("SIGINT"));
    process.on("SIGTERM", () => shutdown("SIGTERM"));

    console.log("✅ [Core] All modules online. Ultra Beast is ready to hunt!");
}

main().catch(err => {
    console.error("❌ [Core] Fatal boot error:", err);
    process.exit(1);
});
