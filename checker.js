// ============================================================
//   WS CHECKER v6 | checker.js
//   Anti-Ban WhatsApp Scraper & Load-Balanced Engine
// ============================================================

"use strict";

const fs = require("fs");
const path = require("path");
const { appendHistory, getDB, getUserLang } = require("./database");
const { getProgressBar, getETA, chunkArray, buildResultText, buildResultCSV, safeUnlink, fmtDuration } = require("./utils");
const config = require("./config");
const state = require("./state");
const { tr } = require("./i18n");

// ── Webhook Trigger Helper ────────────────────────────────────
async function triggerWebhook(url, payload) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 10000);
    try {
        const res = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload),
            signal: controller.signal
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        console.log(`📡 [Webhook] Delivered payload to ${url}`);
    } catch(e) {
        console.log(`⚠️ [Webhook] Failed to send payload to ${url}: ${e.message}`);
    } finally {
        clearTimeout(timer);
    }
}

// ── Micro-Jitter Helper (Anti-Ban) ────────────────────────────
const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));



function saveJobState(uid, data) {
    try {
        const dir = path.join(config.DATA_ROOT, "job_state");
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(path.join(dir, `${uid}.json`), JSON.stringify({ ...data, updatedAt: new Date().toISOString() }, null, 2));
        // Mirror into Postgres so resume-state survives Railway redeploys.
        try { require("./pg_state").saveJob(uid, { ...data, updatedAt: new Date().toISOString() }); } catch (_) {}
    } catch (_) {}
}

// ── Telegram Result Delivery Helper ───────────────────────────
async function sendTelegramResultFiles(bot, uid, reg, unreg, failed, meta) {
    const dir = path.join(config.DATA_ROOT, "tmp_results");
    fs.mkdirSync(dir, { recursive: true });
    const stamp = Date.now();
    const txtPath = path.join(dir, `WSCheck_${uid}_${stamp}.txt`);
    const csvPath = path.join(dir, `WSCheck_${uid}_${stamp}.csv`);
    try {
        fs.writeFileSync(txtPath, buildResultText(reg, unreg, { ...meta, failed }), "utf8");
        fs.writeFileSync(csvPath, buildResultCSV(reg, unreg, failed), "utf8");

        await bot.sendDocument(uid, txtPath, {
            caption: `📄 TXT Result | ✅ ${reg.length} | ❌ ${unreg.length} | ⚠️ ${failed.length}`
        }).catch(e => console.error("⚠️ [Telegram TXT Send Failed]:", e.message));

        await bot.sendDocument(uid, csvPath, {
            caption: `📊 Detailed CSV Result | Duration: ${fmtDuration(meta.duration || 0)}`
        }).catch(e => console.error("⚠️ [Telegram CSV Send Failed]:", e.message));
    } finally {
        safeUnlink(txtPath);
        safeUnlink(csvPath);
    }
}

