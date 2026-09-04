// ============================================================
//   WS CHECKER v6 | auto_setup.js
//   Zero-touch Telegram setup engine (server-side)
// ------------------------------------------------------------
// On boot (or on demand via /autosetup or POST /api/admin/auto-setup)
// the server configures the bot entirely through the Bot API token:
//
//   ✅ getMe                        → bot username + profile
//   ✅ setMyName / setMyDescription / setMyShortDescription
//   ✅ setMyCommands                → slash-command list (auto)
//   ✅ setChatMenuButton            → Mini App "Open App" button
//   ✅ Owner report                 → private message with the app link
//
// The ONLY thing Telegram does not expose via any API is the per-bot
// Web App domain allow-list (@BotFather → Bot Settings → Domain). If the
// menu-button call fails with a whitelist error, the summary says exactly
// which domain to add — everything else is already done automatically.
// ============================================================

"use strict";

const config = require("./config");
const state = require("./state");
const { getDB } = require("./database");

// Track the most recent run for /api/setup-status + admin UI.
state.autoSetup = state.autoSetup || { ran: false, at: null, results: {}, summary: "" };

function appUrl() { return config.MENU_BUTTON_URL || config.DASHBOARD_URL; }

function appLink() {
    return state.BOT_INFO?.username ? `https://t.me/${state.BOT_INFO.username}/app` : appUrl();
}

// Friendly one-line summary of a single step result.
function stepLabel(name, r) {
    return r.ok ? `✅ ${name}` : `❌ ${name} — ${(r.error || "failed").toString().slice(0, 220)}`;
}

