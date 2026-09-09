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
    logStarsPayment, getStarsPayment, removeSubscriber, removeVIP,
    isOwner, isAdmin
} = require("./database");

const EMO = { PRO: "💎", VIP: "🔥" };

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
    return plans().find((p) => p.id === String(id)) || null;
}

function enabled() {
    return !!(config.dynamic && config.dynamic.STARS_ENABLED);
}

function planTitle(p) {
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

    const safeEdit = (chatId, messageId, text, markup) =>
        bot.editMessageText(text, { chat_id: chatId, message_id: messageId, parse_mode: "Markdown", reply_markup: markup })
            .catch((e) => { if (!String(e.message || e.description || "").includes("is not modified")) console.error("❌ [Stars] edit:", e.message); });

    const sendText = (chatId, text, markup) =>
        bot.sendMessage(chatId, text, { parse_mode: "Markdown", reply_markup: markup }).catch(() => {});

    const backPlanGrid = () => ({ inline_keyboard: [[{ text: "🔙 Back to Plans", callback_data: "stars_shop" }]] });
    const backMethods = (planId) => ({ inline_keyboard: [[{ text: "🔙 Back to Methods", callback_data: `up_${planId}` }]] });
    const planGridMarkup = () => {
        const rows = plans().map((p) => [
            { text: `${planTitle(p)} — ${p.stars} ⭐ · choose payment`, callback_data: `up_${p.id}` }
        ]);
        rows.push([{ text: "🔙 Back", callback_data: "back_main" }]);
        return { inline_keyboard: rows };
    };
    const methodChooserMarkup = (plan) => {
        const rows = [
            [{ text: `⭐ Pay ${plan.stars} Stars (instant)`, callback_data: `stars_buy_${plan.id}` }],
            [{ text: "💠 Binance Pay", callback_data: `altpay_BINANCE_${plan.id}` }],
            [{ text: "🪙 USDT (TRC20)", callback_data: `altpay_USDT_${plan.id}` }],
            [{ text: "⛓️ Other Crypto (BTC/ETH)", callback_data: `altpay_CRYPTO_${plan.id}` }],
            [{ text: "🔙 Back to Plans", callback_data: "stars_shop" }],
        ];
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
            if (msgId) return safeEdit(uid, msgId, shopText(uid), planGridMarkup());
            return sendText(uid, shopText(uid), planGridMarkup());
        }

        // ── Method chooser for a specific plan ──
        if (data.startsWith("up_")) {
            const plan = findPlan(data.slice("up_".length));
            if (!plan) { if (msgId) return safeEdit(uid, msgId, "❌ Plan not found.", backPlanGrid()); return; }
            registerUser({ id: uid, first_name: (q.from.first_name || "User"), username: q.from.username });
            return safeEdit(uid, msgId,
                `╭━━━[ ${planTitle(plan)} — ${plan.stars} ⭐ ]━━━╮\n┣ How would you like to pay?\n┣━━━━━━━━━━━━━━━━━━━━━\n┣ ⭐ Stars = instant auto-activation.\n┣ 💠/🪙/⛓️ = contact owner, pay, then tap\n┣     "✅ I've paid" to get activated.\n╰━━━━━━━━━━━━━━━━━━━━━╯`,
                methodChooserMarkup(plan));
        }

        // ── ⭐ Stars: send the invoice (auto path) ─────────────
        if (data.startsWith("stars_buy_")) {
            const plan = findPlan(data.slice("stars_buy_".length));
            if (!plan) { if (msgId) return safeEdit(uid, msgId, "❌ Plan not found.", backPlanGrid()); return; }
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
            const ok = !!plan && Number(query.total_amount) === plan.stars;
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
            sendText(grantUid, confirm);
            sendText(config.OWNER_ID,
                `⭐ *Stars sale* — uid ${grantUid}\n📦 ${plan.tier} ${plan.days}d\n⭐ ${plan.stars} Stars\n🧾 ${cid}`);
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
        if (!cid) return sendText(uid, "Usage: /refundstars <charge_id>");
        const rec = getStarsPayment(cid);
        if (!rec) return sendText(uid, `❌ No Stars payment record found for charge ${cid}.`);
        if (rec.refunded) return sendText(uid, `⚠️ This payment (${cid}) was already refunded.`);
        try {
            await bot.refundStarPayment(Number(rec.uid), cid);
            if (String(rec.tier).toUpperCase() === "VIP") removeVIP(rec.uid);
            else removeSubscriber(rec.uid);
            logStarsPayment({ ...rec, refunded: true, refundedAt: new Date().toISOString() });
            sendText(Number(rec.uid),
                `⭐ *Refund processed.* Charge ${cid} was refunded and your ${rec.tier} access was revoked.`);
            return sendText(uid, `✅ Refunded *${rec.stars} Stars* for charge ${cid} and revoked ${rec.tier} from uid ${rec.uid}.`);
        } catch (e) {
            return sendText(uid, `❌ Refund failed: ${e.message || e.description || "unknown"}`);
        }
    });
}