// ── Main Checker Engine ───────────────────────────────────────
async function runHumanChecker(uid, numbers, activeSocks, bot, statusMsgId) {
    const L = getUserLang(uid);
    const reg = []; 
    const unreg = [];
    const failed = []; 
    let bizCount = 0;
    
    const total = numbers.length; 
    const nodeCount = activeSocks.length;
    const startedAt = Date.now(); 
    let editFails = 0, checked = 0, batchIndex = 0;
    saveJobState(uid, { status: "Running", total, remaining: numbers, reg: [], unreg: [], failed: [] });

    // 🔥 1. MASTER BEAST: 500 NUMBERS PER NODE RULE 🔥
    const MAX_PER_NODE = 500;
    const requiredNodes = Math.ceil(total / MAX_PER_NODE);

    if (nodeCount < requiredNodes) {
        const errorMsg = 
            `╭━━━[ 🛑 *𝗔𝗡𝗧𝗜-𝗕𝗔𝗡 𝗦𝗛𝗜𝗘𝗟𝗗* ]━━━╮\n` +
            `┣ ⚠️ *NODE LIMIT EXCEEDED*\n` +
            `┣━━━━━━━━━━━━━━━━━━━━━━\n` +
            `┣ To scan *${total}* numbers safely at Max Speed,\n` +
            `┣ you must connect at least *${requiredNodes} Nodes*.\n` +
            `┣ 📊 *Rule:* 1 Node = 500 Numbers Max\n` +
            `┣ 🔌 *Your Active Nodes:* ${nodeCount}\n` +
            `┣━━━━━━━━━━━━━━━━━━━━━━\n` +
            `┣ 💡 _Go to Web/Menu -> Add Session_\n` +
            `╰━━━━━━━━━━━━━━━━━━━━━━╯`;
        
        await bot.sendMessage(uid, errorMsg, { parse_mode: "Markdown" }).catch(()=>{});
        
        // Notify Web UI
        if(state.pushNotification) state.pushNotification(`Anti-Ban: Connect ${requiredNodes} nodes for ${total} numbers.`, 'error');
        state.updateWebState(uid, { status: "Cancelled" });
        state.removeProcessing(uid);
        return; // Kill process instantly to prevent ban
    }

    // Load Dynamic Config
    const dynConfig = config.dynamic;

    // 🔥 2. DYNAMIC CONCURRENCY (Max Speed / Zero Delay) 🔥
    // Distribute 15 parallel requests per active node at exactly the same time
    const concurrentLimit = nodeCount * 15; 
    const batches = chunkArray(numbers, concurrentLimit); 

    try {
        for (const batch of batches) {
            // Cancellation Check
            if (state.getWebState(uid)?.status === "Cancelled") break;

            const batchPromises = batch.map(async (numStr, idx) => {
                const sock = activeSocks[idx % nodeCount]; 
                const num = numStr.replace(/[^0-9]/g, "");
                
                if (!num) { failed.push(String(numStr)); return; }

                try {
                    // 🔥 3. TCP MICRO-JITTER (De-syncs WhatsApp Burst Detection) 🔥
                    // Adds a tiny 10ms to 80ms invisible gap between parallel requests.
                    // This breaks the "Bot Pattern" without affecting the overall user speed.
                    await delay((idx % nodeCount) * 15 + Math.floor(Math.random() * 50));

                    const startCall = Date.now();
                    
                    // Connect and fetch with 15-sec hard timeout
                    const [result] = await Promise.race([
                        sock.onWhatsApp(num), 
                        new Promise((_, rej) => setTimeout(() => rej(new Error("timeout")), 15000))
                    ]);
                    
                    // Track Node Health / TPS
                    const latency = Date.now() - startCall;
                    if (state.updateNodeHealth) state.updateNodeHealth(sock.user?.id || "node", latency);
                    if (state.recordNodeResult) state.recordNodeResult(sock, true, latency);

                    if (result?.exists) {
                        let isBiz = false, about = "N/A", dp = "No DP";
                        let bizCategory = "N/A", bizEmail = "N/A", bizWebsite = "N/A";
                        const jid = result.jid;

                        // Deep Scraping with mini-delay to prevent profile-ban
                        try { 
                            const biz = await sock.getBusinessProfile(jid); 
                            if(biz) { 
                                isBiz = true; 
                                bizCount++; 
                                if(biz.category) bizCategory = biz.category;
                                if(biz.email) bizEmail = biz.email;
                                if(biz.website && biz.website.length) bizWebsite = biz.website[0];
                            } 
                        } catch(e){}

                        try { about = (await sock.fetchStatus(jid))?.status || about; } catch(e){}
                        try { dp = await sock.profilePictureUrl(jid, 'image'); } catch(e){}

                        reg.push({ 
                            num: "+" + num, 
                            isBiz, 
                            about, 
                            dp, 
                            bizCategory, 
                            bizEmail, 
                            bizWebsite 
                        });
                    } else { 
                        unreg.push("+" + num); 
                    }
                } catch (e) { 
                    if (state.recordNodeResult) state.recordNodeResult(sock, false, 0);
                    failed.push("+" + num); 
                }
            });

            // Process the parallel batch instantly
            await Promise.allSettled(batchPromises);
            checked = reg.length + unreg.length + failed.length;
            
            saveJobState(uid, { status: "Running", total, checked, remaining: numbers.slice(checked), reg, unreg, failed, bizCount });
            // Sync with Web Dashboard
            state.updateWebState(uid, { current: checked, reg: reg.length, unreg: unreg.length, failed: failed.length, bizCount, nodes: nodeCount, status: "Checking" });

            // Telegram Live Update (Throttled using dynamic config)
            batchIndex++;
            if (statusMsgId && (batchIndex % dynConfig.PROGRESS_UPDATE_EVERY === 0 || checked >= total) && editFails < 5) {
                bot.editMessageText(
                    `╭━━━[ ⚡ *𝗠𝗔𝗦𝗧𝗘𝗥 𝗕𝗘𝗔𝗦𝗧 𝗘𝗡𝗚𝗜𝗡𝗘* ]━━━╮\n` +
                    `┣ ${getProgressBar(checked, total)}\n` +
                    `┣ 📊 *Progress:* ${checked}/${total}\n` +
                    `┣ ✅ *Found:* ${reg.length} (💼 Biz: ${bizCount})\n` +
                    `┣ ⚠️ *Failed/Unknown:* ${failed.length}\n` +
                    `┣ 🚀 *Active Nodes:* ${nodeCount}x\n` +
                    `┣ ⏱️ *ETA:* ${getETA(startedAt, checked, total)}\n` +
                    `╰━━━━━━━━━━━━━━━━━━━━━━╯`, 
                    { chat_id: uid, message_id: statusMsgId, parse_mode: "Markdown" }
                ).catch((e) => { editFails++; console.warn(`⚠️ [TG] live progress edit failed (${editFails}x):`, e.message); });
            }
        }

        // ── COMPLETION PHASE ──
        if (state.getWebState(uid)?.status !== "Cancelled") {
            const finalDuration = Date.now() - startedAt;
            
            state.updateWebState(uid, { current: total, reg: reg.length, unreg: unreg.length, failed: failed.length, bizCount, nodes: nodeCount, status: "Completed" });
            appendHistory(uid, { total, reg: reg.length, unreg: unreg.length, failed: failed.length, bizCount, duration: finalDuration });
            
            saveJobState(uid, { status: "Completed", total, checked: total, remaining: [], reg, unreg, failed, bizCount, duration: finalDuration });
            // Store rich data in memory for Web UI Download
            state.lastResults[uid] = { reg, unreg, failed };
            if (state.pushUserNotification) state.pushUserNotification(uid, `✅ Job completed: ${reg.length} found, ${unreg.length} unregistered, ${failed.length} failed`, 'success'); 

            // 🔥 WEBHOOK TRIGGER 🔥
            if (dynConfig.ENABLE_WEBHOOKS) {
                const db = getDB();
                const u = db.users[Number(uid)];
                if (u && u.webhookUrl) {
                    await triggerWebhook(u.webhookUrl, {
                        event: 'scan_completed',
                        userId: uid,
                        totalScanned: total,
                        registered: reg,
                        unregistered: unreg,
                        failed,
                        durationMs: finalDuration,
                        timestamp: new Date().toISOString()
                    });
                }
            }

            // Send results directly to Telegram bot chat + keep Web dashboard download.
            await bot.sendMessage(uid,
                `✅ *Scan Complete!*\n\n` +
                `📊 *Total:* ${total}\n` +
                `✅ *Registered:* ${reg.length}\n` +
                `❌ *Unregistered:* ${unreg.length}\n` +
                `⚠️ *Failed/Unknown:* ${failed.length}\n` +
                `💼 *Business:* ${bizCount}\n` +
                `⏱️ *Duration:* ${fmtDuration(finalDuration)}\n\n` +
                `Sending TXT + CSV files below...`,
                {parse_mode:"Markdown", reply_markup: { inline_keyboard: [[{ text: "🔁 Retry Failed", callback_data: "retry_failed" }, { text: "🌐 Open Web", url: config.DASHBOARD_URL + "/dashboard" }]] }}
            ).catch(()=>{});

            await sendTelegramResultFiles(bot, uid, reg, unreg, failed, { total, duration: finalDuration });
        }
    } catch (err) { 
        console.error("❌ [Checker Error]:", err);
        state.updateWebState(uid, { status: "Error" }); 
    } finally { 
        if (state.getWebState(uid)?.status === "Cancelled") saveJobState(uid, { status: "Cancelled", total, checked, remaining: numbers.slice(checked), reg, unreg, failed, bizCount });
        state.removeProcessing(uid); 
    }
}

module.exports = { runHumanChecker };
