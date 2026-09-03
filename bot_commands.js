// ============================================================
//   ⚡ BLAZE NXT — V4.0 GOD MODE (MEGABEAST) | bot_commands.js
//   Telegram Bot Commands — Role-Based Routing & Rich Menus
// ============================================================

"use strict";

const { 
    getDB, saveDB, isAdmin, isSub, isVIP, isBanned, isOwner, 
    registerUser, getStats, redeemVoucher, createVoucher, getUserLang, setUserLang, 
    setWebhook, generateApiKey, addAdmin, removeAdmin, 
    addSubscriber, removeSubscriber, addVIP, removeVIP, 
    banUser, unbanUser, setMaintenance 
} = require("./database");
const { sendBroadcastReport } = require("./utils");
const { warmupNodes }         = require("./whatsapp");
const config                  = require("./config");
const state                   = require("./state");
const { tr, langKeyboard }    = require("./i18n");

module.exports = (bot) => {

    async function checkForceJoin(uid) {
        const dyn = config.dynamic;
        const channels = Array.isArray(dyn.FORCE_JOIN_CHANNELS) ? dyn.FORCE_JOIN_CHANNELS : [];
        if (!dyn.FORCE_JOIN_ENABLED || !channels.length || isAdmin(uid)) return { ok: true, missing: [] };
        const missing = [];
        for (const ch of channels) {
            const chatId = ch.chatId || ch.username || ch.url;
            try { const m = await bot.getChatMember(chatId, uid); if (["left", "kicked"].includes(m.status)) missing.push(ch); }
            catch (_) { missing.push(ch); }
        }
        return { ok: missing.length === 0, missing };
    }
    function forceJoinMarkup(missing) {
        const kb = missing.map(ch => [{ text: `Join ${ch.title || ch.chatId || 'Channel'}`, url: ch.url || `https://t.me/${String(ch.chatId||'').replace('@','')}` }]);
        kb.push([{ text: "✅ Verify Join", callback_data: "verify_join" }]);
        return { reply_markup: { inline_keyboard: kb } };
    }

    // ============================================================
    // 🎛️ INLINE KEYBOARD MENU BUILDERS (WITH DEEP NAVIGATION & BACK)
    // ============================================================

    // ── 1. User Main Menu ──
    function mainMenu(uid) {
        const L = getUserLang(uid);
        const btns = [
            [{ text: "🛜 Open Web App", web_app: { url: config.MENU_BUTTON_URL || config.DASHBOARD_URL } }],
            [{ text: "🚀 New Check", callback_data: "start_check" }, { text: "📊 My Stats", callback_data: "my_stats" }],
            [{ text: "🔐 Web Login", callback_data: "gen_web_pass" }, { text: "📱 Add Node", callback_data: "add_sess_req" }],
            [{ text: "📜 History", callback_data: "my_history" }, { text: "🌐 Language", callback_data: "language_menu" }],
            [{ text: "⚙️ API & Webhooks", callback_data: "api_menu" }, { text: "ℹ️ System Info", callback_data: "show_info" }],
            [{ text: "💬 Support", callback_data: "support_chat" }, { text: "💎 Upgrade", callback_data: "buy_prem_req" }],
            [{ text: "🎟️ Redeem", callback_data: "redeem_prompt" }],
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
                    [{ text: "🔙 Back to Main",     callback_data: "back_main"     }]
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
                    [{ text: "🔙 Back to Main",      callback_data: "back_main"      }],
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

    // ── 5. Owner God Panel ──
    function ownerPanel() {
        return {
            reply_markup: {
                inline_keyboard: [
                    [{ text: "👑 Add Admin",         callback_data: "add_adm_req"    }, { text: "🗑️ Remove Admin", callback_data: "rem_adm_list"   }],
                    [{ text: "🚧 Toggle Maintenance",callback_data: "toggle_maint"   }, { text: "💾 Force Backup", callback_data: "force_backup"   }],
                    [{ text: "🔙 Back to Main",      callback_data: "back_main"      }]
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
    // URL buttons pointing at t.me/<bot>/app (always works).
    const isWhitelistBlock = (e) => /whitelist|BUTTON_URL_INVALID|WEBAPP_URL|allowed domain/i.test(String((e && (e.description || e.message)) || e || ""));
    const appDeepLink = () => state.BOT_INFO?.username ? `https://t.me/${state.BOT_INFO.username}/app` : (config.MENU_BUTTON_URL || config.DASHBOARD_URL);
    // Pre-whitelist fallback: t.me/<bot>/app is dead until the menu button is
    // stored, so fall back to the dashboard URL itself (opens in Telegram's
    // browser where ID+password login still works).
    const dashboardUrl = () => config.MENU_BUTTON_URL || config.DASHBOARD_URL;
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
    bot.onText(/\/start(?:\s+(.+))?/, async (msg, match) => {
        const uid = msg.from.id;
        registerUser(msg.from);
        const fj = await checkForceJoin(uid);
        if (!fj.ok) return bot.sendMessage(uid, "🔒 Please join required channels to use this bot.", { parse_mode: "Markdown", ...forceJoinMarkup(fj.missing) });
        
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

        // Mini App deep link (t.me/<bot>/app) — auto-login inside Telegram.
        const miniAppLine = state.BOT_INFO?.username
            ? `┣ 🛜 *Mini App:* t.me/${state.BOT_INFO.username}/app\n`
            : "";

        const welcomeText =
            `╭━━━━━━[ ⚡ *𝗕𝗟𝗔𝗭𝗘 𝗡𝗫𝗧  V4.0* ]━━━━━━╮\n` +
            `┣ 👤 *Welcome,* ${msg.from.first_name}!\n` +
            `┣ 🆔 *Your ID:* \`${uid}\`\n` +
            `┣ 🎖️ *Status:* ${statusBadge}\n` +
            `┣━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n` +
            `┣ 🔌 *Nodes Active:* ${connCount}/${sessCount} Connected\n` +
            `┣ 🌐 *System Mode:* ${freeMode ? 'FREE' : 'SUBSCRIPTION'}\n` +
            `┣ 🚀 *Engine Mode:* 0-Delay Multi-Thread\n` +
            `┣ 🛡️ *Security:* Proxied Anti-Ban\n` +
            miniAppLine +
             `┣ 🌐 *Web Dashboard:* ${config.DASHBOARD_URL} \n` +
            `╰━━━━━━━━━━━━━━━━━━━━━━━━━━━━╯`;

        return sendWithWebApp(uid, welcomeText, { parse_mode: "Markdown" }, mainMenu(uid).reply_markup.inline_keyboard);
    });

    // ── /app — Open the Mini App / Web App ────────────────────
    bot.onText(/\/app/, async (msg) => {
        const uid = msg.from.id;
        const url = dashboardUrl();
        const link = state.BOT_INFO?.username ? `https://t.me/${state.BOT_INFO.username}/app` : url;
        const ready = !!(state.autoSetup && state.autoSetup.webAppReady !== false && state.autoSetup.menuButtonActive);
        const body = ready
            ? `Tap below to open the full dashboard inside Telegram — you are logged in *automatically* (no password needed).`
            : `The Mini App works *inside the Telegram app*. If the button does not launch yet, the domain must be allow-listed once:\n\n@BotFather → /mybots → Bot Settings → Domain → \`${new URL(url).host}\`\n\nThen send /autosetup. Meanwhile the button opens the dashboard (use 🔐 Web Login → ID + password).`;
        return sendWithWebApp(uid,
            `🛜 *Open the Web App*\n\n${body}\n\n🔗 App link (Telegram app me kholo): ${link}`,
            { parse_mode: "Markdown" },
            [[{ text: "🚀 Open Web App", web_app: { url } }]]
        );
    });

    // ── /appcheck — Mini App diagnostics (owner/admin) ────────
    bot.onText(/\/appcheck/, async (msg) => {
        const uid = msg.from.id;
        if (uid !== config.OWNER_ID && !isAdmin(uid)) return;
        const url = dashboardUrl();
        let domain = url;
        try { domain = new URL(url).host; } catch (_) {}
        const send = (txt) => bot.sendMessage(uid, txt, { parse_mode: "Markdown" }).catch(() => {});
        const L = [];
        L.push(`🌐 *Mini App Diagnostics*\n`);
        L.push(`1️⃣ *Configured URL:* \`${url}\``);
        L.push(`   Domain to whitelist: \`${domain}\``);

        // Current menu button state
        try {
            const mb = await bot.getChatMenuButton();
            const btn = (mb && (mb.menu_button || mb)) || {};
            L.push(btn.type === "web_app"
                ? `2️⃣ *Menu button:* ✅ web_app → ${(btn.web_app && (btn.web_app.url || btn.url)) || "?"}`
                : `2️⃣ *Menu button:* ❌ type = "${btn.type || "none"}" — /autosetup se set karo`);
        } catch (e) { L.push(`2️⃣ *Menu button:* read failed — ${e.description || e.message}`); }

        // Try applying it live
        try {
            await bot.setChatMenuButton({ menu_button: { type: "web_app", text: config.MENU_BUTTON_TEXT, url } });
            L.push(`3️⃣ *Apply menu button:* ✅ done`);
        } catch (e) {
            const err = String(e.description || e.message || "");
            L.push(`3️⃣ *Apply menu button:* ❌ ${err.slice(0, 180)}`);
            if (/whitelist|BUTTON_URL_INVALID|WEBAPP_URL|allowed domain/i.test(err)) {
                L.push(`   👉 YAHI PROBLEM HAI — @BotFather → /mybots → Bot Settings → *Domain* → \`${domain}\` daalo, phir /autosetup`);
            }
        }

        // Is the dashboard itself reachable over HTTPS?
        L.push(`4️⃣ *Site reachable:* checking…`);
        const statusMsg = await send(L.join("\n"));
        try {
            const ctl = typeof AbortSignal !== "undefined" && AbortSignal.timeout ? AbortSignal.timeout(12000) : undefined;
            const r = await fetch(url, { method: "GET", redirect: "follow", signal: ctl });
            L.push(`4️⃣ *Site reachable:* ✅ HTTP ${r.status} (${(r.headers.get("content-type") || "").split(";")[0]})`);
        } catch (e) {
            const why = (e && (e.name === "TimeoutError" || e.name === "AbortError")) ? "timeout (12s)" : (e.cause && e.cause.message) || e.message || String(e);
            L.push(`4️⃣ *Site reachable:* ❌ ${why}`);
            L.push(`   👉 Railway URL up hai? Custom domain hai toh DNS/SSL check karo.`);
        }

        let uname = state.BOT_INFO?.username;
        if (!uname) { try { uname = (await bot.getMe()).username; } catch (_) {} }
        L.push(`5️⃣ *App link:* ${uname ? `https://t.me/${uname}/app` : "username unknown"}`);
        L.push(`\n💡 Mini Apps sirf *Telegram app ke andar* khulte hain — browser/web me nahi.`);
        const finalText = L.join("\n");
        if (statusMsg) bot.editMessageText(finalText, { chat_id: uid, message_id: statusMsg.message_id, parse_mode: "Markdown" }).catch(() => send(finalText));
    });

    // ── /autosetup — Re-run server-side auto-setup (owner) ────
    bot.onText(/\/autosetup/, async (msg) => {
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
    bot.onText(/\/help/, async (msg) => {
        const uid = msg.from.id;
        const text = `
╭━━━[ 🛠️ *𝗛𝗘𝗟𝗣 & 𝗖𝗢𝗠𝗠𝗔𝗡𝗗𝗦* ]━━━╮
┣ /start - Open Main Menu
┣ /app - Open Web App (auto login)
┣ /reset - Clear active jobs & web state
┣ /redeem \`<code>\` - Claim Promo Voucher
┣ /setwebhook \`<url>\` - Set API Webhook
┣ /info - System Information
╰━━━━━━━━━━━━━━━━━━━━━━╯`;
        return bot.sendMessage(uid, text, { parse_mode: "Markdown", reply_markup: { inline_keyboard: [[{text: "🔙 Back", callback_data: "back_main"}]] } });
    });


    // ── /language ─────────────────────────────────────────────
    bot.onText(/\/language/, async (msg) => {
        const uid = msg.from.id;
        registerUser(msg.from);
        const L = getUserLang(uid);
        return bot.sendMessage(uid, tr(L, "choose_lang"), { reply_markup: { inline_keyboard: langKeyboard("set_lang") } });
    });

    // ── /reset ────────────────────────────────────────────────
    bot.onText(/\/reset/, async (msg) => {
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
        if (global.webState?.[uid]) global.webState[uid].status = "Cancelled";
        return bot.sendMessage(uid, `╭━━━[ 🔄 *𝗔𝗖𝗧𝗜𝗢𝗡 𝗖𝗔𝗡𝗖𝗘𝗟𝗟𝗘𝗗* ]━━━╮\n┣ ✅ Your session has been reset.\n╰━━━━━━━━━━━━━━━━━━━━━━╯`, { parse_mode: "Markdown" });
    });

    // ── /redeem <code> ────────────────────────────────────────
    bot.onText(/\/redeem (.+)/, async (msg, match) => {
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
    bot.onText(/\/setwebhook (.+)/, async (msg, match) => {
        const uid = msg.from.id;
        if (!isSub(uid)) return bot.sendMessage(uid, `❌ *PRO/VIP Tier required to use Webhooks.*`, { parse_mode: "Markdown" });
        
        let url = match[1].trim();
        if (!url.startsWith("http")) return bot.sendMessage(uid, `❌ *Invalid URL.* Must start with http:// or https://`, { parse_mode: "Markdown" });
        
        setWebhook(uid, url);
        return bot.sendMessage(uid, `✅ *Webhook URL saved successfully!*\nResults will be POSTed to:\n\`${url}\``, { parse_mode: "Markdown" });
    });



    // ── /mystats ──────────────────────────────────────────────
    bot.onText(/\/mystats/, async (msg) => {
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
    bot.onText(/\/queue/, async (msg) => {
        const uid = msg.from.id;
        const queued = (state.jobQueue || []).filter(j => Number(j.uid) === Number(uid));
        const running = state.isProcessing(uid);
        return bot.sendMessage(uid, `🧾 *Queue Status*

Running: *${running ? 'YES' : 'NO'}*
Queued Jobs: *${queued.length}*
${queued.map((j,i)=>`${i+1}. ${j.numbers?.length||0} numbers`).join('\\n') || ''}`, { parse_mode:'Markdown' });
    });

    // ── /mylists ──────────────────────────────────────────────
    bot.onText(/\/mylists/, async (msg) => {
        const uid = msg.from.id; const u = getDB().users[uid]; const lists = u?.savedLists || [];
        if (!lists.length) return bot.sendMessage(uid, '📚 No saved lists found. Save lists from web dashboard.');
        const text = lists.slice(0,20).map((l,i)=>`${i+1}. \`${l.id}\` — *${l.name}* (${l.numbers?.length||0})`).join('\\n');
        return bot.sendMessage(uid, `📚 *My Lists*

${text}

Use /runlist <id>`, { parse_mode:'Markdown' });
    });

    bot.onText(/\/runlist (.+)/, async (msg, match) => {
        const uid = msg.from.id; const id = match[1].trim(); const u = getDB().users[uid]; const list = (u?.savedLists || []).find(l => l.id === id);
        if (!list) return bot.sendMessage(uid, '❌ List not found. Use /mylists');
        bot.emit('message', { from: msg.from, chat: { id: uid }, text: (list.numbers||[]).join('\\n') });
        return bot.sendMessage(uid, `🚀 Started list: *${list.name}* (${list.numbers.length} numbers)`, { parse_mode:'Markdown' });
    });

    bot.onText(/\/retryfailed/, async (msg) => {
        const uid = msg.from.id; const failed = state.lastResults[uid]?.failed || [];
        if (!failed.length) return bot.sendMessage(uid, 'No failed numbers found to retry.');
        bot.emit('message', { from: msg.from, chat: { id: uid }, text: failed.join('\\n') });
        return bot.sendMessage(uid, `🔁 Retrying ${failed.length} failed numbers...`);
    });



    // ============================================================
    // 👑 ADMIN COMMANDS (Admins & Owners Only)
    // ============================================================

    // ── /admin ────────────────────────────────────────────────
    bot.onText(/\/admin/, async (msg) => {
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
    bot.onText(/\/stats/, async (msg) => {
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
    bot.onText(/\/sessions/, async (msg) => {
        if (!isAdmin(msg.from.id)) return;
        const keys = Object.keys(state.sessions);
        if (!keys.length) return bot.sendMessage(msg.chat.id, "❌ No active sessions.");
        const lines = keys.map(k => {
            const s = state.sessions[k];
            const icon = s.status === "Connected" ? "🟢" : "🔴";
            return `${icon} \`${k}\` — ${s.type.toUpperCase()} — Owner: \`${s.owner}\``;
        }).join("\n");
        return bot.sendMessage(msg.chat.id, `╭━━━[ 🗄️ *𝗔𝗖𝗧𝗜𝗩𝗘 𝗡𝗢𝗗𝗘𝗦* ]━━━╮\n${lines}\n╰━━━━━━━━━━━━━━━━━━━━━━╯`, { parse_mode: "Markdown" });
    });

    // ── /warmup ───────────────────────────────────────────────
    bot.onText(/\/warmup/, async (msg) => {
        if (!isAdmin(msg.from.id)) return;
        bot.sendMessage(msg.chat.id, `⏳ *Initiating Anti-Ban Warmup Protocol...*`, { parse_mode: "Markdown" });
        const res = await warmupNodes();
        if (res.ok) bot.sendMessage(msg.chat.id, `✅ *Warmup Complete!*\n${res.sent} Pings delivered across network.`, { parse_mode: "Markdown" });
        else bot.sendMessage(msg.chat.id, `❌ *Warmup Failed:* ${res.msg}`, { parse_mode: "Markdown" });
    });

    // ── /genvoucher <type> <days> <count> ─────────────────────
    bot.onText(/\/genvoucher (PRO|VIP) (\d+) (\d+)/i, async (msg, match) => {
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
    bot.onText(/\/addpro (\d+) (\d+)?/, async (msg, match) => {
        if (!isAdmin(msg.from.id)) return;
        const tid = Number(match[1]); const days = Number(match[2] || 30);
        addSubscriber(tid, days);
        bot.sendMessage(msg.chat.id, `✅ PRO activated for \`${tid}\` (${days} Days)`, { parse_mode: "Markdown" });
        bot.sendMessage(tid, `✨ *Congratulations!* Your PRO subscription has been activated for ${days} days.\n⚡ BLAZE NXT`, { parse_mode: "Markdown" }).catch(() => {});
    });

    bot.onText(/\/rempro (\d+)/, async (msg, match) => {
        if (!isAdmin(msg.from.id)) return; const tid = Number(match[1]);
        removeSubscriber(tid); bot.sendMessage(msg.chat.id, `✅ PRO removed for \`${tid}\``, { parse_mode: "Markdown" });
    });

    bot.onText(/\/addvip (\d+) (\d+)?/, async (msg, match) => {
        if (!isAdmin(msg.from.id)) return;
        const tid = Number(match[1]); const days = Number(match[2] || 30);
        addVIP(tid, days);
        bot.sendMessage(msg.chat.id, `🔥 VIP activated for \`${tid}\` (${days} Days)`, { parse_mode: "Markdown" });
        bot.sendMessage(tid, `🔥 *GOD TIER UNLOCKED!*\nYour account has been upgraded to VIP for ${days} days. Enjoy maximum limits.\n⚡ BLAZE NXT`, { parse_mode: "Markdown" }).catch(() => {});
    });

    bot.onText(/\/remvip (\d+)/, async (msg, match) => {
        if (!isAdmin(msg.from.id)) return; const tid = Number(match[1]);
        removeVIP(tid); bot.sendMessage(msg.chat.id, `✅ VIP removed for \`${tid}\``, { parse_mode: "Markdown" });
    });

    bot.onText(/\/ban (\d+)/, async (msg, match) => {
        if (!isAdmin(msg.from.id)) return; const tid = Number(match[1]);
        if(isOwner(tid)) return bot.sendMessage(msg.chat.id, "❌ Cannot ban the Owner.");
        banUser(tid); bot.sendMessage(msg.chat.id, `🚫 User \`${tid}\` banned.`, { parse_mode: "Markdown" });
    });

    bot.onText(/\/unban (\d+)/, async (msg, match) => {
        if (!isAdmin(msg.from.id)) return; const tid = Number(match[1]);
        unbanUser(tid); bot.sendMessage(msg.chat.id, `✅ User \`${tid}\` unbanned.`, { parse_mode: "Markdown" });
    });

    bot.onText(/\/broadcast (.+)/, async (msg, match) => {
        if (!isAdmin(msg.from.id)) return;
        const text = match[1]; const db = getDB(); const suc = [], fail = [];
        bot.sendMessage(msg.chat.id, "⏳ Broadcasting...");
        for (const id of Object.keys(db.users)) {
            try { await bot.sendMessage(id, `📢 *𝗕𝗥𝗢𝗔𝗗𝗖𝗔𝗦𝗧*\n\n${text}\n\n⚡ _BLAZE NXT_`, { parse_mode: "Markdown" }); suc.push(id); } 
            catch (_) { fail.push(id); }
        }
        await sendBroadcastReport(bot, config.OWNER_ID, suc, fail);
    });


    // ── Force Join Admin Commands ─────────────────────────────
    bot.onText(/\/forcejoin (on|off)/i, async (msg, match) => {
        if (!isAdmin(msg.from.id)) return;
        const enabled = match[1].toLowerCase() === 'on';
        config.setDynamicConfig({ FORCE_JOIN_ENABLED: enabled });
        bot.sendMessage(msg.chat.id, `🔒 Force Join: *${enabled ? 'ON' : 'OFF'}*`, { parse_mode:'Markdown' });
    });
    bot.onText(/\/forcejoin_add (.+)/, async (msg, match) => {
        if (!isAdmin(msg.from.id)) return;
        const [title, chatId, url] = match[1].split('|').map(x=>x.trim());
        const dyn = config.dynamic; const channels = Array.isArray(dyn.FORCE_JOIN_CHANNELS) ? dyn.FORCE_JOIN_CHANNELS : [];
        channels.push({ title: title || chatId, chatId, url });
        config.setDynamicConfig({ FORCE_JOIN_CHANNELS: channels });
        bot.sendMessage(msg.chat.id, `✅ Added force-join channel: ${title || chatId}`);
    });
    bot.onText(/\/forcejoin_list/, async (msg) => {
        if (!isAdmin(msg.from.id)) return;
        const dyn = config.dynamic; const channels = dyn.FORCE_JOIN_CHANNELS || [];
        bot.sendMessage(msg.chat.id, `🔒 *Force Join* ${dyn.FORCE_JOIN_ENABLED?'ON':'OFF'}

${channels.map((c,i)=>`${i+1}. ${c.title||c.chatId} | ${c.chatId}`).join('\n') || 'No channels'}`, { parse_mode:'Markdown' });
    });

    // ============================================================
    // ⚡ OWNER COMMANDS (Only Owner Can Use)
    // ============================================================

    // ── /owner ────────────────────────────────────────────────
    bot.onText(/\/owner/, async (msg) => {
        const uid = msg.from.id;
        if (!isOwner(uid)) return;
        return bot.sendMessage(uid,
            `╭━━━━━[ ⚡ *𝗚𝗢𝗗 𝗣𝗔𝗡𝗘𝗟* ]━━━━━╮\n` +
            `┣ Welcome to the root terminal, Creator.\n` +
            `╰━━━━━━━━━━━━━━━━━━━━━━╯`,
            { parse_mode: "Markdown", ...ownerPanel() }
        );
    });

    // ── /addadmin <uid> ───────────────────────────────────────
    bot.onText(/\/addadmin (\d+)/, async (msg, match) => {
        if (!isOwner(msg.from.id)) return;
        const tid = Number(match[1]); addAdmin(tid);
        bot.sendMessage(msg.chat.id, `👑 \`${tid}\` is now an Admin.`, { parse_mode: "Markdown" });
    });

    bot.onText(/\/remadmin (\d+)/, async (msg, match) => {
        if (!isOwner(msg.from.id)) return;
        const tid = Number(match[1]); removeAdmin(tid);
        bot.sendMessage(msg.chat.id, `🗑️ \`${tid}\` removed from Admin.`, { parse_mode: "Markdown" });
    });

    // ── /maintenance <on|off> ─────────────────────────────────
    bot.onText(/\/maintenance (on|off)/i, async (msg, match) => {
        if (!isOwner(msg.from.id)) return;
        const maintOn = match[1].toLowerCase() === 'on';
        setMaintenance(maintOn);
        bot.sendMessage(msg.chat.id, `🚧 *Maintenance Mode:* ${maintOn ? 'ON (Locked)' : 'OFF (Open)'}`, { parse_mode: "Markdown" });
    });


    // ── /systemmode <free|subscription> ───────────────────────
    bot.onText(/\/systemmode (free|subscription)/i, async (msg, match) => {
        if (!isOwner(msg.from.id)) return;
        const mode = match[1].toLowerCase();
        const ok = config.setDynamicConfig({ SYSTEM_MODE: mode });
        bot.sendMessage(msg.chat.id, ok ? `✅ *System Mode Updated:* ${mode.toUpperCase()}` : `❌ Failed to update system mode.`, { parse_mode: "Markdown" });
    });

};
