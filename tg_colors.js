// ============================================================
//   tg_colors.js
//   Bot API 9.4 colored inline-keyboard buttons (style field)
// ------------------------------------------------------------
//   Telegram Bot API 9.4 (Feb 2026) added the field `style` to
//   InlineKeyboardButton: "primary" (blue), "success" (green),
//   "danger" (red). We inject it into every inline keyboard on
//   sendMessage / editMessageText. Older clients/servers simply
//   ignore the unknown JSON field, so this degrades gracefully.
// ============================================================
"use strict";

const { colorInlineKeyboard } = require("./utils");

function colorizeOptions(opts) {
    if (opts && typeof opts === "object" && opts.reply_markup && opts.reply_markup.inline_keyboard) {
        opts = { ...opts, reply_markup: { ...opts.reply_markup, inline_keyboard: colorInlineKeyboard(opts.reply_markup.inline_keyboard) } };
    }
    return opts;
}

// Wrap bot.sendMessage so every inline keyboard is colorized.
// ⚠️ CRITICAL: node-telegram-bot-api's signature is sendMessage(chatId, text, form).
// The colorized options MUST be forwarded as the THIRD argument — forwarding
// them as the text/second argument drops reply_markup entirely and every
// button disappears from the message.
function installSendMessageColors(bot) {
    const origSend = bot.sendMessage.bind(bot);
    bot.sendMessage = async function (chatId, text, options) {
        return origSend(chatId, text, colorizeOptions(options));
    };
    return bot;
}

module.exports = { colorizeOptions, installSendMessageColors };
