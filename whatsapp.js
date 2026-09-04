// ============================================================
//   WS CHECKER v6 | whatsapp.js
//   WhatsApp Session Manager: Auto-Responder & Warmup Engine
// ============================================================

"use strict";

const {
    default: makeWASocket,
    useMultiFileAuthState,
    fetchLatestBaileysVersion,
    makeCacheableSignalKeyStore,
    DisconnectReason,
} = require("@whiskeysockets/baileys");
const pino   = require("pino");
const fs     = require("fs");
const path   = require("path");

const { saveSessionMeta, deleteSessionMeta, getDB } = require("./database");
const config = require("./config");
const state  = require("./state");
const proxyManager = require("./proxy_manager");
const pgState = require("./pg_state");

// ── Silent logger (prevents Baileys spam in console) ──────────
const silentLogger = pino({ level: "silent" });

// ── Reconnect State (per-session capped backoff) ──────────────
const _reconnectState = {}; // sid -> { tries, timer }
function _clearReconnect(sid) {
    const st = _reconnectState[sid];
    if (st) { clearTimeout(st.timer); delete _reconnectState[sid]; }
}

// ── Per-node Anti-Ban Safety Gate ─────────────────────────────
// Every request a connected node sends is shaped so the number does not
// look like a bot to WhatsApp: parallel lookups per node are capped, a
// small randomized gap is kept between them, and after a burst of failures
// (429 / timeout / forbidden) the node pauses briefly. Settings are read
// from the live dynamic config (admin-tweakable, no restart).
function safetyGate() {
    const dyn = config.dynamic;
    const cfg = {
        enabled: dyn.WA_SAFETY_MODE !== false,
        maxConc: Math.max(1, Number(dyn.WA_MAX_CONCURRENT_PER_NODE) || 10),
        minGap: Math.max(0, Number(dyn.WA_MIN_GAP_MS) || 120),
        maxFails: Math.max(1, Number(dyn.WA_MAX_FAILS_BEFORE_PAUSE) || 6),
        pauseMs: Math.max(1000, Number(dyn.WA_PAUSE_MS) || 45000),
    };
    let inflight = 0, lastRun = 0, failStreak = 0, pausedUntil = 0;
    const wait = (ms) => new Promise(r => setTimeout(r, ms));
    return {
        async run(sessionId, fn) {
            if (!cfg.enabled) return fn();
            while (pausedUntil > Date.now()) {
                await wait(Math.min(pausedUntil - Date.now(), 2000));
            }
            while (inflight >= cfg.maxConc) await wait(40 + Math.floor(Math.random() * 60));
            const now = Date.now();
            const gap = cfg.minGap + Math.floor(Math.random() * 90);
            if (lastRun && now - lastRun < gap) await wait(gap - (now - lastRun));
            lastRun = Date.now();
            inflight++;
            try {
                const out = await fn();
                failStreak = 0;
                return out;
            } catch (e) {
                failStreak++;
                const code = (e && e.output && e.output.statusCode) || (e && (e.status || e.statusCode));
                if (code === 429 || code === 401 || code === 403 || failStreak >= cfg.maxFails) {
                    pausedUntil = Date.now() + cfg.pauseMs;
                    failStreak = 0;
                    console.warn(`🛡️ [WA] Safety pause ${Math.round(cfg.pauseMs / 1000)}s on node ${sessionId} (${String(e.message || e).slice(0, 90)})`);
                }
                throw e;
            } finally { inflight--; }
        },
    };
}

function applySafetyGate(sock, sessionId) {
    const gate = safetyGate();
    const wrap = (name) => {
        const orig = sock[name];
        if (typeof orig !== "function") return;
        sock[name] = (...args) => gate.run(sessionId, () => orig.apply(sock, args));
    };
    // Every operation the checker engine can fire through a node.
    ["onWhatsApp", "getBusinessProfile", "fetchStatus", "profilePictureUrl", "presenceSubscribe"].forEach(wrap);
}

