// ============================================================
//   WS CHECKER v6 | bot_commands.js
//   Telegram Bot Commands — Role-Based Routing & Rich Menus
// ============================================================

"use strict";

const { 
    getDB, saveDB, isAdmin, isSub, isVIP, isBanned, isOwner, 
    registerUser, getStats, redeemVoucher, createVoucher, getUserLang, setUserLang, 
    setWebhook, generateApiKey, addAdmin, removeAdmin, 
    addSubscriber, removeSubscriber, addVIP, removeVIP, 
    banUser, unbanUser, setMaintenance, closeSupport 
} = require("./database");
const { sendBroadcastReport } = require("./utils");
const { warmupNodes, listAllSessions } = require("./whatsapp");
const config                  = require("./config");
const state                   = require("./state");
const { tr, langKeyboard }    = require("./i18n");

module.exports = (bot) => {

    const { checkForceJoin, missingReasonLine, matchJoinRequestChannel } = require("./force_join");

    // ── Safe command registration ─────────────────────────────
    // Every handler below reads msg.from.id, but channel posts and
    // anonymous-admin group messages carry NO `from` field. Registering
    // through this wrapper drops those before they can throw.
    const onText = (re, fn) => bot.onText(re, (msg, match) => {
        if (!msg || !msg.from || typeof msg.from.id === "undefined") return;
        try {
            const r = fn(msg, match);
            if (r && typeof r.catch === "function") r.catch((e) => console.error("❌ [Command] handler error:", e.message));
        } catch (e) {
            console.error("❌ [Command] handler error:", e.message);
        }
    });

    function forceJoinMarkup(missing) {
        const kb = missing.map(m => {
            const ch = m.channel || m;
            const uname = (ch.username || (ch.chatId && String(ch.chatId).startsWith("@") ? ch.chatId : "") || "").replace(/^@/, "");
            const link = ch.url || (uname ? `https://t.me/${uname}` : null);
            return [{ text: `Join ${m.title || "Channel"}`, ...(link ? { url: link } : { callback_data: "verify_join" }) }];
        });
        kb.push([{ text: "✅ Verify Join", callback_data: "verify_join" }]);
        return { reply_markup: { inline_keyboard: kb } };
    }
    function forceJoinNote(missing) {
        if (!missing || !missing.length) return "";
        return "\n\n" + missing.map(m => missingReasonLine(m)).join("\n") + "\n\nThen press ✅ Verify Join.";
    }

    // ============================================================
    // 🎛️ INLINE KEYBOARD MENU BUILDERS (WITH DEEP NAVIGATION & BACK)
    // ============================================================

    // ── 1. User Main Menu ──
    function mainMenu(uid) {
        const btns = [
            // [action]                [account / tools]
            [{ text: "🚀 New Check",       callback_data: "start_check"    }, { text: "📊 My Stats", callback_data: "my_stats" }],
            [{ text: "📱 Add Node",        callback_data: "add_sess_req"   }, { text: "🗄️ My Nodes", callback_data: "my_nodes" }],
            [{ text: "📜 History",         callback_data: "my_history"     }, { text: "🔐 Web Login", callback_data: "gen_web_pass" }],
            [{ text: "⚙️ API & Webhooks", callback_data: "api_menu"       }, { text: "🌐 Language", callback_data: "language_menu" }],
            [{ text: "💬 Support",         callback_data: "support_chat"   }, { text: "ℹ️ About",    callback_data: "show_info" }],
            [{ text: "💎 Upgrade",         callback_data: "stars_shop"     }, { text: "🎟️ Redeem",  callback_data: "redeem_prompt" }],
        ];
        if (isAdmin(uid)) btns.push([{ text: "👑 Admin Console", callback_data: "open_admin_panel" }]);
        if (isOwner(uid)) btns.push([{ text: "⚡ Owner Panel", callback_data: "open_owner_panel" }]);
        return { reply_markup: { inline_keyboard: btns } };
    }

    // ── 2. User API & Settings Menu ──
    function apiMenu() {
        return {
            reply_markup: {
                inline_keyboard: [
                    [{ text: "🔑 Generate API Key", callback_data: "gen_api_key"   }],
                    [{ text: "🔗 Set Webhook URL",  callback_data: "set_webhook"   }],
                    [{ text: "🔙 Back",             callback_data: "back_main"     }]
                ]
            }
        };
    }

    // ── 3. Admin Main Panel ──
    function adminPanel() {
        return {
            reply_markup: {
                inline_keyboard: [
                    [{ text: "📊 Live Bot Stats",    callback_data: "bot_stats"      }, { text: "📢 Broadcast",    callback_data: "broadcast_msg"  }],
                    [{ text: "🗄️ Manage Sessions",   callback_data: "m_sessions"     }, { text: "🛡️ Ping Nodes",   callback_data: "warmup_nodes"   }],
                    [{ text: "⚙️ User Management",   callback_data: "user_mgmt_menu" }, { text: "🎁 Vouchers",     callback_data: "voucher_menu"   }],
                    [{ text: "👥 DB Dump (CSV)",     callback_data: "all_users_list" }],
                    [{ text: "🔙 Back",              callback_data: "back_main"      }],
                ],
            },
        };
    }

    // ── 4. Admin User Management Menu ──
    function userMgmtMenu() {
        return {
            reply_markup: {
                inline_keyboard: [
                    [{ text: "⭐ Add PRO User",      callback_data: "add_sub_req"    }, { text: "➖ Remove PRO",   callback_data: "rem_sub_list"   }],
                    [{ text: "🔥 Add VIP User",      callback_data: "add_vip_req"    }, { text: "➖ Remove VIP",   callback_data: "rem_vip_list"   }],
                    [{ text: "🚫 Ban User",          callback_data: "ban_req"        }, { text: "✅ Unban User",   callback_data: "unban_req"      }],
                    [{ text: "🔙 Back to Admin",     callback_data: "open_admin_panel" }]
                ]
            }
        };
    }

    // ── 5. Owner Panel ──
    function ownerPanel() {
        return {
            reply_markup: {
                inline_keyboard: [
                    [{ text: "👑 Add Admin",          callback_data: "add_adm_req"    }, { text: "🗑️ Remove Admin", callback_data: "rem_adm_list"   }],
                    [{ text: "🚧 Maintenance",        callback_data: "toggle_maint"   }, { text: "💾 Force Backup", callback_data: "force_backup"   }],
                    [{ text: "🌍 Free Mode",          callback_data: "mode_free"       }, { text: "💎 Subscription Mode", callback_data: "mode_subscription" }],
                    [{ text: "🔙 Back",               callback_data: "back_main"      }]
                ]
            }
        };
    }

    // ============================================================
    // 👤 GLOBAL USER COMMANDS (Accessible to everyone)
    // ============================================================

    // ── Safe web_app button sender ─────────────────────────────
    // Telegram rejects web_app buttons at send-time while the domain is not
    // allow-listed in @BotFather. Instead of failing the whole message we
    // auto-fallback: the same menu with web_app buttons replaced by normal
    // URL buttons pointing at the dashboard itself (opens in Telegram's
    // built-in browser, where ID+password login still works).
    const isWhitelistBlock = (e) => /whitelist|BUTTON_URL_INVALID|WEBAPP_URL|allowed domain/i.test(String((e && (e.description || e.message)) || e || ""));
    const dashboardUrl = () => config.MENU_BUTTON_URL || config.DASHBOARD_URL;
    // ── Deep link helpers ─────────────────────────────────────
    // The direct t.me/<bot>/app link is advertised only after auto_setup has
    // probed Telegram and confirmed the Mini App is registered (appname=app
    // on the landing page). Registered direct links open the Mini App with
    // NO "start the bot first" step; the ?startapp form is the fallback.
    const miniAppDeepLink = () => {
        const uname = state.BOT_INFO?.username;
        if (!uname) return dashboardUrl();
        if (state.autoSetup && state.autoSetup.directAppReady) {
            return `https://t.me/${uname}/${state.autoSetup.directSlug || "app"}`;
        }
        return `https://t.me/${uname}?startapp`;
    };
    const withoutWebApp = (rows) => rows.map(row => row.map(b => (b && b.web_app) ? { text: "🌐 Open Dashboard", url: dashboardUrl() } : b));

    async function sendWithWebApp(uid, text, opts, rows) {
        const kb = rows || [[{ text: "🛜 Open Web App", web_app: { url: dashboardUrl() } }]];
        try {
            return await bot.sendMessage(uid, text, { ...opts, reply_markup: { inline_keyboard: kb } });
        } catch (e) {
            if (isWhitelistBlock(e)) {
                console.warn("⚠️ [Bot] web_app button blocked (domain whitelist pending) — fell back to dashboard URL.");
                return bot.sendMessage(uid, text, { ...opts, reply_markup: { inline_keyboard: withoutWebApp(kb) } });
            }
            throw e;
        }
    }

    // ── /start ────────────────────────────────────────────────
    onText(/\/start(?:\s+(.+))?/, async (msg, match) => {
        const uid = msg.from.id;
        registerUser(msg.from);
        closeSupport(uid); // leaving support back to main
        const fj = await checkForceJoin(uid, bot);
        if (!fj.ok) return bot.sendMessage(uid, `🔒 Please join required channels to use this bot.${forceJoinNote(fj.missing)}`, { parse_mode: "Markdown", ...forceJoinMarkup(fj.missing) });
        
        if (isBanned(uid) && !isOwner(uid)) {
            return bot.sendMessage(uid, `🚫 *𝗔𝗖𝗖𝗘𝗦𝗦 𝗗𝗘𝗡𝗜𝗘𝗗*\nYou are permanently banned from this engine.`, { parse_mode: "Markdown" });
        }

        const db = getDB();
        const L = getUserLang(uid);
        // Maintenance Lock
        if (db.meta?.maintenance && !isAdmin(uid)) {
            return bot.sendMessage(uid, "🚧 *MAINTENANCE MODE*\nEngine is offline for upgrades. Check back later.", { parse_mode: "Markdown" });
        }

        const sessCount  = Object.keys(state.sessions).length;
        const connCount  = Object.values(state.sessions).filter(s => s.status === "Connected").length;
        const freeMode = String(config.dynamic.SYSTEM_MODE || "subscription").toLowerCase() === "free";
        let statusBadge = freeMode ? "🌍 FREE MODE USER" : "🧊 FREE TIER";
        if (!freeMode && isVIP(uid)) statusBadge = "🔥 VIP TIER";
        else if (!freeMode && isSub(uid)) statusBadge = "💎 PRO TIER";
        if (isOwner(uid)) statusBadge += " | ⚡ OWNER";
        else if (isAdmin(uid)) statusBadge += " | 👑 ADMIN";

        // Optional: Auto-delete previous message logic if requested (requires tracking msg IDs)
        // This is typically handled purely in callback_query, but text commands send new messages.

        // Mini App entry point: the direct link is shown only after
        // auto_setup probed Telegram and confirmed the registered Mini App
        // (it then opens with no Start needed); otherwise point at the
        // 🛜 Open Web App button below the menu, which always works.
        const miniAppLine = (state.autoSetup && state.autoSetup.directAppReady && state.BOT_INFO?.username)
            ? `┣ 🛜 *Mini App:* ${miniAppDeepLink()}\n`
            : "┣ 🛜 *Mini App:* tap *Open Web App* below ⤵\n";

        const brandTag = `${config.BRAND_NAME} ${config.BRAND_VER}`;
        const welcomeText =
            `╭━━━━━[ ✅ *${brandTag}* ]━━━━━╮\n` +
            `┣ 👤 *Welcome, ${msg.from.first_name}!*\n` +
            `┣ 🆔 *Your ID:* \`${uid}\`\n` +
            `┣ 🎖️ *Status:* ${statusBadge}\n` +
            `┣━━━━━━━━━━━━━━━━━━━━━━━━━\n` +
            `┣ 🔌 *Nodes Active:* ${connCount}/${sessCount} Connected\n` +
            `┣ 🌐 *System Mode:* ${freeMode ? 'FREE' : 'SUBSCRIPTION'}\n` +
            miniAppLine +
            `╰━━━━━━━━━━━━━━━━━━━━━━━━━╯`;

        const mm = mainMenu(uid).reply_markup.inline_keyboard;
        const kb = [[{ text: "🛜 Open Web App", web_app: { url: dashboardUrl() } }]].concat(mm);
        return sendWithWebApp(uid, welcomeText, { parse_mode: "Markdown" }, kb);
    });

    // ── /app — Open the Mini App / Web App ────────────────────
    // NOTE: must not be the bare /\/app/ — that also matches "/appcheck"
    // (Telegram/onText is a substring match), so both handlers fired and the
    // user got the generic Mini-App text plus the diagnostics output.
    onText(/\/app(?:@\w+)?(?:\s|$)/, async (msg) => {
        const uid = msg.from.id;
        const url = dashboardUrl();
        let uname = state.BOT_INFO?.username;
        if (!uname) { try { uname = (await bot.getMe()).username; state.BOT_INFO = state.BOT_INFO || {}; state.BOT_INFO.username = uname; } catch (_) {} }
        const ready = !!(state.autoSetup && state.autoSetup.webAppReady !== false && state.autoSetup.menuButtonActive);
        const body = ready
            ? "Tap *Open Web App* below, or press *🚀 Open App* under the chat box — you are logged in *automatically* (no password needed)."
            : "The Mini App only launches *inside the Telegram app* — and the menu button is applied only after this bot's domain is allow-listed:\n\n@BotFather → /mybots → select this bot → Bot Settings → *Domain* → add `" + new URL(url).host + "`\n\nThen send /autosetup. Until then, use the button below (falls back to 🔐 Web Login → ID + password).";
        let note = "";
        if (uname) {
            const slug = (state.autoSetup && state.autoSetup.directSlug) || "app";
            if (state.autoSetup && state.autoSetup.directAppReady) {
                note = `\n\n🔗 *Mini App link (verified — opens directly, no Start needed):* ${miniAppDeepLink()}`;
            } else if (uid === config.OWNER_ID || isAdmin(uid)) {
                note = `\n\n⚠️ The direct link https://t.me/${uname}/${slug} is *not registered* in @BotFather yet — Telegram still opens this chat for it.\n\nFix (1 minute): @BotFather → /newapp → select this bot → title → URL: ${url} → short name: *${slug}*\n\nThen send /autosetup — the server verifies Telegram-side automatically. Meanwhile the button below (and https://t.me/${uname}?startapp) both work; the startapp link needs the bot started once.`;
            } else {
                note = `\n\n🔗 Deep link (inside Telegram): https://t.me/${uname}?startapp`;
            }
        }
        return sendWithWebApp(uid,
            `🛜 *Open the Mini App*\n\n${body}${note}`,
            { parse_mode: "Markdown" },
            [[{ text: "🚀 Open Web App", web_app: { url } }]]
        );
    });

    // ── /appcheck — Mini App diagnostics (owner/admin) ────────
    onText(/\/appcheck/, async (msg) => {
        const uid = msg.from.id;
        if (uid !== config.OWNER_ID && !isAdmin(uid)) return;
        const url = dashboardUrl();
        let domain = url;
        try { domain = new URL(url).host; } catch (_) {}
        const send = (txt) => bot.sendMessage(uid, txt, { parse_mode: "Markdown" }).catch(() => {});
        const L = [];
        L.push(`🌐 *Mini App Diagnostics*`);
        L.push(`1️⃣ *Configured URL:* \`${url}\``);
        L.push(`   Domain to whitelist: \`${domain}\``);

        // 2️⃣ Try applying the menu button live
        try {
            await bot.setChatMenuButton({ menu_button: { type: "web_app", text: config.MENU_BUTTON_TEXT, url } });
            L.push(`2️⃣ *Apply menu button:* ✅ done`);
        } catch (e) {
            const err = String(e.description || e.message || "");
            L.push(`2️⃣ *Apply menu button:* ❌ ${err.slice(0, 180)}`);
            if (/whitelist|BUTTON_URL_INVALID|WEBAPP_URL|allowed domain/i.test(err)) {
                L.push(`   👉 THIS IS THE PROBLEM — @BotFather → /mybots → Bot Settings → *Domain* → add \`${domain}\`, then run /autosetup`);
            }
        }

        // 3️⃣ Read back and verify what Telegram actually stored
        // (Telegram can apply the change asynchronously, so retry briefly)
        try {
            const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
            let btn = null, readErr = null;
            for (let i = 0; i < 4; i++) {
                try {
                    const mb = await bot.getChatMenuButton();
                    btn = (mb && (mb.menu_button || mb)) || null;
                    if (btn && btn.type === "web_app") break;
                } catch (e) { readErr = e; }
                if (i < 3) await sleep(1500);
            }
            if (btn && btn.type === "web_app") {
                L.push(`3️⃣ *Verify:* ✅ web_app stored → ${(btn.web_app && (btn.web_app.url || btn.url)) || "?"}`);
            } else {
                L.push(readErr
                    ? `3️⃣ *Verify:* read failed — ${readErr.description || readErr.message}`
                    : `3️⃣ *Verify:* ❌ still type = "${(btn && btn.type) || "none"}" — Telegram did not keep web_app. Usually the domain is not allow-listed yet or the button was changed manually — add \`${domain}\` in @BotFather → /mybots → Bot Settings → *Domain*, then run /autosetup again`);
            }
        } catch (e) { L.push(`3️⃣ *Verify:* read failed — ${e.description || e.message}`); }

        // 4️⃣ Is the dashboard itself reachable over HTTPS?
        L.push(`4️⃣ *Site reachable:* checking…`);
        const statusMsg = await send(L.join("\n"));
        try {
            const ctl = typeof AbortSignal !== "undefined" && AbortSignal.timeout ? AbortSignal.timeout(12000) : undefined;
            const r = await fetch(url, { method: "GET", redirect: "follow", signal: ctl });
            L.push(`4️⃣ *Site reachable:* ✅ HTTP ${r.status} (${(r.headers.get("content-type") || "").split(";")[0]})`);
        } catch (e) {
            const why = (e && (e.name === "TimeoutError" || e.name === "AbortError")) ? "timeout (12s)" : (e.cause && e.cause.message) || e.message || String(e);
            L.push(`4️⃣ *Site reachable:* ❌ ${why}`);
            L.push(`   👉 Railway URL is up? If you use a custom domain, check DNS/SSL settings.`);
        }

        let uname = state.BOT_INFO?.username;
        if (!uname) { try { uname = (await bot.getMe()).username; } catch (_) {} }
        const slug = (state.autoSetup && state.autoSetup.directSlug) || "app";
        if (uname) {
            // Live re-probe: Telegram's public landing page shows appname=<slug>
            // only while the Mini App is registered — refresh right now so the
            // owner sees the truth immediately after a /newapp registration.
            let directOk = !!(state.autoSetup && state.autoSetup.directAppReady);
            try {
                const as = require("./auto_setup");
                directOk = await as.probeDirectApp(uname, slug);
            } catch (_) {}
            state.autoSetup = state.autoSetup || {};
            state.autoSetup.directAppReady = directOk;
            state.autoSetup.directSlug = slug;
            if (directOk) {
                state.autoSetup.appLink = `https://t.me/${uname}/${slug}`;
                L.push(`5️⃣ *Direct link:* ✅ https://t.me/${uname}/${slug} — Telegram confirms the Mini App is registered; it opens directly (no Start needed).`);
            } else {
                L.push(`5️⃣ *Direct link:* ❌ https://t.me/${uname}/${slug} — not registered yet; Telegram opens this chat for it.`);
                L.push(`   👉 Register (1 minute): @BotFather → /newapp → select this bot → URL: ${url} → short name: *${slug}*`);
                L.push(`   ⏳ Meanwhile: https://t.me/${uname}?startapp (works after the bot is started once).`);
            }
        } else {
            L.push(`5️⃣ *App link:* username unknown`);
        }
        L.push(`6️⃣ *Deep link still opens the chat?* Open it inside the Telegram app (mobile, or a recent Telegram Desktop) — never in a browser. The 🚀 Open App button under the chat box and web_app buttons inside chats open the Mini App regardless of the direct link.`);
        L.push(`\n💡 Mini Apps only open inside the *Telegram app* — not in a browser/web.`);
        const finalText = L.join("\n");
        if (statusMsg) bot.editMessageText(finalText, { chat_id: uid, message_id: statusMsg.message_id, parse_mode: "Markdown" }).catch(() => send(finalText));
    });

    // ── /autosetup — Re-run server-side auto-setup (owner) ────
    onText(/\/autosetup/, async (msg) => {
        const uid = msg.from.id;
        if (uid !== config.OWNER_ID && !isAdmin(uid)) return;
        const s = await bot.sendMessage(uid, "⚙️ Running auto-setup…").catch(() => {});
        try {
            const r = await require("./auto_setup").runAutoSetup(bot);
            const status = r.whitelistPending
                ? "🟡 *Menu button pending:* whitelist your domain in @BotFather (`/mybots` → Bot Settings → Domain), then send /autosetup again."
                : (r.menuButtonActive ? "🟢 *All settings applied automatically.*" : "🟠 Done, with warnings (see log).");
            if (s) bot.editMessageText(`⚙️ *AUTO-SETUP COMPLETE*\n\n${status}\n\n🛜 App: ${r.appLink || ""}`, { chat_id: uid, message_id: s.message_id, parse_mode: "Markdown" }).catch(() => {});
        } catch (e) {
            if (s) bot.editMessageText(`❌ Auto-setup failed: ${e.message}`, { chat_id: uid, message_id: s.message_id }).catch(() => {});
        }
    });

    // ── /help ─────────────────────────────────────────────────
    onText(/\/help/, async (msg) => {
        const uid = msg.from.id;
        const isAdm = isAdmin(uid);
        const isOwn = isOwner(uid);
        const parts = [];
        parts.push("╭━━━━━━[ 🛠️ *𝗛𝗘𝗟𝗣 & 𝗖𝗢𝗠𝗠𝗔𝗡𝗗𝗦* ]━━━━━━╮");
        parts.push("┣ 👤 *Basics*");
        parts.push("┣  /start — open the main menu");
        parts.push("┣  /help — show this help");
        parts.push("┣  /app — open the dashboard / Mini App");
        parts.push("┣  /language — change language");
        parts.push("┣  /reset — cancel / clear a running job");
        parts.push("┣ 🚀 *Checker*");
        parts.push("┣  /mystats — your usage statistics");
        parts.push("┣  /queue — see queued jobs");
        parts.push("┣  /retryfailed — re-run failed numbers");
        parts.push("┣  /mylists  •  /runlist <id> — saved lists");
        parts.push("┣ 💳 *Plans & Tools*");
        parts.push("┣  /redeem <code> — claim a voucher");
        parts.push("┣  /setwebhook <url> — set a webhook (PRO)");
        if (isAdm) {
            parts.push("┣━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
            parts.push("┣ 👑 *Admin*");
            parts.push("┣  /admin  •  /stats — console & stats");
            parts.push("┣  /sessions  •  /warmup — manage nodes");
            parts.push("┣  /addpro <id> [d]  •  /addvip <id> [d]");
            parts.push("┣  /rempro <id>  •  /remvip <id>");
            parts.push("┣  /ban <id>  •  /unban <id>");
            parts.push("┣  /broadcast <msg>");
            parts.push("┣  /genvoucher PRO|VIP <days> <uses>");
            parts.push("┣  /appcheck — Mini App diagnostics");
        }
        if (isOwn) {
            parts.push("┣━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
            parts.push("┣ ⚡ *Owner*");
            parts.push("┣  /owner — owner panel");
            parts.push("┣  /addadmin <id>  •  /remadmin <id>");
            parts.push("┣  /maintenance on|off");
            parts.push("┣  /systemmode free|subscription");
            parts.push("┣  /autosetup — re-run auto config");
            parts.push("┣  /refundstars <charge_id|user_id> — Stars refund");
            parts.push("┣  /starsbalance — bot Stars balance + txns");
        }
        parts.push("╰━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━╯");
        return bot.sendMessage(uid, parts.join("\n"), { parse_mode: "Markdown", reply_markup: { inline_keyboard: [[{ text: "⌨ All Commands", callback_data: "cmds" }, { text: "🔙 Back", callback_data: "back_main" }]] } });
    });


    // ── /language ─────────────────────────────────────────────
    onText(/\/language/, async (msg) => {
        const uid = msg.from.id;
        registerUser(msg.from);
        const L = getUserLang(uid);
        return bot.sendMessage(uid, tr(L, "choose_lang"), { reply_markup: { inline_keyboard: langKeyboard("set_lang") } });
    });

    // ── /reset ────────────────────────────────────────────────
    onText(/\/reset/, async (msg) => {
        const uid = msg.from.id;
        if (isAdmin(uid)) {
            state.processingUsers.clear();
            Object.keys(global.webState || {}).forEach(k => {
                if (global.webState[k]) global.webState[k].status = "Cancelled";
            });
            return bot.sendMessage(uid, `╭━━━[ 🔄 *𝗚𝗟𝗢𝗕𝗔𝗟 𝗥𝗘𝗦𝗘𝗧* ]━━━╮\n┣ ✅ All Server Jobs Terminated.\n┣ ✅ Web States Cleared.\n╰━━━━━━━━━━━━━━━━━━━━━━╯`, { parse_mode: "Markdown" });
        }
        
        state.removeProcessing(uid);
        state.clearUserStep(uid);
        closeSupport(uid); // closing any open support session
        if (global.webState?.[uid]) global.webState[uid].status = "Cancelled";
        return bot.sendMessage(uid, `╭━━━[ 🔄 *𝗔𝗖𝗧𝗜𝗢𝗡 𝗖𝗔𝗡𝗖𝗘𝗟𝗟𝗘𝗗* ]━━━╮\n┣ ✅ Your session has been reset.\n╰━━━━━━━━━━━━━━━━━━━━━━╯`, { parse_mode: "Markdown" });
    });

    // ── /redeem <code> ────────────────────────────────────────
    onText(/\/redeem (.+)/, async (msg, match) => {
        const uid = msg.from.id;
        const code = match[1].trim();
        const result = redeemVoucher(uid, code);
        
        if (result) {
            return bot.sendMessage(uid, 
                `╭━━━[ 🎉 *𝗩𝗢𝗨𝗖𝗛𝗘𝗥 𝗥𝗘𝗗𝗘𝗘𝗠𝗘𝗗* ]━━━╮\n` +
                `┣ 🎁 *Code:* \`${code}\`\n` +
                `┣ 🎖️ *Granted:* ${result.type} TIER\n` +
                `┣ ⏳ *Duration:* ${result.days} Days\n` +
                `╰━━━━━━━━━━━━━━━━━━━━━━╯`, 
                { parse_mode: "Markdown" }
            );
        }
        return bot.sendMessage(uid, `❌ *Invalid, Expired, or Already Used Code.*`, { parse_mode: "Markdown" });
    });

    // ── /setwebhook <url> ─────────────────────────────────────
    onText(/\/setwebhook (.+)/, async (msg, match) => {
        const uid = msg.from.id;
        if (!isSub(uid)) return bot.sendMessage(uid, `❌ *PRO/VIP Tier required to use Webhooks.*`, { parse_mode: "Markdown" });
        
        let url = match[1].trim();
        if (!url.startsWith("http")) return bot.sendMessage(uid, `❌ *Invalid URL.* Must start with http:// or https://`, { parse_mode: "Markdown" });
        
        setWebhook(uid, url);
        return bot.sendMessage(uid, `✅ *Webhook URL saved successfully!*\nResults will be POSTed to:\n\`${url}\``, { parse_mode: "Markdown" });
    });



    // ── /mystats ──────────────────────────────────────────────
    onText(/\/mystats/, async (msg) => {
        const uid = msg.from.id;
        registerUser(msg.from);
        const db = getDB(); const hist = db.history[uid] || [];
        const total = hist.reduce((a,h)=>a+Number(h.total||0),0);
        const reg = hist.reduce((a,h)=>a+Number(h.reg||0),0);
        const failed = hist.reduce((a,h)=>a+Number(h.failed||0),0);
        const tier = isOwner(uid) ? 'OWNER' : (isAdmin(uid) ? 'ADMIN' : (isVIP(uid) ? 'VIP' : (isSub(uid) ? 'PRO' : 'FREE')));
        return bot.sendMessage(uid, `📊 *My Stats*

🎖️ Tier: *${tier}*
📦 Jobs: *${hist.length}*
🔢 Total Checked: *${total}*
✅ Registered: *${reg}*
⚠️ Failed: *${failed}*`, { parse_mode: 'Markdown' });
    });

    // ── /queue ────────────────────────────────────────────────
    onText(/\/queue/, async (msg) => {
        const uid = msg.from.id;
        const queued = (state.jobQueue || []).filter(j => Number(j.uid) === Number(uid));
        const running = state.isProcessing(uid);
        return bot.sendMessage(uid, `🧾 *Queue Status*

Running: *${running ? 'YES' : 'NO'}*
Queued Jobs: *${queued.length}*
${queued.map((j,i)=>`${i+1}. ${j.numbers?.length||0} numbers`).join('\n') || ''}`, { parse_mode:'Markdown' });
    });

    // ── /mylists ──────────────────────────────────────────────
    onText(/\/mylists/, async (msg) => {
        const uid = msg.from.id; const u = getDB().users[uid]; const lists = u?.savedLists || [];
        if (!lists.length) return bot.sendMessage(uid, '📚 No saved lists found. Save lists from web dashboard.');
        const text = lists.slice(0,20).map((l,i)=>`${i+1}. \`${l.id}\` — *${l.name}* (${l.numbers?.length||0})`).join('\n');
        return bot.sendMessage(uid, `📚 *My Lists*

${text}

Use /runlist <id>`, { parse_mode:'Markdown' });
    });

    onText(/\/runlist (.+)/, async (msg, match) => {
        const uid = msg.from.id; const id = match[1].trim(); const u = getDB().users[uid]; const list = (u?.savedLists || []).find(l => l.id === id);
        if (!list) return bot.sendMessage(uid, '❌ List not found. Use /mylists');
        bot.emit('message', { from: msg.from, chat: { id: uid }, text: (list.numbers||[]).join('\n') });
        return bot.sendMessage(uid, `🚀 Started list: *${list.name}* (${list.numbers.length} numbers)`, { parse_mode:'Markdown' });
    });

    onText(/\/retryfailed/, async (msg) => {
        const uid = msg.from.id; const failed = state.lastResults[uid]?.failed || [];
        if (!failed.length) return bot.sendMessage(uid, 'No failed numbers found to retry.');
        bot.emit('message', { from: msg.from, chat: { id: uid }, text: failed.join('\n') });
        return bot.sendMessage(uid, `🔁 Retrying ${failed.length} failed numbers...`);
    });



    // ============================================================
    // 👑 ADMIN COMMANDS (Admins & Owners Only)
    // ============================================================

    // ── /admin ────────────────────────────────────────────────
    onText(/\/admin/, async (msg) => {
        const uid = msg.from.id;
        if (!isAdmin(uid)) return bot.sendMessage(uid, `⛔ *Restricted.* Admin access required.`, { parse_mode: "Markdown" });
        
        const stats = getStats();
        return bot.sendMessage(uid,
            `╭━━━━━[ 👑 *𝗔𝗗𝗠𝗜𝗡 𝗖𝗢𝗡𝗦𝗢𝗟𝗘* ]━━━━━╮\n` +
            `┣ 👥 *Total Users:* ${stats.totalUsers}\n` +
            `┣ 💎 *PRO Users:* ${stats.totalPro}\n` +
            `┣ 🔥 *VIP Users:* ${stats.totalVIP}\n` +
            `┣ 🔌 *Total Nodes:* ${stats.sessions}\n` +
            `┣ ⚙️ *Active Jobs:* ${state.processingUsers.size}\n` +
            `╰━━━━━━━━━━━━━━━━━━━━━━╯`,
            { parse_mode: "Markdown", ...adminPanel() }
        );
    });

    // ── /stats ────────────────────────────────────────────────
    onText(/\/stats/, async (msg) => {
        if (!isAdmin(msg.from.id)) return;
        const s = getStats();
        const connected = Object.values(state.sessions).filter(x => x.status === "Connected").length;
        return bot.sendMessage(msg.chat.id,
            `╭━━━━[ 📊 *𝗦𝗬𝗦𝗧𝗘𝗠 𝗦𝗧𝗔𝗧𝗦* ]━━━━╮\n` +
            `┣ 👥 *Users:* ${s.totalUsers}\n` +
            `┣ 🔥 *VIP:* ${s.totalVIP}\n` +
            `┣ 💎 *PRO:* ${s.totalPro}\n` +
            `┣ 👑 *Admins:* ${s.totalAdmins}\n` +
            `┣ 🚫 *Banned:* ${s.totalBanned}\n` +
            `┣ 🔌 *Connected Nodes:* ${connected}/${s.sessions}\n` +
            `┣ ⚙️ *RAM Usage:* ${(process.memoryUsage().heapUsed / 1024 / 1024).toFixed(1)} MB\n` +
            `╰━━━━━━━━━━━━━━━━━━━━━━╯`,
            { parse_mode: "Markdown" }
        );
    });

    // ── /sessions ─────────────────────────────────────────────
    onText(/\/sessions/, async (msg) => {
        if (!isAdmin(msg.from.id)) return;
        const rows = listAllSessions();
        if (!rows.length) return bot.sendMessage(msg.chat.id, "❌ No sessions found.");
        const icons = { Connected: "🟢", Connecting: "🟡", Offline: "🔴", Blocked: "🚫" };
        const lines = rows.map(r => `${icons[r.status] || "⚪"} \`${r.sid}\` — ${r.type.toUpperCase()} — Owner: \`${r.owner}\` — ${r.status.toUpperCase()}`).join("\n");
        return bot.sendMessage(msg.chat.id, `╭━━━[ 🗄️ *𝗔𝗟𝗟 𝗡𝗢𝗗𝗘𝗦* (${rows.length}) ]━━━╮\n${lines}\n╰━━━━━━━━━━━━━━━━━━━━━━╯`, { parse_mode: "Markdown" });
    });

    // ── /warmup ───────────────────────────────────────────────
    onText(/\/warmup/, async (msg) => {
        if (!isAdmin(msg.from.id)) return;
        bot.sendMessage(msg.chat.id, `⏳ *Initiating Anti-Ban Warmup Protocol...*`, { parse_mode: "Markdown" });
        const res = await warmupNodes();
        if (res.ok) bot.sendMessage(msg.chat.id, `✅ *Warmup Complete!*\n${res.sent} Pings delivered across network.`, { parse_mode: "Markdown" });
        else bot.sendMessage(msg.chat.id, `❌ *Warmup Failed:* ${res.msg}`, { parse_mode: "Markdown" });
    });

    // ── /genvoucher <type> <days> <count> ─────────────────────
    onText(/\/genvoucher (PRO|VIP) (\d+) (\d+)/i, async (msg, match) => {
        if (!isAdmin(msg.from.id)) return;
        const type = match[1].toUpperCase();
        const days = Number(match[2]);
        const count = Number(match[3]);
        
        const code = createVoucher(type, days, count);
        return bot.sendMessage(msg.chat.id, 
            `╭━━━[ 🎁 *𝗩𝗢𝗨𝗖𝗛𝗘𝗥 𝗚𝗘𝗡𝗘𝗥𝗔𝗧𝗘𝗗* ]━━━╮\n` +
            `┣ 🏷️ *Code:* \`${code}\`\n` +
            `┣ 🎖️ *Tier:* ${type}\n` +
            `┣ ⏳ *Days:* ${days}\n` +
            `┣ 👥 *Max Uses:* ${count}\n` +
            `╰━━━━━━━━━━━━━━━━━━━━━━╯`, 
            { parse_mode: "Markdown" }
        );
    });

    // ── Direct Assignment Commands ────────────────────────────
    onText(/\/addpro (\d+) (\d+)?/, async (msg, match) => {
        if (!isAdmin(msg.from.id)) return;
        const tid = Number(match[1]); const days = Number(match[2] || 30);
        addSubscriber(tid, days);
        bot.sendMessage(msg.chat.id, `✅ PRO activated for \`${tid}\` (${days} Days)`, { parse_mode: "Markdown" });
        bot.sendMessage(tid, `✨ *Congratulations!* Your PRO subscription has been activated for ${days} days.\n✅ WS CHECKER v6`, { parse_mode: "Markdown" }).catch(() => {});
    });

    onText(/\/rempro (\d+)/, async (msg, match) => {
        if (!isAdmin(msg.from.id)) return; const tid = Number(match[1]);
        removeSubscriber(tid); bot.sendMessage(msg.chat.id, `✅ PRO removed for \`${tid}\``, { parse_mode: "Markdown" });
    });

    onText(/\/addvip (\d+) (\d+)?/, async (msg, match) => {
        if (!isAdmin(msg.from.id)) return;
        const tid = Number(match[1]); const days = Number(match[2] || 30);
        addVIP(tid, days);
        bot.sendMessage(msg.chat.id, `🔥 VIP activated for \`${tid}\` (${days} Days)`, { parse_mode: "Markdown" });
        bot.sendMessage(tid, `🔥 *VIP UNLOCKED!*\nYour account has been upgraded to VIP for ${days} days. Enjoy maximum limits.\n✅ WS CHECKER v6`, { parse_mode: "Markdown" }).catch(() => {});
    });

    onText(/\/remvip (\d+)/, async (msg, match) => {
        if (!isAdmin(msg.from.id)) return; const tid = Number(match[1]);
        removeVIP(tid); bot.sendMessage(msg.chat.id, `✅ VIP removed for \`${tid}\``, { parse_mode: "Markdown" });
    });

    onText(/\/ban (\d+)/, async (msg, match) => {
        if (!isAdmin(msg.from.id)) return; const tid = Number(match[1]);
        if(isOwner(tid)) return bot.sendMessage(msg.chat.id, "❌ Cannot ban the Owner.");
        banUser(tid); bot.sendMessage(msg.chat.id, `🚫 User \`${tid}\` banned.`, { parse_mode: "Markdown" });
    });

    onText(/\/unban (\d+)/, async (msg, match) => {
        if (!isAdmin(msg.from.id)) return; const tid = Number(match[1]);
        unbanUser(tid); bot.sendMessage(msg.chat.id, `✅ User \`${tid}\` unbanned.`, { parse_mode: "Markdown" });
    });

    onText(/\/broadcast (.+)/, async (msg, match) => {
        if (!isAdmin(msg.from.id)) return;
        const text = match[1]; const db = getDB(); const suc = [], fail = [];
        bot.sendMessage(msg.chat.id, "⏳ Broadcasting...");
        for (const id of Object.keys(db.users)) {
            try { await bot.sendMessage(id, `📢 *𝗕𝗥𝗢𝗔𝗗𝗖𝗔𝗦𝗧*\n\n${text}\n\n✅ _WS CHECKER v6_`, { parse_mode: "Markdown" }); suc.push(id); } 
            catch (_) { fail.push(id); }
        }
        await sendBroadcastReport(bot, config.OWNER_ID, suc, fail);
    });


    // ── Force Join Admin Commands ─────────────────────────────
    onText(/\/forcejoin (on|off)/i, async (msg, match) => {
        if (!isAdmin(msg.from.id)) return;
        const enabled = match[1].toLowerCase() === 'on';
        config.setDynamicConfig({ FORCE_JOIN_ENABLED: enabled });
        bot.sendMessage(msg.chat.id, `🔒 Force Join: *${enabled ? 'ON' : 'OFF'}*`, { parse_mode:'Markdown' });
    });
    onText(/\/forcejoin_add (.+)/, async (msg, match) => {
        if (!isAdmin(msg.from.id)) return;
        const parts = match[1].split('|').map(x=>x.trim());
        const title = parts[0];
        const chatId = parts[1] || (parts[0] && !parts[0].startsWith("https") ? parts[0] : undefined);
        const url = parts[2] || (parts[0] && parts[0].startsWith("https") ? parts[0] : undefined);
        const dyn = config.dynamic; const channels = Array.isArray(dyn.FORCE_JOIN_CHANNELS) ? dyn.FORCE_JOIN_CHANNELS : [];
        if (!chatId && !url) return bot.sendMessage(msg.chat.id, "❌ Usage:\n/forcejoin_add Title|@channel\n/forcejoin_add Title|-100123456789\n/forcejoin_add Title|@channel|https://t.me/joinchat/xxxx\nPublic channels: username or t.me link works.\nPrivate channels: numeric chat id needed and the bot must be an admin of the channel.");
        channels.push({ title, chatId, url });
        config.setDynamicConfig({ FORCE_JOIN_CHANNELS: channels });
        bot.sendMessage(msg.chat.id, `✅ Added force-join channel: ${title || chatId || url}\n\n📌 Make this bot an *admin* of the channel (private: enable *Invite users* too), then run /forcejoin_test.`, { parse_mode: 'Markdown' }).catch(() => bot.sendMessage(msg.chat.id, `✅ Added force-join channel: ${title || chatId || url}`));
    });
    onText(/\/forcejoin_list/, async (msg) => {
        if (!isAdmin(msg.from.id)) return;
        const dyn = config.dynamic; const channels = dyn.FORCE_JOIN_CHANNELS || [];
        const auto = dyn.FORCE_JOIN_AUTO_APPROVE ? "ON (auto-approve join requests)" : "OFF";
        const lines = channels.map((c,i)=>`${i+1}. ${c.title||c.chatId}\n   id: ${c.chatId || "-"} | user: ${c.username || "-"} | url: ${c.url || "-"}`);
        bot.sendMessage(msg.chat.id, `🔒 *Force Join:* ${dyn.FORCE_JOIN_ENABLED?'ON':'OFF'} | Auto-approve: ${auto}\n\n${lines.join('\n') || 'No channels'}\n\n📌 The bot must be an *admin* of every channel (for private channels also give it *Invite users*), otherwise membership can never be verified.\n\n/forcejoin_test - check the channels from the bot side`, { parse_mode:'Markdown' });
    });

    // ============================================================
    // Auto-approve join requests for force-join channels (needs bot admin with Invite users right).
    onText(/\/forcejoin_auto (on|off)/i, async (msg, match) => {
        if (!isAdmin(msg.from.id)) return;
        const enabled = match[1].toLowerCase() === 'on';
        config.setDynamicConfig({ FORCE_JOIN_AUTO_APPROVE: enabled });
        bot.sendMessage(msg.chat.id, `🔓 Force-join auto-approve: *${enabled ? 'ON' : 'OFF'}*`, { parse_mode:'Markdown' });
    });
    // Live diagnostic: resolves every channel and reports bot-side verification state.
    onText(/\/forcejoin_test/, async (msg) => {
        if (!isAdmin(msg.from.id)) return;
        const { probeChannel, channelLabel } = require("./force_join");
        const dyn = config.dynamic; const channels = dyn.FORCE_JOIN_CHANNELS || [];
        if (!channels.length) return bot.sendMessage(msg.chat.id, "No force-join channels configured yet. Use /forcejoin_add.");
        const out = [`🔍 *Force-join channel test* (as @${(state.BOT_INFO||{}).username || "bot"})\n`];
        for (const ch of channels) {
            const p = await probeChannel(bot, ch, msg.from.id).catch(() => null);
            if (!p) { out.push(`❌ ${channelLabel(ch)} — probe crashed`); continue; }
            if (p.joined) out.push(`✅ ${p.label} — bot CAN verify members (you are ${p.status || "a member"})`);
            else if (p.reason === "not_joined") out.push(`✅ ${p.label} — bot CAN verify (you are not joined yet; probe succeeded)`);
            else if (p.reason === "unverifiable") out.push(`⚠️ ${p.label} — invite link only: impossible to verify. Make the bot an admin and store the numeric chat id.`);
            else out.push(`❌ ${p.label} — ${p.reason === "bot_setup" ? "bot is not an admin of this channel" : (p.detail || "unknown error")}`);
        }
        out.push(`\nTip: add the bot as channel admin, then run this again.`);
        bot.sendMessage(msg.chat.id, out.join("\n"), { parse_mode:'Markdown' }).catch(() => bot.sendMessage(msg.chat.id, out.join("\n")));
    });

    // ── 🔔 Chat join request (private force-join channels) ────
    // Fires when a user asks to join a channel and this bot is an admin with
    // the "Invite users" right there. Without this event the bot can never
    // "see" join requests — getChatMember only reflects approved members.
    bot.on("chat_join_request", async (req) => {
        try {
            const dyn = config.dynamic;
            const channels = Array.isArray(dyn.FORCE_JOIN_CHANNELS) ? dyn.FORCE_JOIN_CHANNELS : [];
            if (!dyn.FORCE_JOIN_ENABLED || !channels.length) return;
            const match = matchJoinRequestChannel(req, channels);
            if (!match) return;
            const uid = Number(req.from && req.from.id);
            if (!uid) return;
            const title = match.channel.title || req.chat.title || (req.chat.username ? "@" + req.chat.username : "channel");
            if (dyn.FORCE_JOIN_AUTO_APPROVE) {
                try {
                    await bot.approveChatJoinRequest(req.chat.id, uid);
                    return bot.sendMessage(uid, `✅ Auto-approved! You are now a member of ${title}. Open the bot and press /start to continue.`).catch(() => {});
                } catch (e) {
                    console.warn("⚠️ [ForceJoin] Auto-approve failed:", e.description || e.message);
                }
            }
            bot.sendMessage(uid, `✅ Your request to join ${title} was received. Once an admin approves it, open the bot again and press ✅ Verify Join (or send /start).`).catch(() => {});
        } catch (e) {
            console.error("❌ [ForceJoin] chat_join_request handler error:", e.message);
        }
    });

    // 👑 OWNER COMMANDS (Only Owner Can Use)
    // ============================================================

    // ── /owner ────────────────────────────────────────────────
    onText(/\/owner/, async (msg) => {
        const uid = msg.from.id;
        if (!isOwner(uid)) return;
        return bot.sendMessage(uid,
            `╭━━━━━[ ⚡ *𝗢𝗪𝗡𝗘𝗥 𝗣𝗔𝗡𝗘𝗟* ]━━━━━╮\n` +
            `┣ Owner controls for this engine.\n` +
            `╰━━━━━━━━━━━━━━━━━━━━━━╯`,
            { parse_mode: "Markdown", ...ownerPanel() }
        );
    });

    // ── /addadmin <uid> ───────────────────────────────────────
    onText(/\/addadmin (\d+)/, async (msg, match) => {
        if (!isOwner(msg.from.id)) return;
        const tid = Number(match[1]); addAdmin(tid);
        bot.sendMessage(msg.chat.id, `👑 \`${tid}\` is now an Admin.`, { parse_mode: "Markdown" });
    });

    onText(/\/remadmin (\d+)/, async (msg, match) => {
        if (!isOwner(msg.from.id)) return;
        const tid = Number(match[1]); removeAdmin(tid);
        bot.sendMessage(msg.chat.id, `🗑️ \`${tid}\` removed from Admin.`, { parse_mode: "Markdown" });
    });

    // ── /maintenance <on|off> ─────────────────────────────────
    onText(/\/maintenance (on|off)/i, async (msg, match) => {
        if (!isOwner(msg.from.id)) return;
        const maintOn = match[1].toLowerCase() === 'on';
        setMaintenance(maintOn);
        bot.sendMessage(msg.chat.id, `🚧 *Maintenance Mode:* ${maintOn ? 'ON (Locked)' : 'OFF (Open)'}`, { parse_mode: "Markdown" });
    });


    // ── /systemmode <free|subscription> ───────────────────────
    onText(/\/systemmode (free|subscription)/i, async (msg, match) => {
        if (!isOwner(msg.from.id)) return;
        const mode = match[1].toLowerCase();
        const ok = config.setDynamicConfig({ SYSTEM_MODE: mode });
        bot.sendMessage(msg.chat.id, ok ? `✅ *System Mode Updated:* ${mode.toUpperCase()}` : `❌ Failed to update system mode.`, { parse_mode: "Markdown" });
    });

};
