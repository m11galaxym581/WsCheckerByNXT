// ============================================================
//   ⚡ BLAZE NXT — V4.0 GOD MODE (MEGABEAST) | bot_commands.js
//   Telegram Bot Commands — Role-Based Routing & Rich Menus
// ============================================================

"use strict";

const { 
    getDB, saveDB, isAdmin, isSub, isVIP, isBanned, isOwner, 
    registerUser, getStats, redeemVoucher, createVoucher, 
    setWebhook, generateApiKey, addAdmin, removeAdmin, 
    addSubscriber, removeSubscriber, addVIP, removeVIP, 
    banUser, unbanUser, setMaintenance 
} = require("./database");
const { sendBroadcastReport } = require("./utils");
const { warmupNodes }         = require("./whatsapp");
const config                  = require("./config");
const state                   = require("./state");

module.exports = (bot) => {

    // ============================================================
    // 🎛️ INLINE KEYBOARD MENU BUILDERS (WITH DEEP NAVIGATION & BACK)
    // ============================================================

    // ── 1. User Main Menu ──
    function mainMenu(uid) {
        const btns = [
            [{ text: "🔍 START CHECKER",          callback_data: "start_check"     }],
            [{ text: "Login to Dashboard",       callback_data: "gen_web_pass"    }],
            [{ text: "💎 Upgrade Tier",           callback_data: "buy_prem_req"    }, { text: "🎁 Redeem Code",   callback_data: "redeem_prompt"  }],
            [{ text: "📱 Connect Private Node",   callback_data: "add_sess_req"    }],
            [{ text: "📜 Check History",          callback_data: "my_history"      }, { text: "⚙️ API & Webhooks", callback_data: "api_menu"       }],
            [{ text: "ℹ️ System Info",            callback_data: "show_info"       }, { text: "💬 Support",       callback_data: "support_chat"   }],
        ];
        if (isAdmin(uid)) btns.push([{ text: "👑 ADMIN CONSOLE", callback_data: "open_admin_panel" }]);
        if (isOwner(uid)) btns.push([{ text: "⚡ GOD MODE (OWNER)", callback_data: "open_owner_panel" }]);
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

    // ── /start ────────────────────────────────────────────────
    bot.onText(/\/start/, async (msg) => {
        const uid = msg.from.id;
        registerUser(msg.from);
        
        if (isBanned(uid) && !isOwner(uid)) {
            return bot.sendMessage(uid, `🚫 *𝗔𝗖𝗖𝗘𝗦𝗦 𝗗𝗘𝗡𝗜𝗘𝗗*\nYou are permanently banned from this engine.`, { parse_mode: "Markdown" });
        }

        const db = getDB();
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
        
        return bot.sendMessage(uid,
            `╭━━━━━━[ ⚡ *𝗕𝗟𝗔𝗭𝗘 𝗡𝗫𝗧  V4.0* ]━━━━━━╮\n` +
            `┣ 👤 *Welcome,* ${msg.from.first_name}!\n` +
            `┣ 🆔 *Your ID:* \`${uid}\`\n` +
            `┣ 🎖️ *Status:* ${statusBadge}\n` +
            `┣━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n` +
            `┣ 🔌 *Nodes Active:* ${connCount}/${sessCount} Connected\n` +
            `┣ 🌐 *System Mode:* ${freeMode ? 'FREE' : 'SUBSCRIPTION'}\n` +
            `┣ 🚀 *Engine Mode:* 0-Delay Multi-Thread\n` +
            `┣ 🛡️ *Security:* Proxied Anti-Ban\n` +
             `┣ 🌐 *Web Dashboard:* ${config.DASHBOARD_URL} \n` +
            `╰━━━━━━━━━━━━━━━━━━━━━━━━━━━━╯`,
            { parse_mode: "Markdown", ...mainMenu(uid) }
        );
    });

    // ── /help ─────────────────────────────────────────────────
    bot.onText(/\/help/, async (msg) => {
        const uid = msg.from.id;
        const text = `
╭━━━[ 🛠️ *𝗛𝗘𝗟𝗣 & 𝗖𝗢𝗠𝗠𝗔𝗡𝗗𝗦* ]━━━╮
┣ /start - Open Main Menu
┣ /reset - Clear active jobs & web state
┣ /redeem \`<code>\` - Claim Promo Voucher
┣ /setwebhook \`<url>\` - Set API Webhook
┣ /info - System Information
╰━━━━━━━━━━━━━━━━━━━━━━╯`;
        return bot.sendMessage(uid, text, { parse_mode: "Markdown", reply_markup: { inline_keyboard: [[{text: "🔙 Back", callback_data: "back_main"}]] } });
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
