// ============================================================
//   md_html.js
//   Markdown → HTML renderer for Telegram bot messages.
// ------------------------------------------------------------
//   The bot's user-visible text was authored with *bold*,
//   `code`, _italic_ and occasionally [text](url) markup that
//   requires Telegram's legacy "Markdown" parser. Telegram HTML
//   mode is far more reliable and never leaks a stray `*`, so we
//   convert these messages to HTML at the send boundary.
//
//   Supported subset (flat, no nesting): 
//     *bold*      → <b>…</b>
//     _italic_    → <i>…</i>
//     `code`      → <code>…</code>
//     [text](url) → <a href="url">…</a>
//     >> quote    → <blockquote>…</blockquote>  (line start)
//     >>> quote   → <blockquote expandable>…</blockquote>
//   Plain text (including anything inside the tags above) is
//   HTML-escaped so stray & < > can never break Telegram parsing.
// ============================================================

"use strict";

const ESC = {
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
};

function escapeHtml(s) {
    return String(s).replace(/[&<>]/g, (c) => ESC[c]);
}

// Heuristic: does the text carry any of the markup we understand?
function hasMarkup(text) {
    if (typeof text !== "string") return false;
    return (
        /\*[^*\n]+\*/.test(text) || // bold
        /`[^`\n]+`/.test(text) ||   // code
        /_[^_\n]+_/.test(text) ||   // italic
        /\[[^\]\n]+\]\([^)\n]+\)/.test(text) || // link
        /^ *>>+ .+/m.test(text) // blockquote
    );
}

function markdownToHtml(text, allowQuote = true) {
    if (typeof text !== "string") return text;

    const original = text;
    // Blockquotes first (line-based). Inner content is processed
    // recursively so inline markup (`code`, *bold*) works inside.
    const quoteHoles = [];
    const QH = "\u0000MDQUOTE";
    if (allowQuote) {
        text = text.replace(/^ *>>+( +)(.*)$/gm, (_m, _sp, inner) => {
            const expandable = _m.trimStart().startsWith(">>>");
            quoteHoles.push({ expandable, inner });
            return QH + (quoteHoles.length - 1) + "\u0000";
        });
    }
    // Protect code spans first (code may sit inside bold), and let
    // us HTML-escape their content exactly once.
    const codeHoles = [];
    const CODE = "\u0000MDCODE";
    text = text.replace(/`([^`]*)`/g, (_m, c) => {
        codeHoles.push(escapeHtml(c));
        return CODE + (codeHoles.length - 1) + "\u0000";
    });

    // Escape every remaining plain character now, so that anything
    // we wrap in a tag later is already safe.
    text = escapeHtml(text);

    // Bold — tags are introduced after escaping, so they survive.
    text = text.replace(/\*([^*\n]+?)\*/g, "<b>$1</b>");

    // Italic.
    text = text.replace(/_([^_\n]+?)_/g, "<i>$1</i>");

    // Links. label & href were already HTML-escaped by the global
    // pass above, so drop them straight into the <a> tag.
    text = text.replace(/\[([^\]\n]+?)\]\(([^)\n]+?)\)/g, (_m, label, href) => {
        return `<a href="${href}">${label}</a>`;
    });

    // Restore code spans.
    text = text.replace(new RegExp(CODE + "(\\d+)\\u0000", "g"), (_m, i) => `<code>${codeHoles[Number(i)]}</code>`);

    // Restore blockquotes (recursive inline pass, quotes disabled inside).
    if (quoteHoles.length) {
        text = text.replace(new RegExp(QH + "(\\d+)\\u0000", "g"), (_m, i) => {
            const q = quoteHoles[Number(i)];
            const inner = markdownToHtml(q.inner, false);
            return q.expandable
                ? `<blockquote expandable>${inner}</blockquote>`
                : `<blockquote>${inner}</blockquote>`;
        });
    }

    if (text === escapeHtml(original) && !/<b>|<i>|<code>|<a /.test(text)) {
        // Nothing structurally changed (only & < > were escaped) — safe either way.
    }
    return text;
}

module.exports = { escapeHtml, hasMarkup, markdownToHtml };
