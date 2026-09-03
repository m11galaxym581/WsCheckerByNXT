// ============================================================
//   tests/pg_store.test.js
//   Integration test: database.js + pg_store.js against an
//   in-memory PostgreSQL driver (FakePool), covering:
//     1. boot with DATABASE_URL -> postgres backend
//     2. one-time migration from an existing users.json
//     3. mutations flushed to PG, then reloaded in a "fresh process"
//     4. file-backend still works when DATABASE_URL is absent
// ============================================================
"use strict";

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");

const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "pgtest-"));

// ── Phase 1: PG backend ─────────────────────────────────────
process.env.DATABASE_URL = "postgresql://user:pass@localhost:5432/pgtest";
process.env.PGSSLMODE = "disable";
process.env.DATA_DIR = DATA_DIR;
process.env.TG_TOKEN = "123456:AA-DummyTelegramTokenForSandboxTestOnly";
process.env.OWNER_ID = "8708907310";
process.env.PORT = "9877";

// Seed an existing users.json (migration source)
const fixture = {
    users: {
        111: { id: 111, username: "old", name: "Legacy", count: 0, banned: false, web_pass: "", lang: "en", proExpiry: null, vipExpiry: null, joinedAt: new Date().toISOString() },
    },
    subscribers: [],
    vips: [],
    admins: [8708907310],
    sessionMeta: {},
    history: {},
    banned: [],
    dailyStats: {},
    vouchers: {},
    meta: { version: 5, maintenance: false },
};
fs.writeFileSync(path.join(DATA_DIR, "users.json"), JSON.stringify(fixture, null, 2));

const { FakePool } = require("./fake_pg");

async function main() {
    // --- first "process": boot store with PG ---------------------------------
    const pgStore1 = require("../pg_store");
    const fake1 = new FakePool();
    pgStore1._setPoolForTest(fake1);

    const dbm1 = require("../database");
    const backend1 = await dbm1.initDB();
    assert.strictEqual(backend1, "postgres", "backend should be postgres with DATABASE_URL set");
    assert.strictEqual(dbm1.dbBackend(), "postgres");

    // migration from users.json happened + defaults filled by repair
    let db = dbm1.getDB();
    assert.ok(db.users["111"], "legacy user migrated from users.json");
    assert.ok(Array.isArray(db.admins) && db.admins.includes(8708907310));
    assert.ok(db.vouchers && typeof db.vouchers === "object", "default schema repaired");

    // --- mutations flow through to PG ----------------------------------------
    dbm1.registerUser({ id: 222, first_name: "Bob", username: "bob" });
    assert.strictEqual(dbm1.addSubscriber(222, 30), true);
    assert.ok(dbm1.isSub(222), "fresh subscriber should have access");
    dbm1.saveSessionMeta("s1", 222, "private", { proxy: "masked" });
    dbm1.createVoucher("PRO", 30, 1);
    dbm1.setMaintenance(true);

    await dbm1.syncDB(); // wait for all queued flushes
    const persisted = fake1.dump("db");
    assert.ok(persisted, "PG row should exist after syncDB");
    assert.ok(persisted.users["222"], "new user persisted to PG");
    assert.ok(persisted.users["222"].proExpiry > Date.now() - 1000, "proExpiry persisted");
    assert.ok(persisted.subscribers.includes(222), "subscriber list persisted");
    assert.ok(persisted.sessionMeta["s1"], "session meta persisted");
    assert.strictEqual(persisted.meta.maintenance, true, "maintenance flag persisted");
    assert.ok(Object.keys(persisted.vouchers).length === 1, "voucher persisted");

    // isSub still true in memory view
    assert.ok(dbm1.isSub(222));

    // --- second "process": restart, reload state from PG ----------------------
    for (const mod of ["../pg_store", "../database", "../config", "./fake_pg"]) {
        delete require.cache[require.resolve(mod)];
    }
    const pgStore2 = require("../pg_store");
    pgStore2._setPoolForTest(fake1); // same "database" survives the restart
    const dbm2 = require("../database");
    const backend2 = await dbm2.initDB();
    assert.strictEqual(backend2, "postgres");

    db = dbm2.getDB();
    assert.ok(db.users["222"], "user survived restart (loaded from PG)");
    assert.ok(db.subscribers.includes(222), "subscription survived restart");
    assert.ok(db.sessionMeta["s1"], "session meta survived restart");
    assert.strictEqual(db.meta.maintenance, true, "maintenance survived restart");

    // expiry cleanup on reload
    db.users["222"].proExpiry = Date.now() - 5000; // force expiry
    dbm2.saveDB(db);
    assert.ok(!dbm2.isSub(222), "expired subscriber loses access after repair");
    await dbm2.syncDB();
    assert.ok(!fake1.dump("db").subscribers.includes(222), "expired subscriber removed from PG");

    console.log("✅ Phase 1+2 (PostgreSQL backend, migration, persistence, expiry) PASSED");

    // --- Phase 3: no DATABASE_URL -> file backend still works -----------------
    for (const mod of ["../pg_store", "../database", "../config"]) {
        delete require.cache[require.resolve(mod)];
    }
    delete process.env.DATABASE_URL;
    delete process.env.PGSSLMODE;
    const dbm3 = require("../database");
    assert.strictEqual(dbm3.dbBackend(), "file");
    dbm3.registerUser({ id: 333, first_name: "Cara", username: "cara" });
    const db3 = dbm3.getDB();
    assert.ok(db3.users["333"], "file backend still functional");
    assert.ok(fs.existsSync(path.join(DATA_DIR, "users.json")), "users.json written on file backend");

    console.log("✅ Phase 3 (file backend fallback) PASSED");
    console.log("🎉 ALL PG STORE TESTS PASSED");
    process.exit(0);
}

main().catch((e) => {
    console.error("❌ PG STORE TEST FAILED:", e);
    process.exit(1);
});
