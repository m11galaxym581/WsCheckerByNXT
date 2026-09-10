// ============================================================
//   WS CHECKER v6 | stars.js
//   💳 Payments — Telegram Stars (auto) + Alternative methods
// ------------------------------------------------------------
// Two payment paths for PRO / VIP plan upgrades:
//
//  A) ⭐ Telegram Stars — fully automatic:
//       shop -> sendInvoice (currency XTR) -> pre_checkout -> we approve
//       -> successful_payment -> plan granted instantly + charge id logged.
//
//  B) 💠 Binance Pay / 🪙 USDT / ⛓️ other networks — routed to the OWNER:
//       user picks a non-Star method -> gets a deep link to the owner DM
//       pre-filled with the plan + network -> taps "✅ I've paid — Notify"
//       -> the owner receives a one-tap "Approve {tier} {days}d" button that
//       grants the exact pack. (Real Binance/gateway credentials aren't wired;
//       the owner confirms receipt out-of-band, as chosen.)
//
// Admin can always fall back to /addpro, /addvip and vouchers.
//
// Pricing/packs are editable live via config (STARS_ENABLED + STARS_PLANS).
// ============================================================

"use strict";

const config = require("./config");
const {
    getDB, registerUser, extendPlanStack,
    logStarsPayment, getStarsPayment, listStarsPayments,
    listStarsPaymentsByUid, revokePlanDays,
    isOwner, isAdmin, markTrialUsed, hasUsedTrial
} = require("./database");

// ── Display helpers ───────────────────────────────────────
// Charge ids are ~110 chars — they must NEVER sit inside a sentence
// (it wraps and shatters the box layout). Show a short id inline and,
// when the full id is needed, put it on its own `code` line (tap-to-copy).
const shortCid = (cid) => {
    cid = String(cid || "");
    return cid.length > 18 ? `${cid.slice(0, 8)}…${cid.slice(-6)}` : cid;
};
const starWord = (n) => `${n} Star${Number(n) === 1 ? "" : "s"}`;

// ── Direct Bot API calls (JSON POST) ──────────────────────────
// Refunds / balance / transactions go through a direct HTTPS call with
// the exact JSON shape every official guide uses, instead of the
// node-telegram-bot-api wrapper's form-encoded request. This removes the
// whole HTTP-form layer as a failure suspect and surfaces Telegram's raw
// error description so the refund handler can translate it.
async function tgApi(method, body) {
    const token = config.TG_TOKEN || "";
    const res = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body || {}),
    });
    let data = null;
    try { data = await res.json(); } catch (_) { /* non-JSON: proxy/network issue */ }
    if (!data || data.ok !== true) {
        const desc = (data && data.description) || `HTTP ${res.status} (no JSON body)`;
        const err = new Error(desc);
        err.code = data && data.error_code;
        throw err;
    }
    return data.result;
}

// Ground truth for one charge: find it in Telegram's own transaction list
// (most recent 100) and learn who really paid it + how much it was worth.
// Returns { txn, payerUid, payerName, srcType, searched } — txn is null when
// the charge is older than the window (or foreign to this bot).
async function findTelegramTxn(chargeId) {
    const tx = await tgApi("getStarTransactions", { limit: 100 });
    const list = (tx && tx.transactions) || [];
    const hit = list.find(t => t && String(t.id) === String(chargeId)) || null;
    if (!hit) return { txn: null, payerUid: null, payerName: "", srcType: "", searched: list.length };
    const u = hit.source && hit.source.user;
    return {
        txn: hit,
        searched: list.length,
        payerUid: u && u.id ? Number(u.id) : null,
        payerName: u ? [u.first_name, u.last_name].filter(Boolean).join(" ") : "",
        srcType: hit.source ? String(hit.source.type || "") : "",
    };
}

const EMO = { PRO: "💎", VIP: "🔥" };

// ── 🎁 One-time free trial ──────────────────────────────────
// Built-in plan (never read from the dynamic file) so it is always
// available, and consumed only once per user.
const TRIAL_ID = "trial_1";

function trialEnabled() {
    const d = config.dynamic || {};
    return !!(d.STARS_ENABLED && d.STARS_TRIAL_ENABLED !== false);
}

function trialPlan() {
    if (!trialEnabled()) return null;
    const t = (config.dynamic && config.dynamic.STARS_TRIAL) || {};
    const days = Number(t.days) || 1;
    const stars = Number(t.stars) || 1;
    const tier = String(t.tier || "PRO").toUpperCase();
    return { id: TRIAL_ID, tier, days, stars, trial: true };
}

function isTrialPlan(id) {
    return String(id) === TRIAL_ID;
}

