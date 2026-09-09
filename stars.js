// ============================================================
//   WS CHECKER v6 | stars.js
//   ⭐ Telegram Stars Plan Shop — Automated Upgrades
// ------------------------------------------------------------
// Sells PRO / VIP upgrades for Telegram Stars (currency "XTR").
// Flow:
//   1. User taps "💎 Upgrade" (callback stars_shop) -> plan grid.
//   2. Picking a pack sends a Stars invoice (sendInvoice, currency XTR,
//      empty provider_token, single price item).
//   3. Telegram asks pre_checkout_query -> we validate + approve.
//   4. On successful_payment we STACK the granted days on the active
//      expiry, log the charge id, and confirm to the buyer + owner.
//   5. /refundstars <charge_id> (owner) refunds via refundStarPayment and
//      revokes the granted days.
//
// Pricing/packs are editable live via config (STARS_ENABLED + STARS_PLANS).
// ============================================================

"use strict";

const config = require("./config");
const {
    getDB, registerUser, extendPlanStack,
    logStarsPayment, getStarsPayment, removeSubscriber, removeVIP,
    isOwner
} = require("./database");

const EMO = { PRO: "💎", VIP: "🔥" };

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
    return plans().find((p) => p.id === String(id)) || null;
}

function enabled() {
    return !!(config.dynamic && config.dynamic.STARS_ENABLED);
}

function shopText(uid) {
    const db = getDB();
    uid = Number(uid);
    const inVip = db.vips && db.vips.includes(uid);
    const inSub = db.subscribers && db.subscribers.includes(uid);
    const nowTier = inVip ? "🔥 VIP" : (inSub ? "💎 PRO" : "🧊 FREE");
    return "╭━━━━━[ ⭐ *𝗦𝗧𝗔𝗥𝗦 𝗨𝗣𝗚𝗥𝗔𝗗𝗘* ]━━━━━╮\n" +
        "┣ Pay with ⭐ Telegram Stars — upgrade is *instant & automatic*.\n" +
        "┣━━━━━━━━━━━━━━━━━━━━━━━━━━━\n" +
        `┣ 🎖️ Your tier now: *${nowTier}*\n` +
        `┣ 💎 PRO   → ${config.dynamic.PRO_LIMIT} numbers / batch\n` +
        `┣ 🔥 VIP   → ${config.dynamic.VIP_LIMIT} numbers / batch\n` +
        "┣━━━━━━━━━━━━━━━━━━━━━━━━━━━\n" +
        "┣ ⏳ Renewals *stack* on your remaining time.\n" +
        "┣ Choose a pack below:\n" +
        "╰━━━━━━━━━━━━━━━━━━━━━━━━━━━╯";
}

function shopKeyboard() {
    const rows = plans().map((p) => [
        { text: `${EMO[p.tier] || "⭐"} ${p.tier} • ${p.days} Day${p.days > 1 ? "s" : ""} — ${p.stars} ⭐`, callback_data: `stars_buy_${p.id}` }
    ]);
    rows.push([{ text: "🔙 Back", callback_data: "back_main" }]);
    return { inline_keyboard: rows };
}

module.exports = {
    installStars,
    enabled,
    plans,
    findPlan,
};

