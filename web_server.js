// ============================================================
//   WS CHECKER v6 | web_server.js
//   Express REST API — Dashboard Engine & Webhooks
// ============================================================

"use strict";

const express = require("express"); 
const cors    = require("cors"); 
const fs      = require("fs"); 
const path    = require("path");
const crypto  = require("crypto");

const config = require("./config");
const { OWNER_ID, PORT, WEB_SECRET } = config;
const { 
    getDB, saveDB, registerUser, isAdmin, isVIP, isSub, isBanned, verifyWebPass, setWebhook, setUserLang, 
    addSubscriber, removeSubscriber, addVIP, removeVIP, 
    banUser, unbanUser, addAdmin, removeAdmin, 
    getStats, generateApiKey, getUidByApiKey, 
    setMaintenance, createVoucher, storageInfo, restoreDatabase 
} = require("./database");

const { warmupNodes, deleteSession, startSession, requestPairingCode } = require("./whatsapp");
const state = require("./state");
const proxyManager = require("./proxy_manager");

// ── Telegram Mini App initData verifier (auto-login) ─────────
// Validates initData signed by Telegram using the bot token.
// Docs: https://core.telegram.org/bots/webapps#validating-data-received-via-the-mini-app
function verifyTelegramInitData(initData, botToken) {
    try {
        const params = new URLSearchParams(String(initData || ""));
        const hash = params.get("hash");
        if (!hash) return null;
        params.delete("hash");
        const checkString = [...params.entries()]
            .map(([k, v]) => `${k}=${v}`)
            .sort()
            .join("\n");
        const secretKey = crypto.createHmac("sha256", "WebAppData").update(botToken).digest();
        const calcHash = crypto.createHmac("sha256", secretKey).update(checkString).digest("hex");
        const a = Buffer.from(calcHash, "hex");
        const b = Buffer.from(hash, "hex");
        if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
        // Reject stale payloads (older than 24h) to prevent replays
        const authDate = Number(params.get("auth_date") || 0);
        if (!authDate || (Date.now() / 1000) - authDate > 86400) return null;
        const rawUser = params.get("user");
        if (!rawUser) return null;
        const user = JSON.parse(rawUser);
        if (!user || !Number(user.id)) return null;
        return user;
    } catch (_) { return null; }
}