// ── Session directory generator ───────────────────────────────
// Sessions hold WhatsApp credentials and MUST live on persistent storage
// (Railway volume / DATA_DIR) so nodes survive redeploys.
const SESSION_DIR = (id) => path.join(config.DATA_ROOT, `session_${id}`);

// ── Notify Admins ─────────────────────────────────────────────
async function notifyAdmins(bot, text) {
    const db = getDB();
    for (const adminId of db.admins) {
        bot.sendMessage(adminId, text, { parse_mode: "Markdown" }).catch(() => {});
    }
}

// ── Start / Restore a WhatsApp session ────────────────────────
async function startSession(sessionId, displayName, requesterInfo, sessionType = "public", bot, silent = false) {
    if (state.sessions[sessionId]?.status === "Connecting" ||
        state.sessions[sessionId]?.status === "Connected") {
        return;
    }

    const sessDir = SESSION_DIR(sessionId);

    try {
        // PostgreSQL-backed auth (creds + signal keys in one JSONB row, no
        // session folder needed) when Postgres is up; classic multi-file auth
        // (session_<id>/ folder on DATA_ROOT) otherwise.
        const usePG = pgState.active();
        let authState, saveCreds;
        if (usePG) {
            const pgAuth = await pgState.makeWAAuth(sessionId);
            authState = pgAuth.state;
            saveCreds = pgAuth.saveCreds;
        } else {
            const mf = await useMultiFileAuthState(sessDir);
            authState = mf.state;
            saveCreds = mf.saveCreds;
        }
        const { version } = await fetchLatestBaileysVersion();
        
        // Proxy Pool Logic: one sticky residential proxy per WA node/session.
        const dynConfig = config.dynamic;
        let agent = undefined;
        let proxyInfo = null;
        if (dynConfig.ENABLE_PROXY) {
            proxyInfo = proxyManager.getProxyForSession(sessionId);
            if (proxyInfo?.url) {
                agent = proxyManager.createAgent(proxyInfo.url);
                console.log(`🛡️ [WA] Proxy assigned for ${sessionId}: ${proxyInfo.masked}`);
            } else {
                console.warn(`⚠️ [WA] Proxy enabled but no valid proxy found for ${sessionId}`);
            }
        }

        const sock = makeWASocket({
            version,
            logger: silentLogger,
            auth: {
                creds: authState.creds,
                keys: makeCacheableSignalKeyStore(authState.keys, silentLogger),
            },
            browser: config.WA_BROWSER,
            printQRInTerminal: false,
            connectTimeoutMs: 60_000,
            keepAliveIntervalMs: 25_000,
            agent: agent, // Connects via Proxy if enabled
        });

        // Anti-ban request shaping for every WA call this node makes.
        applySafetyGate(sock, sessionId);

        // Register in state
        state.setSession(sessionId, {
            sock,
            name: displayName,
            status: "Connecting",
            owner: requesterInfo.id,
            type: sessionType,
            startedAt: Date.now(),
            proxyId: proxyInfo?.id || null,
            proxy: proxyInfo?.masked || null,
        });

        sock.ev.on("creds.update", saveCreds);

        // ── Connection Update ─────────────────────────────────
        sock.ev.on("connection.update", async (update) => {
            const { connection, lastDisconnect } = update;

            if (connection === "open") {
                _clearReconnect(sessionId);
                state.setSession(sessionId, { status: "Connected", connectedAt: Date.now(), proxyId: proxyInfo?.id || null, proxy: proxyInfo?.masked || null });
                if (proxyInfo?.url) proxyManager.markProxyResult(proxyInfo.url, true, Date.now() - (state.sessions[sessionId]?.startedAt || Date.now()));
                saveSessionMeta(sessionId, requesterInfo.id, sessionType, { proxyId: proxyInfo?.id || null, proxy: proxyInfo?.masked || null, banFlag: false, bannedAt: null, lastError: null });
                if (usePG) pgState.flushSession(sessionId).catch(() => {}); // pairing creds → Postgres now
                console.log(`✅ [WA] Node Active [${sessionId}]`);

                if (!silent) {
                    await notifyAdmins(bot,
                        `╭━━━[ 🟢 *𝗡𝗢𝗗𝗘 𝗢𝗡𝗟𝗜𝗡𝗘* ]━━━╮\n` +
                        `┣ 📱 *Type:* ${sessionType.toUpperCase()}\n` +
                        `┣ 🆔 *Session:* \`${sessionId}\`\n` +
                        `┣ 👤 *Added By:* ${requesterInfo.name}\n` +
                        `╰━━━━━━━━━━━━━━━━━━━━━━╯`
                    );
                }
            }

            if (connection === "close") {
                const rawErr = lastDisconnect?.error;
                const errMsg = String((rawErr && (rawErr.message || rawErr.data)) || "").toLowerCase();
                const errCode = rawErr?.output?.statusCode;
                // 403 forbidden = the number was blocked/banned by WhatsApp.
                // A 401 with ban/restrict wording is the same. Never auto-loop
                // a blocked number (that makes bans permanent) — quarantine it
                // and tell the owner; creds are kept so the number can be
                // re-added from "My Nodes" once unblocked.
                const banned = errCode === DisconnectReason.forbidden
                    || (errCode === DisconnectReason.loggedOut && /ban|restrict|blocked/i.test(errMsg))
                    || (errCode === DisconnectReason.unavailableService && /ban|restrict|blocked/i.test(errMsg));
                // 401 logged out / 500 bad session = creds are dead.
                const deadCreds = !banned && (errCode === DisconnectReason.loggedOut || errCode === DisconnectReason.badSession);

                if (proxyInfo?.url) proxyManager.markProxyResult(proxyInfo.url, false, 0, rawErr?.message || "connection closed");
                state.removeSession(sessionId);

                const ownerId = (getDB().sessionMeta && getDB().sessionMeta[sessionId] && getDB().sessionMeta[sessionId].owner) || requesterInfo.id;

                if (banned) {
                    _clearReconnect(sessionId);
                    try {
                        saveSessionMeta(sessionId, ownerId, sessionType, { banFlag: true, bannedAt: new Date().toISOString(), lastError: String(rawErr?.message || "banned by WhatsApp").slice(0, 200) });
                    } catch (_) {}
                    console.error(`🚫 [WA] Node ${sessionId} BLOCKED by WhatsApp (${errCode}) — auto-reconnect disabled. Remove & re-add it from My Nodes after the block lifts.`);
                    if (bot) {
                        const txt = `🚫 *NODE BLOCKED BY WHATSAPP*\n\n🆔 Session: \`${sessionId}\`\n⚠️ WhatsApp blocked this number (${errCode}). The node will NOT auto-reconnect — retrying a blocked number makes it permanent.\n\n🛡️ What to do:\n1. Open WhatsApp on the phone and check for a ban notice.\n2. After the block lifts, remove the node (My Nodes → Delete) and add it again.`;
                        bot.sendMessage(ownerId, txt, { parse_mode: "Markdown" }).catch(() => {});
                        notifyAdmins(bot, `🚫 *Node blocked by WhatsApp:* \`${sessionId}\` — ${String(rawErr?.message || "").slice(0, 120)}`).catch(() => {});
                    }
                } else if (deadCreds) {
                    _clearReconnect(sessionId);
                    _cleanupSession(sessionId);
                    deleteSessionMeta(sessionId);
                    if (usePG) pgState.dropWA(sessionId).catch(() => {}); // dead creds must not be restored next boot

                    if (!silent && bot) {
                        await notifyAdmins(bot,
                            `╭━━━[ 🔴 *𝗡𝗢𝗗𝗘 𝗗𝗘𝗔𝗗* ]━━━╮\n` +
                            `┣ ⚠️ *Reason:* Logged Out (${errCode})\n` +
                            `┣ 🆔 *Session:* \`${sessionId}\`\n` +
                            `┣ 🗑️ *Action:* Cleaned up — add it again from My Nodes.\n` +
                            `╰━━━━━━━━━━━━━━━━━━━━━━╯`
                        );
                    }
                } else {
                    // Transient network/server drop → reconnect with capped
                    // exponential backoff + jitter. Give up after N tries so
                    // a dead number is not hammered forever.
                    const prev = _reconnectState[sessionId]?.tries || 0;
                    const tries = prev + 1;
                    const maxTries = Number(dynConfig.WA_MAX_RECONNECT_TRIES) || 9;
                    if (tries > maxTries) {
                        _clearReconnect(sessionId);
                        console.error(`❌ [WA] Node ${sessionId} gave up after ${maxTries} reconnect tries.`);
                        if (bot && !silent) notifyAdmins(bot, `❌ *Node offline:* \`${sessionId}\` gave up after ${maxTries} reconnect tries (${errCode}). Check the number/network, then Delete + re-add, or wait for the next boot.`).catch(() => {});
                    } else {
                        const base = Math.max(Number(dynConfig.RECONNECT_DELAY) || 5000, 4000);
                        const delayMs = Math.min(base * Math.pow(1.8, tries - 1) + Math.floor(Math.random() * 3000), 120000);
                        _clearReconnect(sessionId);
                        _reconnectState[sessionId] = {
                            tries,
                            timer: setTimeout(async () => {
                                delete _reconnectState[sessionId];
                                await startSession(sessionId, displayName, requesterInfo, sessionType, bot, true);
                            }, delayMs),
                        };
                        console.log(`♻️ [WA] Node ${sessionId} dropped (${errCode}) — reconnect attempt ${tries}/${maxTries} in ${Math.round(delayMs / 1000)}s`);
                    }
                }
            }
        });

        // 🔥 NEW: AUTO-RESPONDER (ANTI-BAN MECHANISM) 🔥
        sock.ev.on("messages.upsert", async ({ messages, type }) => {
            if (type !== "notify") return;
            const msg = messages[0];
            
            // Ignore status broadcasts or messages from self
            if (!msg.message || msg.key.fromMe || msg.key.remoteJid === "status@broadcast") return;

            const liveConfig = config.dynamic;
            if (liveConfig.AUTO_RESPONDER) {
                try {
                    // Simulating human interaction: Mark as read
                    await sock.readMessages([msg.key]); 
                    
                    // Add a human-like delay before replying
                    setTimeout(async () => {
                        await sock.sendMessage(msg.key.remoteJid, { 
                            text: liveConfig.AUTO_RESPONDER_MSG 
                        }, { quoted: msg });
                        console.log(`🤖 [WA] Auto-Responder sent reply to ${msg.key.remoteJid}`);
                    }, 2500);
                } catch(e) {
                    // Ignore errors if message fails to send
                }
            }
        });

    } catch (err) {
        console.error(`❌ [WA] Failed to start node [${sessionId}]:`, err.message);
        state.removeSession(sessionId);
    }
}

