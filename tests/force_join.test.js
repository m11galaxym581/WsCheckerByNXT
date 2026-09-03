// ============================================================
//   tests/force_join.test.js
//   Unit tests for the shared force-join engine (fake bot, no
//   network). Covers the real-world bugs: users blocked forever
//   because membership could not be verified, invite-link-only
//   channels, and the bot lacking admin rights in the channel.
// ============================================================
"use strict";

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "forcejoin-"));
process.env.OWNER_ID = "999999001";
process.env.TG_TOKEN = "123456:AA-DummyTelegramTokenForSandboxTestOnly";

const config = require("../config");
const { checkForceJoin, probeChannel, normalizeChannel, matchJoinRequestChannel, missingReasonLine } = require("../force_join");

const USER = 100200300;

const calls = [];
function makeBot(handler) {
    return {
        async getChatMember(chatId, uid) {
            calls.push({ chatId: String(chatId), uid });
            return handler(String(chatId), uid);
        },
    };
}

function setChannels(channels) {
    config.setDynamicConfig({ FORCE_JOIN_ENABLED: true, FORCE_JOIN_CHANNELS: channels });
}
function clearAll() {
    config.setDynamicConfig({ FORCE_JOIN_ENABLED: false, FORCE_JOIN_CHANNELS: [] });
}

async function main() {
    // ── Scenario 1: joined members pass ───────────────────────
    calls.length = 0;
    setChannels([{ title: "Pub", chatId: "@publicchan", url: "https://t.me/publicchan" }]);
    const bot1 = makeBot((chatId) => {
        assert.strictEqual(chatId, "@publicchan", "username normalized with @");
        return { status: "member" };
    });
    let r = await checkForceJoin(USER, bot1);
    assert.strictEqual(r.ok, true, "member passes");
    assert.deepStrictEqual(r.missing, []);

    // restricted (can't speak) still counts as a member
    const bot1b = makeBot(() => ({ status: "restricted" }));
    r = await checkForceJoin(USER, bot1b);
    assert.strictEqual(r.ok, true, "restricted user passes");
    console.log("✅ Scenario 1 (member/restricted pass, @username normalized) PASSED");

    // ── Scenario 2: not joined / kicked → blocked ─────────────
    setChannels([{ title: "Pub", chatId: "@publicchan" }]);
    const bot2 = makeBot(() => ({ status: "left" }));
    r = await checkForceJoin(USER, bot2);
    assert.strictEqual(r.ok, false, "left user blocked");
    assert.strictEqual(r.missing.length, 1);
    assert.strictEqual(r.missing[0].reason, "not_joined");
    assert.ok(missingReasonLine(r.missing[0]).includes("not joined"), "message says not joined");
    const bot2b = makeBot(() => ({ status: "kicked" }));
    r = await checkForceJoin(USER, bot2b);
    assert.strictEqual(r.ok, false, "kicked user blocked");
    console.log("✅ Scenario 2 (left/kicked blocked with clear message) PASSED");

    // ── Scenario 3: private channel via NUMERIC id (join requests) ──
    setChannels([{ title: "Private", chatId: "-1001234567890" }]);
    const bot3 = makeBot((chatId) => {
        assert.strictEqual(chatId, "-1001234567890", "numeric chat id passed through");
        return { status: "member" };
    });
    r = await checkForceJoin(USER, bot3);
    assert.strictEqual(r.ok, true, "approved private-channel member passes via numeric id");
    console.log("✅ Scenario 3 (numeric private channel id works) PASSED");

    // ── Scenario 4: invite-link-only channel → honest failure ──
    calls.length = 0;
    setChannels([{ title: "Secret", url: "https://t.me/+abcd1234EF" }]);
    const bot4 = makeBot(() => ({ status: "member" })); // would never even be called
    r = await checkForceJoin(USER, bot4);
    assert.strictEqual(r.ok, false, "invite-link channel must not silently pass (old web_server bug)");
    assert.strictEqual(r.missing[0].reason, "unverifiable");
    assert.ok(calls.length === 0, "no getChatMember call for invite links");
    assert.ok(missingReasonLine(r.missing[0]).includes("admin"), "message explains the fix");
    console.log("✅ Scenario 4 (invite links never silently bypass verification) PASSED");

    // ── Scenario 5: bot lacks admin rights → clear setup error ──
    setChannels([{ title: "Pub", chatId: "@publicchan" }]);
    calls.length = 0;
    const e = new Error("Forbidden: bot is not a member of the channel chat");
    e.description = "Forbidden: bot is not a member of the channel chat";
    const bot5 = makeBot(() => { throw e; });
    r = await checkForceJoin(USER, bot5);
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.missing[0].reason, "bot_setup", "bot-permission problems are classified");
    assert.ok(missingReasonLine(r.missing[0]).includes("admin"), "user told the bot must be admin");
    console.log("✅ Scenario 5 (bot-not-admin detected, no silent forever-block) PASSED");

    // ── Scenario 6: admin/owner always passes ─────────────────
    setChannels([{ title: "Pub", chatId: "@publicchan" }]);
    const bot6 = makeBot(() => { throw new Error("should not be called"); });
    r = await checkForceJoin(999999001, bot6);
    assert.strictEqual(r.ok, true, "admins bypass force join");
    console.log("✅ Scenario 6 (admins bypass) PASSED");

    // ── Scenario 7: disabled / empty config ───────────────────
    clearAll();
    const bot7 = makeBot(() => { throw new Error("should not be called"); });
    r = await checkForceJoin(USER, bot7);
    assert.strictEqual(r.ok, true, "disabled force join passes everyone");
    console.log("✅ Scenario 7 (disabled/empty passes) PASSED");

    // ── Scenario 8: normalizeChannel + join-request matching ──
    assert.strictEqual(normalizeChannel({ chatId: "-100555" }).mode, "id");
    assert.strictEqual(normalizeChannel({ chatId: "@abcde" }).mode, "username");
    assert.strictEqual(normalizeChannel({ username: "abcde" }).mode, "username");
    assert.strictEqual(normalizeChannel({ url: "https://t.me/abcde" }).mode, "username");
    assert.strictEqual(normalizeChannel({ url: "https://t.me/+abc123" }).mode, "none");
    const chanList = [{ title: "A", chatId: "-100777" }, { title: "B", username: "pubchan" }];
    assert.ok(matchJoinRequestChannel({ chat: { id: -100777 }, from: { id: 1 } }, chanList), "numeric request matches");
    assert.ok(matchJoinRequestChannel({ chat: { id: -5, username: "pubchan" }, from: { id: 1 } }, chanList), "username request matches");
    assert.strictEqual(matchJoinRequestChannel({ chat: { id: -9, username: "other" }, from: { id: 1 } }, chanList), null, "foreign channel ignored");
    console.log("✅ Scenario 8 (normalization + join-request matching) PASSED");

    clearAll();
    console.log("🎉 FORCE-JOIN TESTS PASSED");
    process.exit(0);
}

main().catch(e => { console.error("❌ FORCE-JOIN TEST FAILED:", e); process.exit(1); });
