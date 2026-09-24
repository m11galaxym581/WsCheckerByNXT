// ============================================================
//   WS CHECKER v6 | cmd_flow.js
//   ⌨ Button flows for EVERY /command
// ------------------------------------------------------------
//   A data-driven menu: each row in COMMANDS describes one bot
//   command (who may use it, what args it needs, whether it needs
//   confirmation). The engine renders:
//
//     ⌨ Commands → Category → Command card → [▶ Run / ✏️ Start]
//       → guided prompts (with validation + /cancel)
//       → optional confirm → executes the REAL /command by emitting
//         a `text` update, so button flows and typed commands share
//         100% of the handler logic (no duplicate code paths).
//
//   Toggle commands (maintenance, systemmode, forcejoin…) render
//   one-tap choice buttons instead of prompts.
// ============================================================

"use strict";

const { isAdmin, isOwner } = require("./database");
const state = require("./state");

// ── Command catalog ─────────────────────────────────────────
// role: all | admin | owner
// run:  command text to execute directly (display commands)
// args: guided prompts [{ k, label, re, hint, optional, def }]
// choices: one-tap buttons [{ label, value }] -> `/cmd value`
// confirm: show a Yes/No screen before executing
// link: native callback to open instead (reuses existing flows)
const COMMANDS = [
    // ── 👤 Me & Checks ──
    { cmd: "start",    t: "🏠 Main Menu",  cat: "user",  role: "all",   d: "Open the main menu.", run: "start" },
    { cmd: "app",      t: "🌐 Mini App",   cat: "user",  role: "all",   d: "Open the Mini App / dashboard link.", run: "app" },
    { cmd: "mystats",  t: "📊 My Stats",   cat: "user",  role: "all",   d: "Your tier, usage and limits.", run: "mystats" },
    { cmd: "language", t: "🌐 Language",   cat: "user",  role: "all",   d: "Change bot language.", run: "language" },
    { cmd: "redeem",   t: "🎟️ Redeem",     cat: "user",  role: "all",   d: "Redeem a PRO/VIP voucher code.", u: "/redeem <code>",
      args: [{ k: "code", label: "Voucher code", re: "^[A-Za-z0-9][A-Za-z0-9\\-:]{3,}$", hint: "e.g. BLAZE-XXXX-XXXX" }] },
    { cmd: "setwebhook", t: "🔗 Webhook",  cat: "user",  role: "all",   d: "Set your result webhook URL.", u: "/setwebhook <https-url>",
      args: [{ k: "url", label: "Webhook URL", re: "^https?://\\S+$", hint: "must start with http(s)://" }] },
    { cmd: "reset",    t: "🔄 Reset",      cat: "user",  role: "all",   d: "Abort your running job and clear state.", u: "/reset",
      run: "reset", confirm: "Abort the running job and reset your state?" },

    // ── 📋 Lists & Queue ──
    { cmd: "queue",    t: "📥 Queue",      cat: "lists", role: "all",   d: "Show your queued jobs.", run: "queue" },
    { cmd: "mylists",  t: "📋 My Lists",   cat: "lists", role: "all",   d: "Show your saved number lists.", run: "mylists" },
    { cmd: "retryfailed", t: "🔁 Retry Failed", cat: "lists", role: "all", d: "Re-run numbers that failed last time.", run: "retryfailed" },
    { cmd: "runlist",  t: "▶️ Run List",   cat: "lists", role: "all",   d: "Run a check on a saved list.", u: "/runlist <list name>",
      args: [{ k: "name", label: "List name", re: ".+", hint: "as shown in /mylists" }] },

    // ── 👑 Admin ──
    { cmd: "admin",    t: "👑 Console",    cat: "admin", role: "admin", d: "Open the admin console.", run: "admin" },
    { cmd: "stats",    t: "📊 Bot Stats",  cat: "admin", role: "admin", d: "Global bot statistics.", run: "stats" },
    { cmd: "sessions", t: "🗄️ Sessions",   cat: "admin", role: "admin", d: "All WhatsApp sessions.", run: "sessions" },
    { cmd: "warmup",   t: "🛡️ Warmup",     cat: "admin", role: "admin", d: "Ping all nodes (health check).", run: "warmup" },
    { cmd: "appcheck", t: "🌐 App Check",  cat: "admin", role: "admin", d: "Mini App diagnostics.", run: "appcheck" },
    { cmd: "addpro",   t: "⭐ Grant PRO",  cat: "admin", role: "admin", d: "Grant PRO days (stacks).", u: "/addpro <user_id> [days]",
      args: [
          { k: "uid", label: "User ID", re: "^\\d+$", hint: "numbers only" },
          { k: "days", label: "Days", re: "^\\d{1,4}$", hint: "1-9999", optional: true, def: "30" },
      ] },
    { cmd: "rempro",   t: "➖ Revoke PRO", cat: "admin", role: "admin", d: "Remove PRO from a user.", u: "/rempro <user_id>",
      args: [{ k: "uid", label: "User ID", re: "^\\d+$", hint: "numbers only" }], confirm: "Revoke PRO access?" },
    { cmd: "addvip",   t: "🔥 Grant VIP",  cat: "admin", role: "admin", d: "Grant VIP days (stacks).", u: "/addvip <user_id> [days]",
      args: [
          { k: "uid", label: "User ID", re: "^\\d+$", hint: "numbers only" },
          { k: "days", label: "Days", re: "^\\d{1,4}$", hint: "1-9999", optional: true, def: "30" },
      ] },
    { cmd: "remvip",   t: "➖ Revoke VIP", cat: "admin", role: "admin", d: "Remove VIP from a user.", u: "/remvip <user_id>",
      args: [{ k: "uid", label: "User ID", re: "^\\d+$", hint: "numbers only" }], confirm: "Revoke VIP access?" },
    { cmd: "ban",      t: "🚫 Ban",        cat: "admin", role: "admin", d: "Ban a user from the bot.", u: "/ban <user_id>",
      args: [{ k: "uid", label: "User ID", re: "^\\d+$", hint: "numbers only" }], confirm: "Ban this user?" },
    { cmd: "unban",    t: "✅ Unban",      cat: "admin", role: "admin", d: "Unban a user.", u: "/unban <user_id>",
      args: [{ k: "uid", label: "User ID", re: "^\\d+$", hint: "numbers only" }] },
    { cmd: "genvoucher", t: "🎁 Voucher",  cat: "admin", role: "admin", d: "Create a voucher (custom days/uses).", u: "/genvoucher <PRO|VIP> <days> <uses>",
      args: [
          { k: "type", label: "Type (PRO or VIP)", re: "^(PRO|VIP)$", hint: "PRO or VIP" },
          { k: "days", label: "Days", re: "^\\d{1,4}$", hint: "1-9999" },
          { k: "uses", label: "Max uses", re: "^\\d{1,3}$", hint: "1-999" },
      ] },
    { cmd: "broadcast", t: "📢 Broadcast", cat: "admin", role: "admin", d: "Message ALL users.", u: "/broadcast <text>",
      args: [{ k: "text", label: "Broadcast text", re: ".+", hint: "sent to every user" }], confirm: "Send this broadcast to ALL users?" },
    { cmd: "forcejoin", t: "🔒 Force Join", cat: "admin", role: "admin", d: "Require channel join.", u: "/forcejoin <on|off>",
      choices: [{ label: "✅ ON", value: "on" }, { label: "⛔ OFF", value: "off" }] },
    { cmd: "forcejoin_add", t: "➕ FJ Channel", cat: "admin", role: "admin", d: "Add a force-join channel.", u: "/forcejoin_add <title|@chat|url>",
      args: [{ k: "spec", label: "Channel (title|@chat|url)", re: ".+", hint: "e.g. News|@mychan|https://t.me/mychan" }] },
    { cmd: "forcejoin_list", t: "📜 FJ List", cat: "admin", role: "admin", d: "List force-join channels.", run: "forcejoin_list" },
    { cmd: "forcejoin_auto", t: "🤖 FJ Auto", cat: "admin", role: "admin", d: "Auto-detect join requests.", u: "/forcejoin_auto <on|off>",
      choices: [{ label: "✅ ON", value: "on" }, { label: "⛔ OFF", value: "off" }] },
    { cmd: "forcejoin_test", t: "🧪 FJ Test", cat: "admin", role: "admin", d: "Test force-join for yourself.", run: "forcejoin_test" },

    // ── 💳 Stars & Trial ──
    { cmd: "upgrade",  t: "💎 Upgrade",    cat: "stars", role: "all",   d: "Open the Stars shop (PRO/VIP).", link: "stars_shop", linkText: "🛒 Open Shop" },
    { cmd: "trial",    t: "🎁 Free Trial", cat: "stars", role: "all",   d: "1-day PRO for 1 ⭐ — once per user.", link: "stars_shop", linkText: "🎁 Claim in Shop" },

    // ── ⚡ Owner ──
    { cmd: "owner",    t: "⚡ Panel",      cat: "owner", role: "owner", d: "Open the owner panel.", run: "owner" },
    { cmd: "starsbalance", t: "⭐ Balance", cat: "owner", role: "owner", d: "Bot Stars balance + transactions.", run: "starsbalance" },
    { cmd: "refundstars", t: "💸 Refund",  cat: "owner", role: "owner", d: "Refund a Stars payment.", u: "/refundstars <charge_id|user_id>",
      args: [{ k: "id", label: "Charge id or buyer user id", re: ".+", hint: "from /starsbalance" }], confirm: "Refund this payment? Stars move instantly." },
    { cmd: "addadmin", t: "👑 Add Admin",  cat: "owner", role: "owner", d: "Make a user admin.", u: "/addadmin <user_id>",
      args: [{ k: "uid", label: "User ID", re: "^\\d+$", hint: "numbers only" }] },
    { cmd: "remadmin", t: "🗑️ Rem Admin",  cat: "owner", role: "owner", d: "Remove an admin.", u: "/remadmin <user_id>",
      args: [{ k: "uid", label: "User ID", re: "^\\d+$", hint: "numbers only" }] },
    { cmd: "maintenance", t: "🚧 Maint.",  cat: "owner", role: "owner", d: "Maintenance mode.", u: "/maintenance <on|off>",
      choices: [{ label: "🚧 ON", value: "on" }, { label: "✅ OFF", value: "off" }] },
    { cmd: "systemmode", t: "🌍 Sys Mode", cat: "owner", role: "owner", d: "Free vs subscription mode.", u: "/systemmode <free|subscription>",
      choices: [{ label: "🌍 FREE", value: "free" }, { label: "💎 SUBSCRIPTION", value: "subscription" }] },
    { cmd: "autosetup", t: "⚙️ AutoSetup", cat: "owner", role: "owner", d: "Re-run zero-touch server config.", u: "/autosetup",
      run: "autosetup", confirm: "Re-run auto-setup (bot name, menu, Mini App button)?" },
];

