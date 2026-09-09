// ============================================================
//   tests/preload_fake_pg.js
//   Preload hook for full-app boot tests: swaps the real pg
//   connection pool for the in-memory FakePool BEFORE index.js
//   loads (use: node -r ./tests/preload_fake_pg.js index.js)
// ============================================================
"use strict";
process.env.PGSSLMODE = "disable";
const { FakePool } = require("./fake_pg");
const pgStore = require("../pg_store");
const fake = new FakePool();
global.__FAKE_PG__ = fake;
pgStore._setPoolForTest(fake);
console.log("🧪 [Test] In-memory PostgreSQL driver installed.");
