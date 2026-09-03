// ============================================================
//   tests/tg_colors.test.js
//   Unit test for the Bot API 9.4 button-color wrapper.
//   Regression guard: the wrapper must preserve node-telegram-
//   bot-api's sendMessage(chatId, text, form) signature — when
//   the colorized options were forwarded as the SECOND argument,
//   reply_markup was dropped and every button disappeared from
//   real messages ("sare buttons gayab" bug).
// ============================================================
"use strict";

const assert = require("assert");
const { colorizeOptions, installSendMessageColors } = require("../tg_colors");

function makeFakeBot() {
    const calls = [];
    const bot = {
        calls,
        async sendMessage(chatId, text, form = {}) {
            calls.push({ chatId, text, form });
            return { message_id: calls.length };
        },
    };
    return bot;
}

async function main() {
    // ── Scenario 1: keyboard survives AND gets colored ────────
    const bot = makeFakeBot();
    installSendMessageColors(bot);
    const kb = [[{ text: "🚫 Delete", callback_data: "del" }], [{ text: "🚀 Open Web App", web_app: { url: "https://x.test" } }]];
    const res = await bot.sendMessage(8708907310, "Hello", { parse_mode: "Markdown", reply_markup: { inline_keyboard: kb } });
    assert.ok(res && res.message_id === 1, "message was sent");
    assert.strictEqual(bot.calls.length, 1, "exactly one underlying call");
    const c = bot.calls[0];
    assert.strictEqual(c.chatId, 8708907310, "chatId forwarded as FIRST arg");
    assert.strictEqual(c.text, "Hello", "text forwarded as SECOND arg");
    assert.ok(c.form && c.form.reply_markup, "reply_markup keyboard survived in THIRD arg (form)");
    assert.ok(c.form.reply_markup.inline_keyboard, "inline_keyboard survived");
    const btns = c.form.reply_markup.inline_keyboard.flat();
    assert.ok(btns.length === 2, "both buttons present");
    assert.strictEqual(btns[0].style, "danger", "Delete → danger");
    assert.strictEqual(btns[1].style, "primary", "Open Web App → primary");
    assert.strictEqual(c.form.parse_mode, "Markdown", "other options untouched");
    console.log("✅ Scenario 1 (keyboard survives with style, 3-arg mapping) PASSED");

    // ── Scenario 2: no options → still works (default form) ───
    const bot2 = makeFakeBot();
    installSendMessageColors(bot2);
    await bot2.sendMessage(123, "plain");
    assert.strictEqual(bot2.calls[0].text, "plain");
    assert.deepStrictEqual(bot2.calls[0].form, {}, "form defaults to {}");
    console.log("✅ Scenario 2 (two-arg call unchanged) PASSED");

    // ── Scenario 3: pre-stringified reply_markup left as-is ───
    const bot3 = makeFakeBot();
    installSendMessageColors(bot3);
    const jsonRm = JSON.stringify({ inline_keyboard: [[{ text: "raw", callback_data: "r" }]] });
    await bot3.sendMessage(1, "x", { reply_markup: jsonRm });
    assert.strictEqual(bot3.calls[0].form.reply_markup, jsonRm, "string reply_markup untouched");
    console.log("✅ Scenario 3 (string reply_markup untouched) PASSED");

    // ── Scenario 4: buttons that already carry a style stay ───
    const out = colorizeOptions({ reply_markup: { inline_keyboard: [[{ text: "Custom", style: "danger", callback_data: "c" }]] } });
    assert.strictEqual(out.reply_markup.inline_keyboard[0][0].style, "danger");
    console.log("✅ Scenario 4 (explicit style respected) PASSED");

    console.log("🎉 TG-COLORS TESTS PASSED");
    process.exit(0);
}

main().catch(e => { console.error("❌ TG-COLORS TEST FAILED:", e); process.exit(1); });
