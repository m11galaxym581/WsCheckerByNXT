"use strict";

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const config = require("./config");
const { getDB, saveDB } = require("./database");

function proxyFilePath() {
    const dyn = config.dynamic;
    return path.resolve(__dirname, process.env.PROXY_FILE || dyn.PROXY_FILE || "proxies.txt");
}

function loadProxyList() {
    const dyn = config.dynamic;
    const out = [];
    if (process.env.PROXY_URL) out.push(process.env.PROXY_URL.trim());
    const fp = proxyFilePath();
    if (fs.existsSync(fp)) {
        const lines = fs.readFileSync(fp, "utf8").split(/\r?\n/)
            .map(x => x.trim()).filter(x => x && !x.startsWith("#"));
        out.push(...lines);
    }
    if (Array.isArray(dyn.PROXY_LIST)) out.push(...dyn.PROXY_LIST.map(String));
    return [...new Set(out)].filter(isValidProxyUrl);
}

function isValidProxyUrl(url) {
    try { const u = new URL(url); return ["http:", "https:", "socks:", "socks4:", "socks5:"].includes(u.protocol); }
    catch (_) { return false; }
}

function proxyId(url) { return crypto.createHash("sha1").update(String(url)).digest("hex").slice(0, 12); }
function maskProxy(url) {
    try { const u = new URL(url); return `${u.protocol}//${u.username ? "***:***@" : ""}${u.hostname}:${u.port || ""}`; }
    catch (_) { return "Invalid proxy"; }
}

function ensureProxyDB(db) {
    if (!db.meta) db.meta = {};
    if (!db.meta.proxyAssignments) db.meta.proxyAssignments = {};
    if (!db.meta.proxyHealth) db.meta.proxyHealth = {};
    return db;
}

function getProxyForSession(sessionId) {
    const dyn = config.dynamic;
    if (!dyn.ENABLE_PROXY) return null;
    const proxies = loadProxyList();
    if (!proxies.length) return null;
    const db = ensureProxyDB(getDB());
    const existing = db.meta.proxyAssignments[sessionId];
    if (existing && proxies.includes(existing.url)) return { id: proxyId(existing.url), url: existing.url, masked: maskProxy(existing.url), reused: true };

    const counts = {};
    Object.values(db.meta.proxyAssignments).forEach(a => { if (a?.url) counts[a.url] = (counts[a.url] || 0) + 1; });
    const now = Date.now();
    const chosen = proxies
        .filter(p => !(db.meta.proxyHealth[proxyId(p)]?.cooldownUntil > now))
        .sort((a,b) => (counts[a] || 0) - (counts[b] || 0))[0] || proxies[0];
    db.meta.proxyAssignments[sessionId] = { url: chosen, assignedAt: new Date().toISOString(), sticky: dyn.PROXY_STICKY !== false };
    saveDB(db);
    return { id: proxyId(chosen), url: chosen, masked: maskProxy(chosen), reused: false };
}

function releaseProxy(sessionId) {
    const db = ensureProxyDB(getDB());
    delete db.meta.proxyAssignments[sessionId];
    saveDB(db);
}

function markProxyResult(proxyUrl, ok, latencyMs = 0, error = "") {
    if (!proxyUrl) return;
    const db = ensureProxyDB(getDB());
    const id = proxyId(proxyUrl);
    const h = db.meta.proxyHealth[id] || { id, masked: maskProxy(proxyUrl), success: 0, fail: 0, totalLatency: 0, avgLatency: 0, lastError: "", lastActive: null, cooldownUntil: 0 };
    if (ok) h.success++; else h.fail++;
    if (latencyMs) { h.totalLatency += Number(latencyMs) || 0; h.avgLatency = Math.round(h.totalLatency / Math.max(1, h.success + h.fail)); }
    h.lastActive = new Date().toISOString();
    h.lastError = ok ? "" : String(error || "proxy/node failure").slice(0, 160);
    if (!ok && h.fail >= 3 && h.fail > h.success) h.cooldownUntil = Date.now() + 5 * 60 * 1000;
    db.meta.proxyHealth[id] = h;
    saveDB(db);
}

function createAgent(proxyUrl) {
    if (!proxyUrl) return undefined;
    try {
        const protocol = new URL(proxyUrl).protocol;
        if (protocol.startsWith("socks")) {
            const { SocksProxyAgent } = require("socks-proxy-agent");
            return new SocksProxyAgent(proxyUrl);
        }
        const { HttpsProxyAgent } = require("https-proxy-agent");
        return new HttpsProxyAgent(proxyUrl);
    } catch (e) {
        console.error("⚠️ [Proxy] Agent creation failed:", e.message);
        return undefined;
    }
}

function getProxyStatus() {
    const db = ensureProxyDB(getDB());
    const proxies = loadProxyList();
    const assigned = db.meta.proxyAssignments || {};
    const assignedCounts = {};
    Object.values(assigned).forEach(a => { if (a?.url) assignedCounts[proxyId(a.url)] = (assignedCounts[proxyId(a.url)] || 0) + 1; });
    return {
        enabled: !!config.dynamic.ENABLE_PROXY,
        file: proxyFilePath(),
        total: proxies.length,
        proxies: proxies.map(url => ({ id: proxyId(url), masked: maskProxy(url), assigned: assignedCounts[proxyId(url)] || 0, health: db.meta.proxyHealth[proxyId(url)] || null })),
        assignments: Object.fromEntries(Object.entries(assigned).map(([sid,a]) => [sid, { id: proxyId(a.url), masked: maskProxy(a.url), assignedAt: a.assignedAt }]))
    };
}

module.exports = { loadProxyList, getProxyForSession, releaseProxy, markProxyResult, createAgent, getProxyStatus, maskProxy, proxyId };
