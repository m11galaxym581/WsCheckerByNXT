// ============================================================
//   tests/make_initdata.js
//   Mints a Telegram-WebApp-style signed initData for testing.
//   Usage: node tests/make_initdata.js <botToken> <userId> [username]
//   Prints a single line: the initData string.
// ============================================================
"use strict";
const crypto = require("crypto");

const botToken = process.argv[2];
const userId = process.argv[3] || "8708907310";
const username = process.argv[4] || "testuser";
const firstName = process.argv[5] || "Test User";

const params = new URLSearchParams();
params.set("query_id", "AAHdF6IQAAAAAN0XohDhrOrc");
params.set("user", JSON.stringify({ id: Number(userId), first_name: firstName, last_name: "", username, language_code: "en", is_premium: true }));
params.set("auth_date", String(Math.floor(Date.now() / 1000)));
params.set("hash", "placeholder"); // replaced after signing

// sign
const secretKey = crypto.createHmac("sha256", "WebAppData").update(botToken).digest();
const check = [...params.entries()].filter(([k]) => k !== "hash").map(([k, v]) => `${k}=${v}`).sort().join("\n");
const hash = crypto.createHmac("sha256", secretKey).update(check).digest("hex");
params.set("hash", hash);
console.log(params.toString());