// ── Request pairing code ──────────────────────────────────────
// WhatsApp lets the PAIRING DEVICE choose the code: Baileys generates it
// locally (never from WhatsApp's server) and the user types it into
// WhatsApp → Linked Devices → Pair. So instead of a random code we send the
// fixed branded code from config (CUSTOM_PAIRING_CODE, default "BLAZENXT" —
// must be exactly 8 chars, A-Z/0-9, or the library throws). The phone
// accepts exactly this value; config.PAIRING_BRAND ("BlazeNXT") is the
// label used in the messages that show the code.
async function requestPairingCode(sessionId, phoneNumber) {
    const sess = state.sessions[sessionId];
    if (!sess?.sock) throw new Error("Session socket not ready");
    const custom = config.CUSTOM_PAIRING_CODE;
    if (!custom || custom.length !== 8) {
        throw new Error(`CUSTOM_PAIRING_CODE must be exactly 8 characters (A-Z/0-9) — got "${custom || "(empty)"}". Check the env var or config.js.`);
    }
    return await sess.sock.requestPairingCode(phoneNumber.replace(/[^0-9]/g, ""), custom);
}

// ── Delete a session ──────────────────────────────────────────
async function deleteSession(sessionId) {
    const sess = state.sessions[sessionId];
    if (sess?.sock) {
        try { await sess.sock.logout(); } catch (_) {}
    }
    state.removeSession(sessionId);
    _cleanupSession(sessionId);
    if (pgState.active()) await pgState.dropWA(sessionId).catch(() => {});
    proxyManager.releaseProxy(sessionId);
    deleteSessionMeta(sessionId);
}

