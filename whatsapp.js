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

// ── Silent logger (prevents Baileys spam in console) ──────────
const silentLogger = pino({ level: "silent" });

// ── Session directory generator ───────────────────────────────
// Sessions hold WhatsApp credentials and MUST live on persistent storage
// (Railway volume / DATA_DIR) so nodes survive redeploys.
const SESSION_DIR = (id) => path.join(config.DATA_ROOT, `session_${id}`);

// ── Reconnect Timers & Proxy Logic ────────────────────────────
const _reconnectTimers = {};


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
        const { state: authState, saveCreds } = await useMultiFileAuthState(sessDir);
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
                state.setSession(sessionId, { status: "Connected", connectedAt: Date.now(), proxyId: proxyInfo?.id || null, proxy: proxyInfo?.masked || null });
                if (proxyInfo?.url) proxyManager.markProxyResult(proxyInfo.url, true, Date.now() - (state.sessions[sessionId]?.startedAt || Date.now()));
                saveSessionMeta(sessionId, requesterInfo.id, sessionType, { proxyId: proxyInfo?.id || null, proxy: proxyInfo?.masked || null });
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
                const errCode = lastDisconnect?.error?.output?.statusCode;
                const loggedOut = errCode === DisconnectReason.loggedOut || errCode === 401 || errCode === 403;
                
                if (proxyInfo?.url) proxyManager.markProxyResult(proxyInfo.url, false, 0, lastDisconnect?.error?.message || "connection closed");
                state.removeSession(sessionId);

                if (!loggedOut) {
                    if (_reconnectTimers[sessionId]) clearTimeout(_reconnectTimers[sessionId]);
                    _reconnectTimers[sessionId] = setTimeout(async () => {
                        delete _reconnectTimers[sessionId];
                        await startSession(sessionId, displayName, requesterInfo, sessionType, bot, true);
                    }, dynConfig.RECONNECT_DELAY || 5000);
                } else {
                    _cleanupSession(sessionId);
                    deleteSessionMeta(sessionId);

                    if (!silent) {
                        await notifyAdmins(bot,
                            `╭━━━[ 🔴 *𝗡𝗢𝗗𝗘 𝗗𝗘𝗔𝗗* ]━━━╮\n` +
                            `┣ ⚠️ *Reason:* Logged Out / Banned\n` +
                            `┣ 🆔 *Session:* \`${sessionId}\`\n` +
                            `┣ 🗑️ *Action:* Cleaned up.\n` +
                            `╰━━━━━━━━━━━━━━━━━━━━━━╯`
                        );
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
async function requestPairingCode(sessionId, phoneNumber) {
    const sess = state.sessions[sessionId];
    if (!sess?.sock) throw new Error("Session socket not ready");
    return await sess.sock.requestPairingCode(phoneNumber.replace(/[^0-9]/g, ""));
}

// ── Delete a session ──────────────────────────────────────────
async function deleteSession(sessionId) {
    const sess = state.sessions[sessionId];
    if (sess?.sock) {
        try { await sess.sock.logout(); } catch (_) {}
    }
    state.removeSession(sessionId);
    _cleanupSession(sessionId);
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
    let entries = [];
    try { entries = fs.readdirSync(config.DATA_ROOT); } catch (e) { console.error(`⚠️ [WA] Cannot read data dir: ${e.message}`); }
    for (const entry of entries) {
        if (!entry.startsWith("session_") || !fs.lstatSync(path.join(config.DATA_ROOT, entry)).isDirectory()) continue;
        const sid = entry.replace("session_", "");
        const meta = db.sessionMeta[sid] || { owner: config.OWNER_ID, type: "public" };
        
        await startSession(sid, "Saved", { id: meta.owner, name: "System" }, meta.type, bot, true);
        await new Promise(r => setTimeout(r, 1500)); // Stagger starts
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

module.exports = {
    startSession,
    requestPairingCode,
    deleteSession,
    loadSavedSessions,
    warmupNodes // Exporting new warmup function
};