const CATS = [
    { id: "user",  t: "👤 Me & Checks" },
    { id: "lists", t: "📋 Lists & Queue" },
    { id: "admin", t: "👑 Admin", role: "admin" },
    { id: "stars", t: "💳 Stars & Trial" },
    { id: "owner", t: "⚡ Owner", role: "owner" },
];

const byCmd = Object.fromEntries(COMMANDS.map(c => [c.cmd, c]));
const pending = new Map(); // uid -> { text, desc }

function roleOk(uid, role) {
    if (!role || role === "all") return true;
    if (role === "owner") return isOwner(uid);
    return isAdmin(uid) || isOwner(uid);
}
function itemsFor(cat, uid) {
    return COMMANDS.filter(c => c.cat === cat && roleOk(uid, c.role));
}
function grid(rows) { return { inline_keyboard: rows }; }
function backRow(target) { return [{ text: "🔙 Back", callback_data: target }]; }

function rootMarkup(uid) {
    const rows = CATS
        .filter(c => !c.role || roleOk(uid, c.role))
        .map(c => [{ text: `${c.t} (${itemsFor(c.id, uid).length})`, callback_data: `cmds_${c.id}` }]);
    rows.push(backRow("back_main"));
    return grid(rows);
}
function catMarkup(cat, uid) {
    const items = itemsFor(cat, uid);
    const rows = [];
    for (let i = 0; i < items.length; i += 2) {
        rows.push(items.slice(i, i + 2).map(c => ({ text: c.t, callback_data: `cmd_${c.cmd}` })));
    }
    rows.push(backRow("cmds"));
    return grid(rows);
}
function cardMarkup(c) {
    const rows = [];
    if (c.link) {
        rows.push([{ text: c.linkText || "Open", callback_data: c.link }]);
    } else if (c.choices) {
        rows.push(c.choices.map((ch, i) => ({ text: ch.label, callback_data: `cmdset_${c.cmd}_${i}` })));
    } else if (c.args) {
        rows.push([{ text: "✏️ Start", callback_data: `cmdgo_${c.cmd}` }]);
    } else {
        rows.push([{ text: c.confirm ? "▶️ Continue" : "▶️ Run", callback_data: `cmdgo_${c.cmd}` }]);
    }
    rows.push(backRow(`cmds_${c.cat}`));
    return grid(rows);
}