async function attempt(label, fn) {
    try {
        const res = await fn();
        return { ok: true, res };
    } catch (e) {
        return { ok: false, error: e.description || e.message || String(e), raw: e };
    }
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// ── Background self-heal ──────────────────────────────────────
// The menu button can only be stored once the bot's domain is allow-listed
// in @BotFather (no API can do that step). When a run finishes with the
// button NOT active, keep retrying quietly in the background — the moment
// the owner adds the domain, the button is applied automatically (no manual
// /autosetup, no redeploy). Stops as soon as it succeeds.
let _healTimer = null;
let _healTries = 0;
const HEAL_INTERVAL_MS = 5 * 60 * 1000; // retry every 5 minutes
const HEAL_MAX_TRIES = 72;               // …for up to 6 hours, then wait for next boot

function stopHeal() {
    if (_healTimer) { clearInterval(_healTimer); _healTimer = null; }
    _healTries = 0;
}

async function healTick(bot) {
    const st = state.autoSetup;
    if (!bot || !st || st.menuButtonActive) { stopHeal(); return; }
    if (_healTries >= HEAL_MAX_TRIES) {
        console.warn("⚠️ [AutoSetup] Self-heal gave up for now — whitelist the domain in @BotFather, then send /autosetup (or redeploy).");
        stopHeal();
        return;
    }
    _healTries++;
    const url = appUrl();
    try {
        const menuButtonJson = JSON.stringify({ type: "web_app", text: config.MENU_BUTTON_TEXT, url });
        await bot.setChatMenuButton({ menu_button: menuButtonJson });
        // Telegram applies menu-button changes asynchronously — poll read-back.
        let stored = null;
        for (let i = 0; i < 4; i++) {
            const rb = await bot.getChatMenuButton().catch(() => null);
            stored = rb?.menu_button || rb || null;
            if (stored?.type === "web_app") break;
            if (i < 3) await sleep(1500);
        }
        if (stored?.type === "web_app") {
            stopHeal();
            st.menuButtonActive = true;
            st.whitelistPending = false;
            st.webAppReady = true;
            st.at = new Date().toISOString();
            st.summary = "✅ Auto-setup complete — Mini App menu button active (applied automatically after the domain was allow-listed).";
            console.log(`✅ [AutoSetup] Self-heal: Mini App menu button now active → ${url}`);
            try {
                await bot.sendMessage(config.OWNER_ID,
                    "🟢 *Menu button is now active!*\n\nTap it (or send /app) to open the Mini App — it launches instantly inside Telegram.",
                    { parse_mode: "Markdown" }).catch(() => {});
            } catch (_) {}
        }
    } catch (e) {
        const err = String(e.description || e.message || e);
        if (!/whitelist|BUTTON_URL_INVALID|WEBAPP_URL|allowed domain/i.test(err)) {
            console.warn(`⚠️ [AutoSetup] Self-heal attempt ${_healTries} failed (${err.slice(0, 120)}) — will retry.`);
        }
    }
}

function maybeStartHeal(bot) {
    if (_healTimer || !bot) return;
    console.log("♻️ [AutoSetup] Menu button pending — background self-heal started (applies automatically once the domain is allow-listed in @BotFather).");
    _healTimer = setInterval(() => healTick(bot), HEAL_INTERVAL_MS);
    healTick(bot); // try immediately too — the domain may have just been added
}

async function runAutoSetup(bot) {
    if (!config.AUTO_SETUP) {
        state.autoSetup = { ran: false, at: null, results: {}, summary: "Auto-setup disabled (AUTO_SETUP=false)." };
        return state.autoSetup;
    }
    const results = {};

    // ── 1. Identity ───────────────────────────────────────────
    results.getMe = await attempt("getMe", () => bot.getMe());
    if (results.getMe.ok) {
        state.BOT_INFO = results.getMe.res;
        console.log(`✅ [AutoSetup] Bot identity: @${state.BOT_INFO.username} (${state.BOT_INFO.first_name})`);
    } else {
        console.error(`❌ [AutoSetup] getMe failed: ${results.getMe.error}`);
    }

    // Retry transient network errors a few times; permanent API errors
    // (whitelist, invalid URL, …) fail fast so the summary stays accurate.
    async function withRetry(label, fn, isRetriable) {
        for (let i = 0; i < 3; i++) {
            const r = await attempt(label, fn);
            if (r.ok) return r;
            const retriable = isRetriable ? isRetriable(r.error) : /timeout|EFATAL|socket|ECONN|429|network/i.test(String(r.error));
            if (!retriable || i === 2) return r;
            await sleep(2000 * (i + 1));
        }
    }

    // ── 2. Name / descriptions ────────────────────────────────
    results.setName = await withRetry("setMyName", () => bot.setMyName(config.BOT_NAME));
    results.setDescription = await withRetry("setMyDescription", () => bot.setMyDescription(config.BOT_DESCRIPTION));
    results.setShortDescription = await withRetry("setMyShortDescription", () => bot.setMyShortDescription(config.BOT_SHORT_DESC));

    // ── 3. Command list (visible in the bot menu) ─────────────
    results.setCommands = await withRetry("setMyCommands", () => bot.setMyCommands(config.BOT_COMMANDS));

    // ── 4. Mini App menu button (needs whitelisted domain) ────
    const url = appUrl();
    // NOTE: this lib auto-stringifies only reply_markup/entities — menu_button
    // must be JSON.stringify'd or it is mangled by form encoding ([object Object])
    // and Telegram answers 400, which used to look like a generic "not confirmed".
    const menuButtonJson = JSON.stringify({ type: "web_app", text: config.MENU_BUTTON_TEXT, url });
    results.setMenuButton = await withRetry(
        "setChatMenuButton",
        () => bot.setChatMenuButton({ menu_button: menuButtonJson }),
        (err) => !/whitelist|BUTTON_URL_INVALID|WEBAPP_URL|allowed domains/i.test(String(err)) // whitelist errors don't heal with retries
    );
    if (results.setMenuButton.ok) {
        console.log(`✅ [AutoSetup] Mini App menu button → ${url}`);
    } else {
        const err = String(results.setMenuButton.error);
        if (/whitelist|BUTTON_URL_INVALID|WEBAPP_URL|allowed domain/i.test(err)) {
            results.whitelistHint = true;
            console.warn(`⚠️ [AutoSetup] Menu button: domain must be allow-listed in @BotFather. Add → ${url.split("/")[2]}`);
        } else {
            console.warn(`⚠️ [AutoSetup] Menu button not set yet (${err.slice(0,140)}). Retry with /autosetup.`);
        }
    }

    // ── 5. Verify what Telegram actually stored ───────────────
    // getChatMenuButton returns the MenuButton object directly:
    //   { type: 'web_app', text, web_app: { url } } | { type: 'commands' } | { type: 'default' }
    // Telegram applies menu-button changes asynchronously, so an immediate
    // read-back right after a successful set can still return the OLD value
    // ("commands"). Poll a few times before declaring the state pending.
    if (results.setMenuButton.ok) {
        for (let i = 0; i < 5; i++) {
            results.verifyMenuButton = await attempt("getChatMenuButton", () => bot.getChatMenuButton());
            if (results.verifyMenuButton.ok) {
                const sb = results.verifyMenuButton.res?.menu_button || results.verifyMenuButton.res;
                if ((sb?.type || null) === "web_app") break;
            }
            if (i < 4) await sleep(1500);
        }
    } else {
        results.verifyMenuButton = await attempt("getChatMenuButton", () => bot.getChatMenuButton());
    }
    const storedButton = results.verifyMenuButton.ok ? (results.verifyMenuButton.res?.menu_button || results.verifyMenuButton.res) : null;
    const storedType = storedButton?.type || null;
    results.menuButtonActive = results.verifyMenuButton.ok && storedType === "web_app";
    if (results.setMenuButton.ok) {
        if (results.menuButtonActive) {
            console.log(`✅ [AutoSetup] Verified menu button: web_app → ${url}`);
        } else {
            console.warn(`⚠️ [AutoSetup] Menu button set OK but read-back still shows "${storedType || "none"}" — Telegram may be caching; re-verify with /appcheck in a few seconds.`);
        }
    }

    // ── 6. Domain whitelist probe ─────────────────────────────
    // Telegram rejects web_app buttons at send-time until the domain is
    // allow-listed in @BotFather. When the menu button did not store cleanly,
    // probe with a tiny self-destructing message to the owner so we can tell
    // the user exactly whether the whitelist step is still pending.
    const wlErr = (e) => /whitelist|BUTTON_URL_INVALID|WEBAPP_URL|allowed domain/i.test(String(e));
    let whitelistPending = false;
    if (!results.setMenuButton.ok && wlErr(results.setMenuButton.error)) {
        whitelistPending = true;
    } else if (!results.menuButtonActive) {
        const db = getDB();
        if (db.users[config.OWNER_ID] && bot) {
            results.probe = await attempt("domainProbe", () =>
                bot.sendMessage(config.OWNER_ID, "🧪 Web App domain probe (auto-deleted)", {
                    reply_markup: { inline_keyboard: [[{ text: "Open", web_app: { url } }]] },
                }).then(async (m) => { try { await bot.deleteMessage(config.OWNER_ID, m.message_id); } catch (_) {} return m; })
            );
            if (!results.probe.ok && wlErr(results.probe.error)) whitelistPending = true;
        }
    }
    const webAppReady = !whitelistPending; // unknown → assume ready (client-side enforcement)

    // ── Summary ───────────────────────────────────────────────
    const lines = [];
    lines.push(stepLabel("Bot identity", results.getMe));
    lines.push(stepLabel("Bot name", results.setName));
    lines.push(stepLabel("Description", results.setDescription));
    lines.push(stepLabel("Short description", results.setShortDescription));
    lines.push(stepLabel("Command list", results.setCommands));
    if (results.menuButtonActive) lines.push(`✅ Mini App menu button — ${config.MENU_BUTTON_TEXT} → ${url}`);
    else if (whitelistPending) lines.push("❌ Mini App menu button — domain not allow-listed yet");
    else lines.push("⚠️ Mini App menu button — not confirmed yet (offline / retry with /autosetup)");

    const botTag = results.getMe.ok && results.getMe.res?.username ? `@${results.getMe.res.username}` : "your bot";
    let summary = lines.join("\n");
    if (whitelistPending) {
        summary += `\n⚠️ ACTION NEEDED (30 sec, once): @BotFather → /mybots → select ${botTag} → Bot Settings → *Domain* → add: ${url.split("/")[2]}\nThen send /autosetup or redeploy — everything else is automatic.`;
    }

    state.autoSetup = { ran: true, at: new Date().toISOString(), results, summary, appUrl: url, appLink: appLink(), whitelistPending, webAppReady, menuButtonActive: !!results.menuButtonActive };
    console.log("🧩 [AutoSetup] Summary:\n" + summary);

    // ── 6. Owner report (only if the owner has started the bot) ─
    try {
        const db = getDB();
        const owner = db.users[config.OWNER_ID];
        if (owner && bot) {
            const me = results.getMe.ok ? results.getMe.res : null;
            await bot.sendMessage(config.OWNER_ID,
                `╭━━━[ ⚙️ *𝗔𝗨𝗧𝗢-𝗦𝗘𝗧𝗨𝗣 𝗥𝗘𝗣𝗢𝗥𝗧* ]━━━╮\n` +
                `┣ 🤖 *Bot:* ${botTag}\n` +
                `┣ 🛜 *Mini App:* ${me ? `https://t.me/${me.username}/app` : url}\n` +
                `┣ 🌐 *Domain:* ${url.split("/")[2] || url}\n` +
                `┣━━━━━━━━━━━━━━━━━━━━━━\n` +
                `┣ ${results.menuButtonActive ? "🟢 All bot settings applied automatically." : "🟡 Menu button pending — whitelist the domain in @BotFather for THIS bot, then send /autosetup"}\n` +
                `┣ 🧩 Commands/name/description: auto ✓\n` +
                `╰━━━━━━━━━━━━━━━━━━━━━━╯`,
                { parse_mode: "Markdown" }).catch(() => {});
        }
    } catch (_) { /* owner may not have started the bot yet — fine */ }

    // ── Self-heal when the menu button could not be stored ────
    if (!results.menuButtonActive) maybeStartHeal(bot);
    else stopHeal();

    return state.autoSetup;
}

module.exports = { runAutoSetup, appLink, appUrl };