function _cleanupSession(sessionId) {
    const dir = SESSION_DIR(sessionId);
    if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
}

// ── Restore sessions ──────────────────────────────────────────
async function loadSavedSessions(bot) {
    const db = getDB();
    const restored = new Set();
    const stagger = async (sid, meta) => {
        if (restored.has(sid)) return;
        if (meta && meta.banFlag) {
            restored.add(sid); // remember it, but never auto-restart a blocked number
            console.warn(`🚫 [WA] Skipping blocked node ${sid} (banned by WhatsApp) — owner can Delete it from My Nodes.`);
            return;
        }
        restored.add(sid);
        await startSession(sid, "Saved", { id: meta.owner, name: "System" }, meta.type || "public", bot, true);
        await new Promise(r => setTimeout(r, 1500)); // Stagger starts
    };

    if (pgState.active()) {
        // Postgres mode: every session row IS the session — no folders needed.
        // Known ids come from sessionMeta (Postgres-backed DB doc) plus any
        // wa:* rows that still exist.
        const ids = new Set(Object.keys(db.sessionMeta || {}));
        const credIds = new Set();
        try { for (const sid of await pgState.listWASessions()) { ids.add(sid); credIds.add(sid); } } catch (_) {}
        // One-time migration: legacy session_* folders still on disk (volume /
        // local dev) that have no PG row yet are imported into Postgres first.
        try {
            const rows = new Set(await pgState.listWASessions());
            const entries = fs.readdirSync(config.DATA_ROOT);
            for (const entry of entries) {
                if (!entry.startsWith("session_") || rows.has(entry.slice(8))) continue;
                const p = path.join(config.DATA_ROOT, entry);
                if (!fs.lstatSync(p).isDirectory()) continue;
                if (await pgState.importSessionDir(entry.slice(8), p)) { ids.add(entry.slice(8)); credIds.add(entry.slice(8)); }
            }
        } catch (_) {}
        let n = 0, skipped = 0;
        for (const sid of ids) {
            if (!credIds.has(sid)) { skipped++; continue; } // no credentials stored — cannot restore
            const meta = db.sessionMeta[sid] || { owner: config.OWNER_ID, type: "public" };
            await stagger(sid, meta);
            n++;
        }
        if (skipped > 0) {
            console.warn(`⚠️ [WA] ${skipped} saved node(s) have no stored credentials (they were lost in an older redeploy before Postgres storage existed). Re-add them once via /start → Add Node — they will now persist forever.`);
        }
        console.log(`✅ [WA] Restored ${n} auto-saved nodes (Postgres).`);
        return;
    }

    // File mode (no DATABASE_URL): legacy behaviour — read session folders.
    let entries = [];
    try { entries = fs.readdirSync(config.DATA_ROOT); } catch (e) { console.error(`⚠️ [WA] Cannot read data dir: ${e.message}`); }
    for (const entry of entries) {
        if (!entry.startsWith("session_") || !fs.lstatSync(path.join(config.DATA_ROOT, entry)).isDirectory()) continue;
        const sid = entry.replace("session_", "");
        const meta = db.sessionMeta[sid] || { owner: config.OWNER_ID, type: "public" };
        await stagger(sid, meta);
    }
    console.log(`✅ [WA] Restored auto-saved nodes.`);
}

