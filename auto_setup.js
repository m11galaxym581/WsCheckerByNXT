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

// Deep links (https://t.me/<bot>/<app> and https://t.me/<bot>?startapp) only
// open the Mini App once a Mini App / "Main Mini App" is registered for the
// bot in @BotFather — a Telegram-side directory setting that no Bot API call
// can create. Without it, a plain t.me/<bot>/app link just opens the bot's
// chat, and ?startapp requires the user to have started the bot first.
// Registered direct-link Mini Apps open with NO Start required.
//
// Whether Telegram resolves the direct link is PUBLIC information: the
// landing page for https://t.me/<bot>/<slug> renders an "Open App" link
// containing appname=<slug> only when an app with that short name exists
// (a bare bot page never contains appname). So the code probes that page
// once per boot and only advertises the direct /app link after Telegram
// itself confirms it resolves — no manual configuration needed.
const DIRECT_APP_SLUG = String(process.env.MINI_APP_SLUG || "app");

let _directProbeCache = null; // { key, ok, at } — positives cached forever, negatives for 15 min
let _probeImpl = null;        // test hook

function botUsername() { return state.BOT_INFO?.username || null; }

async function probeDirectApp(uname, slug) {
    if (_probeImpl) { // test hook: always fresh, and keeps appLink() coherent
        const ok = !!(await _probeImpl(uname, slug));
        _directProbeCache = { key: `${uname}/${slug}`, ok, at: Date.now() };
        return ok;
    }
    const key = `${uname}/${slug}`;
    const cached = _directProbeCache && _directProbeCache.key === key ? _directProbeCache : null;
    if (cached && (cached.ok || Date.now() - cached.at < 15 * 60 * 1000)) return cached.ok;
    let ok = false;
    try {
        const ctl = typeof AbortSignal !== "undefined" && AbortSignal.timeout ? AbortSignal.timeout(10000) : undefined;
        const r = await fetch(`https://t.me/${encodeURIComponent(uname)}/${encodeURIComponent(slug)}`, {
            headers: { "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36" },
            redirect: "follow",
            signal: ctl,
        });
        if (r.ok) {
            const html = await r.text();
            ok = new RegExp(`appname=${slug}(&|["'\\s]|$)`).test(html);
        }
    } catch (_) { ok = false; }
    _directProbeCache = { key, ok, at: Date.now() };
    return ok;
}

// Canonical Mini App deep link used in every message the code generates.
// Prefers the registered direct link (verified by probe); falls back to the
// startapp form, which opens the Mini App in-chat (still fine once the
// owner enables the Main Mini App / menu button flow).
function appLink() {
    const uname = botUsername();
    if (!uname) return appUrl();
    if (_directProbeCache && _directProbeCache.key === `${uname}/${DIRECT_APP_SLUG}` && _directProbeCache.ok) {
        return `https://t.me/${uname}/${DIRECT_APP_SLUG}`;
    }
    return `https://t.me/${uname}?startapp`;
}