// Execute the REAL command handler by emitting a `text` update — the same
// event typed commands arrive on — so buttons and typing share one path.
function emitCommand(bot, uid, from, cmdText) {
    bot.emit("text", {
        message_id: Math.floor(Date.now() % 1000000000),
        from: { id: uid, first_name: (from && from.first_name) || "User", username: (from && from.username) || undefined },
        chat: { id: uid, type: "private" },
        date: Math.floor(Date.now() / 1000),
        text: cmdText,
    });
}

function confirmMarkup() {
    return grid([[ 
        { text: "✅ Yes, do it", callback_data: "cmdyes" },
        { text: "❌ Cancel", callback_data: "cmdno" },
    ]]);
}

function installCmdFlows(bot) {
    if (!bot) return;

    const safeEdit = (chatId, messageId, text, markup) => {
        if (!messageId) {
            return bot.sendMessage(chatId, text, { parse_mode: "Markdown", reply_markup: markup }).catch(() => {});
        }
        return bot.editMessageText(text, { chat_id: chatId, message_id: messageId, parse_mode: "Markdown", reply_markup: markup })
            .catch(() => {});
    };

    bot.on("callback_query", async (q) => {
        const data = q && q.data;
        if (typeof data !== "string") return;
        if (!/^(cmds$|cmds_|cmd_|cmdgo_|cmdset_|cmdyes$|cmdno$|cmdcancel$)/.test(data)) return;
        const uid = q.from && q.from.id;
        if (!uid) return;
        const msgId = q.message && q.message.message_id;
        try { await bot.answerCallbackQuery(q.id); } catch (_) {}

        // ── Root: categories ──
        if (data === "cmds") {
            state.clearUserStep(uid);
            pending.delete(uid);
            return safeEdit(uid, msgId,
                `╭━━━[ ⌨ *ALL COMMANDS* ]━━━╮\n┣ Pick a category — every /command\n┣ is runnable from buttons.\n╰━━━━━━━━━━━━━━━━━━━━╯`,
                rootMarkup(uid));
        }
        // ── Category grid ──
        if (data.startsWith("cmds_")) {
            const cat = CATS.find(c => c.id === data.slice(5));
            if (!cat || (cat.role && !roleOk(uid, cat.role))) return;
            state.clearUserStep(uid);
            pending.delete(uid);
            return safeEdit(uid, msgId, `╭━━━[ ${cat.t} ]━━━╮\n┣ Choose a command:\n╰━━━━━━━━━━━━━━━━━━━━╯`, catMarkup(cat.id, uid));
        }
        // ── Command card ──
        if (data.startsWith("cmd_") && !data.startsWith("cmdgo_") && !data.startsWith("cmdset_") && data !== "cmdyes" && data !== "cmdno" && data !== "cmdcancel") {
            const c = byCmd[data.slice(4)];
            if (!c || !roleOk(uid, c.role)) return;
            const lines = [
                `╭━━━[ ${c.t} ]━━━╮`,
                `┣ ${c.d}`,
            ];
            if (c.u) lines.push(`┣ \`${c.u}\``);
            if (c.args) lines.push(`┣ Needs: ${c.args.map(a => a.label).join(" → ")}`);
            lines.push(`╰━━━━━━━━━━━━━━━━━━━━╯`);
            return safeEdit(uid, msgId, lines.join("\n"), cardMarkup(c));
        }
        // ── Run / Start ──
        if (data.startsWith("cmdgo_")) {
            const c = byCmd[data.slice(6)];
            if (!c || !roleOk(uid, c.role)) return;
            // Guided prompts first.
            if (c.args && c.args.length) {
                state.setUserStep(uid, { step: "cmdflow", flow: c.cmd, idx: 0, vals: {}, chat: uid });
                const a = c.args[0];
                return safeEdit(uid, msgId,
                    `✏️ *${c.t} — step 1/${c.args.length}*\n\nSend *${a.label}*${a.hint ? ` (${a.hint})` : ""}${a.optional ? `\nor \`skip\` for default (${a.def})` : ""}.\n\n/cancel aborts.`,
                    grid([[ { text: "❌ Cancel", callback_data: "cmdcancel" } ]]));
            }
            // Confirm screen when required.
            if (c.confirm) {
                pending.set(uid, { text: `/${c.run}`, desc: c.confirm });
                return safeEdit(uid, msgId,
                    `⚠️ *${c.t}*\n\n${c.confirm}\n\nWill run: \`/${c.run}\``,
                    confirmMarkup());
            }
            // Direct execution.
            emitCommand(bot, uid, q.from, `/${c.run}`);
            return;
        }
        // ── One-tap choice ──
        if (data.startsWith("cmdset_")) {
            const m = /^cmdset_([A-Za-z0-9_]+)_(\d+)$/.exec(data);
            if (!m) return;
            const c = byCmd[m[1]];
            const ch = c && c.choices && c.choices[Number(m[2])];
            if (!c || !ch || !roleOk(uid, c.role)) return;
            emitCommand(bot, uid, q.from, `/${c.cmd} ${ch.value}`);
            return;
        }
        // ── Confirm Yes/No ──
        if (data === "cmdyes" || data === "cmdno") {
            const p = pending.get(uid);
            pending.delete(uid);
            if (data === "cmdno" || !p) {
                state.clearUserStep(uid);
                return safeEdit(uid, msgId, `❌ Cancelled.`, grid([backRow("cmds")]));
            }
            emitCommand(bot, uid, q.from, p.text);
            return safeEdit(uid, msgId, `⏳ Running \`${p.text}\`…`, grid([backRow("cmds")]));
        }
        // ── Cancel flow ──
        if (data === "cmdcancel") {
            state.clearUserStep(uid);
            pending.delete(uid);
            return safeEdit(uid, msgId,
                `╭━━━[ ⌨ *ALL COMMANDS* ]━━━╮\n┣ Flow cancelled.\n╰━━━━━━━━━━━━━━━━━━━━╯`,
                rootMarkup(uid));
        }
    });

    // /cancel aborts any guided flow.
    bot.onText(/\/cancel(?:@\w+)?(?:\s|$)/, async (msg) => {
        const uid = msg.from && msg.from.id;
        if (!uid) return;
        state.clearUserStep(uid);
        pending.delete(uid);
        bot.sendMessage(msg.chat.id, `❌ Flow cancelled.`, { reply_markup: rootMarkup(uid) }).catch(() => {});
    });
}

