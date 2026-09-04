// ============================================================
//   tests/auto_setup.test.js
//   Unit test for the zero-touch Telegram setup engine with a
//   fake bot (no network). Scenarios:
//     1. happy path -> everything applied, owner report sent,
//        menu button verified, app link built from username
//     2. domain not allow-listed -> whitelistPending=true and the
//        owner report tells the user exactly what to do
// ============================================================
"use strict";

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "autosetup-"));
process.env.TG_TOKEN = "123456:AA-DummyTelegramTokenForSandboxTestOnly";
process.env.OWNER_ID = "8708907310";
process.env.PORT = "9885";
process.env.DASHBOARD_URL = "https://blaze-dash.up.railway.app";

const state = require("../state");
const { getDB, saveDB } = require("../database");
const { runAutoSetup } = require("../auto_setup");

// register the owner so the report path triggers
const db = getDB();
db.users[8708907310] = { id: 8708907310, name: "Owner", username: "owner", count: 0, banned: false, web_pass: "", lang: "en", proExpiry: null, vipExpiry: null };
saveDB(db);

let ownerMessages = [];
const makeBot = (overrides = {}) => ({
    async getMe() { return { id: 1, username: "blaze_demo_bot", first_name: "Blaze Demo" }; },
    async setMyName() { return true; },
    async setMyDescription() { return true; },
    async setMyShortDescription() { return true; },
    async getMyName() { return { name: "WS CHECKER" }; },
    async getMyDescription() { return { description: "WhatsApp checker" }; },
    async getMyShortDescription() { return { short_description: "Number checker" }; },
    async setMyCommands(cmds) { assert.ok(Array.isArray(cmds) && cmds.length, "commands must be an array"); return true; },
    async setChatMenuButton() { return true; },
    // Real Telegram API: getChatMenuButton returns the MenuButton directly.
    async getChatMenuButton() { return { type: "web_app", text: "Open App", web_app: { url: "https://x.test" } }; },
    // Raw Bot API request used for setMyProfilePhoto (no wrapper in lib yet)
    async _request(method) { if (method === "setMyProfilePhoto") return true; throw new Error("unhandled _request: " + method); },
    async sendMessage(chatId, text) { ownerMessages.push({ chatId, text }); return { message_id: ownerMessages.length }; },
    async deleteMessage() { return true; },
    ...overrides,
});

async function main() {
    // ── Scenario 1: happy path ────────────────────────────────
    ownerMessages = [];
    const r1 = await runAutoSetup(makeBot());
    assert.strictEqual(r1.ran, true);
    assert.strictEqual(r1.menuButtonActive, true, "menu button stored & verified");
    assert.strictEqual(r1.whitelistPending, false);
    assert.strictEqual(r1.appLink, "https://t.me/blaze_demo_bot/app", "app link built from bot username");
    assert.strictEqual(state.BOT_INFO.username, "blaze_demo_bot");
    assert.ok(r1.results.setName.ok && r1.results.setCommands.ok && r1.results.setDescription.ok);
    assert.ok(r1.summary.includes("✅"), "summary lists successes");
    const ownerMsg = ownerMessages.find(m => m.chatId === 8708907310);
    assert.ok(ownerMsg && ownerMsg.text.includes("t.me/blaze_demo_bot/app"), "owner report sent with app link");
    console.log("✅ Scenario 1 (happy path) PASSED");

    // ── Scenario 2: domain whitelist pending ─────────────────
    ownerMessages = [];
    const blockedBot = makeBot({
        async setChatMenuButton() { const e = new Error("Bad Request: BUTTON_URL_INVALID"); e.description = "Bad Request: BUTTON_URL_INVALID: The domain of the URL must be added to the bot's whitelist"; throw e; },
        async getChatMenuButton() { return { type: "default" }; },
    });
    const r2 = await runAutoSetup(blockedBot);
    assert.strictEqual(r2.whitelistPending, true, "whitelist pending detected");
    assert.strictEqual(r2.menuButtonActive, false);
    assert.ok(r2.summary.includes("ACTION NEEDED"), "summary tells owner what to do");
    const ownerMsg2 = ownerMessages.find(m => m.chatId === 8708907310);
    assert.ok(ownerMsg2 && ownerMsg2.text.includes("whitelist"), "owner report mentions whitelist");
    console.log("✅ Scenario 2 (whitelist pending) PASSED");

    // ── Scenario 3: read-back happens AFTER apply (ordering) ──
    // Regression guard for the real-deployment bug where verification read
    // the menu button state BEFORE it was applied, so bots that had a
    // "commands" button kept being reported as broken even after a
    // successful setChatMenuButton. Also simulates Telegram's async
    // propagation: the first read-backs still return the OLD "commands"
    // state and only later reads return "web_app".
    ownerMessages = [];
    let menuApplied = false;
    let getCalls = 0;
    let setCalls = 0;
    let firstGetBeforeSet = false;
    const eventualBot = makeBot({
        async setChatMenuButton() {
            setCalls++;
            menuApplied = true;
            return true;
        },
        async getChatMenuButton() {
            if (!menuApplied) firstGetBeforeSet = true;
            getCalls++;
            if (menuApplied && getCalls >= 3) {
                return { type: "web_app", text: "Open App", web_app: { url: "https://x.test" } };
            }
            return { type: "commands" }; // stale until Telegram propagates
        },
    });
    const r3 = await runAutoSetup(eventualBot);
    assert.strictEqual(firstGetBeforeSet, false, "getChatMenuButton must never be called before setChatMenuButton");
    assert.strictEqual(setCalls, 1, "setChatMenuButton called exactly once");
    assert.ok(getCalls >= 3, `verify should poll stale reads (got ${getCalls} reads)`);
    assert.strictEqual(r3.menuButtonActive, true, "menu button verified web_app after polling");
    assert.strictEqual(r3.whitelistPending, false);
    assert.ok(r3.results.verifyMenuButton.ok);
    console.log("✅ Scenario 3 (read-after-apply ordering + async propagation) PASSED");
    console.log("🎉 AUTO-SETUP TESTS PASSED");
    process.exit(0);
}

main().catch(e => { console.error("❌ AUTO-SETUP TEST FAILED:", e); process.exit(1); });