// Alternative (non-Star) networks offered via owner-DM routing.
const ALT_METHODS = [
    { code: "BINANCE", label: "💠 Binance Pay",   note: "via Binance Pay" },
    { code: "USDT",    label: "🪙 USDT (TRC20)",  note: "USDT on TRC20" },
    { code: "CRYPTO",  label: "⛓️ Other Crypto",  note: "BTC / ETH / other network" },
];

function plans() {
    const d = config.dynamic || {};
    if (!d.STARS_ENABLED) return [];
    const list = Array.isArray(d.STARS_PLANS) ? d.STARS_PLANS : [];
    const out = [];
    for (const p of list) {
        if (!p || !p.id || !p.tier || !Number(p.days) || !Number(p.stars)) continue;
        out.push({ id: String(p.id), tier: String(p.tier).toUpperCase(), days: Number(p.days), stars: Number(p.stars) });
    }
    return out;
}

function findPlan(id) {
    const paid = plans().find((p) => p.id === String(id));
    if (paid) return paid;
    const t = trialPlan();
    return t && t.id === String(id) ? t : null;
}

// Which plans a given user may currently see. The one-time trial is hidden
// as soon as the user has consumed it.
function visiblePlans(uid) {
    const list = plans();
    const t = trialPlan();
    if (!t) return list;
    if (uid != null && hasUsedTrial(uid)) return list;
    return [t, ...list];
}

function enabled() {
    return !!(config.dynamic && config.dynamic.STARS_ENABLED);
}

function planTitle(p) {
    if (p && p.trial) {
        return `🎁 FREE TRIAL • ${p.days} Day${p.days > 1 ? "s" : ""} for ${p.stars} ⭐`;
    }
    return `${EMO[p.tier] || "⭐"} ${p.tier} • ${p.days} Day${p.days > 1 ? "s" : ""}`;
}

// Owner/Support Telegram handle (no @) for the deep link to the owner DM.
function ownerHandle() {
    try {
        const u = (getDB().users || {})[config.OWNER_ID];
        const un = u && u.username && String(u.username) !== "NoUser" ? String(u.username).replace(/^@/, "") : "";
        if (un) return un;
    } catch (_) {}
    return config.SUPPORT_USERNAME || "";
}

// Parse a data string that begins with `prefix` and then has `<METHOD>_<planId>`.
// e.g. parseMethodPlan("np_BINANCE_pro_30", "np_") -> { method:..., planId:"pro_30" }
function parseMethodPlan(data, prefix) {
    const rest = String(data).slice(String(prefix).length);
    for (const m of ALT_METHODS) {
        if (rest.startsWith(m.code + "_")) {
            return { method: m, planId: rest.slice(m.code.length + 1) };
        }
    }
    // fallback: first token as method, remainder as planId
    const i = rest.indexOf("_");
    if (i === -1) return { method: null, planId: rest };
    const m = ALT_METHODS.find((x) => x.code === rest.slice(0, i));
    return { method: m || null, planId: rest.slice(i + 1) };
}

module.exports = { installStars, enabled, plans, findPlan, ownerHandle, planTitle };

