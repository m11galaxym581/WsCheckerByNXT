// ============================================================
//   tests/fake_pg.js
//   In-memory PostgreSQL stand-in with a pg-compatible API
//   (handles exactly the SQL statements pg_store.js issues)
// ============================================================
"use strict";

class FakePool {
    constructor() {
        this.tables = new Map(); // 'app_state' -> Map(schema_key -> object)
        this.queryLog = [];
    }

    async query(text, params = []) {
        this.queryLog.push({ text, params });
        if (/CREATE TABLE IF NOT EXISTS app_state/i.test(text)) {
            if (!this.tables.has("app_state")) this.tables.set("app_state", new Map());
            return { rows: [], rowCount: 0 };
        }
        if (/INSERT INTO app_state/i.test(text)) {
            const table = this.tables.get("app_state") || new Map();
            table.set(params[0], JSON.parse(params[1]));
            this.tables.set("app_state", table);
            return { rows: [], rowCount: 1 };
        }
        if (/SELECT data FROM app_state WHERE schema_key = \$1/i.test(text)) {
            const table = this.tables.get("app_state") || new Map();
            const value = table.get(params[0]);
            return { rows: value ? [{ data: value }] : [] };
        }
        if (/SELECT schema_key, data FROM app_state WHERE schema_key LIKE \$1/i.test(text)) {
            const table = this.tables.get("app_state") || new Map();
            const prefix = params[0].replace(/%$/, "");
            const rows = [];
            for (const key of table.keys()) if (key.startsWith(prefix)) rows.push({ schema_key: key, data: table.get(key) });
            return { rows };
        }
        if (/DELETE FROM app_state/i.test(text)) {
            const table = this.tables.get("app_state") || new Map();
            table.delete(params[0]);
            return { rows: [], rowCount: 1 };
        }
        throw new Error("FakePool: unhandled SQL -> " + text);
    }

    async end() {}

    dump(schemaKey = "db") {
        const table = this.tables.get("app_state") || new Map();
        return table.get(schemaKey) || null;
    }
}

module.exports = { FakePool };
