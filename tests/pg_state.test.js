// ============================================================
//   tests/pg_state.test.js
//   Integration test: pg_state.js (Postgres-backed WhatsApp
//   session auth + KV mirrors) against the in-memory FakePool.
//   Verifies the full lifecycle a redeploy relies on:
//     set keys/creds -> flush to PG -> row survives -> reload.
// ============================================================
"use strict";

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");

const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "pgstate-"));

process.env.DATABASE_URL = "postgresql://user:pass@localhost:5432/pgstate_test";
process.env.PGSSLMODE = "disable";
process.env.DATA_DIR = DATA_DIR;
process.env.TG_TOKEN = "123456:AA-DummyTelegramTokenForSandboxTestOnly";
process.env.OWNER_ID = "8708907310";
process.env.PORT = "9878";

const pgStore = require("../pg_store");
const pgState = require("../pg_state");
const { FakePool } = require("./fake_pg");

(async () => {
    const fake = new FakePool();
    pgStore._setPoolForTest(fake);
    const ok = await pgStore.initPGStore({});
    assert.strictEqual(ok, true, "PG init should succeed on FakePool");

    // ── 1. generic KV roundtrip ───────────────────────────────
    assert.strictEqual(await pgStore.kvSet("dynamic", { FORCE_JOIN_CHANNELS: [{ title: "C", chatId: "@c" }] }), true);
    const dyn = await pgStore.kvGet("dynamic");
    assert.deepStrictEqual(dyn, { FORCE_JOIN_CHANNELS: [{ title: "C", chatId: "@c" }] });
    assert.strictEqual((await pgStore.kvList("job:")).length, 0);
    await pgStore.kvSet("job:42", { nums: 3 });
    const jobs = await pgStore.kvList("job:");
    assert.strictEqual(jobs.length, 1);
    assert.strictEqual(jobs[0].data.nums, 3);
    assert.strictEqual(await pgStore.kvDelete("job:42"), true);
    assert.strictEqual((await pgStore.kvList("job:")).length, 0);
    console.log("✅ KV mirror roundtrip PASSED");

    // ── 2. WhatsApp session auth: write keys+creds, flush, reload ──
    const sid = "testnode1";
    const auth = await pgState.makeWAAuth(sid);
    assert.ok(auth.state.creds, "creds object must exist");
    assert.strictEqual(typeof auth.saveCreds, "function");

    const buf = Buffer.from("signal-material-bytes");
    await auth.state.keys.set({
        session: { "abc123": { registrationId: 7, bufferData: buf } },
        "sender-key": { "120363041235403838@g.us": { keyId: 1 } },
        "app-state-sync-key": { "AAAAkey": { indexData: Buffer.from("idx") } },
    });
    await auth.saveCreds();
    await pgState.flushSession(sid); // force the debounce

    // Reload path: drop the in-memory registry entry (simulates restart),
    // then re-create the auth from the row that "survived" in Postgres.
    // (dropWA deletes the row; so clear registry without deleting row via
    //  kvGet directly to assert what a fresh process would load.)
    const row = await pgStore.kvGet("wa:" + sid);
    assert.ok(row, "wa: row must exist in Postgres after flush");
    assert.ok(row.creds && typeof row.creds === "object", "creds persisted");
    assert.ok(row.keys.session && row.keys.session.abc123, "session key persisted");
    assert.ok(row.keys["sender-key"]["120363041235403838@g.us"], "sender key persisted");
    assert.ok(row.keys["app-state-sync-key"].AAAAkey, "app-state-sync key persisted");
    console.log("✅ WA auth persisted row PASSED");

    // keys.get contract (what Baileys calls after a restart)
    const auth2 = await pgState.makeWAAuth(sid);
    const got = await auth2.state.keys.get("session", ["abc123"]);
    assert.ok(got.abc123, "reloaded session key readable via keys.get");
    assert.strictEqual(got.abc123.registrationId, 7);
    const gotSender = await auth2.state.keys.get("sender-key", ["120363041235403838@g.us"]);
    assert.ok(gotSender["120363041235403838@g.us"], "reloaded sender-key readable");
    const absent = await auth2.state.keys.get("session", ["nope"]);
    assert.strictEqual(absent.nope, null, "absent key -> null (file-store parity)");
    console.log("✅ WA auth reload + keys.get PASSED");

    // ── 3. delete session drops the row ───────────────────────
    assert.ok((await pgState.listWASessions()).includes(sid));
    await pgState.dropWA(sid);
    assert.strictEqual(await pgStore.kvGet("wa:" + sid), null, "row deleted on node removal");
    console.log("✅ dropWA PASSED");

    // ── 4. legacy folder import ───────────────────────────────
    const dir = path.join(DATA_DIR, "session_legacy1");
    fs.mkdirSync(dir, { recursive: true });
    const { BufferJSON } = require("@whiskeysockets/baileys");
    fs.writeFileSync(path.join(dir, "creds.json"), JSON.stringify({ me: { id: "919999999999:1" }, registered: true }, BufferJSON.replacer));
    fs.writeFileSync(path.join(dir, "session-key1.json"), JSON.stringify({ data: Buffer.from("sess") }, BufferJSON.replacer));
    fs.writeFileSync(path.join(dir, "sender-key-919876543210@s.whatsapp.net.json"), JSON.stringify({ data: Buffer.from("sk") }, BufferJSON.replacer));
    fs.writeFileSync(path.join(dir, "random-other.json"), JSON.stringify({ x: 1 }));
    assert.strictEqual(await pgState.importSessionDir("legacy1", dir), true);
    const legacyRow = await pgStore.kvGet("wa:legacy1");
    assert.ok(legacyRow.creds.me.id === "919999999999:1", "legacy creds imported");
    assert.ok(legacyRow.keys.session.key1, "legacy session key imported");
    assert.ok(legacyRow.keys["sender-key"]["919876543210@s.whatsapp.net"], "legacy sender-key imported");
    assert.ok(!legacyRow.keys["random-other"], "non-session files ignored");
    await pgState.dropWA("legacy1");
    console.log("✅ legacy folder import PASSED");

    console.log("🎉 PG-STATE TESTS PASSED");
    process.exit(0);
})().catch((e) => { console.error("❌ PG-STATE TEST FAILED:", e); process.exit(1); });