// 🔥 NEW: ANTI-BAN WARMUP (Nodes chat with each other to build trust) 🔥
async function warmupNodes() {
    const socks = state.getConnectedSocks();
    if(socks.length < 2) return { ok: false, msg: "Need at least 2 connected nodes to run warmup." };
    
    let sent = 0;
    for(let i = 0; i < socks.length; i++) {
        const sender = socks[i];
        const receiver = socks[(i + 1) % socks.length]; // Each node pings the next one
        
        if(sender.user && receiver.user) {
            // Get proper JID (WhatsApp ID)
            const jid = receiver.user.id.split(':')[0] + "@s.whatsapp.net";
            try {
                // Send a randomized warm-up ping
                const pingText = `Hello! Automated Warmup Ping. TS: ${Date.now()}`;
                await sender.sendMessage(jid, { text: pingText });
                sent++;
            } catch(e) {}
        }
    }
    return { ok: true, sent };
}

// ── Session listing for user self-management (bot + web) ──────
// Combines persisted metadata (db.sessionMeta — survives restarts) with the
// live in-memory status. Admins can pass any uid; users only ever see (and
// the callers only ever delete) their own nodes.
function listUserSessions(uid) {
    uid = Number(uid);
    const db = getDB();
    const metaMap = db.sessionMeta || {};
    const rows = [];
    for (const sid of Object.keys(metaMap)) {
        if (Number(metaMap[sid].owner) !== uid) continue;
        const meta = metaMap[sid];
        const live = state.sessions[sid];
        rows.push({
            sid,
            type: meta.type || live?.type || "private",
            status: live?.status || (meta.banFlag ? "Blocked" : "Offline"),
            banFlag: !!meta.banFlag,
            connectedAt: meta.connectedAt || null,
            lastError: meta.lastError || null,
        });
    }
    // Sessions live in memory but not yet flushed to meta (edge case).
    for (const sid of Object.keys(state.sessions)) {
        const s = state.sessions[sid];
        if (Number(s.owner) !== uid || rows.some(r => r.sid === sid)) continue;
        rows.push({ sid, type: s.type || "private", status: s.status, banFlag: false, connectedAt: null, lastError: null });
    }
    return rows.sort((a, b) => String(b.connectedAt || "").localeCompare(String(a.connectedAt || "")));
}

function listAllSessions() {
    const db = getDB();
    const metaMap = db.sessionMeta || {};
    const rows = [];
    for (const sid of Object.keys(metaMap)) {
        const meta = metaMap[sid];
        const live = state.sessions[sid];
        rows.push({
            sid,
            owner: Number(meta.owner),
            type: meta.type || live?.type || "private",
            status: live?.status || (meta.banFlag ? "Blocked" : "Offline"),
            banFlag: !!meta.banFlag,
            connectedAt: meta.connectedAt || null,
            lastError: meta.lastError || null,
        });
    }
    for (const sid of Object.keys(state.sessions)) {
        const s = state.sessions[sid];
        if (rows.some(r => r.sid === sid)) continue;
        rows.push({ sid, owner: Number(s.owner), type: s.type || "private", status: s.status, banFlag: false, connectedAt: null, lastError: null });
    }
    return rows.sort((a, b) => String(b.connectedAt || "").localeCompare(String(a.connectedAt || "")));
}

module.exports = {
    startSession,
    requestPairingCode,
    deleteSession,
    loadSavedSessions,
    listUserSessions,
    listAllSessions,
    warmupNodes // Exporting new warmup function
};