// ── Wire all bot event handlers ────────────────────────────
function installStars(bot) {
    if (!bot) return;

    const safeEdit = (chatId, messageId, text, markup) => {
        // Inline-mode callbacks have no message to edit — send a fresh one.
        if (!messageId) {
            return bot.sendMessage(chatId, text, { parse_mode: "Markdown", reply_markup: markup }).catch(() => {});
        }
        return bot.editMessageText(text, { chat_id: chatId, message_id: messageId, parse_mode: "Markdown", reply_markup: markup })
            .catch((e) => { if (!String(e.message || e.description || "").includes("is not modified")) console.error("❌ [Stars] edit:", e.message); });
    };

    const sendText = (chatId, text, markup) =>
        bot.sendMessage(chatId, text, { parse_mode: "Markdown", reply_markup: markup }).catch(() => {});

    const backPlanGrid = () => ({ inline_keyboard: [[{ text: "🔙 Back to Plans", callback_data: "stars_shop" }]] });
    const backMethods = (planId) => ({ inline_keyboard: [[{ text: "🔙 Back to Methods", callback_data: `up_${planId}` }]] });
    const planGridMarkup = (uid) => {
        const list = visiblePlans(uid);
        const rows = [];
        // The one-time trial gets its own, clearly-labelled row on top.
        const trial = list.find((p) => p.trial);
        if (trial) {
            rows.push([{ text: `🎁 ONE-TIME FREE TRIAL — ${trial.days} Day for ${trial.stars} ⭐`, callback_data: `up_${trial.id}` }]);
        }
        list.filter((p) => !p.trial).forEach((p) => {
            rows.push([{ text: `${planTitle(p)} — ${p.stars} ⭐ · choose payment`, callback_data: `up_${p.id}` }]);
        });
        rows.push([{ text: "🔙 Back", callback_data: "back_main" }]);
        return { inline_keyboard: rows };
    };
    const methodChooserMarkup = (plan) => {
        const rows = [
            [{ text: `⭐ Pay ${plan.stars} Stars (instant)`, callback_data: `stars_buy_${plan.id}` }],
        ];
        // The one-time trial is Stars-only (no owner-approval bypass).
        if (!plan.trial) {
            rows.push([{ text: "💠 Binance Pay", callback_data: `altpay_BINANCE_${plan.id}` }]);
            rows.push([{ text: "🪙 USDT (TRC20)", callback_data: `altpay_USDT_${plan.id}` }]);
            rows.push([{ text: "⛓️ Other Crypto (BTC/ETH)", callback_data: `altpay_CRYPTO_${plan.id}` }]);
        }
        rows.push([{ text: "🔙 Back to Plans", callback_data: "stars_shop" }]);
        return { inline_keyboard: rows };
    };

    function shopText(uid) {
        const db = getDB();
        uid = Number(uid);
        const inVip = db.vips && db.vips.includes(uid);
        const inSub = db.subscribers && db.subscribers.includes(uid);
        const nowTier = inVip ? "🔥 VIP" : (inSub ? "💎 PRO" : "🧊 FREE");
        return "╭━━━━━[ 💳 *𝗨𝗣𝗚𝗥𝗔𝗗𝗘 𝗬𝗢𝗨𝗥 𝗣𝗟𝗔𝗡* ]━━━━━╮\n" +
            `┣ 🎖️ Your tier now: *${nowTier}*\n` +
            `┣ 💎 PRO  → ${config.dynamic.PRO_LIMIT} numbers / batch\n` +
            `┣ 🔥 VIP  → ${config.dynamic.VIP_LIMIT} numbers / batch\n` +
            "┣━━━━━━━━━━━━━━━━━━━━━━━━━━━\n" +
            "┣ Pick a plan, then choose how to pay:\n" +
            "┣  • ⭐ Telegram Stars — *instant, auto*\n" +
            "┣  • 💠 Binance / 🪙 USDT / ⛓️ other —\n" +
            "┣      you arrange with the *owner* and\n" +
            "┣      tap a button to get activated.\n" +
            "┣ ⏳ Renewals *stack* on remaining time.\n" +
            (() => {
                const t = trialPlan();
                if (!t || hasUsedTrial(uid)) return "";
                return "┣━━━━━━━━━━━━━━━━━━━━━━━━━━━\n" +
                    `┣ 🎁 *ONE-TIME FREE TRIAL* — ${t.days} day of ${t.tier} for *${t.stars} ⭐*\n` +
                    "┣    Usable *once only* — it is removed after.\n";
            })() +
            "╰━━━━━━━━━━━━━━━━━━━━━━━━━━━╯";
    }

    // ── 1. Upgrade navigation + per-plan pay actions ─────────
    bot.on("callback_query", async (q) => {
        const data = q && q.data;
        if (typeof data !== "string" || !/^(stars_|up_|altpay_|np_|ap_)/.test(data)) return; // owned elsewhere
        const uid = q.from && q.from.id;
        if (!uid) return;
        const msgId = q.message && q.message.message_id;
        try { await bot.answerCallbackQuery(q.id); } catch (_) {}

        // ── Plan grid (entry point from the 💎 Upgrade button) ──
        if (data === "stars_shop") {
            if (msgId) return safeEdit(uid, msgId, shopText(uid), planGridMarkup(uid));
            return sendText(uid, shopText(uid), planGridMarkup(uid));
        }

        // ── Method chooser for a specific plan ──
        if (data.startsWith("up_")) {
            const plan = findPlan(data.slice("up_".length));
            if (!plan) { if (msgId) return safeEdit(uid, msgId, "❌ Plan not found.", backPlanGrid()); return; }
            if (plan.trial && hasUsedTrial(uid)) {
                if (msgId) return safeEdit(uid, msgId, "⛔ *Free trial already used.*\n\nIt can only be claimed once. Please pick a regular plan below.", planGridMarkup(uid));
                return;
            }
            registerUser({ id: uid, first_name: (q.from.first_name || "User"), username: q.from.username });
            return safeEdit(uid, msgId,
                `╭━━━[ ${planTitle(plan)} — ${plan.stars} ⭐ ]━━━╮\n┣ How would you like to pay?\n┣━━━━━━━━━━━━━━━━━━━━━\n┣ ⭐ Stars = instant auto-activation.\n┣ 💠/🪙/⛓️ = contact owner, pay, then tap\n┣     "✅ I've paid" to get activated.\n╰━━━━━━━━━━━━━━━━━━━━━╯`,
                methodChooserMarkup(plan));
        }

        // ── ⭐ Stars: send the invoice (auto path) ─────────────
        if (data.startsWith("stars_buy_")) {
            const plan = findPlan(data.slice("stars_buy_".length));
            if (!plan) { if (msgId) return safeEdit(uid, msgId, "❌ Plan not found.", backPlanGrid()); return; }
            if (plan.trial && hasUsedTrial(uid)) {
                if (msgId) return safeEdit(uid, msgId, "⛔ *Free trial already used.*\n\nIt can only be claimed once.", planGridMarkup(uid));
                return;
            }
            registerUser({ id: uid, first_name: (q.from.first_name || "User"), username: q.from.username });
            const payload = `${plan.id}:${uid}:${Date.now()}`; // <128 bytes
            try {
                await bot.sendInvoice(
                    uid,
                    `${plan.tier} Plan - ${plan.days} Day${plan.days > 1 ? "s" : ""}`,
                    `WS CHECKER ${plan.tier} upgrade. ${plan.days} day${plan.days > 1 ? "s" : ""}. Auto-activated instantly on payment.`,
                    payload,
                    "",
                    "XTR",
                    [{ label: `${plan.tier} ${plan.days} Day${plan.days > 1 ? "s" : ""}`, amount: plan.stars }]
                ).catch(() => { throw new Error("sendInvoice failed"); });
                if (msgId) safeEdit(uid, msgId, "🧾 *Invoice sent.* Tap *Pay ⭐ …* on the invoice above to complete the purchase. It is delivered automatically once Telegram confirms the payment.", backPlanGrid());
            } catch (e) {
                console.error("❌ [Stars] invoice send failed:", e.message);
                if (msgId) return safeEdit(uid, msgId, "❌ Could not send the Stars invoice. Please try again or use Binance/USDT → contact owner.", methodChooserMarkup(plan));
            }
            return;
        }

        // ── 💠/🪙/⛓️ Non-Star method → route to owner DM ──────
        if (data.startsWith("altpay_")) {
            const { method, planId } = parseMethodPlan(data, "altpay_");
            const plan = findPlan(planId);
            if (!plan) { if (msgId) return safeEdit(uid, msgId, "❌ Plan not found.", backPlanGrid()); return; }
            if (!method) { if (msgId) return safeEdit(uid, msgId, "❌ Invalid payment method.", backMethods(planId)); return; }
            if (plan.trial) { if (msgId) return safeEdit(uid, msgId, "⭐ The free trial is payable with Stars only.", methodChooserMarkup(plan)); return; }
            const uname = ownerHandle();
            const prefill = encodeURIComponent(
                `Hi! I'd like to upgrade to ${plan.tier} (${plan.days} days), paying ${method.note}. My Telegram ID: ${uid}. Please share payment details.`
            );
            const kb = [];
            if (uname) kb.push([{ text: "📩 Message Owner to Pay", url: `https://t.me/${uname}?text=${prefill}` }]);
            kb.push([{ text: "✅ I've Paid — Notify Owner", callback_data: `np_${method.code}_${plan.id}` }]);
            kb.push([{ text: "🔙 Back to Methods", callback_data: `up_${plan.id}` }]);
            const lines = [
                `╭━━━[ ${planTitle(plan)} — ${method.label} ]━━━╮`,
                `┣ You chose: *${plan.tier} ${plan.days}d*`,
                `┣ Method: ${method.label}`,
                `┣━━━━━━━━━━━━━━━━━━━━━`,
                `┣ 1. *${uname ? "Tap “Message Owner” to open" : "Message"} the owner* (${uname ? "@" + uname : "the bot will notify them"})`,
                `┣ 2. Send payment via ${method.note}`,
                `┣ 3. Tap *"✅ I've Paid — Notify Owner"*`,
                `┣ 4. Owner confirms → your ${plan.tier} is activated.`,
                `╰━━━━━━━━━━━━━━━━━━━━━╯`,
            ].join("\n");
            return safeEdit(uid, msgId, lines, { inline_keyboard: kb });
        }

        // ── "I've paid — notify owner" → owner DM with approve ─
        if (data.startsWith("np_")) {
            const { method, planId } = parseMethodPlan(data, "np_");
            const plan = findPlan(planId);
            if (!plan || !method) { if (msgId) return safeEdit(uid, msgId, "❌ Invalid request.", backPlanGrid()); return; }
            if (plan.trial) { if (msgId) return safeEdit(uid, msgId, "⭐ The free trial is payable with Stars only.", methodChooserMarkup(plan)); return; }
            const name = q.from.first_name || "User";
            const kb = [[{ text: `✅ Approve ${plan.tier} ${plan.days}d`, callback_data: `ap_${plan.tier}${plan.days}_${uid}` }]];
            const msg =
                `🚨 *PAYMENT ARRANGED — ALTERNATIVE METHOD*\n` +
                `┣ 👤 User: ${name}\n` +
                `┣ 🆔 ID: ${uid}\n` +
                `┣ 📦 Plan: ${planTitle(plan)}\n` +
                `┣ 💠 Method: ${method.label} (${method.note})\n` +
                `┣━━━━━━━━━━━━━━━━\n` +
                `┣ Confirm you received payment, then tap Approve.`;
            db_admins_notify(bot, msg, kb);
            if (msgId) safeEdit(uid, msgId,
                `✅ *Owner notified!*\n\nYour request for ${planTitle(plan)} via ${method.label} was sent to the owner. Once you've sent the payment and the owner confirms, your plan will be activated automatically.`,
                backPlanGrid());
            return;
        }

        // ── Owner/admin one-tap approval for the exact pack ───
        if (data.startsWith("ap_")) {
            const mm = /^ap_([A-Z]+)(\d+)_(\d+)$/.exec(data);
            if (!mm) return;
            const tier = mm[1], days = Number(mm[2]), tid = Number(mm[3]);
            if (!isOwner(uid) && !isAdmin(uid)) return;
            const expiry = extendPlanStack(tid, tier, days);
            const db = getDB();
            const uname = (db.users[tid] && db.users[tid].username && String(db.users[tid].username) !== "NoUser")
                ? "@" + db.users[tid].username : `uid ${tid}`;
            sendText(tid,
                `╭━━━[ ✨ *PLAN ACTIVATED* ]━━━╮\n` +
                `┣ ${EMO[tier] || ""} *${tier}* ${days} day${days > 1 ? "s" : ""} granted!\n` +
                `┣ 🗓️ Expires: *${new Date(expiry).toLocaleDateString("en-GB")}*\n` +
                `╰━━━━━━━━━━━━━━━╯`,
                { inline_keyboard: [[{ text: "🔙 Main Menu", callback_data: "back_main" }]] });
            console.log(`💳 [Pay] ${tier} ${days}d granted to ${tid} by ${uid} (manual/alt approve)`);
            if (msgId) return safeEdit(uid, msgId,
                `✅ ${tier} ${days} day${days > 1 ? "s" : ""} approved for ${uname}.\n🗓️ New expiry: ${new Date(expiry).toLocaleDateString("en-GB")}.`,
                { inline_keyboard: [[{ text: "🔙 Back", callback_data: "back_main" }]] });
        }
    });

    // Notify all admins + owner of an alternative-payment request.
    function db_admins_notify(bot, text, kb) {
        const db = getDB();
        const targets = new Set([config.OWNER_ID].concat(db.admins || []));
        targets.forEach((aid) => bot.sendMessage(aid, text, { parse_mode: "Markdown", reply_markup: { inline_keyboard: kb } }).catch(() => {}));
    }

    // ── 2. Approve/deny Stars pre-checkout (must answer < 10s) ──
    bot.on("pre_checkout_query", async (query) => {
        try {
            const payload = String(query.invoice_payload || "");
            const plan = findPlan(payload.split(":")[0]);
            let ok = !!plan && Number(query.total_amount) === plan.stars;
            // One-time trial: refuse payment if this user already used it.
            if (ok && plan.trial) {
                const buyer = Number(query.from && query.from.id);
                if (hasUsedTrial(buyer)) {
                    ok = false;
                    console.warn("⚠️ [Stars] trial replay blocked for uid", buyer);
                    try { await bot.answerPreCheckoutQuery(query.id, false, "This one-time free trial has already been used."); return; } catch (_) {}
                }
            }
            if (!ok) console.warn("⚠️ [Stars] pre-checkout rejected:", payload, "amount", query.total_amount);
            await bot.answerPreCheckoutQuery(query.id, ok);
        } catch (e) {
            console.error("❌ [Stars] pre-checkout error:", e.message);
            try { await bot.answerPreCheckoutQuery(query.id, false); } catch (_) {}
        }
    });

    // ── 3. Auto-deliver on successful Stars payment ──────────
    bot.on("message", async (msg) => {
        const pay = msg && msg.successful_payment;
        if (!pay) return; // not a payment
        const from = msg.from || {};
        const chatUid = Number(from.id);
        try {
            const payload = String(pay.invoice_payload || "");
            const [planId, puidRaw] = payload.split(":");
            const plan = findPlan(planId);
            if (!plan) { console.warn("⚠️ [Stars] unknown plan in payload:", payload); return; }
            if (Number(pay.total_amount) !== plan.stars) { console.warn("⚠️ [Stars] amount mismatch:", pay.total_amount, plan.stars); return; }
            const cid = pay.telegram_payment_charge_id;
            if (!cid) return;
            if (getStarsPayment(cid)) return; // already delivered (duplicate update)
            // Kept for forensics: if a refund ever fails, comparing the two
            // ids against /starsbalance tells us instantly which one is bad.
            const pcid = pay.provider_payment_charge_id || "";

            const grantUid = (puidRaw && Number.isFinite(Number(puidRaw)) && Number(puidRaw) > 0) ? Number(puidRaw) : chatUid;

            // One-time trial: if it was already consumed, do not grant again.
            if (plan.trial && hasUsedTrial(grantUid)) {
                console.warn("⚠️ [Stars] trial already used — not granting again for uid", grantUid);
                logStarsPayment({
                    chargeId: cid, uid: grantUid, tier: plan.tier, days: plan.days,
                    stars: plan.stars, currency: pay.currency || "XTR",
                    planId: plan.id, providerChargeId: pcid,
                    refunded: false, duplicateTrial: true,
                    at: new Date().toISOString(),
                });
                return;
            }

            registerUser({ id: grantUid, first_name: from.first_name || "User", username: from.username });
            const expiry = extendPlanStack(grantUid, plan.tier, plan.days);
            // Consume the trial permanently -> option disappears from the shop.
            if (plan.trial) markTrialUsed(grantUid);

            logStarsPayment({
                chargeId: cid, uid: grantUid, tier: plan.tier, days: plan.days,
                stars: plan.stars, currency: pay.currency || "XTR",
                planId: plan.id, providerChargeId: pcid, refunded: false,
                at: new Date().toISOString(),
            });

            const confirm =
                `╭━━━[ ${plan.trial ? "🎁 *FREE TRIAL ACTIVATED*" : "⭐ *PAYMENT RECEIVED*"} ]━━━╮\n` +
                `┣ ${EMO[plan.tier] || ""} *${plan.tier}* ${plan.days} day${plan.days > 1 ? "s" : ""} activated!\n` +
                (plan.trial ? `┣ ⏳ Enjoy your trial — the *1 ⭐* offer is now used up.\n` : "") +
                `┣ ⭐ Paid: *${starWord(plan.stars)}*\n` +
                `┣ 🗓️ New expiry: *${new Date(expiry).toLocaleDateString("en-GB")}*\n` +
                `┣ 🧾 \`${shortCid(cid)}\`\n` +
                `╰━━━━━━━━━━━━━━━━━━━━╯`;
            sendText(grantUid, confirm);
            sendText(config.OWNER_ID,
                `╭━━━[ ${plan.trial ? "🎁 *TRIAL SALE*" : "⭐ *STARS SALE*"} ]━━━╮\n` +
                `┣ 👤 \`${grantUid}\` · 📦 ${plan.tier} ${plan.days}d\n` +
                `┣ 💰 ${starWord(plan.stars)} · 🧾 \`${shortCid(cid)}\`\n` +
                `┣ \`${cid}\`\n` +
                `╰━━━━━━━━━━━━━━━━━━━━╯`);
            console.log(`⭐ [Stars] Paid ${plan.stars} XTR — ${plan.tier} ${plan.days}d for uid ${grantUid} (charge ${cid})`);
        } catch (e) {
            console.error("❌ [Stars] payment handler error:", e.message);
        }
    });

    // ── 4. Owner refund ──────────────────────────────────────
    // Accepts the full charge id OR the buyer's numeric user id (resolves
    // to their most recent unrefunded payment).
    bot.onText(/\/refundstars(?:@\w+)?(?:\s+(.+))?/, async (msg, match) => {
        const uid = msg.from && msg.from.id;
        if (!isOwner(uid)) return;
        // Strip code ticks: the id is displayed in `code` so owners can tap
        // to copy, and some clients include the ticks in the paste.
        const arg = String((match && match[1]) || "").trim().replace(/^`+|`+$/g, "").trim();
        if (!arg) return sendText(uid, "Usage: `/refundstars <charge_id>`\nor `/refundstars <buyer_user_id>`");
        let rec = getStarsPayment(arg);
        let resolvedByUid = false;
        // Numeric input that is not a charge id -> treat as buyer uid.
        if (!rec && /^\d+$/.test(arg)) {
            const mine = listStarsPaymentsByUid(arg).filter(r => !r.refunded);
            if (mine.length) {
                rec = mine[0];
                resolvedByUid = true;
            }
        }
        if (!rec) return sendText(uid,
            `❌ No Stars payment record found for \`${arg}\`.\n\n` +
            `Tip: use \`/starsbalance\` to list the real Telegram-side transactions and copy the exact charge id.`);
        if (rec.refunded) return sendText(uid, `⚠️ \`${shortCid(rec.chargeId)}\` was already refunded.`);
        // Never call Telegram with an empty id — that is exactly what makes
        // Telegram answer CHARGE_ID_EMPTY. Refuse loudly instead.
        const cid = String(rec.chargeId || "").trim();
        const ledgerUid = Number(rec.uid);
        if (!cid || !Number.isFinite(ledgerUid) || ledgerUid <= 0) {
            console.error("❌ [Stars] refund refused — corrupt record:", JSON.stringify({ cidLen: cid.length, uid: rec.uid }));
            return sendText(uid,
                `❌ The stored payment record looks corrupt (empty charge id / bad user id) — nothing was sent to Telegram.\n\n` +
                `Open \`/starsbalance\` for the real transaction id and retry with that.`);
        }
        // ── Smart payer resolution ──
        // Ask Telegram who actually paid this charge. If our ledger uid ever
        // disagrees (forwarded invoice, manual grant, stale record), the
        // Telegram-side payer wins — a wrong user_id is a classic cause of
        // cryptic refund rejections.
        let payUid = ledgerUid, payerFixed = false, diag = "";
        try {
            const found = await findTelegramTxn(cid);
            if (found.txn) {
                const amt = typeof found.txn.amount === "number" ? found.txn.amount : "?";
                diag = `Telegram txn: ${amt} ⭐` +
                    (found.payerUid ? ` from 👤 ${found.payerUid}` : ` (${found.srcType || "no source"})`);
                if (found.payerUid && found.payerUid !== payUid) {
                    console.warn(`⚠️ [Stars] ledger uid ${payUid} != Telegram payer ${found.payerUid} for ${cid} — using Telegram's.`);
                    diag += ` — payer corrected`;
                    payUid = found.payerUid;
                    payerFixed = true;
                }
            } else {
                diag = `charge NOT in last ${found.searched} Telegram txns`;
                console.warn(`⚠️ [Stars] ${cid} not in recent Telegram txns (searched ${found.searched}) — trying ledger uid ${payUid}.`);
            }
        } catch (e) {
            diag = `txn pre-check failed (${e.message})`;
            console.warn("⚠️ [Stars] txn pre-check failed, using ledger uid:", e.message);
        }
        console.log(`💸 [Stars] refunding ${shortCid(cid)} (uid ${payUid}, ${rec.stars} ⭐). ${diag}`);
        try {
            // Direct JSON POST (see tgApi) — same shape as the official docs.
            await tgApi("refundStarPayment", { user_id: payUid, telegram_payment_charge_id: cid });
        } catch (e) {
            const desc = String((e && e.message) || "unknown");
            console.error(`❌ [Stars] refund failed for ${cid}:`, desc);
            const flat = desc.replace(/[_\s]+/g, "").toUpperCase();
            // Self-heal: Telegram says it was already refunded but our ledger
            // disagrees -> sync the ledger + revoke, instead of just erroring.
            if (flat.includes("CHARGEALREADYREFUNDED")) {
                const remaining = revokePlanDays(rec.uid, rec.tier, rec.days);
                logStarsPayment({ ...rec, refunded: true, refundedAt: new Date().toISOString(), syncedAlreadyRefunded: true });
                const stillActive = remaining && Number(remaining) > Date.now();
                return sendText(uid,
                    `⚠️ Telegram already refunded \`${shortCid(cid)}\` earlier — ledger synced` +
                    (stillActive
                        ? `, uid ${rec.uid} keeps *${rec.tier}* till *${new Date(remaining).toLocaleDateString("en-GB")}*.`
                        : `, *${rec.tier}* revoked from uid ${rec.uid}.`));
            }
            if (flat.includes("CHARGEIDEMPTY")) {
                return sendText(uid,
                    `╭━━━[ ❌ *REFUND FAILED* ]━━━╮\n` +
                    `┣ Telegram got an *empty* charge id.\n` +
                    `┣ On file: \`${shortCid(cid)}\`\n` +
                    (diag ? `┣ 🔍 ${diag}\n` : "") +
                    `┣━━━━━━━━━━━━━━━━━━━━━━\n` +
                    `┣ 🧾 Full id (tap to copy):\n` +
                    `┣ \`${cid}\`\n` +
                    `┣━━━━━━━━━━━━━━━━━━━━━━\n` +
                    `┣ Copy the id from \`/starsbalance\`,\n` +
                    `┣ then \`/refundstars <paste>\`.\n` +
                    `┣ Still fails? The ⭐ stay in the bot\n` +
                    `┣ balance — withdraw later via Fragment.\n` +
                    `╰━━━━━━━━━━━━━━━━━━━━╯`);
            }
            if (flat.includes("CHARGENOTFOUND") || flat.includes("CHARGEIDINVALID") || flat.includes("INVALIDCHARGE")) {
                return sendText(uid,
                    `╭━━━[ ❌ *REFUND FAILED* ]━━━╮\n` +
                    `┣ Telegram doesn't know this charge.\n` +
                    `┣ \`${shortCid(cid)}\` · 👤 ${payUid}\n` +
                    (diag ? `┣ 🔍 ${diag}\n` : "") +
                    `┣ Check \`/starsbalance\` for the real id.\n` +
                    `╰━━━━━━━━━━━━━━━━━━━━╯`);
            }
            return sendText(uid,
                `❌ Refund of \`${shortCid(cid)}\` failed: ${desc}` +
                (diag ? `\n🔍 ${diag}` : ""));
        }
        // Refunds remove ONLY the refunded pack, pro-rata: if the user paid
        // for several stacked plans, the remaining time must survive.
        const remaining = revokePlanDays(rec.uid, rec.tier, rec.days);
        logStarsPayment({ ...rec, refunded: true, refundedAt: new Date().toISOString() });
        const stillActive = remaining && Number(remaining) > Date.now();
        sendText(Number(rec.uid),
            stillActive
                ? `⭐ *Refund processed — ${starWord(rec.stars)} back in your Stars balance.*\n\nYour *${rec.tier}* stays active till *${new Date(remaining).toLocaleDateString("en-GB")}*.`
                : `⭐ *Refund processed — ${starWord(rec.stars)} back in your Stars balance.*\n\nYour ${rec.tier} access has ended.`);
        const out = [
            `╭━━━[ ✅ *STARS REFUNDED* ]━━━╮`,
            `┣ 💰 ${starWord(rec.stars)} → 👤 ${payUid}`,
            stillActive
                ? `┣ ⏳ ${rec.tier} stays till *${new Date(remaining).toLocaleDateString("en-GB")}*`
                : `┣ 📦 ${rec.tier} ${rec.days}d revoked`,
        ];
        if (resolvedByUid) out.push(`┣ 🔍 Found via buyer uid \`${arg}\``);
        if (payerFixed) out.push(`┣ 🔍 Payer corrected per Telegram`);
        out.push(`┣ 🧾 \`${shortCid(cid)}\``, `┣ \`${cid}\``, `╰━━━━━━━━━━━━━━━━━━━━╯`);
        return sendText(uid, out.join("\n"));
    });

    // ── 5. Owner: real Telegram-side Stars balance + transactions ──
    // Stars paid by buyers sit on the BOT's Telegram balance (held by
    // Telegram, not in our DB — our DB only keeps the payment ledger).
    // Layout rule: one-line summary per txn (amount · date · payer · plan),
    // then the full id alone on its own `code` line for tap-to-copy.
    bot.onText(/\/starsbalance(?:@\w+)?(?:\s|$)/, async (msg) => {
        const uid = msg.from && msg.from.id;
        if (!isOwner(uid)) return;
        let balText = "n/a", txns = [], warn = "";
        try {
            const bal = await tgApi("getMyStarBalance", {});
            const amt = bal && typeof bal.amount === "number" ? bal.amount : bal;
            balText = starWord(amt);
        } catch (e) {
            warn += `┣ ⚠️ Balance failed: ${e.message}\n`;
        }
        try {
            const tx = await tgApi("getStarTransactions", { limit: 5 });
            txns = (tx && tx.transactions) || [];
        } catch (e) {
            warn += `┣ ⚠️ Transactions failed: ${e.message}\n`;
        }
        const ledger = listStarsPayments();
        const live = ledger.filter(r => !r.refunded);
        const liveSum = live.reduce((s, r) => s + (Number(r.stars) || 0), 0);
        const out = [
            `╭━━━[ ⭐ *STARS BALANCE* ]━━━╮`,
            `┣ 💰 Telegram holds: *${balText}*`,
            `┣ 📒 Ledger: ${live.length} live payment${live.length === 1 ? "" : "s"} (${starWord(liveSum)})`,
        ];
        if (txns.length) {
            out.push(`┣━━━━━━━━━━━━━━━━━━━━━━`, `┣ 🧾 *Latest transactions:*`);
            for (const t of txns) {
                const id = t && t.id ? String(t.id) : "?";
                const amt = t && typeof t.amount === "number" ? t.amount : 0;
                const dt = t && t.date ? new Date(Number(t.date) * 1000).toLocaleDateString("en-GB") : "?";
                const u = t && t.source && t.source.user;
                const who = u && u.id ? ` · 👤 ${u.id}` : "";
                const rec = id !== "?" ? getStarsPayment(id) : null;
                const tag = rec ? ` · ${rec.tier} ${rec.days}d` : ` · ⚠️ unlogged`;
                out.push(`┣ ${amt < 0 ? "-" : "+"}${starWord(Math.abs(amt))} · ${dt}${who}${tag}`);
                out.push(`┣ \`${id}\``);
            }
        } else {
            out.push(`┣ (no Telegram transactions)`);
        }
        out.push(`┣━━━━━━━━━━━━━━━━━━━━━━`, `┣ \`/refundstars <id or buyer uid>\``);
        if (warn) out.push(warn.trimEnd());
        out.push(`╰━━━━━━━━━━━━━━━━━━━━╯`);
        return sendText(uid, out.join("\n"));
    });
}
