// ============================================================
//   WS CHECKER v6 | bot_messages.js
//   Message Handler: Multi-Step Prompts, Checker, Support Chat
// ============================================================

"use strict";

const { 
    getDB, isAdmin, isSub, isVIP, isBanned, isOwner, getUserLang, 
    registerUser, addAdmin, removeAdmin, 
    addSubscriber, removeSubscriber, addVIP, removeVIP, 
    banUser, unbanUser 
} = require("./database");
const { sendBroadcastReport, parseNumbers } = require("./utils");
const { startSession, requestPairingCode }  = require("./whatsapp");
const { runHumanChecker }                   = require("./checker");
const config                                = require("./config");
const state                                 = require("./state");
const { tr }                                = require("./i18n");

module.exports = (bot) => {
    bot.on("message", async (msg) => {
        if (!msg || !msg.from) return;
        
        const uid  = msg.from.id;
        const text = msg.text;

        // Ignore commands and empty messages
        if (!text || text.startsWith("/")) return; 

        // 1. Auto-Register & Fetch Live Database/Config
        registerUser(msg.from);
        const db = getDB();
        const dynConfig = config.dynamic; // Fetches LIVE config without server restart
        const L = getUserLang(uid);

        // 2. Security Guards (Banned & Maintenance)
        if (isBanned(uid) && !isOwner(uid)) {
            return bot.sendMessage(uid, "🚫 *𝗔𝗖𝗖𝗘𝗦𝗦 𝗗𝗘𝗡𝗜𝗘𝗗*\nYou are banned from this engine.", { parse_mode: "Markdown" }).catch(() => {});
        }

        if (db.meta?.maintenance && !isAdmin(uid)) {
            return bot.sendMessage(uid, "🚧 *MAINTENANCE MODE*\nEngine is offline for upgrades. Check back later.", { parse_mode: "Markdown" }).catch(() => {});
        }

        const send = (t, opts = {}) => bot.sendMessage(uid, t, { parse_mode: "Markdown", ...opts }).catch(() => {});
        const step = state.getUserStep(uid);

        // ============================================================
        // 🎛️ MULTI-STEP ADMIN WORKFLOWS
        // ============================================================
        if (step && typeof step === "string") {
            const tid = Number(text.trim());
            
            // Validate ID format for all ID-based steps
            if (step !== "broadcast_wait" && isNaN(tid)) {
                return send("❌ *Invalid ID Format.* Please send numbers only.");
            }

            // ── Owner Specific Steps ──
            if (step === "wait_adm_id" && isOwner(uid)) {
                addAdmin(tid); state.clearUserStep(uid); 
                return send(`✅ *Admin Privileges Granted* to \`${tid}\``);
            }
            if (step === "wait_rem_adm_id" && isOwner(uid)) {
                removeAdmin(tid); state.clearUserStep(uid); 
                return send(`🗑️ *Admin Privileges Revoked* from \`${tid}\``);
            }

            // ── Admin Specific Steps ──
            if (isAdmin(uid)) {
                switch(step) {
                    case "wait_sub_id":
                        addSubscriber(tid, 30); state.clearUserStep(uid);
                        bot.sendMessage(tid, `✨ *PRO TIER ACTIVATED!*\nYour account has been upgraded.`, { parse_mode: "Markdown" }).catch(() => {});
                        return send(`✅ *PRO Granted* to \`${tid}\``);
                        
                    case "wait_rem_sub_id":
                        removeSubscriber(tid); state.clearUserStep(uid);
                        bot.sendMessage(tid, `⚠️ *PRO TIER EXPIRED/REVOKED.*`, { parse_mode: "Markdown" }).catch(() => {});
                        return send(`➖ *PRO Removed* from \`${tid}\``);

                    case "wait_vip_id":
                        addVIP(tid, 30); state.clearUserStep(uid);
                        bot.sendMessage(tid, `🔥 *GOD TIER UNLOCKED!*\nYour account is now VIP. Enjoy maximum limits.`, { parse_mode: "Markdown" }).catch(() => {});
                        return send(`🔥 *VIP Granted* to \`${tid}\``);
                        
                    case "wait_rem_vip_id":
                        removeVIP(tid); state.clearUserStep(uid);
                        return send(`➖ *VIP Removed* from \`${tid}\``);

                    case "wait_ban_id":
                        if (isOwner(tid)) return send("❌ *Cannot ban the Engine Creator.*");
                        banUser(tid); state.clearUserStep(uid);
                        return send(`🚫 *User Banned:* \`${tid}\``);

                    case "wait_unban_id":
                        unbanUser(tid); state.clearUserStep(uid);
                        return send(`✅ *User Unbanned:* \`${tid}\``);

                    case "broadcast_wait":
                        state.clearUserStep(uid);
                        const uids = Object.keys(getDB().users);
                        const suc = [], fail = [];
                        await send(`📢 *Broadcasting to ${uids.length} users...*`);
                        
                        for (const id of uids) {
                            try { 
                                await bot.sendMessage(id, `📢 *𝗕𝗥𝗢𝗔𝗗𝗖𝗔𝗦𝗧*\n\n${text}\n\n⚡ _${config.BRAND_NAME}_`, { parse_mode: "Markdown" }); 
                                suc.push(id); 
                            } catch (_) { fail.push(id); }
                        }
                        return sendBroadcastReport(bot, config.OWNER_ID, suc, fail);
                }
            }
        }

        // ============================================================
        // 📡 NODE PAIRING WORKFLOW
        // ============================================================
        if (step && typeof step === "object" && step.step === "wait_num") {
            const slot = step.slot; 
            const num = text.replace(/[^0-9]/g, "");
            
            if (!num || num.length < 7) return send(`❌ *Invalid number format.* Send digits only.`);
            
            state.clearUserStep(uid);
            // Type chosen on the "Add Node" screen (🔒 Private / 🌍 Public).
            // Private = runs only this user's checks; Public = shared pool.
            const sessionType = step && step.type === "public" ? "public" : "private";
            
            await send(`⏳ *Preparing ${sessionType.toUpperCase()} Pairing...*\nSetting up secure pairing for \`+${num}\``);
            
            try {
                await startSession(slot, msg.from.first_name, { id: uid, name: msg.from.first_name, username: msg.from.username || "N/A" }, sessionType, bot);
                
                // Wait for socket to boot up
                await new Promise(r => setTimeout(r, 6000));
                
                if (!state.sessions[slot]?.sock) return send(`❌ *Node Initialization Failed.* Server might be busy. Try again.`);
                
                const code = await requestPairingCode(slot, num);
                return send(
                    `╭━━━━[ 📡 *${config.PAIRING_BRAND} PAIRING* ]━━━━╮\n` +
                    `┣ 📱 *Number:* \`+${num}\`\n` +
                    `┣ 🎖️ *Type:* ${sessionType === "public" ? "🌍 PUBLIC (shared pool)" : "🔒 PRIVATE (your checks only)"}\n` +
                    `┣ 🔑 *Code:* \`${code}\`\n` +
                    `┣━━━━━━━━━━━━━━━━━━━━━━━━━━\n` +
                    `┣ ⏳ *Expires in:* 30 seconds\n` +
                    `┣ 📲 Open WhatsApp → Linked Devices\n` +
                    `┣ 📝 Type *${code}* exactly on the phone\n` +
                    `╰━━━━━━━━━━━━━━━━━━━━━━━━━━╯`
                );
            } catch (err) {
                return send(`❌ *𝗣𝗔𝗜𝗥𝗜𝗡𝗚 𝗙𝗔𝗜𝗟𝗘𝗗:* \n\`${err.message}\``);
            }
        }

        // ============================================================
        // 💬 SUPPORT CHAT vs 🔍 NUMBER CHECKER LOGIC
        // ============================================================
        const numbers = parseNumbers(text);
        
        // ── 1. Support Chat (No valid phone numbers found in text) ──
        if (numbers.length === 0) {
            if (!state.chats[uid]) state.chats[uid] = [];
            state.chats[uid].push({ 
                sender: 'user', 
                text: text, 
                ts: new Date().toLocaleTimeString('en-IN', { timeZone: 'Asia/Kolkata' }) 
            });
            
            // Push Notification to Web Dashboard
            state.pushNotification(`💬 New Msg from ${msg.from.first_name}`, 'info');
            return send(`📨 _Message sent to Support Desk. An Admin will review and reply here._`);
        }

        // ── 2. Number Checker Engine ──
        
        if (state.isProcessing(uid)) {
            return send(`⚠️ *Engine Busy.* A check job is already running for your account.\nUse /reset to abort.`);
        }
        
        if (state.processingUsers.size >= dynConfig.MAX_PARALLEL) {
            return send(`🔴 *Server Overloaded.* All parallel threads are occupied. Please queue up in a moment.`);
        }
        
        // Dynamic Tier Limit Resolution
        // Owner/Admin retain full rights. Free Mode gives all regular users VIP limit.
        let userLimit = dynConfig.FREE_LIMIT;
        if (isOwner(uid) || isAdmin(uid)) userLimit = 9999999;
        else if (String(dynConfig.SYSTEM_MODE || "subscription").toLowerCase() === "free") userLimit = dynConfig.VIP_LIMIT;
        else if (isVIP(uid)) userLimit = dynConfig.VIP_LIMIT;
        else if (isSub(uid)) userLimit = dynConfig.PRO_LIMIT;

        if (numbers.length > userLimit) {
            return send(`⚠️ *Limit Exceeded!*\nYour tier limit is *${userLimit}* numbers per batch.\nYou sent: *${numbers.length}*.`);
        }

        const activeSocks = state.getActiveSocksForUser(uid);
        if (activeSocks.length === 0) {
            return send(`❌ *No Nodes Available.*\nPlease connect a Private Session using the menu.`);
        }

        // Lock User State & Init UI
        state.addProcessing(uid); 
        state.initWebState(uid, numbers.length);
        
        const statusMsg = await bot.sendMessage(uid, `🚀 *Engine Fired Up!*\nInitializing deep scan for ${numbers.length} numbers using ${activeSocks.length} nodes...`, { parse_mode: "Markdown" }).catch(() => null);

        // Launch God Mode Checker
        runHumanChecker(uid, numbers, activeSocks, bot, statusMsg?.message_id).catch((err) => {
            console.error("❌ Checker Crash in bot_messages:", err); 
            state.removeProcessing(uid);
        });
    });
};