function startServer(bot) {
    const app = express(); 
    // Behind a reverse proxy (Railway, nginx, Cloudflare) trust the first hop so
    // req.ip / rate-limits / login-lockouts see real client IPs, not the proxy's.
    if (process.env.TRUST_PROXY === "true" || config.isRailway) app.set("trust proxy", 1);
    app.use(cors()); 
    app.use(express.json({ limit: "15mb" })); // Increased limit for massive DB exports
    app.get('/manifest.json', (req,res)=>res.sendFile(path.join(__dirname,'manifest.json')));
    // Static app assets (logo, PWA icons, favicon) — whitelisted filenames only.
    app.get('/assets/:file', (req, res) => {
        const f = String(req.params.file||'');
        if (!/^[a-z0-9._-]+\.(png|svg|ico|jpg|jpeg|webp)$/i.test(f)) return res.status(400).end();
        res.type(path.extname(f).slice(1)).sendFile(path.join(__dirname, 'assets', f), (err) => {
            if (err && !res.headersSent) res.status(404).end();
        });
    });
    app.get('/sw.js', (req,res)=>res.type('application/javascript').sendFile(path.join(__dirname,'sw.js')));
    // Do NOT serve the project root. It may contain users.json, sessions, source files, etc.
    app.get(["/", "/login", "/signup", "/dashboard", "/checker", "/history", "/sessions", "/profile", "/api", "/webhooks", "/jobs", "/lists", "/templates", "/files", "/proxies", "/audit", "/plans", "/vouchers", "/branding", "/force-join", "/security", "/help", "/status", "/changelog", "/system", "/docs", "/settings", "/support", "/admin", "/share/:id"], (req, res) => res.sendFile(path.join(__dirname, "index.html")));

    // ── 🛡️ Lightweight API Rate Limiter ─────────────────────────────
    const rateBuckets = new Map();
    const apiUsage = new Map();
    function createRateLimiter(max = 600, windowMs = 60_000) {
        return (req, res, next) => {
            const key = `${req.ip || req.socket.remoteAddress}:${req.path}`;
            const now = Date.now();
            const bucket = rateBuckets.get(key) || { count: 0, reset: now + windowMs };
            if (bucket.reset < now) { bucket.count = 0; bucket.reset = now + windowMs; }
            bucket.count++;
            rateBuckets.set(key, bucket);
            if (bucket.count > max) return res.status(429).json({ ok: false, error: "Too many requests. Please slow down." });
            next();
        };
    }
    app.use('/api', createRateLimiter(600, 60_000));


    // ── 🔐 WEB AUTH HELPERS ─────────────────────────────────────────
    const TOKEN_TTL_MS = 7 * 24 * 60 * 60 * 1000;
    const HUMAN_TTL_MS = 2 * 60 * 1000;
    const humanChallenges = new Map();
    const loginFailures = new Map();

    function cleanupHumanChallenges() {
        const now = Date.now();
        for (const [id, ch] of humanChallenges.entries()) if (ch.exp < now) humanChallenges.delete(id);
    }
    function createHumanChallenge(req) {
        cleanupHumanChallenges();
        const a = crypto.randomInt(10, 49);
        const b = crypto.randomInt(10, 49);
        const op = crypto.randomInt(0, 2) === 0 ? "+" : "-";
        const answer = op === "+" ? a + b : a - b;
        const id = crypto.randomBytes(16).toString("base64url");
        const exp = Date.now() + HUMAN_TTL_MS;
        humanChallenges.set(id, { answer: String(answer), exp, ip: req.ip || req.socket.remoteAddress });
        const body = b64url({ id, exp });
        return { question: `${a} ${op} ${b} = ?`, token: `${body}.${sign(body)}`, expiresIn: HUMAN_TTL_MS / 1000 };
    }
    function verifyHumanChallenge(token, answer, req) {
        if (!token || answer === undefined || !String(token).includes(".")) return false;
        const [body, sig] = String(token).split(".");
        if (!body || !sig || sign(body) !== sig) return false;
        let payload;
        try { payload = JSON.parse(Buffer.from(body, "base64url").toString("utf8")); } catch (_) { return false; }
        if (!payload.id || payload.exp < Date.now()) return false;
        const ch = humanChallenges.get(payload.id);
        humanChallenges.delete(payload.id); // one-time use
        if (!ch || ch.exp < Date.now()) return false;
        const ip = req.ip || req.socket.remoteAddress;
        if (ch.ip && ip && ch.ip !== ip) return false;
        return String(answer).trim() === ch.answer;
    }
    function loginKey(req, uid) { return `${req.ip || req.socket.remoteAddress}:${uid || "unknown"}`; }
    function isLoginLocked(req, uid) {
        const rec = loginFailures.get(loginKey(req, uid));
        if (!rec) return false;
        if (rec.lockUntil && rec.lockUntil > Date.now()) return Math.ceil((rec.lockUntil - Date.now()) / 1000);
        if (rec.lockUntil) loginFailures.delete(loginKey(req, uid));
        return false;
    }
    function recordLoginFailure(req, uid) {
        const key = loginKey(req, uid);
        const rec = loginFailures.get(key) || { count: 0, lockUntil: 0 };
        rec.count++;
        if (rec.count >= 5) { rec.lockUntil = Date.now() + 10 * 60 * 1000; rec.count = 0; }
        loginFailures.set(key, rec);
    }
    function clearLoginFailures(req, uid) { loginFailures.delete(loginKey(req, uid)); }

    function b64url(obj) { return Buffer.from(JSON.stringify(obj)).toString("base64url"); }
    function sign(data) { return crypto.createHmac("sha256", WEB_SECRET || config.TG_TOKEN).update(data).digest("base64url"); }
    const revokedSids = new Set();
    const deviceSessions = new Map();
    // Hydrate web login sessions from the DB document so that logged-in
    // devices (and their "log out all devices" state) survive redeploys.
    try {
        const _db = getDB();
        if (_db.meta && typeof _db.meta.webSessions === "object") {
            for (const uid of Object.keys(_db.meta.webSessions)) {
                const arr = _db.meta.webSessions[uid];
                if (Array.isArray(arr)) deviceSessions.set(Number(uid), arr);
            }
        }
    } catch (_) {}
    function persistDeviceSessions(uid) {
        try {
            const db = getDB();
            if (!db.meta) db.meta = {};
            db.meta.webSessions = db.meta.webSessions || {};
            db.meta.webSessions[String(uid)] = deviceSessions.get(uid) || [];
            saveDB(db);
        } catch (_) {}
    }
    function createToken(uid, sid = crypto.randomBytes(12).toString("base64url")) {
        const payload = { uid: Number(uid), sid, exp: Date.now() + TOKEN_TTL_MS, iat: Date.now() };
        const body = b64url(payload);
        return `${body}.${sign(body)}`;
    }
    function verifyToken(token) {
        if (!token || typeof token !== "string" || !token.includes(".")) return null;
        const [body, sig] = token.split(".");
        if (!body || !sig || sign(body) !== sig) return null;
        try {
            const payload = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
            if (!payload.uid || payload.exp < Date.now() || (payload.sid && revokedSids.has(payload.sid))) return null;
            const db = getDB();
            if (!db.users[Number(payload.uid)] || db.users[Number(payload.uid)]?.banned) return null;
            return { uid: Number(payload.uid), sid: payload.sid };
        } catch (_) { return null; }
    }
    function parseCookies(req) {
        return String(req.headers.cookie || "").split(';').reduce((acc, part) => {
            const i = part.indexOf('='); if (i > -1) acc[decodeURIComponent(part.slice(0,i).trim())] = decodeURIComponent(part.slice(i+1).trim());
            return acc;
        }, {});
    }
    function readToken(req) {
        const h = req.headers.authorization || "";
        if (h.startsWith("Bearer ")) return h.slice(7);
        const cookies = parseCookies(req);
        return req.headers["x-auth-token"] || req.body?.token || req.query?.token || cookies.auth_token;
    }
    function setAuthCookies(res, token, csrf) {
        const secure = process.env.NODE_ENV === 'production' ? '; Secure' : '';
        res.setHeader('Set-Cookie', [
            `auth_token=${encodeURIComponent(token)}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${TOKEN_TTL_MS/1000}${secure}`,
            `csrf_token=${encodeURIComponent(csrf)}; SameSite=Strict; Path=/; Max-Age=${TOKEN_TTL_MS/1000}${secure}`
        ]);
    }
    function clearAuthCookies(res) {
        res.setHeader('Set-Cookie', ['auth_token=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0', 'csrf_token=; SameSite=Strict; Path=/; Max-Age=0']);
    }
    function requireCsrf(req, res, next) {
        const original = req.originalUrl || req.url || "";
        // Login-like endpoints must work before a CSRF cookie exists.
        if (original.startsWith("/api/login") || original.startsWith("/api/tg-auth") || original.startsWith("/api/v1") || original.startsWith("/api/human-challenge")) return next();
        if (["GET", "HEAD", "OPTIONS"].includes(req.method)) return next();
        const cookies = parseCookies(req);
        const sent = req.headers['x-csrf-token'] || req.body?.csrfToken;
        if (!cookies.csrf_token || !sent || cookies.csrf_token !== sent) return res.status(403).json({ ok:false, error:"CSRF verification failed." });
        next();
    }
    function requireAuth(req, res, next) {
        const user = verifyToken(readToken(req));
        if (!user) return res.status(401).json({ ok: false, error: "Authentication required." });
        req.user = user;
        next();
    }
    function optionalAuth(req, _res, next) {
        req.user = verifyToken(readToken(req));
        next();
    }

    function isUnsafeWebhookHost(hostname) {
        const h = String(hostname || "").toLowerCase();
        if (["localhost", "127.0.0.1", "0.0.0.0", "::1"].includes(h)) return true;
        if (/^(10\.|192\.168\.|169\.254\.)/.test(h)) return true;
        if (/^172\.(1[6-9]|2\d|3[0-1])\./.test(h)) return true;
        if (/^fc|^fd/.test(h)) return true; // basic IPv6 ULA guard
        return false;
    }

    function assertSelfOrAdmin(req, res, uid) {
        const nUid = Number(uid);
        if (!req.user || (req.user.uid !== nUid && !isAdmin(req.user.uid))) {
            res.status(403).json({ ok: false, error: "Forbidden." });
            return false;
        }
        return true;
    }

    // ── 👑 ADMIN AUTH GUARD ─────────────────────────────────────────
    function requireAdmin(req, res, next) {
        const user = verifyToken(readToken(req));
        if (!user || !isAdmin(user.uid)) return res.status(403).json({ ok: false, error: "Admin access required." });
        req.user = user;
        req.adminUid = user.uid;
        next();
    }
    function requireOwner(req, res, next) {
        const user = verifyToken(readToken(req));
        if (!user || Number(user.uid) !== OWNER_ID) return res.status(403).json({ ok: false, error: "Owner access required." });
        req.user = user;
        next();
    }

    function ensureFeatureDB(db) {
        if (!db.meta) db.meta = {};
        if (!db.meta.auditLogs) db.meta.auditLogs = [];
        if (!db.meta.plans) db.meta.plans = { Free:{limit:config.dynamic.FREE_LIMIT}, PRO:{limit:config.dynamic.PRO_LIMIT}, VIP:{limit:config.dynamic.VIP_LIMIT} };
        if (!db.meta.webhookLogs) db.meta.webhookLogs = {};
        if (!db.meta.whiteLabel) db.meta.whiteLabel = { appName:"WS CHECKER", poweredBy:"Powered by WS CHECKER", support:"@FORURSUPPORT" };
        if (!db.meta.security) db.meta.security = { sessionTtlDays: 7 };
        if (!db.meta.shares) db.meta.shares = {};
        return db;
    }
    function audit(actor, action, target = "", details = {}) {
        const db = ensureFeatureDB(getDB());
        db.meta.auditLogs.unshift({ id:Date.now(), ts:new Date().toISOString(), actor:Number(actor)||0, action, target:String(target||""), details });
        db.meta.auditLogs = db.meta.auditLogs.slice(0, 500);
        saveDB(db);
    }
    function userFeature(uid) {
        const db = ensureFeatureDB(getDB()); const id=String(uid);
        if (!db.users[id]) db.users[id] = { id:Number(uid), name:"Unknown", username:"NoUser", count:0, banned:false };
        const u = db.users[id];
        if (!u.savedLists) u.savedLists = [];
        if (!u.scanTemplates) u.scanTemplates = [];
        if (!u.files) u.files = [];
        if (!u.notes) u.notes = [];
        if (!u.apiKeys) u.apiKeys = [];
        return { db, u, id };
    }
    // Shared force-join engine (same logic as the bot commands/callbacks):
    // resolves usernames/ids/invite links, reports bot-permission problems
    // honestly and never silently bypasses private invite-link channels.
    async function checkForceJoin(uid) {
        return require("./force_join").checkForceJoin(uid, bot);
    }

    if (!state.jobQueue) state.jobQueue = [];
    function emitCheckJob(uid, numbers) {
        state.initWebState(uid, numbers.length);
        bot.emit("message", { from: { id: uid, first_name: "Web", username: "Web" }, chat: { id: uid }, text: numbers.join("\n") });
    }
    function enqueueCheckJob(uid, numbers, source = 'web') {
        const job = { id: crypto.randomBytes(8).toString('hex'), uid, numbers, source, status:'Queued', queuedAt:new Date().toISOString() };
        state.jobQueue.push(job);
        if (state.pushUserNotification) state.pushUserNotification(uid, `🧾 Job queued: ${numbers.length} numbers`, 'info');
        return job;
    }
    function processJobQueue() {
        try {
            const dyn = config.dynamic;
            while (state.jobQueue.length && state.processingUsers.size < (dyn.MAX_PARALLEL || 5)) {
                const job = state.jobQueue.shift();
                if (!job || state.isProcessing(job.uid)) { if(job) state.jobQueue.push(job); break; }
                emitCheckJob(job.uid, job.numbers);
                if (state.pushUserNotification) state.pushUserNotification(job.uid, `🚀 Queued job started: ${job.numbers.length} numbers`, 'info');
            }
        } catch(e) { console.error('Queue processor error:', e.message); }
    }
    setInterval(processJobQueue, 3000);


    // ── 🚧 MAINTENANCE MIDDLEWARE ───────────────────────────────────
    app.use((req, res, next) => {
        const db = getDB();
        const publicDuringMaintenance = req.path === "/" || req.path.includes('/api/login') || req.path.includes('/api/tg-auth') || req.path.includes('/api/status') || req.path.includes('/api/sysinfo');
        if (db.meta?.maintenance && !publicDuringMaintenance && !req.path.includes('/api/admin')) {
            const user = verifyToken(readToken(req));
            if (!user || !db.admins.includes(Number(user.uid))) {
                return res.status(503).json({ ok: false, error: "🚧 SYSTEM UNDER MAINTENANCE. Please try again later." });
            }
        }
        next();
    });

    app.use('/api', requireCsrf);

    // ============================================================
    // 🔌 EXTERNAL B3AST API (FOR RESELLERS / OTHER SOFTWARES)
    // ============================================================
    app.get("/api/v1/check", async (req, res) => {
        const { key, number } = req.query;
        if (!key || !number) return res.status(400).json({ ok: false, error: "API Key and number required." });
        
        const uid = getUidByApiKey(key);
        if (!uid) return res.status(401).json({ ok: false, error: "Invalid API Key." });
        if (!isSub(uid)) return res.status(403).json({ ok: false, error: "PRO/VIP subscription required." });
        const safeNumber = String(number).replace(/[^0-9]/g, "");
        if (safeNumber.length < 7 || safeNumber.length > 15) return res.status(400).json({ ok: false, error: "Invalid number." });
        
        const socks = state.getActiveSocksForUser(uid);
        if(socks.length === 0) return res.status(500).json({ ok: false, error: "No active WhatsApp nodes available." });
        
        try {
            const sock = socks[Math.floor(Math.random() * socks.length)];
            const startCall = Date.now();
            
            const [waRes] = await Promise.race([
                sock.onWhatsApp(safeNumber),
                new Promise((_, rej) => setTimeout(() => rej(new Error("timeout")), 10000))
            ]);
            
            const latency = Date.now() - startCall;
            if (state.updateNodeHealth) state.updateNodeHealth(sock.user?.id || "node", latency);
            if (state.recordNodeResult) state.recordNodeResult(sock, true, latency);
            const usage = apiUsage.get(uid) || { today: new Date().toISOString().slice(0,10), requests:0, success:0, fail:0, lastRequest:null };
            const today = new Date().toISOString().slice(0,10); if (usage.today !== today) { usage.today=today; usage.requests=0; usage.success=0; usage.fail=0; }
            usage.requests++; usage.success++; usage.lastRequest = new Date().toISOString(); apiUsage.set(uid, usage);

            let isBiz = false, bizCategory = "N/A", dp = "No DP", about = "N/A";
            
            if (waRes?.exists) {
                // Deep Scraping for API
                try { 
                    const biz = await sock.getBusinessProfile(waRes.jid); 
                    if(biz) { isBiz = true; bizCategory = biz.category || "N/A"; } 
                } catch(e){}
                try { about = (await sock.fetchStatus(waRes.jid))?.status || "N/A"; } catch(e){}
                try { dp = await sock.profilePictureUrl(waRes.jid, 'image'); } catch(e){}
            }

            res.json({ 
                ok: true, 
                number: safeNumber, 
                exists: !!waRes?.exists, 
                isBusiness: isBiz,
                category: bizCategory,
                about: about,
                dp: dp
            });
        } catch(e) {
            const usage = apiUsage.get(uid) || { today: new Date().toISOString().slice(0,10), requests:0, success:0, fail:0, lastRequest:null };
            usage.requests++; usage.fail++; usage.lastRequest = new Date().toISOString(); apiUsage.set(uid, usage);
            res.status(500).json({ ok: false, error: "Node processing error or timeout." }); 
        }
    });


    app.post("/api/v1/batch-check", async (req, res) => {
        const { key, numbers } = req.body || {};
        if (!key || !Array.isArray(numbers)) return res.status(400).json({ ok:false, error:"API key and numbers[] required" });
        const uid = getUidByApiKey(key); if (!uid) return res.status(401).json({ ok:false, error:"Invalid API Key" });
        if (!isSub(uid)) return res.status(403).json({ ok:false, error:"PRO/VIP subscription required" });
        const safe = [...new Set(numbers.map(n=>String(n).replace(/[^0-9]/g,'')).filter(n=>n.length>=7&&n.length<=15))].slice(0, 100);
        const socks = state.getActiveSocksForUser(uid); if(!socks.length) return res.status(500).json({ ok:false, error:"No active nodes" });
        const results=[]; let i=0;
        async function worker(){ while(i<safe.length){ const n=safe[i++]; const sock=socks[i%socks.length]; try{ const [r]=await Promise.race([sock.onWhatsApp(n), new Promise((_,rej)=>setTimeout(()=>rej(new Error('timeout')),10000))]); results.push({number:n,exists:!!r?.exists}); if(state.recordNodeResult) state.recordNodeResult(sock,true,0); }catch(e){ results.push({number:n,error:'timeout/failed'}); if(state.recordNodeResult) state.recordNodeResult(sock,false,0); } } }
        await Promise.all(Array.from({length:Math.min(5,safe.length)}, worker));
        res.json({ ok:true, count:results.length, results });
    });

    // ============================================================
    // 👤 PUBLIC / USER APIS (Web Dashboard UI)
    // ============================================================
    
    app.get("/api/human-challenge", (req, res) => {
        res.json({ ok: true, challenge: createHumanChallenge(req) });
    });

    app.get("/api/status", optionalAuth, (req, res) => {
        const db = getDB();
        const sess = Object.keys(state.sessions).map(k => ({ 
            id: k, 
            status: state.sessions[k].status, 
            type: (db.sessionMeta[k] || {}).type || "unknown", 
            owner: (db.sessionMeta[k] || {}).owner || "Unknown",
            proxy: state.sessions[k].proxy || (db.sessionMeta[k] || {}).proxy || null,
            proxyId: state.sessions[k].proxyId || (db.sessionMeta[k] || {}).proxyId || null
        }));
        const isAdm = req.user && db.admins.includes(Number(req.user.uid));
        const sInfo = storageInfo();
        const storage = { backend: sInfo.backend, volumeMounted: sInfo.volumeMounted, pgConnected: sInfo.pgConnected, dataRootDurable: sInfo.dataRootDurable, durable: sInfo.durable };
        if (isAdm) storage.dataRoot = sInfo.dataRoot;
        res.json({ 
            ok: true, 
            botInfo: state.BOT_INFO, 
            sessions: isAdm ? sess : sess.map(s => ({ status: s.status, type: s.type })), 
            activeTasks: state.processingUsers.size,
            systemMode: String(config.dynamic.SYSTEM_MODE || "subscription").toLowerCase(), 
            maintenance: db.meta?.maintenance,
            storage
        });
    });

    // Shared "session issued" handler for every successful login path.
    // Sets the auth+CSRF cookies, records the device session and returns the
    // full user payload the web UI expects.
    function finalizeAuth(req, res, db, nUid, user) {
        const sid = crypto.randomBytes(12).toString("base64url");
        const token = createToken(nUid, sid);
        const csrfToken = crypto.randomBytes(16).toString("base64url");
        setAuthCookies(res, token, csrfToken);
        const sessions = deviceSessions.get(nUid) || [];
        sessions.unshift({ sid, ip: req.ip || req.socket.remoteAddress, ua: req.headers['user-agent'] || 'Unknown', lastLogin: new Date().toISOString() });
        deviceSessions.set(nUid, sessions.slice(0, 10));
        persistDeviceSessions(nUid);

        res.json({ 
            ok: true, 
            authMode: req.authMode || "password",
            csrfToken,
            user: { 
                id: nUid, 
                name: user.name, 
                username: user.username, 
                apiKey: user.apiKey, 
                webhookUrl: user.webhookUrl || null,
                lang: user.lang || "en",
                proExpiry: user.proExpiry,
                vipExpiry: user.vipExpiry
            }, 
            systemMode: String(config.dynamic.SYSTEM_MODE || "subscription").toLowerCase(),
            isFreeMode: String(config.dynamic.SYSTEM_MODE || "subscription").toLowerCase() === "free",
            isPro: String(config.dynamic.SYSTEM_MODE || "subscription").toLowerCase() === "free" || db.subscribers.includes(nUid) || db.admins.includes(nUid), 
            isVIP: db.vips.includes(nUid) || db.admins.includes(nUid),
            isAdmin: db.admins.includes(nUid),
            isOwner: nUid === OWNER_ID
        });
    }

    app.post("/api/login", async (req, res) => {
        const { uid, password } = req.body; 
        const db = getDB(); 
        const nUid = Number(uid);
        const locked = isLoginLocked(req, nUid);
        if (locked) return res.status(429).json({ ok: false, message: `Too many login attempts. Try after ${locked}s.` });
        const user = db.users[nUid];
        
        if (!user || !user.web_pass || !password || !verifyWebPass(user.web_pass, password) || user.banned) {
            recordLoginFailure(req, nUid);
            return res.json({ ok: false, message: "Invalid credentials or Banned." });
        }
        const fj = await checkForceJoin(nUid);
        if (!fj.ok) return res.status(403).json({ ok: false, message: "Please join required channels first.", forceJoin: fj.missing });
        clearLoginFailures(req, nUid);
        req.authMode = "password";
        finalizeAuth(req, res, db, nUid, user);
    });

    // ── 🛜 TELEGRAM MINI APP AUTO-LOGIN ─────────────────────────
    // When the dashboard is opened inside Telegram (Mini App), Telegram sends
    // signed initData (user + auth_date + hash). We verify the HMAC-SHA256
    // signature with the bot token, auto-register the user and issue a normal
    // web session — no web password needed inside Telegram.
    app.post("/api/tg-auth", async (req, res) => {
        try {
            const initData = req.body?.initData || req.body?.tg_init_data || "";
            const tgUser = verifyTelegramInitData(initData, config.TG_TOKEN);
            if (!tgUser) return res.status(401).json({ ok: false, message: "Telegram verification failed. Open the dashboard from the bot's Mini App." });

            const nUid = Number(tgUser.id);
            const db = getDB();
            if (db.users[nUid]?.banned) return res.status(403).json({ ok: false, message: "Access denied." });

            registerUser({
                id: nUid,
                first_name: tgUser.first_name || tgUser.firstName || "Telegram User",
                username: tgUser.username || "NoUser",
            });
            const user = getDB().users[nUid];

            const fj = await checkForceJoin(nUid);
            if (!fj.ok) return res.status(403).json({ ok: false, message: "Please join required channels first.", forceJoin: fj.missing });

            if (state.pushUserNotification) state.pushUserNotification(nUid, "🛜 Logged in via Telegram Mini App", "info");
            req.authMode = "telegram";
            finalizeAuth(req, res, getDB(), nUid, user);
        } catch (err) {
            console.error("❌ [tg-auth] Auto-login failed:", err.message);
            res.status(500).json({ ok: false, message: "Auto-login service error. Please use the ID + web password from the bot.", error: err.message });
        }
    });



    app.get("/api/me", requireAuth, (req, res) => {
        const db = getDB();
        const nUid = req.user.uid;
        const user = db.users[nUid];
        if (!user) return res.status(404).json({ ok: false, error: "User not found" });
        res.json({
            ok: true,
            user: {
                id: nUid,
                name: user.name,
                username: user.username,
                apiKey: user.apiKey,
                webhookUrl: user.webhookUrl || null,
                lang: user.lang || "en",
                proExpiry: user.proExpiry,
                vipExpiry: user.vipExpiry
            },
            systemMode: String(config.dynamic.SYSTEM_MODE || "subscription").toLowerCase(),
            isFreeMode: String(config.dynamic.SYSTEM_MODE || "subscription").toLowerCase() === "free",
            isPro: String(config.dynamic.SYSTEM_MODE || "subscription").toLowerCase() === "free" || db.subscribers.includes(nUid) || db.admins.includes(nUid), 
            isVIP: db.vips.includes(nUid) || db.admins.includes(nUid),
            isAdmin: db.admins.includes(nUid),
            isOwner: nUid === OWNER_ID
        });
    });

    app.get("/api/security/sessions", requireAuth, (req, res) => {
        const sessions = (deviceSessions.get(req.user.uid) || []).map(s => ({ ...s, current: s.sid === req.user.sid }));
        res.json({ ok:true, sessions });
    });
    app.post("/api/security/logout-all", requireAuth, (req, res) => {
        const sessions = deviceSessions.get(req.user.uid) || [];
        sessions.forEach(s => revokedSids.add(s.sid));
        deviceSessions.set(req.user.uid, []);
        persistDeviceSessions(req.user.uid);
        clearAuthCookies(res);
        res.json({ ok:true });
    });

    app.post("/api/logout", requireAuth, (req, res) => { 
        if (req.user.sid) revokedSids.add(req.user.sid);
        const arr = (deviceSessions.get(req.user.uid) || []).filter(s => s.sid !== req.user.sid);
        deviceSessions.set(req.user.uid, arr);
        persistDeviceSessions(req.user.uid);
        clearAuthCookies(res); res.json({ ok:true });
    });

    app.get("/api/user/api-usage", requireAuth, (req, res) => {
        const db = getDB(); const u = db.users[req.user.uid] || {};
        res.json({ ok:true, apiKey:u.apiKey || null, usage: apiUsage.get(req.user.uid) || { today:new Date().toISOString().slice(0,10), requests:0, success:0, fail:0, lastRequest:null } });
    });

    app.post("/api/user/language", requireAuth, (req, res) => {
        const lang = String(req.body.lang || "en").slice(0, 8);
        setUserLang(req.user.uid, lang);
        audit(req.user.uid, 'language_update', req.user.uid, { lang });
        res.json({ ok: true, lang });
    });

    app.post("/api/user/generate-api", requireAuth, (req, res) => {
        const uid = req.user.uid;
        if (!isSub(uid)) return res.status(403).json({ ok: false, error: "PRO/VIP required." });
        const expiry = req.body.expiry === "7" ? 7 : (req.body.expiry === "30" ? 30 : null);
        const key = generateApiKey(uid, expiry);
        if(key) res.json({ ok: true, apiKey: key, expiresInDays: expiry }); 
        else res.status(400).json({ok: false, error: "Failed to generate key."});
    });

    // ── Session Pairing via Web ──
    app.post("/api/add-session", requireAuth, async (req, res) => {
        try {
            const { uid, phone } = req.body;
            if (!uid || !phone) return res.status(400).json({ ok: false, error: "Missing parameters." });
            if (!assertSelfOrAdmin(req, res, uid)) return;

            const num = String(phone).replace(/[^0-9]/g, "");
            const db = getDB();
            const u = db.users[Number(uid)]?.name || uid;
            
            // Notify Admin Bell
            state.pushNotification(`📱 Session Pairing Requested by ${u}`, 'info');
            
            const slot = `s_${uid}_${Date.now()}`;
            const sessionType = isAdmin(Number(uid)) ? "public" : "private";
            
            // Start Socket Process
            await startSession(slot, u, { id: Number(uid), name: u, username: "N/A" }, sessionType, bot);
            
            // Wait for Baileys to Boot
            await new Promise(r => setTimeout(r, 6000));
            if (!state.sessions[slot]?.sock) return res.status(500).json({ ok: false, error: "Socket initialization failed." });
            
            // Request Pair Code
            const code = await requestPairingCode(slot, num);
            
            // Backup code to Telegram
            bot.sendMessage(uid, `🔑 *Web Pairing Code:* \`${code}\`\nExpires in 30s.`, { parse_mode: "Markdown" }).catch(()=>{});
            
            res.json({ ok: true, code });
        } catch (e) { 
            res.status(500).json({ ok: false, error: e.message || "Failed to generate code." }); 
        }
    });

    app.get("/api/sysinfo", (req, res) => {
        const cpFile = path.join(__dirname, "COPYRIGHT.txt");
        const text = fs.existsSync(cpFile) ? fs.readFileSync(cpFile, "utf-8") : "© 2026 WS CHECKER v6\nOwner: @firstoget";
        res.json({ ok: true, text });
    });

    // ── Webhook Save (User) ──
    app.post("/api/user/set-webhook", requireAuth, (req, res) => {
        const { webhook } = req.body;
        const nUid = req.user.uid;
        if (!webhook) return res.status(400).json({ ok: false, message: "Missing webhook URL" });
        let parsed;
        try { parsed = new URL(String(webhook)); } catch (_) { return res.status(400).json({ ok: false, message: "Invalid URL" }); }
        if (!["http:", "https:"].includes(parsed.protocol)) return res.status(400).json({ ok: false, message: "Only http/https URLs are allowed" });
        if (isUnsafeWebhookHost(parsed.hostname)) return res.status(400).json({ ok: false, message: "Unsafe webhook host" });
        if (!isSub(nUid)) return res.status(403).json({ ok: false, message: "PRO/VIP required" });
        setWebhook(nUid, parsed.toString());
        res.json({ ok: true, webhookUrl: parsed.toString() });
    });

    // ── Checker Controls ──
    app.get("/api/progress/:uid", requireAuth, (req, res) => {
        if (!assertSelfOrAdmin(req, res, req.params.uid)) return;
        res.json({ ok: true, progress: state.getWebState(req.params.uid) || null, results: state.lastResults[req.params.uid] || { reg: [], unreg: [], failed: [] } });
    });

    app.post("/api/start-check", requireAuth, (req, res) => {
        const uid = Number(req.body.uid || req.user.uid);
        if (!assertSelfOrAdmin(req, res, uid)) return;
        if (!Array.isArray(req.body.numbers)) return res.status(400).json({ ok: false, error: "numbers must be an array" });
        const numbers = req.body.numbers.map(n => String(n).replace(/[^0-9]/g, "")).filter(n => n.length >= 7 && n.length <= 15);
        if (!numbers.length) return res.status(400).json({ ok: false, error: "No valid numbers" });
        state.initWebState(uid, numbers.length);
        bot.emit("message", { from: { id: uid, first_name: "Web", username: "Web" }, chat: { id: uid }, text: numbers.join("\n") });
        res.json({ ok: true });
    });

    app.post("/api/cancel/:uid", requireAuth, (req, res) => {
        if (!assertSelfOrAdmin(req, res, req.params.uid)) return;
        state.cancelUser(req.params.uid);
        res.json({ ok: true });
    });

    app.post("/api/reset", requireAuth, (req, res) => {
        const uid = Number(req.body.uid || req.user.uid);
        if (!assertSelfOrAdmin(req, res, uid)) return;
        if (isAdmin(req.user.uid) && req.body.global === true) {
            state.processingUsers.clear();
            Object.keys(global.webState || {}).forEach(k => { if (global.webState[k]) global.webState[k].status = "Cancelled"; });
        } else {
            state.cancelUser(uid);
            state.clearUserStep(uid);
        }
        res.json({ ok: true });
    });
    
    app.get("/api/history/:uid", requireAuth, (req, res) => {
        if (!assertSelfOrAdmin(req, res, req.params.uid)) return;
        res.json({ ok: true, history: getDB().history[Number(req.params.uid)] || [] });
    });

    app.get("/api/resume-info/:uid", requireAuth, (req, res) => {
        if (!assertSelfOrAdmin(req, res, req.params.uid)) return;
        const file = path.join(config.DATA_ROOT, "job_state", `${Number(req.params.uid)}.json`);
        if (!fs.existsSync(file)) return res.json({ ok:true, job:null });
        try { res.json({ ok:true, job: JSON.parse(fs.readFileSync(file, "utf8")) }); }
        catch (_) { res.json({ ok:true, job:null }); }
    });

    app.post("/api/resume-job", requireAuth, (req, res) => {
        const uid = Number(req.body.uid || req.user.uid);
        if (!assertSelfOrAdmin(req, res, uid)) return;
        const file = path.join(config.DATA_ROOT, "job_state", `${uid}.json`);
        if (!fs.existsSync(file)) return res.status(404).json({ ok:false, error:"No resumable job" });
        let job; try { job = JSON.parse(fs.readFileSync(file, "utf8")); } catch (_) {}
        const numbers = (job?.remaining || []).map(n => String(n).replace(/[^0-9]/g, "")).filter(n => n.length >= 7 && n.length <= 15);
        if (!numbers.length) return res.status(400).json({ ok:false, error:"No remaining numbers" });
        state.initWebState(uid, numbers.length);
        bot.emit("message", { from:{ id:uid, first_name:"Web", username:"Web" }, chat:{ id:uid }, text:numbers.join("\n") });
        res.json({ ok:true, remaining:numbers.length });
    });
    

    // ── Feature Pack: Jobs, Lists, Templates, Audit, Plans, Webhooks, Shares ──
    app.get("/api/jobs", requireAuth, (req, res) => {
        const dir = path.join(config.DATA_ROOT, "job_state");
        const jobs = [];
        try { if (fs.existsSync(dir)) for (const f of fs.readdirSync(dir)) {
            if (!f.endsWith('.json')) continue; const uid = Number(f.replace('.json',''));
            if (uid !== req.user.uid && !isAdmin(req.user.uid)) continue;
            try { jobs.push({ uid, ...JSON.parse(fs.readFileSync(path.join(dir,f),'utf8')) }); } catch(_){ }
        }} catch(_){ }
        const queued = (state.jobQueue || []).filter(j => j.uid === req.user.uid || isAdmin(req.user.uid));
        res.json({ ok:true, jobs, queued });
    });

    app.get("/api/lists", requireAuth, (req, res) => { const {u}=userFeature(req.user.uid); res.json({ok:true, lists:u.savedLists}); });
    app.post("/api/lists", requireAuth, (req, res) => { const {db,u}=userFeature(req.user.uid); const nums=(req.body.numbers||[]).map(n=>String(n).replace(/[^0-9]/g,'')).filter(n=>n.length>=7&&n.length<=15); const list={id:crypto.randomBytes(8).toString('hex'), name:String(req.body.name||`List ${Date.now()}`), numbers:[...new Set(nums)], createdAt:new Date().toISOString()}; u.savedLists.unshift(list); saveDB(db); audit(req.user.uid,'list_create',list.id,{count:list.numbers.length}); res.json({ok:true,list}); });
    app.delete("/api/lists/:id", requireAuth, (req, res) => { const {db,u}=userFeature(req.user.uid); u.savedLists=u.savedLists.filter(x=>x.id!==req.params.id); saveDB(db); audit(req.user.uid,'list_delete',req.params.id); res.json({ok:true}); });

    app.get("/api/templates", requireAuth, (req, res) => { const {u}=userFeature(req.user.uid); res.json({ok:true, templates:u.scanTemplates}); });
    app.post("/api/templates", requireAuth, (req, res) => { const {db,u}=userFeature(req.user.uid); const tpl={id:crypto.randomBytes(8).toString('hex'), name:String(req.body.name||'Template'), deepScan:req.body.deepScan!==false, speed:String(req.body.speed||'balanced'), createdAt:new Date().toISOString()}; u.scanTemplates.unshift(tpl); saveDB(db); audit(req.user.uid,'template_create',tpl.id,tpl); res.json({ok:true,template:tpl}); });

    app.get("/api/admin/audit", requireAdmin, (req, res) => { const db=ensureFeatureDB(getDB()); res.json({ok:true, logs:db.meta.auditLogs||[]}); });
    app.get("/api/admin/user/:uid", requireAdmin, (req,res)=>{ const db=ensureFeatureDB(getDB()); const u=db.users[Number(req.params.uid)]||db.users[String(req.params.uid)]; res.json({ok:!!u,user:u||null,history:db.history[Number(req.params.uid)]||[]}); });
    app.post("/api/admin/user/:uid/notes", requireAdmin, (req,res)=>{ const {db,u}=userFeature(req.params.uid); u.notes.unshift({id:Date.now(), admin:req.user.uid, text:String(req.body.text||''), ts:new Date().toISOString()}); saveDB(db); audit(req.user.uid,'admin_note',req.params.uid,{text:req.body.text}); res.json({ok:true,notes:u.notes}); });
    app.post("/api/admin/user/:uid/reset-pass", requireAdmin, (req,res)=>{ const {generateWebPass}=require('./database'); const pass=generateWebPass(req.params.uid); audit(req.user.uid,'reset_web_pass',req.params.uid); res.json({ok:true,password:pass}); });
    app.post("/api/admin/user/:uid/payment", requireAdmin, (req,res)=>{ const {db,u}=userFeature(req.params.uid); if(!u.payments) u.payments=[]; u.payments.unshift({id:Date.now(), amount:req.body.amount||0, method:req.body.method||'manual', note:req.body.note||'', ts:new Date().toISOString(), admin:req.user.uid}); saveDB(db); audit(req.user.uid,'payment_record',req.params.uid,{amount:req.body.amount}); res.json({ok:true,payments:u.payments}); });
    app.post("/api/admin/user/:uid/ban-toggle", requireAdmin, (req,res)=>{ const db=getDB(); const id=Number(req.params.uid); if(!db.users[id]) return res.status(404).json({ok:false}); db.users[id].banned=!db.users[id].banned; if(db.users[id].banned && !db.banned.includes(id)) db.banned.push(id); if(!db.users[id].banned) db.banned=db.banned.filter(x=>x!==id); saveDB(db); audit(req.user.uid,'ban_toggle',id,{banned:db.users[id].banned}); res.json({ok:true,banned:db.users[id].banned}); });

    app.get("/api/admin/plans", requireAdmin, (req,res)=>{ const db=ensureFeatureDB(getDB()); res.json({ok:true,plans:db.meta.plans}); });
    app.post("/api/admin/plans", requireOwner, (req,res)=>{ const db=ensureFeatureDB(getDB()); db.meta.plans=req.body.plans||db.meta.plans; saveDB(db); audit(req.user.uid,'plans_update','plans',db.meta.plans); res.json({ok:true,plans:db.meta.plans}); });

    app.get("/api/admin/vouchers", requireAdmin, (req,res)=>{ const db=getDB(); res.json({ok:true,vouchers:db.vouchers||{}}); });
    app.post("/api/admin/vouchers/bulk", requireAdmin, (req,res)=>{ const type=String(req.body.type||"PRO").toUpperCase(); const days=Number(req.body.days||30); const count=Math.min(500, Math.max(1, Number(req.body.count||100))); const uses=Number(req.body.uses||1); const expiresAt=req.body.expiresAt?Number(req.body.expiresAt):null; const codes=[]; for(let i=0;i<count;i++) codes.push(createVoucher(type, days, uses, {expiresAt})); audit(req.user.uid,'voucher_bulk','vouchers',{type,days,count,uses,expiresAt}); res.json({ok:true,codes}); });
    app.post("/api/admin/vouchers/:code/disable", requireAdmin, (req,res)=>{ const db=getDB(); if(!db.vouchers[req.params.code]) return res.status(404).json({ok:false,error:'Not found'}); db.vouchers[req.params.code].disabled=true; saveDB(db); audit(req.user.uid,'voucher_disable',req.params.code); res.json({ok:true}); });
    app.get("/api/admin/vouchers-export", requireAdmin, (req,res)=>{ const db=getDB(); let csv='Code,Type,Days,Uses,Disabled,ExpiresAt,UsedBy\n'; Object.entries(db.vouchers||{}).forEach(([c,v])=>{csv += `${c},${v.type},${v.days},${v.uses},${!!v.disabled},${v.expiresAt||''},"${(v.usedBy||[]).join('|')}"\n`;}); res.type('text/csv').send(csv); });

    app.get("/api/webhook/logs", requireAuth, (req,res)=>{ const db=ensureFeatureDB(getDB()); res.json({ok:true,logs:db.meta.webhookLogs[String(req.user.uid)]||[]}); });
    app.post("/api/webhook/test", requireAuth, async (req,res)=>{ const db=ensureFeatureDB(getDB()); const u=db.users[req.user.uid]; if(!u?.webhookUrl) return res.status(400).json({ok:false,error:'Webhook URL not set'}); let ok=false, status=0, error=''; try{ const r=await fetch(u.webhookUrl,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({event:'test',userId:req.user.uid,ts:new Date().toISOString()})}); ok=r.ok; status=r.status; }catch(e){ error=e.message; } const log={id:Date.now(),ts:new Date().toISOString(),ok,status,error,type:'test'}; if(!db.meta.webhookLogs[String(req.user.uid)]) db.meta.webhookLogs[String(req.user.uid)]=[]; db.meta.webhookLogs[String(req.user.uid)].unshift(log); saveDB(db); res.json({ok,log}); });

    app.post("/api/api-key/revoke", requireAuth, (req,res)=>{ const db=getDB(); if(db.users[req.user.uid]) db.users[req.user.uid].apiKey=null; saveDB(db); audit(req.user.uid,'api_key_revoke',req.user.uid); res.json({ok:true}); });
    app.post("/api/api-key/secondary", requireAuth, (req,res)=>{ const {db,u}=userFeature(req.user.uid); const days=req.body.expiry==="7"?7:(req.body.expiry==="30"?30:null); const key='B3AST2-'+crypto.randomBytes(18).toString('base64url').toUpperCase(); u.apiKeys.unshift({key,createdAt:new Date().toISOString(),expiresAt:days?Date.now()+days*86400000:null,active:true}); saveDB(db); audit(req.user.uid,'api_key_secondary',req.user.uid,{days}); res.json({ok:true,key,expiresInDays:days}); });

    app.get("/api/files", requireAuth, (req,res)=>{ const {u}=userFeature(req.user.uid); res.json({ok:true,files:u.files||[]}); });
    app.post("/api/share-result", requireAuth, (req,res)=>{ const db=ensureFeatureDB(getDB()); const id=crypto.randomBytes(8).toString('hex'); const payload={id,uid:req.user.uid,createdAt:new Date().toISOString(),expiresAt:Date.now()+86400000,results:state.lastResults[req.user.uid]||{reg:[],unreg:[],failed:[]}}; db.meta.shares[id]=payload; saveDB(db); audit(req.user.uid,'share_create',id); res.json({ok:true,id,url:`/share/${id}`}); });
    app.get("/api/share/:id", (req,res)=>{ const db=ensureFeatureDB(getDB()); const sh=db.meta.shares[req.params.id]; if(!sh||sh.expiresAt<Date.now()) return res.status(404).json({ok:false,error:'Share expired/not found'}); res.json({ok:true,share:sh}); });

    app.get("/api/whitelabel", (req,res)=>{ const db=ensureFeatureDB(getDB()); res.json({ok:true,whiteLabel:db.meta.whiteLabel}); });
    app.post("/api/admin/whitelabel", requireOwner, (req,res)=>{ const db=ensureFeatureDB(getDB()); db.meta.whiteLabel={...db.meta.whiteLabel,...req.body}; saveDB(db); audit(req.user.uid,'whitelabel_update','branding',db.meta.whiteLabel); res.json({ok:true,whiteLabel:db.meta.whiteLabel}); });


    // ── Force Join Settings ──
    app.get("/api/force-join", requireAuth, async (req, res) => res.json({ ok:true, settings:{ enabled:!!config.dynamic.FORCE_JOIN_ENABLED, channels:config.dynamic.FORCE_JOIN_CHANNELS||[] }, status: await checkForceJoin(req.user.uid) }));
    app.post("/api/admin/force-join", requireAdmin, (req, res) => { const enabled=!!req.body.enabled; const channels=Array.isArray(req.body.channels)?req.body.channels:[]; const ok=config.setDynamicConfig({ FORCE_JOIN_ENABLED:enabled, FORCE_JOIN_CHANNELS:channels }); audit(req.user.uid,'force_join_update','settings',{enabled,channels}); res.json({ ok, settings:{enabled,channels} }); });

    app.post("/api/premium-request", requireAuth, (req, res) => { 
        const uid = req.user.uid;
        const db = getDB();
        const u = db.users[uid]?.name || uid;
        state.pushNotification(`💎 PRO Upgrade Requested by ${u}`, 'gold');
        db.admins.forEach(aid => {
            bot.sendMessage(aid, `🚨 *UPGRADE REQUEST*
┣ 👤 Name: ${u}
┣ 🆔 ID: \`${uid}\``, {
                parse_mode: "Markdown",
                reply_markup: { inline_keyboard: [[{ text: "✅ Approve PRO 30d", callback_data: `apr_sub_${uid}` }]] }
            }).catch(()=>{});
        });
        res.json({ ok: true }); 
    });

    // ============================================================
    // 👑 ADMIN APIS (V4.0 Advanced Features)
    // ============================================================
    
    // ── Owner System Mode ──
    app.post("/api/admin/system-mode", requireOwner, (req, res) => {
        const mode = String(req.body.mode || "").toLowerCase();
        if (!["free", "subscription"].includes(mode)) return res.status(400).json({ ok: false, error: "Mode must be free or subscription." });
        const ok = config.setDynamicConfig({ SYSTEM_MODE: mode });
        state.pushNotification(`🌐 System Mode changed to ${mode.toUpperCase()}`, 'gold');
        res.json({ ok, systemMode: mode });
    });

    // ── User Notification Center ──
    app.get("/api/notifications", requireAuth, (req, res) => res.json({ ok:true, notifs: state.userNotifications[String(req.user.uid)] || [] }));
    app.post("/api/notifications/clear", requireAuth, (req, res) => { state.userNotifications[String(req.user.uid)] = []; res.json({ ok:true }); });

    app.post("/api/admin/security", requireOwner, (req,res)=>{ const db=ensureFeatureDB(getDB()); const days=Math.max(1,Math.min(90,Number(req.body.sessionTtlDays||7))); db.meta.security.sessionTtlDays=days; saveDB(db); audit(req.user.uid,'security_update','sessionTtl',{days}); res.json({ok:true,security:db.meta.security}); });
    app.get("/api/admin/security-center", requireAdmin, (req,res)=>{ const db=ensureFeatureDB(getDB()); const suspects=Object.values(db.users||{}).filter(u=>u.banned||u.count>100000).map(u=>({id:u.id,name:u.name,banned:u.banned,count:u.count||0})); res.json({ok:true,suspects,audit:(db.meta.auditLogs||[]).slice(0,20),sessions:Object.fromEntries(deviceSessions),features:db.meta.featureFlags||{},security:db.meta.security}); });
    app.get("/api/admin/abuse", requireAdmin, (req,res)=>{ const db=getDB(); const suspects=Object.values(db.users||{}).filter(u=>u.banned||u.count>100000).map(u=>({id:u.id,name:u.name,banned:u.banned,count:u.count||0})); res.json({ok:true,suspects}); });
    app.get("/api/admin/feature-flags", requireAdmin, (req,res)=>{ const db=ensureFeatureDB(getDB()); if(!db.meta.featureFlags) db.meta.featureFlags={api:true,batchApi:true,webhooks:true,publicShare:true,proxyPool:true,pwa:true}; res.json({ok:true,features:db.meta.featureFlags}); });
    app.post("/api/admin/feature-flags", requireOwner, (req,res)=>{ const db=ensureFeatureDB(getDB()); db.meta.featureFlags={...(db.meta.featureFlags||{}),...(req.body.features||{})}; saveDB(db); audit(req.user.uid,'feature_flags','system',db.meta.featureFlags); res.json({ok:true,features:db.meta.featureFlags}); });
    app.post("/api/admin/backup-encrypted", requireOwner, (req,res)=>{ try{ const raw=Buffer.from(JSON.stringify(getDB())); const iv=crypto.randomBytes(12); const key=crypto.createHash('sha256').update(WEB_SECRET||config.TG_TOKEN).digest(); const cipher=crypto.createCipheriv('aes-256-gcm',key,iv); const enc=Buffer.concat([cipher.update(raw),cipher.final()]); const tag=cipher.getAuthTag(); const out=Buffer.concat([iv,tag,enc]); const file=path.join(config.DATA_ROOT,`backup_${Date.now()}.enc`); fs.writeFileSync(file,out); audit(req.user.uid,'encrypted_backup','db',{file:path.basename(file)}); res.json({ok:true,file:path.basename(file)}); }catch(e){res.status(500).json({ok:false,error:e.message});} });
    app.post("/api/admin/backup-schedule", requireOwner, (req,res)=>{ const db=ensureFeatureDB(getDB()); db.meta.backupSchedule={enabled:!!req.body.enabled, intervalHours:Number(req.body.intervalHours||6), keep:Number(req.body.keep||10)}; saveDB(db); audit(req.user.uid,'backup_schedule','db',db.meta.backupSchedule); res.json({ok:true,schedule:db.meta.backupSchedule}); });
    app.post("/api/admin/backup-restore", requireOwner, (req,res)=>{ try{ const buf=Buffer.from(String(req.body.data||''),'base64'); const iv=buf.subarray(0,12), tag=buf.subarray(12,28), enc=buf.subarray(28); const key=crypto.createHash('sha256').update(WEB_SECRET||config.TG_TOKEN).digest(); const dec=crypto.createDecipheriv('aes-256-gcm',key,iv); dec.setAuthTag(tag); const raw=Buffer.concat([dec.update(enc),dec.final()]); const parsed=JSON.parse(raw.toString('utf8')); restoreDatabase(parsed); audit(req.user.uid,'backup_restore','db'); res.json({ok:true}); }catch(e){res.status(400).json({ok:false,error:e.message});} });

    // ── Proxy Pool Management ──
    app.get("/api/admin/proxies", requireAdmin, (req, res) => {
        res.json({ ok: true, ...proxyManager.getProxyStatus() });
    });
    app.post("/api/admin/proxies/reload", requireAdmin, (req, res) => {
        audit(req.user.uid, 'proxy_reload', 'proxies');
        res.json({ ok: true, ...proxyManager.getProxyStatus() });
    });
    app.post("/api/admin/proxies/toggle", requireOwner, (req, res) => {
        const enabled = !!req.body.enabled;
        const ok = config.setDynamicConfig({ ENABLE_PROXY: enabled });
        audit(req.user.uid, 'proxy_toggle', 'proxies', { enabled });
        res.json({ ok, enabled, ...proxyManager.getProxyStatus() });
    });

    // ── Notifications System ──
    app.get("/api/admin/notifs/:adminUid", requireAdmin, (req, res) => res.json({ ok: true, notifs: state.notifications }));
    app.post("/api/admin/notifs/clear", requireAdmin, (req, res) => { state.notifications = []; res.json({ ok: true }); });

    // ── Web ↔ Telegram Support Chat System ──
    app.get("/api/admin/chats/:adminUid", requireAdmin, (req, res) => {
        const db = getDB();
        const chatList = Object.keys(state.chats).map(uid => ({
            uid, 
            name: db.users[uid]?.name || "Unknown User", 
            last: state.chats[uid][state.chats[uid].length - 1]
        })).sort((a,b) => new Date("1970/01/01 " + b.last.ts) - new Date("1970/01/01 " + a.last.ts)); // Sort by newest
        res.json({ ok: true, chats: chatList });
    });
    
    app.get("/api/admin/chat/:adminUid/:uid", requireAdmin, (req, res) => {
        res.json({ ok: true, history: state.chats[req.params.uid] || [] });
    });
    
    app.post("/api/admin/chat/send", requireAdmin, async (req, res) => {
        const { targetUid, text } = req.body;
        if (!state.chats[targetUid]) state.chats[targetUid] = [];
        state.chats[targetUid].push({ sender: 'admin', text, ts: new Date().toLocaleTimeString('en-IN', { timeZone: 'Asia/Kolkata' }) });
        
        await bot.sendMessage(targetUid, `👨‍💻 *Admin Reply:*\n\n${text}`, { parse_mode: "Markdown" }).catch(()=>{});
        res.json({ ok: true });
    });

    // ── Vouchers & Maintenance ──
    app.post("/api/admin/voucher", requireAdmin, (req, res) => {
        const { type, days, count } = req.body;
        const code = createVoucher(type || "PRO", days || 30, count || 1);
        res.json({ ok: true, code });
    });

    app.post("/api/admin/maintenance", requireAdmin, (req, res) => {
        const maintOn = req.body.state; 
        setMaintenance(maintOn);
        bot.sendMessage(OWNER_ID, `🚧 *Maintenance Mode:* ${maintOn ? 'ON' : 'OFF'}`, {parse_mode:"Markdown"}).catch(()=>{});
        res.json({ ok: true, maintenance: maintOn });
    });

    // ── Warmup & Sessions ──
    app.post("/api/admin/warmup", requireAdmin, async (req, res) => {
        const result = await warmupNodes();
        res.json(result);
    });

    app.post("/api/admin/del_session", requireAdmin, async (req, res) => {
        await deleteSession(req.body.sessionId).catch(()=>{}); 
        res.json({ ok: true });
    });

    // ── Admin Actions & Stats ──
    app.get("/api/admin/stats/:adminUid", requireAdmin, (req, res) => {
        res.json({ 
            ok: true, 
            ...getStats(),
            systemMode: String(config.dynamic.SYSTEM_MODE || "subscription").toLowerCase(), 
            nodeHealth: state.nodeHealth || {}, nodeMetrics: state.nodeMetrics || {}, proxyStatus: proxyManager.getProxyStatus(), 
            connectedSessions: Object.values(state.sessions).filter(s=>s.status==="Connected").length, 
            activeJobs: state.processingUsers.size, 
            uptime: process.uptime(), 
            memUsageMB: (process.memoryUsage().heapUsed/1024/1024).toFixed(1) 
        });
    });

    app.post("/api/admin/action", requireAdmin, (req, res) => {
        const { action, targetUid, days } = req.body; 
        const tUid = Number(targetUid);
        
        // V4 Dynamic Actions
        if (action === 'add_sub') addSubscriber(tUid, days || 30);
        else if (action === 'add_vip') addVIP(tUid, days || 30);
        else {
            const a = { 
                rem_sub: () => removeSubscriber(tUid), 
                rem_vip: () => removeVIP(tUid),
                ban:     () => banUser(tUid), 
                unban:   () => unbanUser(tUid), 
                add_adm: () => addAdmin(tUid), 
                rem_adm: () => removeAdmin(tUid) 
            }[action];
            if (a) a();
        }
        res.json({ ok: true });
    });

    app.post("/api/admin/broadcast", requireAdmin, async (req, res) => {
        const db = getDB();
        const uids = Object.keys(db.users);
        let sent = 0;
        for (const id of uids) { 
            try {
                await bot.sendMessage(id, `📢 *𝗪𝗘𝗕 𝗕𝗥𝗢𝗔𝗗𝗖𝗔𝗦𝗧*\n\n${req.body.text}\n\n✅ _WS CHECKER v6_`, { parse_mode: "Markdown" }); 
                sent++;
            } catch(e){}
        }
        res.json({ ok: true, sent });
    });

    app.get("/api/admin/users/:adminUid", requireAdmin, (req, res) => { 
        const db = getDB(); 
        res.json({ ok: true, users: db.users, admins: db.admins, subs: db.subscribers, vips: db.vips, banned: db.banned || [] }); 
    });
    
    app.get("/api/public-status", (req,res)=>{ const db=getDB(); const sInfo=storageInfo(); res.json({ok:true, botInfo:state.BOT_INFO, sessions:Object.values(state.sessions).filter(s=>s.status==='Connected').length, queue:(state.jobQueue||[]).length, maintenance:db.meta?.maintenance, uptime:process.uptime(), storage:{backend:sInfo.backend, volumeMounted:sInfo.volumeMounted, pgConnected:sInfo.pgConnected, dataRootDurable:sInfo.dataRootDurable, durable:sInfo.durable}}); });

    // ── ⚙️ AUTO-SETUP STATUS (public, no secrets) ──────────────
    // Shows what the server configured automatically and whether the
    // one-time @BotFather domain whitelist is still pending.
    app.get("/api/setup-status", (req, res) => {
        const s = state.autoSetup || {};
        res.json({
            ok: true,
            autoSetupEnabled: config.AUTO_SETUP,
            botUsername: state.BOT_INFO?.username || null,
            appUrl: s.appUrl || config.MENU_BUTTON_URL || config.DASHBOARD_URL,
            appLink: s.appLink || null,
            miniAppLink: state.BOT_INFO?.username ? `https://t.me/${state.BOT_INFO.username}?startapp` : null,
            directMiniAppLink: state.BOT_INFO?.username ? `https://t.me/${state.BOT_INFO.username}/app` : null,
            lastRunAt: s.at || null,
            menuButtonActive: !!s.menuButtonActive,
            whitelistPending: !!s.whitelistPending,
            summary: s.summary || "Auto-setup has not run yet.",
            menuButtonError: s.menuButtonError || null,
            menuButtonStored: s.menuButtonStored || null,
            profilePhotoActive: !!s.profilePhotoActive,
            storedName: s.storedName || null,
            backend: (typeof require("./database").dbBackend === "function") ? require("./database").dbBackend() : "file",
            platform: config.isRailway ? "railway" : "other",
        });
    });

    // ── ⚙️ RE-RUN AUTO-SETUP (owner only) ─────────────────────
    // Use after whitelisting the domain in @BotFather — no redeploy needed.
    app.post("/api/admin/auto-setup", requireOwner, async (req, res) => {
        try {
            const r = await require("./auto_setup").runAutoSetup(bot);
            audit(req.user.uid, 'auto_setup', 'bot', { menuButtonActive: !!r.menuButtonActive, whitelistPending: !!r.whitelistPending });
            res.json({ ok: true, ...r });
        } catch (e) {
            res.status(500).json({ ok: false, error: e.message });
        }
    });

    // ── Safety Fallbacks ──
    app.use((req, res) => res.status(404).json({ ok: false, error: "Route not found." }));
    app.use((err, req, res, next) => {
        console.error("API Error:", err);
        res.status(500).json({ ok: false, error: "Internal Server Error" });
    });

    app.listen(PORT, "0.0.0.0", () => console.log(`\nWS CHECKER v6 API live on port ${PORT}!`));
}

module.exports = { startServer };
