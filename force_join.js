// ============================================================
//   force_join.js
//   Shared force-join membership engine.
// ------------------------------------------------------------
//   Used by bot_commands.js, bot_callbacks.js and web_server.js
//   so the membership logic (and its failure handling) lives in
//   ONE place. Telegram cannot verify private invite links, and
//   getChatMember needs the bot to be an admin of the channel —
//   this module reports those cases honestly instead of silently
//   blocking every user (old bug) or silently letting everyone
//   through (web_server old bug).
// ============================================================
"use strict";

const JOINED_STATUSES = new Set(["member", "administrator", "creator", "restricted"]);

const CHANNEL_LINK_RE = /t\.me\/([A-Za-z][A-Za-z0-9_]{4,})/;

// Resolve the most useful Telegram chat reference from a configured channel.
//   mode "id"       → numeric chat id (e.g. -100123456789) — works for private
//                     channels when the bot is an admin there
//   mode "username" → @public_username — works for public channels
//   mode "none"     → only an invite link (t.me/+abc, t.me/joinchat/…) — the
//                     bot cannot query membership of such chats at all
function normalizeChannel(ch) {
    const src = ch || {};
    const chatIdRaw = String(src.chatId ?? "").trim();
    const userRaw = String(src.username ?? "").trim().replace(/^@/, "");
    const url = String(src.url ?? "");

    if (chatIdRaw && /^-?\d{4,}$/.test(chatIdRaw)) {
        return { ...src, mode: "id", ref: chatIdRaw };
    }
    if (userRaw && /^[A-Za-z][A-Za-z0-9_]{4,}$/.test(userRaw)) {
        return { ...src, mode: "username", ref: "@" + userRaw };
    }
    if (chatIdRaw && /^@[A-Za-z][A-Za-z0-9_]{4,}$/.test(chatIdRaw)) {
        return { ...src, mode: "username", ref: chatIdRaw };
    }
    if (chatIdRaw && /^[A-Za-z][A-Za-z0-9_]{4,}$/.test(chatIdRaw)) {
        return { ...src, mode: "username", ref: "@" + chatIdRaw };
    }
    const m = url.match(CHANNEL_LINK_RE);
    const privateInvite = /t\.me\/(\+|joinchat\/)/.test(url);
    if (m && !privateInvite) {
        return { ...src, mode: "username", ref: "@" + m[1] };
    }
    // Some configs store the full t.me link inside chatId — accept that too.
    const m2 = chatIdRaw.match(CHANNEL_LINK_RE);
    const privateInvite2 = /t\.me\/(\+|joinchat\/)/.test(chatIdRaw);
    if (m2 && !privateInvite2) {
        return { ...src, mode: "username", ref: "@" + m2[1] };
    }
    return { ...src, mode: "none", ref: null };
}

function channelLabel(ch) {
    const c = ch || {};
    return c.title || c.chatId || c.username || (c.url ? c.url.replace(/^https?:\/\//, "") : "Channel");
}

// One membership probe against Telegram.
async function probeChannel(bot, ch, uid) {
    const norm = normalizeChannel(ch);
    if (norm.mode === "none") {
        return { joined: false, reason: "unverifiable", label: channelLabel(ch), norm };
    }
    let member;
    try {
        member = await bot.getChatMember(norm.ref, uid);
    } catch (e) {
        const err = String(e.description || e.message || e);
        if (/not found|chat not found|user not found|USER_NOT_PARTICIPANT|participant/i.test(err)) {
            return { joined: false, reason: "not_joined", status: "left", label: channelLabel(ch), norm, detail: err.slice(0, 140) };
        }
        if (/forbidden|bot.*(member of the chat|admin)|need administrator|administrator rights|not enough rights|can't|cannot|chat member|method is available only/i.test(err)) {
            return { joined: false, reason: "bot_setup", label: channelLabel(ch), norm, detail: err.slice(0, 140) };
        }
        return { joined: false, reason: "error", label: channelLabel(ch), norm, detail: err.slice(0, 140) };
    }
    const status = member && member.status ? member.status : "left";
    if (JOINED_STATUSES.has(status)) return { joined: true, label: channelLabel(ch), norm, status };
    return { joined: false, reason: "not_joined", status, label: channelLabel(ch), norm };
}

// Membership check for one user across all configured channels.
// Admins always pass (config convention, unchanged from original bots).
async function checkForceJoin(uid, bot) {
    const { dynamic } = require("./config");
    const { isAdmin } = require("./database");
    const channels = Array.isArray(dynamic.FORCE_JOIN_CHANNELS) ? dynamic.FORCE_JOIN_CHANNELS : [];
    if (!dynamic.FORCE_JOIN_ENABLED || !channels.length || isAdmin(uid)) {
        return { ok: true, missing: [], enabled: !!dynamic.FORCE_JOIN_ENABLED };
    }
    const probes = await Promise.all(channels.map(ch => probeChannel(bot, ch, uid).catch(() => ({ joined: false, reason: "error", label: channelLabel(ch), norm: normalizeChannel(ch) }))));
    // Keep the original channel fields (chatId/username/url/...) on each item so
    // existing UI and bot markup keep working; add reason/status for messaging.
    const missing = probes.filter(p => !p.joined).map(p => ({ ...p.norm, title: p.label, reason: p.reason, status: p.status, detail: p.detail }));
    return { ok: missing.length === 0, missing, enabled: true };
}

// Human-readable one-line reason for a blocked channel (English only).
function missingReasonLine(m) {
    const title = m.title || "Channel";
    switch (m.reason) {
        case "unverifiable":
            return `❌ ${title} — invite link: membership can't be checked. Make the bot an admin of the channel and save its numeric chat id via /forcejoin_add, then press ✅ Verify Join.`;
        case "bot_setup":
            return `❌ ${title} — the bot cannot verify members (add it as an *admin* of this channel), then press ✅ Verify Join.`;
        case "error":
            return `❌ ${title} — check failed (${(m.detail || "unknown error").split("\n")[0]}). Try again in a few seconds.`;
        case "not_joined":
        default:
            return `❌ ${title} — you have not joined yet.`;
    }
}

// Does a chat_join_request update belong to one of the force-join channels?
function matchJoinRequestChannel(req, channels) {
    const chat = (req && req.chat) || {};
    const list = Array.isArray(channels) ? channels : [];
    for (const ch of list) {
        const norm = normalizeChannel(ch);
        if (norm.mode === "id" && String(chat.id) === String(Number(norm.ref))) return { channel: ch, norm };
        if (norm.mode === "username" && chat.username && norm.ref.toLowerCase() === "@" + String(chat.username).toLowerCase()) return { channel: ch, norm };
    }
    return null;
}

module.exports = { normalizeChannel, channelLabel, probeChannel, checkForceJoin, missingReasonLine, matchJoinRequestChannel, JOINED_STATUSES };