// Direct t.me/<bot>/app link kept for reference — resolves only while an app
// with short name "app" is registered in @BotFather (see probeDirectApp).
function directAppLink() {
    const uname = botUsername();
    return uname ? `https://t.me/${uname}/${DIRECT_APP_SLUG}` : appUrl();
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
        const menuButtonJson = JSON.stringify({ type: "web_app", text: config.MENU_BUTTON_TEXT, web_app: { url } });
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

    // ── 1b. Direct Mini App link probe (t.me/<bot>/<slug>) ────
    // Telegram's landing page for the direct link shows appname=<slug> only
    // once the owner registered the Mini App in @BotFather (/newapp). When
    // confirmed, the direct link opens the Mini App with NO "start the bot
    // first" step — so advertise it. Otherwise fall back to ?startapp.
    results.directApp = { ok: false, slug: DIRECT_APP_SLUG, error: null };
    if (results.getMe.ok && state.BOT_INFO?.username) {
        const uname = state.BOT_INFO.username;
        const confirmed = await probeDirectApp(uname, DIRECT_APP_SLUG);
        results.directApp.ok = confirmed;
        if (confirmed) {
            console.log(`✅ [AutoSetup] Direct Mini App link verified: https://t.me/${uname}/${DIRECT_APP_SLUG} (Telegram confirms the app is registered — opens without Start)`);
        } else {
            console.log(`ℹ️ [AutoSetup] Direct Mini App link not registered yet: https://t.me/${uname}/${DIRECT_APP_SLUG} — @BotFather → /newapp (short name: ${DIRECT_APP_SLUG}); will keep using ?startapp until then.`);
        }
    } else {
        results.directApp.error = "getMe failed — probe skipped";
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

    // ── 2. Name / about(short description) / description ─────
    // NOTE: these wrappers pass `form` straight to the urlencoded HTTP layer,
    // so they MUST receive the official form object ({name}, {description},
    // {short_description}) — passing a bare string made Telegram answer
    // "BOT_TITLE_INVALID" even though the name itself was valid.
    results.setName = await withRetry("setMyName", () => bot.setMyName({ name: String(config.BOT_NAME).slice(0, 64) }));
    results.setDescription = await withRetry("setMyDescription", () => bot.setMyDescription({ description: String(config.BOT_DESCRIPTION).slice(0, 512) }));
    results.setShortDescription = await withRetry("setMyShortDescription", () => bot.setMyShortDescription({ short_description: String(config.BOT_SHORT_DESC).slice(0, 120) }));
    // Read back what Telegram actually stored (name/description are keyed by
    // language; omit language_code → the default language).
    results.storedName = await attempt("getMyName", () => bot.getMyName());
    results.storedDescription = await attempt("getMyDescription", () => bot.getMyDescription());
    results.storedShortDescription = await attempt("getMyShortDescription", () => bot.getMyShortDescription());

    // ── 2b. Profile photo (DP) via setMyProfilePhoto ──────────
    // Bot API 8.4+ (Feb 2026): bots can change their own profile picture.
    // Static type requires a NEW .JPG upload (file_ids can't be reused),
    // sent as multipart: field "photo" = JSON {type:"static",
    // photo:"attach://<name>"} plus the JPG under that attach name.
    // node-telegram-bot-api v0.67 has no wrapper yet → raw _request.
    const fs = require("fs");
    const pathMod = require("path");
    const photoPath = pathMod.join(__dirname, "assets", "bot-photo.jpg");
    results.setProfilePhoto = { ok: false, skipped: false, error: "" };
    if (fs.existsSync(photoPath) && bot && typeof bot._request === "function") {
        results.setProfilePhoto = await attempt("setMyProfilePhoto", () =>
            bot._request("setMyProfilePhoto", {
                formData: {
                    bot_profile_jpg: {
                        value: fs.createReadStream(photoPath),
                        options: { filename: "bot-photo.jpg", contentType: "image/jpeg" },
                    },
                    photo: JSON.stringify({ type: "static", photo: "attach://bot_profile_jpg" }),
                },
            })
        );
        if (results.setProfilePhoto.ok) {
            console.log("✅ [AutoSetup] Bot profile photo set (assets/bot-photo.jpg)");
        } else {
            console.warn(`⚠️ [AutoSetup] Profile photo not set: ${String(results.setProfilePhoto.error).slice(0, 200)}`);
        }
    } else {
        results.setProfilePhoto.skipped = true;
        results.setProfilePhoto.error = "no assets/bot-photo.jpg available in this deploy";
    }

    // ── 3. Command list (visible in the bot menu) ─────────────
    results.setCommands = await withRetry("setMyCommands", () => bot.setMyCommands(config.BOT_COMMANDS));

    // ── 4. Mini App menu button (needs whitelisted domain) ────
    const url = appUrl();
    // NOTE: (1) this lib auto-stringifies only reply_markup/entities — menu_button
    // must be JSON.stringify'd; (2) Telegram's MenuButtonWebApp schema nests the
    // url under web_app: { type:"web_app", text, web_app:{ url } } — a top-level
    // url made Telegram answer "Can't find field web_app" forever.
    const menuButtonJson = JSON.stringify({ type: "web_app", text: config.MENU_BUTTON_TEXT, web_app: { url } });
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
    const storedNameOk = results.storedName && results.storedName.ok && results.storedName.res && results.storedName.res.name;
    if (results.setName.ok && storedNameOk) lines.push(`✅ Bot name — ${String(results.storedName.res.name).slice(0, 64)}`);
    else lines.push(stepLabel("Bot name", results.setName));
    const storedDescOk = results.storedDescription && results.storedDescription.ok && results.storedDescription.res && results.storedDescription.res.description;
    if (results.setDescription.ok && storedDescOk) lines.push(`✅ Description — ${String(results.storedDescription.res.description).slice(0, 90)}${String(results.storedDescription.res.description).length > 90 ? "…" : ""}`);
    else lines.push(stepLabel("Description", results.setDescription));
    const storedAboutOk = results.storedShortDescription && results.storedShortDescription.ok && results.storedShortDescription.res && results.storedShortDescription.res.short_description;
    if (results.setShortDescription.ok && storedAboutOk) lines.push(`✅ About (profile) — ${String(results.storedShortDescription.res.short_description).slice(0, 90)}`);
    else lines.push(stepLabel("About (profile)", results.setShortDescription));
    lines.push(stepLabel("Command list", results.setCommands));
    if (results.setProfilePhoto && results.setProfilePhoto.ok) lines.push("✅ Profile photo — WS CHECKER logo (assets/bot-photo.jpg)");
    else if (results.setProfilePhoto && results.setProfilePhoto.skipped) lines.push(`⚠️ Profile photo — skipped (${results.setProfilePhoto.error})`);
    else lines.push(stepLabel("Profile photo", results.setProfilePhoto || { ok: false, error: "not attempted" }));
    if (results.menuButtonActive) lines.push(`✅ Mini App menu button — ${config.MENU_BUTTON_TEXT} → ${url}`);
    else if (whitelistPending) lines.push("❌ Mini App menu button — domain not allow-listed yet");
    else {
        // Surface the exact Telegram error so a persistent failure is not a
        // mystery ("not confirmed yet (offline)" told us nothing).
        const setErr = results.setMenuButton && !results.setMenuButton.ok ? String(results.setMenuButton.error) : "";
        const detail = setErr ? setErr.split("\n")[0].slice(0, 180)
            : `read-back type = ${storedType || "none"}`;
        lines.push(`⚠️ Mini App menu button — not confirmed: ${detail}`);
    }
    const uname = results.getMe.ok && results.getMe.res?.username ? results.getMe.res.username : null;
    if (uname) {
        if (results.directApp.ok) {
            lines.push(`✅ Direct Mini App link — https://t.me/${uname}/${DIRECT_APP_SLUG} (Telegram-verified — opens without Start)`);
        } else {
            lines.push(`ℹ️ Direct link https://t.me/${uname}/${DIRECT_APP_SLUG} — register it via @BotFather → /newapp (short name: ${DIRECT_APP_SLUG}) so users don't have to Start the bot first`);
        }
    }

    const botTag = results.getMe.ok && results.getMe.res?.username ? `@${results.getMe.res.username}` : "your bot";
    let summary = lines.join("\n");
    if (whitelistPending) {
        summary += `\n⚠️ ACTION NEEDED (30 sec, once): @BotFather → /mybots → select ${botTag} → Bot Settings → *Domain* → add: ${url.split("/")[2]}\nThen send /autosetup or redeploy — everything else is automatic.`;
    }

    state.autoSetup = { ran: true, at: new Date().toISOString(), results, summary, appUrl: url, appLink: appLink(), directAppLink: directAppLink(), directAppReady: !!(results.directApp && results.directApp.ok), directSlug: DIRECT_APP_SLUG, whitelistPending, webAppReady, menuButtonActive: !!results.menuButtonActive,
        menuButtonError: (results.setMenuButton && !results.setMenuButton.ok) ? String(results.setMenuButton.error).slice(0, 300) : null,
        menuButtonStored: storedType || null,
        profilePhotoActive: !!(results.setProfilePhoto && results.setProfilePhoto.ok),
        storedName: (storedNameOk && String(results.storedName.res.name)) || null };
    console.log("🧩 [AutoSetup] Summary:\n" + summary);

    // ── 6. Owner report (only if the owner has started the bot) ─
    try {
        const db = getDB();
        const owner = db.users[config.OWNER_ID];
        if (owner && bot) {
            const me = results.getMe.ok ? results.getMe.res : null;
            const nameLine = (results.setName.ok && storedNameOk) ? `✅ *Name:* ${String(results.storedName.res.name).slice(0, 64)}` : `❌ Name: ${String((results.setName && results.setName.error) || "failed").slice(0, 120)}`;
            const photoLine = (results.setProfilePhoto && results.setProfilePhoto.ok)
                ? "🖼 *Profile photo:* WS CHECKER logo ✓"
                : `🖼 Profile photo: ${String((results.setProfilePhoto && (results.setProfilePhoto.error || (results.setProfilePhoto.skipped ? "skipped" : "failed"))) || "failed").slice(0, 120)}`;
            const aboutLine = (results.setShortDescription.ok && storedAboutOk) ? `✅ *About:* ${String(results.storedShortDescription.res.short_description).slice(0, 90)}` : `❌ About: ${String((results.setShortDescription && results.setShortDescription.error) || "failed").slice(0, 120)}`;
            const descLine = (results.setDescription.ok && storedDescOk) ? `✅ *Description:* ${String(results.storedDescription.res.description).slice(0, 90)}${String(results.storedDescription.res.description).length > 90 ? "…" : ""}` : `❌ Description: ${String((results.setDescription && results.setDescription.error) || "failed").slice(0, 120)}`;
            await bot.sendMessage(config.OWNER_ID,
                `╭━━━[ ⚙️ *𝗔𝗨𝗧𝗢-𝗦𝗘𝗧𝗨𝗣 𝗥𝗘𝗣𝗢𝗥𝗧* ]━━━╮\n` +
                `┣ 🤖 *Bot:* ${botTag}\n` +
                `┣ ${nameLine}\n` +
                `┣ ${photoLine}\n` +
                `┣ ${aboutLine}\n` +
                `┣ ${descLine}\n` +
                `┣ 🧩 Commands: auto ✓\n` +
                `┣ 🛜 *Mini App:* ${me ? appLink() : url}\n` +
                `┣ 🌐 *Domain:* ${url.split("/")[2] || url}\n` +
                `┣━━━━━━━━━━━━━━━━━━━━━━\n` +
                `┣ ${results.menuButtonActive ? "🟢 Menu button active." : "🟡 Menu button pending — whitelist the domain in @BotFather, then send /autosetup"}\n` +
                `╰━━━━━━━━━━━━━━━━━━━━━━╯`,
                { parse_mode: "Markdown" }).catch(() => {});
        }
    } catch (_) { /* owner may not have started the bot yet — fine */ }

    // ── Self-heal when the menu button could not be stored ────
    if (!results.menuButtonActive) maybeStartHeal(bot);
    else stopHeal();

    return state.autoSetup;
}

module.exports = { runAutoSetup, appLink, directAppLink, appUrl, probeDirectApp, _setProbeImpl: (fn) => { _probeImpl = fn; } };
