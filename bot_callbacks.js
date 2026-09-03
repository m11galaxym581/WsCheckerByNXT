// ============================================================
//   ⚡ BLAZE NXT — V4.0 GOD MODE (MEGABEAST) | bot_callbacks.js
//   Inline Button Callbacks — Auto-Edit, Deep Navigation & Roles
// ============================================================

"use strict";

const {
    getDB, saveDB, isAdmin, isSub, isVIP, isOwner, isBanned, getUserLang, setUserLang,
    addAdmin, removeAdmin, addSubscriber, removeSubscriber, addVIP, removeVIP,
    banUser, unbanUser, generateWebPass, generateApiKey, createVoucher, getStats
} = require("./database");
const { warmupNodes, deleteSession } = require("./whatsapp");
const config = require("./config");
const state  = require("./state");
const { tr, langKeyboard, normalizeLang } = require("./i18n");
const fs     = require("fs");
const path   = require("path");

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
        return { inline_keyboard: kb };
    }

    // ============================================================
    // 🎛️ REUSABLE MENU BUILDERS (For Back Buttons)
    // ============================================================

    function mainMenu(uid) {
        const L = getUserLang(uid);
        const btns = [
            [{ text: "🚀 New Check", callback_data: "start_check" }, { text: "📊 My Stats", callback_data: "my_stats" }],
            [{ text: "🔐 Web Login", callback_data: "gen_web_pass" }, { text: "📱 Add Node", callback_data: "add_sess_req" }],
            [{ text: "📜 History", callback_data: "my_history" }, { text: "🌐 Language", callback_data: "language_menu" }],
            [{ text: "⚙️ API & Webhooks", callback_data: "api_menu" }, { text: "ℹ️ System Info", callback_data: "show_info" }],
            [{ text: "💬 Support", callback_data: "support_chat" }, { text: "💎 Upgrade", callback_data: "buy_prem_req" }],
            [{ text: "🎟️ Redeem", callback_data: "redeem_prompt" }],
        ];
        if (isAdmin(uid)) btns.push([{ text: "👑 Admin Console", callback_data: "open_admin_panel" }]);
        if (isOwner(uid)) btns.push([{ text: "⚡ Owner Panel", callback_data: "open_owner_panel" }]);
        return { inline_keyboard: btns };
    }

    function apiMenu() {
        return {
            inline_keyboard: [
                [{ text: "🔑 Generate API Key", callback_data: "gen_api_key"   }],
                [{ text: "🔗 Set Webhook URL",  callback_data: "set_webhook"   }],
                [{ text: "🔙 Back to Main Menu",callback_data: "back_main"     }]
            ]
        };
    }

    function adminPanel() {
        return {
            inline_keyboard: [
                [{ text: "📊 Live Bot Stats",    callback_data: "bot_stats"      }, { text: "📢 Broadcast",    callback_data: "broadcast_msg"  }],
                [{ text: "🗄️ Manage Sessions",   callback_data: "m_sessions"     }, { text: "🛡️ Ping Nodes",   callback_data: "warmup_nodes"   }],
                [{ text: "⚙️ User Management",   callback_data: "user_mgmt_menu" }, { text: "🎁 Vouchers",     callback_data: "voucher_menu"   }],
                [{ text: "👥 DB Dump (CSV)",     callback_data: "all_users_list" }],
                [{ text: "🔙 Back to Main Menu", callback_data: "back_main"      }],
            ]
        };
    }

    function userMgmtMenu() {
        return {
            inline_keyboard: [
                [{ text: "⭐ Add PRO User",      callback_data: "add_sub_req"    }, { text: "➖ Remove PRO",   callback_data: "rem_sub_list"   }],
                [{ text: "🔥 Add VIP User",      callback_data: "add_vip_req"    }, { text: "➖ Remove VIP",   callback_data: "rem_vip_list"   }],
                [{ text: "🚫 Ban User",          callback_data: "ban_req"        }, { text: "✅ Unban User",   callback_data: "unban_req"      }],
                [{ text: "🔙 Back to Admin Panel",callback_data: "open_admin_panel" }]
            ]
        };
    }

    function voucherMenu() {
        return {
            inline_keyboard: [
                [{ text: "🎁 Generate 30-Day PRO", callback_data: "gen_vouch_pro_30" }],
                [{ text: "🔥 Generate 30-Day VIP", callback_data: "gen_vouch_vip_30" }],
                [{ text: "🔙 Back to Admin Panel", callback_data: "open_admin_panel" }]
            ]
        };
    }

    function ownerPanel() {
        return {
            inline_keyboard: [
                [{ text: "👑 Add Admin",         callback_data: "add_adm_req"    }, { text: "🗑️ Remove Admin", callback_data: "rem_adm_list"   }],
                [{ text: "🚧 Toggle Maintenance",callback_data: "toggle_maint"   }, { text: "💾 Force Backup", callback_data: "force_backup"   }],
                [{ text: "🌍 Free Mode", callback_data: "mode_free" }, { text: "💎 Subscription Mode", callback_data: "mode_subscription" }],
                [{ text: "🔙 Back to Main Menu", callback_data: "back_main"      }]
            ]
        };
    }

    // Helper for generating standard "Back" button markup
    const backBtn = (target, text = "🔙 Cancel / Back") => ({ inline_keyboard: [[{ text, callback_data: target }]] });

    // ============================================================
    // 🕹️ CALLBACK QUERY HANDLER
    // ============================================================
    bot.on("callback_query", async (q) => {
        const uid  = q.from.id;
        const data = q.data;
        const msgId = q.message.message_id;

        // Answer callback to remove Telegram loading spinner
        try { await bot.answerCallbackQuery(q.id); } catch (_) {}

        const db = getDB();

        // ── Security Guards ──
        if (isBanned(uid) && !isOwner(uid)) return;
        if (db.meta?.maintenance && !isAdmin(uid)) {
            return bot.sendMessage(uid, "🚧 Maintenance Mode Active.");
        }

        // ── Helper: Edit Message (Auto-Delete Old Content) ──
        const safeEdit = (text, markup) => {
            return bot.editMessageText(text, {
                chat_id: uid,
                message_id: msgId,
                parse_mode: "Markdown",
                reply_markup: markup
            }).catch((e) => {
                // Ignore "message is not modified" errors, log others
                if (!e.message.includes("is not modified")) {
                    console.error("❌ [Telegram Edit Error]:", e.message);
                }
            });
        };


        if (data === "verify_join") {
            const fj = await checkForceJoin(uid);
            if (!fj.ok) return safeEdit("🔒 Please join all required channels first.", forceJoinMarkup(fj.missing));
            return safeEdit("✅ Verified successfully!", mainMenu(uid));
        }

        // ============================================================
        // 🔄 GLOBAL NAVIGATION & BACK BUTTONS
        // ============================================================
        if (data === "back_main") {
            state.clearUserStep(uid);
            let statusBadge = isOwner(uid) ? "⚡ GOD (OWNER)" : (isAdmin(uid) ? "👑 ADMIN" : (isVIP(uid) ? "🔥 VIP TIER" : (isSub(uid) ? "💎 PRO TIER" : "🧊 FREE TIER")));
            return safeEdit(`╭━━━━━━[ ⚡ *𝗕𝗟𝗔𝗭𝗘 𝗡𝗫𝗧  v5.0.59* ]━━━━━━╮\n┣ 👤 *Welcome back,* ${q.from.first_name}!\n┣ 🎖️ *Status:* ${statusBadge}\n╰━━━━━━━━━━━━━━━━━━━━━━━━━━━━╯`, mainMenu(uid));
        }


        if (data === "language_menu") {
            const L = getUserLang(uid);
            return safeEdit(tr(L, "choose_lang"), { inline_keyboard: [...langKeyboard("set_lang"), [{ text: tr(L, "back"), callback_data: "back_main" }]] });
        }

        if (data.startsWith("set_lang_")) {
            const lang = normalizeLang(data.replace("set_lang_", ""));
            setUserLang(uid, lang);
            return safeEdit(tr(lang, "lang_saved"), mainMenu(uid));
        }

        if (data === "open_admin_panel" && isAdmin(uid)) {
            state.clearUserStep(uid); const s = getStats();
            return safeEdit(`╭━━━━━[ 👑 *𝗔𝗗𝗠𝗜𝗡 𝗖𝗢𝗡𝗦𝗢𝗟𝗘* ]━━━━━╮\n┣ 👥 Users: ${s.totalUsers} | 💎 PRO: ${s.totalPro} | 🔥 VIP: ${s.totalVIP}\n┣ 🔌 Nodes: ${s.sessions} | ⚙️ Jobs: ${state.processingUsers.size}\n╰━━━━━━━━━━━━━━━━━━━━━━╯`, adminPanel());
        }

        if (data === "user_mgmt_menu" && isAdmin(uid)) {
            return safeEdit(`╭━━━[ ⚙️ *𝗨𝗦𝗘𝗥 𝗠𝗔𝗡𝗔𝗚𝗘𝗠𝗘𝗡𝗧* ]━━━╮\n┣ Select an action to perform on a user.\n╰━━━━━━━━━━━━━━━━━━━━━━╯`, userMgmtMenu());
        }

        if (data === "voucher_menu" && isAdmin(uid)) {
            return safeEdit(`╭━━━[ 🎁 *𝗩𝗢𝗨𝗖𝗛𝗘𝗥𝗦 / 𝗣𝗥𝗢𝗠𝗢𝗦* ]━━━╮\n┣ Generate redeemable codes for users.\n╰━━━━━━━━━━━━━━━━━━━━━━╯`, voucherMenu());
        }

        if (data === "open_owner_panel" && isOwner(uid)) {
            state.clearUserStep(uid);
            return safeEdit(`╭━━━━━[ ⚡ *𝗚𝗢𝗗 𝗣𝗔𝗡𝗘𝗟* ]━━━━━╮\n┣ Root Access Granted.\n╰━━━━━━━━━━━━━━━━━━━━━━╯`, ownerPanel());
        }

        if (data === "api_menu") {
            return safeEdit(`╭━━━[ ⚙️ *𝗔𝗣𝗜 & 𝗪𝗘𝗕𝗛𝗢𝗢𝗞𝗦* ]━━━╮\n┣ Manage your external integrations.\n╰━━━━━━━━━━━━━━━━━━━━━━╯`, apiMenu());
        }



        if (data === "my_stats") {
            const dbStats = getDB();
            const hist = dbStats.history?.[uid] || [];
            const total = hist.reduce((a,h)=>a+Number(h.total||0),0);
            const reg = hist.reduce((a,h)=>a+Number(h.reg||0),0);
            const failed = hist.reduce((a,h)=>a+Number(h.failed||0),0);
            const tier = isOwner(uid) ? 'OWNER' : (isAdmin(uid) ? 'ADMIN' : (isVIP(uid) ? 'VIP' : (isSub(uid) ? 'PRO' : 'FREE')));
            return safeEdit(`📊 *My Stats*

🎖️ Tier: *${tier}*
📦 Jobs: *${hist.length}*
🔢 Total Checked: *${total}*
✅ Registered: *${reg}*
⚠️ Failed: *${failed}*`, backBtn("back_main"));
        }

        // ============================================================
        // 👤 USER FEATURES (Checker, API, Profile, Support)
        // ============================================================

        if (data === "start_check") {
            const freeMode = String(config.dynamic.SYSTEM_MODE || "subscription").toLowerCase() === "free";
            const limit = isOwner(uid) || isAdmin(uid) ? "Unlimited" : (freeMode ? config.dynamic.VIP_LIMIT : (isVIP(uid) ? config.dynamic.VIP_LIMIT : (isSub(uid) ? config.dynamic.PRO_LIMIT : config.dynamic.FREE_LIMIT)));
            return safeEdit(`╭━━━[ 📝 *𝗦𝗘𝗡𝗗 𝗡𝗨𝗠𝗕𝗘𝗥𝗦* ]━━━╮\n┣ 🌐 *Mode:* ${freeMode ? 'FREE' : 'SUBSCRIPTION'}\n┣ Send numbers — *one per line*.\n┣ 📊 *Your Limit:* ${limit} numbers\n┣ ✅ International format supported.\n╰━━━━━━━━━━━━━━━━━━━━━━╯`, backBtn("back_main"));
        }

        if (data === "gen_web_pass") {
            const pass = generateWebPass(uid);
            const miniApp = state.BOT_INFO?.username ? `https://t.me/${state.BOT_INFO.username}/app` : config.DASHBOARD_URL;
            return safeEdit(`╭━━━━[ 🔐 *𝗪𝗘𝗕 𝗗𝗔𝗦𝗛𝗕𝗢𝗔𝗥𝗗* ]━━━━╮\n┣ 🆔 *User ID:* \`${uid}\`\n┣ 🔑 *Password:* \`${pass}\`\n┣━━━━━━━━━━━━━━━━━━━━━━━━━━\n┣ 💡 Login at the Web URL to use Drag & Drop.\n┣ 🛜 *Auto-Login (inside Telegram):*\n┣    ${miniApp}\n┣    No password needed when opened from Telegram\n┣ 🌐 *Web Dashboard:* ${config.DASHBOARD_URL}\n╰━━━━━━━━━━━━━━━━━━━━━━━━━━╯`, backBtn("back_main", "🔙 Back"));
        }

        if (data === "buy_prem_req") {
            safeEdit("🚀 乂 𝐁𝐋𝐀𝐙𝐄 𝐍𝐗𝐓 乂\n\n" +
"💎 𝗣𝗥𝗘𝗠𝗜𝗨𝗠 𝗥𝗘𝗤𝗨𝗘𝗦𝗧 𝗦𝗘𝗡𝗧!\n\n" +
"⏳ Your request has been successfully sent to our Admin team.\n" +
"⚡ Approval usually takes 𝗮 𝗳𝗲𝘄 𝗺𝗶𝗻𝘂𝘁𝗲𝘀.\n\n" +
"━━━━━━━━━━━━━━━━━━━\n" +
"🔥 𝗪𝗛𝗬 𝗚𝗢 𝗣𝗥𝗘𝗠𝗜𝗨𝗠?\n" +
"• ⚡ Ultra Fast Checking Speed\n" +
"• 🔢 Up to Unlimited Numbers per check\n" +
"• 🚀 Priority Server Access\n" +
"• 💎 Premium Experience\n" +
"━━━━━━━━━━━━━━━━━━━\n\n" +
"📞 𝗖𝗢𝗡𝗧𝗔𝗖𝗧 𝗔𝗗𝗠𝗜𝗡 𝗙𝗢𝗥 𝗙𝗔𝗦𝗧 𝗔𝗣𝗣𝗥𝗢𝗩𝗔𝗟:\n" +
"• @firstoget\n\n" +
"© *Developed by:* @firstoget\n" +
"⚡ Powered by 乂 𝐁𝐋𝐀𝐙𝐄 𝐍𝐗𝐓 乂", backBtn("back_main"));
            db.admins.forEach(aid => {
                bot.sendMessage(aid, `🚨 *UPGRADE REQUEST*\n┣ 👤 Name: ${q.from.first_name}\n┣ 🆔 ID: \`${uid}\``, {
                    parse_mode: "Markdown", reply_markup: { inline_keyboard: [[{ text: "✅ Approve PRO 30d", callback_data: `apr_sub_${uid}` }]] }
                }).catch(()=>{});
            });
            return;
        }

        if (data.startsWith("apr_sub_") && isAdmin(uid)) {
            const tid = Number(data.split("_")[2]);
            const { addSubscriber } = require("./database"); addSubscriber(tid, 30);
            bot.sendMessage(tid, `✨ *PRO ACTIVATED!*\nYour limit has been upgraded.`, { parse_mode: "Markdown" }).catch(()=>{});
            return safeEdit(`✅ PRO approved for user \`${tid}\`.`, backBtn("open_admin_panel"));
        }

        if (data === "add_sess_req") {
            const slot = `s_${uid}_${Date.now()}`;
            state.setUserStep(uid, { step: "wait_num", slot });
            return safeEdit(`╭━━━[ 📡 *𝗖𝗢𝗡𝗡𝗘𝗖𝗧 𝗡𝗢𝗗𝗘* ]━━━╮\n┣ Send your WhatsApp number.\n┣ Format: digits only, no + sign.\n╰━━━━━━━━━━━━━━━━━━━━━━╯`, backBtn("back_main"));
        }

        if (data === "my_history") {
            const hist = db.history?.[uid];
            if (!hist || hist.length === 0) return safeEdit("📜 *No check history found.*", backBtn("back_main"));
            const lines = hist.slice(0,10).map((h, i) => `${i + 1}. 📅 ${h.date}\n   Total: ${h.total} | ✅ ${h.reg} | 💼 Biz: ${h.isBiz||0} | ❌ ${h.unreg}`).join("\n\n");
            return safeEdit(`╭━━━[ 📜 *𝗠𝗬 𝗛𝗜𝗦𝗧𝗢𝗥𝗬* (Last 10) ]━━━╮\n\n${lines}\n\n╰━━━━━━━━━━━━━━━━━━━━━━╯`, backBtn("back_main"));
        }

        if (data === "show_info") {
            let infoText = `© 2026 ${config.BRAND_NAME} ${config.BRAND_VER}`;
            try { const fs = require("fs"); const cp = require("path").join(__dirname, "COPYRIGHT.txt"); if (fs.existsSync(cp)) infoText = fs.readFileSync(cp, "utf-8"); } catch(_) {}
            return safeEdit(infoText, backBtn("back_main"));
        }

        if (data === "support_chat") {
            return safeEdit(`╭━━━[ 💬 *𝗦𝗨𝗣𝗣𝗢𝗥𝗧 𝗗𝗘𝗦𝗞* ]━━━╮\n┣ Type your message directly in chat.\n┣ (Do not include phone numbers)\n┣ Admins will reply here shortly.\n╰━━━━━━━━━━━━━━━━━━━━━━╯`, backBtn("back_main", "🔙 Back to Main"));
        }

        if (data === "redeem_prompt") {
            return safeEdit(`╭━━━[ 🎁 *𝗥𝗘𝗗𝗘𝗘𝗠 𝗩𝗢𝗨𝗖𝗛𝗘𝗥* ]━━━╮\n┣ To redeem a Promo Code, send the command:\n┣ \`/redeem BLAZE<TIER>-XXXXXX\`\n╰━━━━━━━━━━━━━━━━━━━━━━╯`, backBtn("back_main"));
        }

        // ── API & Webhooks ──
        if (data === "gen_api_key") {
            if(!isSub(uid)) return safeEdit(`❌ *PRO/VIP Tier required to use API.*`, backBtn("api_menu"));
            const key = generateApiKey(uid);
            return safeEdit(`╭━━━[ 🔑 *𝗔𝗣𝗜 𝗞𝗘𝗬 𝗚𝗘𝗡𝗘𝗥𝗔𝗧𝗘𝗗* ]━━━╮\n┣ Your Secret Key:\n┣ \`${key}\`\n┣ ⚠️ Keep it safe.\n╰━━━━━━━━━━━━━━━━━━━━━━╯`, backBtn("api_menu"));
        }

        if (data === "set_webhook") {
            if(!isSub(uid)) return safeEdit(`❌ *PRO/VIP Tier required for Webhooks.*`, backBtn("api_menu"));
            // BUG FIXED IN THIS LINE BELOW!
            return safeEdit(`╭━━━[ 🔗 *𝗦𝗘𝗧 𝗪𝗘𝗕𝗛𝗢𝗢𝗞* ]━━━╮\n┣ To set a webhook, send the command:\n┣ \`/setwebhook https://your-domain.com/api\`\n╰━━━━━━━━━━━━━━━━━━━━━━╯`, backBtn("api_menu"));
        }


        if (data === "retry_failed") {
            const failed = state.lastResults[uid]?.failed || [];
            if (!failed.length) return safeEdit("❌ No failed numbers available to retry.", backBtn("back_main"));
            bot.emit("message", { from: q.from, chat: { id: uid }, text: failed.join("\n") });
            return safeEdit(`🔁 Retrying *${failed.length}* failed numbers...`, backBtn("back_main"));
        }

        // ============================================================
        // 👑 ADMIN ACTIONS
        // ============================================================
        if (!isAdmin(uid)) return;

        if (data === "bot_stats") {
            const s = getStats(); const connected = state.getConnectedSocks().length;
            return safeEdit(`╭━━━━[ 📊 *𝗦𝗬𝗦𝗧𝗘𝗠 𝗦𝗧𝗔𝗧𝗦* ]━━━━╮\n┣ 👥 Users: ${s.totalUsers}\n┣ 🔥 VIP: ${s.totalVIP} | 💎 PRO: ${s.totalPro}\n┣ 🔌 Nodes: ${connected}/${s.sessions}\n┣ ⚙️ RAM: ${(process.memoryUsage().heapUsed/1024/1024).toFixed(1)} MB\n╰━━━━━━━━━━━━━━━━━━━━━━╯`, backBtn("open_admin_panel"));
        }

        if (data === "m_sessions") {
            const keys = Object.keys(state.sessions);
            if (!keys.length) return safeEdit("❌ No active sessions.", backBtn("open_admin_panel"));
            const kb = keys.map(k => [{ text: `🗑️ Delete: ${k.substring(0,10)}...`, callback_data: `del_sess_${k}` }]);
            kb.push([{ text: "🔙 Back", callback_data: "open_admin_panel" }]);
            return safeEdit(`🗄️ *Active Sessions (${keys.length}):*`, { inline_keyboard: kb });
        }

        if (data.startsWith("del_sess_")) {
            const sid = data.replace("del_sess_", "");
            await deleteSession(sid).catch(() => {});
            return safeEdit(`✅ Session \`${sid}\` deleted.`, backBtn("m_sessions", "🔙 Back to Sessions"));
        }

        if (data === "broadcast_msg") {
            state.setUserStep(uid, "broadcast_wait");
            return safeEdit(`╭━━━[ 📢 *𝗕𝗥𝗢𝗔𝗗𝗖𝗔𝗦𝗧* ]━━━╮\n┣ Send your message now.\n╰━━━━━━━━━━━━━━━━━━━━━━╯`, backBtn("open_admin_panel", "🔙 Cancel"));
        }

        if (data === "warmup_nodes") {
            safeEdit(`⏳ *Pinging Nodes...*`, backBtn("open_admin_panel", "🔙 Working..."));
            const res = await warmupNodes();
            return safeEdit(res.ok ? `✅ *Warmup Complete!*\n${res.sent} Pings delivered.` : `❌ *Warmup Failed:* ${res.msg}`, backBtn("open_admin_panel"));
        }

        // ── Admin User Management Steps ──
        const mgmtActions = {
            add_sub_req: "wait_sub_id", rem_sub_list: "wait_rem_sub_id",
            add_vip_req: "wait_vip_id", rem_vip_list: "wait_rem_vip_id",
            ban_req: "wait_ban_id", unban_req: "wait_unban_id"
        };
        if (mgmtActions[data]) {
            state.setUserStep(uid, mgmtActions[data]);
            const actionText = data.replace(/_req|_list/g, "").replace(/_/g, " ").toUpperCase();
            return safeEdit(`🆔 Send the *User ID* to ${actionText}:`, backBtn("user_mgmt_menu", "🔙 Cancel"));
        }

        // ── Voucher Generation ──
        if (data === "gen_vouch_pro_30") {
            const code = createVoucher("PRO", 30, 1);
            return safeEdit(`╭━━━[ 🎁 *𝗣𝗥𝗢 𝗩𝗢𝗨𝗖𝗛𝗘𝗥* ]━━━╮\n┣ 🏷️ Code: \`${code}\`\n┣ ⏳ Duration: 30 Days\n╰━━━━━━━━━━━━━━━━━━━━━━╯`, backBtn("voucher_menu", "🔙 Back"));
        }
        if (data === "gen_vouch_vip_30") {
            const code = createVoucher("VIP", 30, 1);
            return safeEdit(`╭━━━[ 🔥 *𝗩𝗜𝗣 𝗩𝗢𝗨𝗖𝗛𝗘𝗥* ]━━━╮\n┣ 🏷️ Code: \`${code}\`\n┣ ⏳ Duration: 30 Days\n╰━━━━━━━━━━━━━━━━━━━━━━╯`, backBtn("voucher_menu", "🔙 Back"));
        }

        if (data === "all_users_list") {
            const users = getDB().users; const ids = Object.keys(users);
            if (!ids.length) return safeEdit("👥 *No users.*", backBtn("open_admin_panel"));
            safeEdit(`⏳ *Generating Database CSV via Bot...*`, backBtn("open_admin_panel"));
            
            // Generate native CSV for Telegram
            let csv = "ID,Name,Username,Banned\n";
            ids.forEach(id => { csv += `${id},"${users[id].name}","${users[id].username}","${users[id].banned}"\n`; });
            const filePath = path.join(__dirname, `DB_Dump_${Date.now()}.csv`);
            fs.writeFileSync(filePath, csv);
            await bot.sendDocument(uid, filePath, { caption: "👥 Database Export" }).catch(()=>{});
            fs.unlinkSync(filePath);
            return;
        }

        // ============================================================
        // ⚡ OWNER ACTIONS (Root Access)
        // ============================================================
        if (!isOwner(uid)) return;

        if (data === "add_adm_req") {
            state.setUserStep(uid, "wait_adm_id");
            return safeEdit("🆔 Send the *User ID* to make Admin:", backBtn("open_owner_panel", "🔙 Cancel"));
        }

        if (data === "rem_adm_list") {
            const admins = db.admins.filter(i => i !== config.OWNER_ID);
            if (!admins.length) return safeEdit("❌ No other admins.", backBtn("open_owner_panel"));
            const kb = admins.map(id => [{ text: `❌ Remove Admin ${id}`, callback_data: `do_rem_adm_${id}` }]);
            kb.push([{ text: "🔙 Cancel", callback_data: "open_owner_panel" }]);
            return safeEdit("Select admin to remove:", { inline_keyboard: kb });
        }

        if (data.startsWith("do_rem_adm_")) {
            const tid = Number(data.replace("do_rem_adm_", ""));
            removeAdmin(tid);
            return safeEdit(`✅ Admin \`${tid}\` removed.`, backBtn("open_owner_panel"));
        }

        if (data === "toggle_maint") {
            const newMaintState = !db.meta.maintenance;
            const { setMaintenance } = require("./database"); setMaintenance(newMaintState);
            return safeEdit(`🚧 *Maintenance Mode:* ${newMaintState ? 'ON (Locked)' : 'OFF (Open)'}`, backBtn("open_owner_panel"));
        }

        if (data === "mode_free" || data === "mode_subscription") {
            const mode = data === "mode_free" ? "free" : "subscription";
            const ok = config.setDynamicConfig({ SYSTEM_MODE: mode });
            return safeEdit(ok ? `✅ *System Mode Updated:* ${mode.toUpperCase()}

${mode === 'free' ? 'All users can use premium system features.' : 'Subscription tiers are now enforced.'}` : "❌ Failed to update mode.", backBtn("open_owner_panel"));
        }

        if (data === "force_backup") {
            try {
                const dbPath = config.dataPath(config.DB_FILE);
                if (fs.existsSync(dbPath)) fs.copyFileSync(dbPath, dbPath + '.bak_manual');
                else fs.writeFileSync(dbPath + '.bak_manual', JSON.stringify(require('./database').getDB(), null, 2));
                return safeEdit("💾 *Manual Backup Created Successfully!*", backBtn("open_owner_panel"));
            }
            catch(e) { return safeEdit("❌ Backup Failed.", backBtn("open_owner_panel")); }
        }

    });
};