// ── Guided-prompt step collector (called from bot_messages) ──
async function handleStep(bot, msg, send) {
    const uid = msg.from.id;
    const st = state.getUserStep(uid);
    const c = st && byCmd[st.flow];
    if (!c || !c.args) { state.clearUserStep(uid); return; }
    const arg = c.args[st.idx];
    let val = String(msg.text || "").trim();
    // Optional arg: `skip` takes the default.
    if (arg.optional && /^skip$/i.test(val)) val = arg.def;
    const re = new RegExp(arg.re, arg.k === "type" ? "i" : "");
    if (!re.test(val)) {
        return send(`❌ Invalid *${arg.label}.* ${arg.hint || ""}\n\nTry again, or /cancel.`);
    }
    if (arg.k === "type") val = val.toUpperCase();
    st.vals[arg.k] = val;
    st.idx += 1;
    // More prompts to go.
    if (st.idx < c.args.length) {
        state.setUserStep(uid, st);
        const nx = c.args[st.idx];
        return send(`✏️ *${c.t} — step ${st.idx + 1}/${c.args.length}*\n\nSend *${nx.label}*${nx.hint ? ` (${nx.hint})` : ""}${nx.optional ? `\nor \`skip\` for default (${nx.def})` : ""}.\n\n/cancel aborts.`);
    }
    // All args collected → build the command.
    state.clearUserStep(uid);
    const cmdText = `/${c.cmd} ` + c.args.map(a => st.vals[a.k]).join(" ");
    if (c.confirm) {
        pending.set(uid, { text: cmdText, desc: c.confirm });
        const preview = cmdText.length > 140 ? cmdText.slice(0, 140) + "…" : cmdText;
        return send(`${c.confirm}\n\nWill run:\n\`${preview}\``, { reply_markup: confirmMarkup() });
    }
    emitCommand(bot, uid, msg.from, cmdText);
}

module.exports = { installCmdFlows, handleStep, COMMANDS, roleOk };
