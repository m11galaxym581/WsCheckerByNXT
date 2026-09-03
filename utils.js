// ============================================================
//   ⚡ BLAZE NXT — V4.0 GOD MODE | utils.js
//   Advanced Utilities — Formatting, Sorters, Exporters
// ============================================================

"use strict";

// ── Progress Bar & Speed ──────────────────────────────────────

/**
 * Generate a visual progress bar.
 */
function getProgressBar(current, total, barLen = 14) {
    if (!total || total === 0) return `[${"░".repeat(barLen)}] 0%`;
    const percent = Math.min(100, Math.floor((current / total) * 100));
    const filled  = Math.floor((percent / 100) * barLen);
    const empty   = barLen - filled;
    const bar     = "█".repeat(filled) + "░".repeat(empty);
    return `[${bar}] ${percent}%`;
}

/**
 * Get a speed/ETA string for progress messages including TPS.
 */
function getETA(startedAt, current, total) {
    if (!startedAt || current <= 0) return "Calculating...";
    const elapsed = (Date.now() - startedAt) / 1000; // seconds
    const rate    = current / elapsed;               // TPS (Tasks Per Second)
    
    if (!rate || rate <= 0) return "Calculating...";
    const remaining = (total - current) / rate;
    
    let timeStr = "";
    if (remaining < 60)  timeStr = `~${Math.ceil(remaining)}s`;
    else if (remaining < 3600) timeStr = `~${Math.ceil(remaining / 60)}m`;
    else timeStr = `~${(remaining / 3600).toFixed(1)}h`;

    return `${timeStr} (${rate.toFixed(1)}/sec)`;
}

// ── Number Parsing & Analysis ─────────────────────────────────

/**
 * Parse and clean a list of phone numbers from raw text.
 */
function parseNumbers(text) {
    if (!text || typeof text !== "string") return [];
    const seen = new Set();
    return text
        .split(/[\r\n,;]+/)
        .map(n => n.replace(/[^0-9]/g, "").trim())
        .filter(n => n.length >= 7 && n.length <= 15)
        .filter(n => {
            if (seen.has(n)) return false;
            seen.add(n);
            return true;
        });
}

/**
 * Very basic Country Guesser based on prefixes.
 */
function guessCountry(num) {
    const n = String(num).replace(/[^0-9]/g, "");
    if (n.startsWith("91")) return "🇮🇳 India (+91)";
    if (n.startsWith("1")) return "🇺🇸/🇨🇦 US/Canada (+1)";
    if (n.startsWith("44")) return "🇬🇧 United Kingdom (+44)";
    if (n.startsWith("92")) return "🇵🇰 Pakistan (+92)";
    if (n.startsWith("880")) return "🇧🇩 Bangladesh (+880)";
    if (n.startsWith("55")) return "🇧🇷 Brazil (+55)";
    if (n.startsWith("62")) return "🇮🇩 Indonesia (+62)";
    if (n.startsWith("60")) return "🇲🇾 Malaysia (+60)";
    if (n.startsWith("234")) return "🇳🇬 Nigeria (+234)";
    return "🌍 Other Regions";
}

// ── Message Sending Helpers ───────────────────────────────────

/**
 * Send a message that may exceed Telegram's 4096-char limit.
 */
async function sendLongMessage(bot, chatId, text, opts = {}) {
    const LIMIT = 4000;
    for (let i = 0; i < text.length; i += LIMIT) {
        const chunk = text.substring(i, i + LIMIT);
        await bot.sendMessage(chatId, chunk, i === 0 ? opts : {}).catch(() => {});
    }
}

/**
 * Send a broadcast report to the owner.
 */
async function sendBroadcastReport(bot, ownerId, successList, failList) {
    const header   = `📢 *𝗕𝗥𝗢𝗔𝗗𝗖𝗔𝗦𝗧 𝗥𝗘𝗣𝗢𝗥𝗧*\n\n`;
    const sucPart  = successList.length
        ? `✅ *Delivered (${successList.length}):*\n${successList.slice(0, 100).join("\n")}`
        : "✅ *Delivered:* 0";
    const failPart = failList.length
        ? `\n\n❌ *Failed (${failList.length}):*\n${failList.slice(0, 50).join("\n")}`
        : "";
    await sendLongMessage(bot, ownerId, header + sucPart + failPart, { parse_mode: "Markdown" });
}

// ── Formatting ────────────────────────────────────────────────

function fmtNum(n) { return Number(n).toLocaleString("en-IN"); }

function fmtDuration(ms) {
    if (ms < 1000)  return `${ms}ms`;
    const s = Math.floor(ms / 1000); const m = Math.floor(s / 60); const h = Math.floor(m / 60);
    if (h > 0) return `${h}h ${m % 60}m ${s % 60}s`;
    if (m > 0) return `${m}m ${s % 60}s`;
    return `${s}s`;
}