// ── Wire all bot event handlers ────────────────────────────
function installStars(bot) {
    if (!bot) return;

    const safeEdit = (chatId, messageId, text, markup) =>
        bot.editMessageText(text, { chat_id: chatId, message_id: messageId, parse_mode: "Markdown", reply_markup: markup })
            .catch((e) => { if (!String(e.message || e.description || "").includes("is not modified")) console.error("❌ [Stars] edit:", e.message); });

    const backStars = () => ({ inline_keyboard: [[{ text: "🔙 Back to Plans", callback_data: "stars_shop" }]] });

    // ── 1. Shop navigation & "buy" callbacks ─────────────────
    bot.on("callback_query", async (q) => {
        const data = q && q.data;
        if (typeof data !== "string" || !data.startsWith("stars_")) return; // owned by bot_callbacks
        const uid = q.from && q.from.id;
        if (!uid) return;
        const msgId = q.message && q.message.message_id;
        try { await bot.answerCallbackQuery(q.id); } catch (_) {}

        if (!enabled()) {
            if (msgId) return safeEdit(uid, msgId, "⭐ The Stars shop is currently disabled. Contact an admin.", backStars());
            return bot.sendMessage(uid, "⭐ The Stars shop is currently disabled. Contact an admin.").catch(() => {});
        }

        if (data === "stars_shop") {
            if (msgId) return safeEdit(uid, msgId, shopText(uid), shopKeyboard());
            return bot.sendMessage(uid, shopText(uid), { parse_mode: "Markdown", reply_markup: shopKeyboard() }).catch(() => {});
        }

        if (data.startsWith("stars_buy_")) {
            const plan = findPlan(data.slice("stars_buy_".length));
            if (!plan) { if (msgId) return safeEdit(uid, msgId, "❌ Plan not found.", backStars()); return; }
            registerUser({ id: uid, first_name: (q.from.first_name || "User"), username: q.from.username });
            const payload = `${plan.id}:${uid}:${Date.now()}`;   // <128 bytes
            try {
                await bot.sendInvoice(
                    uid,                                      // chat_id
                    `${EMO[plan.tier] || ""} ${plan.tier} — ${plan.days} Day${plan.days > 1 ? "s" : ""}`, // title (1-32 chars)
                    `WS CHECKER ${plan.tier} upgrade. ${plan.days} day${plan.days > 1 ? "s" : ""}. Auto-activated instantly on payment.`, // description
                    payload,                                  // invoice payload (echoed back to us)
                    "",                                       // provider_token — empty for Stars
                    "XTR",                                    // currency = Telegram Stars
                    [{ label: `${plan.tier} ${plan.days} Day${plan.days > 1 ? "s" : ""}`, amount: plan.stars }]
                ).catch(() => { throw new Error("sendInvoice failed"); });
                if (msgId) safeEdit(uid, msgId, "🧾 *Invoice sent.* Tap *Pay ⭐ …* on the invoice message above to complete the purchase.\n\nIt is delivered automatically once Telegram confirms the payment.", backStars());
            } catch (e) {
                console.error("❌ [Stars] invoice send failed:", e.message);
                if (msgId) return safeEdit(uid, msgId, "❌ Could not send the Stars invoice. Please make sure this is a private chat with the bot and try again.", backStars());
            }
            return;
        }
    });

    // ── 2. Approve/deny pre-checkout (must answer < 10s) ─────
    bot.on("pre_checkout_query", async (query) => {
        try {
            const payload = String(query.invoice_payload || "");
            const plan = findPlan(payload.split(":")[0]);
            const ok = !!plan && Number(query.total_amount) === plan.stars;
            if (!ok) console.warn("⚠️ [Stars] pre-checkout rejected:", payload, "amount", query.total_amount);
            await bot.answerPreCheckoutQuery(query.id, ok);
        } catch (e) {
            console.error("❌ [Stars] pre-checkout error:", e.message);
            try { await bot.answerPreCheckoutQuery(query.id, false); } catch (_) {}
        }
    });

    // ── 3. Auto-deliver on successful payment ────────────────
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

            const grantUid = (puidRaw && Number.isFinite(Number(puidRaw)) && Number(puidRaw) > 0) ? Number(puidRaw) : chatUid;
            registerUser({ id: grantUid, first_name: from.first_name || "User", username: from.username });
            const expiry = extendPlanStack(grantUid, plan.tier, plan.days);

            logStarsPayment({
                chargeId: cid, uid: grantUid, tier: plan.tier, days: plan.days,
                stars: plan.stars, currency: pay.currency || "XTR",
                planId: plan.id, refunded: false,
                at: new Date().toISOString(),
            });

            const confirm =
                `╭━━━[ ⭐ *PAYMENT RECEIVED* ]━━━╮\n` +
                `┣ ${EMO[plan.tier] || ""} *${plan.tier}* ${plan.days} day${plan.days > 1 ? "s" : ""} activated!\n` +
                `┣ ⭐ Paid: *${plan.stars} Stars*\n` +
                `┣ 🗓️ New expiry: *${new Date(expiry).toLocaleDateString("en-GB")}*\n` +
                `┣ 🧾 Charge: ${cid}\n` +
                `╰━━━━━━━━━━━━━━━━━━━━╯`;
            bot.sendMessage(grantUid, confirm, { parse_mode: "Markdown" }).catch(() => {});
            bot.sendMessage(config.OWNER_ID,
                `⭐ *Stars sale* — uid ${grantUid}\n📦 ${plan.tier} ${plan.days}d\n⭐ ${plan.stars} Stars\n🧾 ${cid}`,
                { parse_mode: "Markdown" }).catch(() => {});
            console.log(`⭐ [Stars] Paid ${plan.stars} XTR — ${plan.tier} ${plan.days}d for uid ${grantUid} (charge ${cid})`);
        } catch (e) {
            console.error("❌ [Stars] payment handler error:", e.message);
        }
    });

    // ── 4. Owner refund ──────────────────────────────────────
    bot.onText(/\/refundstars (.+)/, async (msg, match) => {
        const uid = msg.from && msg.from.id;
        if (!isOwner(uid)) return;
        const cid = String(match[1] || "").trim();
        if (!cid) return bot.sendMessage(uid, "Usage: /refundstars <charge_id>", { parse_mode: "Markdown" });
        const rec = getStarsPayment(cid);
        if (!rec) return bot.sendMessage(uid, `❌ No Stars payment record found for charge ${cid}.`, { parse_mode: "Markdown" });
        if (rec.refunded) return bot.sendMessage(uid, `⚠️ This payment (${cid}) was already refunded.`, { parse_mode: "Markdown" });
        try {
            await bot.refundStarPayment(Number(rec.uid), cid);
            // Revoke the granted days for the tier purchased.
            if (String(rec.tier).toUpperCase() === "VIP") removeVIP(rec.uid);
            else removeSubscriber(rec.uid);
            logStarsPayment({ ...rec, refunded: true, refundedAt: new Date().toISOString() });
            bot.sendMessage(Number(rec.uid),
                `⭐ *Refund processed.* Charge ${cid} was refunded and your ${rec.tier} access was revoked.`,
                { parse_mode: "Markdown" }).catch(() => {});
            return bot.sendMessage(uid,
                `✅ Refunded *${rec.stars} Stars* for charge ${cid} and revoked ${rec.tier} from uid ${rec.uid}.`,
                { parse_mode: "Markdown" });
        } catch (e) {
            return bot.sendMessage(uid, `❌ Refund failed: ${e.message || e.description || "unknown"}`, { parse_mode: "Markdown" });
        }
    });
}