function fmtBytes(bytes) {
    if (bytes === 0) return '0 Bytes';
    const k = 1024; const sizes = ['Bytes', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}

// ── Result Exporters (TXT & CSV) ──────────────────────────────

/**
 * Build the standard Result TXT string (Supports God Mode deep data & Auto-Sorting).
 */
function buildResultText(reg, unreg, meta = {}) {
    const failed = Array.isArray(meta.failed) ? meta.failed : [];
    const line = "═".repeat(45);
    const ts   = new Date().toLocaleString("en-IN", { timeZone: "Asia/Kolkata" });
    const dur  = meta.duration ? `\n⏱  Duration   : ${fmtDuration(meta.duration)}` : "";
    
    let txt = `${line}\n   ⚡ BLAZE NXT — V5.0 UPGRADED RESULTS\n${line}\n\n`;
    txt += `📅 Date       : ${ts}\n📊 Total      : ${fmtNum(meta.total || reg.length + unreg.length + failed.length)}\n✅ Registered : ${fmtNum(reg.length)}\n❌ Unreg      : ${fmtNum(unreg.length)}\n⚠️ Failed     : ${fmtNum(failed.length)}${dur}\n\n${line}\n\n`;

    // Advanced Country Sorting
    let sorted = {};
    reg.forEach(item => {
        let nStr = typeof item === 'object' ? (item.num || item) : item;
        let isB  = typeof item === 'object' && item.isBiz ? " (BUSINESS)" : "";
        let bio  = typeof item === 'object' && item.about ? ` - Bio: ${String(item.about).substring(0,30)}` : "";
        let cc   = guessCountry(nStr);
        if(!sorted[cc]) sorted[cc] = [];
        sorted[cc].push(`${nStr}${isB}${bio}`);
    });

    txt += `✅ REGISTERED (SORTED BY REGION):\n\n`;
    for(let country in sorted) {
        txt += `[ ${country} ] — ${sorted[country].length} numbers\n`;
        txt += sorted[country].join("\n") + "\n\n";
    }

    txt += `${line}\n\n❌ UNREGISTERED (${unreg.length}):\n${unreg.join("\n") || "None"}\n\n`;
    txt += `${line}\n\n⚠️ FAILED / UNKNOWN (${failed.length}):\n${failed.join("\n") || "None"}\n\n${line}`;
    return txt;
}

/**
 * Build a CSV string containing Deep Scraping data.
 */
function buildResultCSV(reg, unreg, failed = []) {
    let csv = "Number,AccountType,Bio/Status,Category,Email,Website,DP_Link\n";
    
    reg.forEach(item => {
        if (typeof item === 'object') {
            const num = item.num || "N/A";
            const type = item.isBiz ? "Business" : "Normal";
            const bio = String(item.about || "").replace(/"/g, '""'); // escape quotes
            const cat = String(item.bizCategory || "N/A").replace(/"/g, '""');
            const email = String(item.bizEmail || "N/A").replace(/"/g, '""');
            const web = String(item.bizWebsite || "N/A").replace(/"/g, '""');
            const dp = String(item.dp || "N/A").replace(/"/g, '""');
            csv += `"${num}","${type}","${bio}","${cat}","${email}","${web}","${dp}"\n`;
        } else {
            csv += `"${item}","Normal","N/A","N/A","N/A","N/A","N/A"\n`;
        }
    });

    unreg.forEach(u => {
        csv += `"${u}","Unregistered","N/A","N/A","N/A","N/A","N/A"\n`;
    });

    failed.forEach(u => {
        csv += `"${u}","Failed/Unknown","N/A","N/A","N/A","N/A","N/A"\n`;
    });

    return csv;
}

// ── Telegram Bot API 9.4 button colors (inline keyboards) ────
// Bot API 9.4 (Feb 2026) added the field `style` to InlineKeyboardButton /
// KeyboardButton: "primary" (blue), "success" (green), "danger" (red).
// This helper colors every button that has no explicit style yet, using the
// button text/emoji to pick a sensible color. Buttons already carrying a
// style are left untouched.
const _STYLE_DANGER = /🚫|❌|🗑|➖|🛑|✖|remove|ban |delete|disable|logout|revoke|clear|reset|cancel|deny|kick/i;
const _STYLE_SUCCESS = /✅|🟢|💎|🎁|redeem|upgrade|premium|activate|approve|unban|success|paid|payment/i;
const _STYLE_PRIMARY = /🚀|🔐|📱|🛜|⚙️|🔑|🔗|generate|webhook|api|new check|web login|add node|admin console|owner panel|run|start|send|create|save|enable|check|session|node|warmup|broadcast|language|support|force|backup|ping|docs|menu|open web app/i;

function colorInlineKeyboard(kb) {
    if (!Array.isArray(kb)) return kb;
    return kb.map(row => (Array.isArray(row) ? row : []).map(btn => {
        if (!btn || typeof btn !== "object" || btn.style) return btn;
        const t = String(btn.text || "");
        let style = null;
        if (_STYLE_DANGER.test(t)) style = "danger";
        else if (_STYLE_SUCCESS.test(t)) style = "success";
        else if (_STYLE_PRIMARY.test(t)) style = "primary";
        return style ? { ...btn, style } : btn;
    }));
}

// ── Array & File Utils ────────────────────────────────────────

function safeUnlink(filePath) {
    try { require("fs").unlinkSync(filePath); } catch (_) {}
}

function randomDelay(minMs, maxMs) {
    const ms = Math.floor(Math.random() * (maxMs - minMs + 1)) + minMs;
    return new Promise(res => setTimeout(res, ms));
}

function chunkArray(arr, size) {
    const out = [];
    for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
    return out;
}

// ── Exports ───────────────────────────────────────────────────
module.exports = {
    getProgressBar,
    getETA,
    parseNumbers,
    guessCountry,
    sendLongMessage,
    sendBroadcastReport,
    fmtNum,
    fmtDuration,
    fmtBytes,
    buildResultText,
    buildResultCSV,
    safeUnlink,
    randomDelay,
    chunkArray,
    colorInlineKeyboard,
};
