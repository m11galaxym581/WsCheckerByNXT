// ============================================================
//   WS CHECKER v6 | state.js
//   Global In-Memory State — Live Metrics, Chat & Notifications
// ============================================================

"use strict";

if (!global.webState) global.webState = {};

function initWebState(uid, total) {
    global.webState[uid] = {
        current: 0, 
        total: total, 
        reg: 0, 
        unreg: 0,
        bizCount: 0, // NEW: V4.0 Business Number Tracking
        status: "Starting", 
        startedAt: Date.now(), 
        updatedAt: Date.now(),
    };
}

function updateWebState(uid, patch) {
    if (!global.webState[uid]) return;
    Object.assign(global.webState[uid], patch, { updatedAt: Date.now() });
}

function getWebState(uid) {
    return global.webState[uid] || null;
}

function cancelUser(uid) {
    if (global.webState[uid]) {
        global.webState[uid].status = "Cancelled";
        global.webState[uid].updatedAt = Date.now();
    }
    // Do not release the processing lock here; the checker will release it in finally.
}


const state = {
    sessions: {},
    processingUsers: new Set(),
    lastResults: {},
    userState: {},
    BOT_INFO: { first_name: "WS CHECKER", username: "WS_CHECKER_BOT" },

    // 🔥 Live Node Health & Smart Load-Balancer Metrics 🔥
    nodeHealth: {},
    nodeMetrics: {},
    updateNodeHealth(nodeId, latencyMs) {
        this.nodeHealth[nodeId] = latencyMs;
        if (!this.nodeMetrics[nodeId]) this.nodeMetrics[nodeId] = { success:0, fail:0, totalLatency:0, avgLatency:0, lastActive:null, cooldownUntil:0 };
        const m = this.nodeMetrics[nodeId]; m.totalLatency += Number(latencyMs)||0; m.avgLatency = Math.round(m.totalLatency / Math.max(1, m.success + m.fail)); m.lastActive = new Date().toISOString();
    },
    recordNodeResult(sock, ok, latencyMs = 0) {
        const nodeId = sock?.user?.id || "node";
        if (!this.nodeMetrics[nodeId]) this.nodeMetrics[nodeId] = { success:0, fail:0, totalLatency:0, avgLatency:0, lastActive:null, cooldownUntil:0 };
        const m = this.nodeMetrics[nodeId]; if (ok) m.success++; else { m.fail++; if (m.fail >= 5 && m.fail > m.success) m.cooldownUntil = Date.now() + 60000; }
        if (latencyMs) { m.totalLatency += latencyMs; m.avgLatency = Math.round(m.totalLatency / Math.max(1, m.success + m.fail)); }
        m.lastActive = new Date().toISOString(); this.nodeHealth[nodeId] = m.avgLatency || latencyMs || this.nodeHealth[nodeId] || 0;
    },
    sortSocksByHealth(socks = []) {
        return [...socks].sort((a,b) => {
            const aid=a?.user?.id||"node", bid=b?.user?.id||"node"; const am=this.nodeMetrics[aid]||{}, bm=this.nodeMetrics[bid]||{};
            const ac=(am.cooldownUntil||0)>Date.now(), bc=(bm.cooldownUntil||0)>Date.now(); if(ac!==bc) return ac?1:-1;
            return (am.avgLatency||9999) - (bm.avgLatency||9999);
        });
    },

    // ── V3/V4: Chat & Notifications ──
    notifications: [],
    userNotifications: {},
    chats: {},

    pushUserNotification(uid, text, type = 'info') {
        const id = String(uid);
        if (!this.userNotifications[id]) this.userNotifications[id] = [];
        this.userNotifications[id].unshift({ id: Date.now(), text, type, time: new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', hour:'2-digit', minute:'2-digit', second:'2-digit' }), read:false });
        if (this.userNotifications[id].length > 50) this.userNotifications[id].pop();
    },
    pushNotification(text, type = 'info') {
        this.notifications.unshift({ 
            id: Date.now(), 
            text, 
            type, 
            time: new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', hour: '2-digit', minute:'2-digit', second:'2-digit' }), 
            read: false 
        });
        if (this.notifications.length > 50) this.notifications.pop(); // Keeps RAM optimized
    },

    // ── Session Management ──
    setSession(id, data) { 
        this.sessions[id] = { ...this.sessions[id], ...data }; 
    },
    removeSession(id) { 
        delete this.sessions[id]; 
        delete this.nodeHealth[id]; delete this.nodeMetrics[id]; // Cleanup health stats when node dies
    },
    
    getConnectedSocks() { return Object.values(this.sessions).filter(s => s.status === "Connected").map(s => s.sock); },
    getPrivateSocks(ownerId) { return Object.values(this.sessions).filter(s => s.status === "Connected" && s.owner === ownerId).map(s => s.sock); },
    getPublicSocks() { return Object.values(this.sessions).filter(s => s.status === "Connected" && s.type === "public").map(s => s.sock); },
    
    getActiveSocksForUser(ownerId) {
        // V4 Logic: Prioritizes private nodes. If none available, falls back to public.
        const priv = this.getPrivateSocks(ownerId);
        if (priv.length > 0) return this.sortSocksByHealth(priv);
        return this.sortSocksByHealth(this.getPublicSocks());
    },

    // ── Job Processing ──
    isProcessing(uid) { return this.processingUsers.has(Number(uid)); },
    addProcessing(uid) { this.processingUsers.add(Number(uid)); },
    removeProcessing(uid) { this.processingUsers.delete(Number(uid)); },

    // ── Step Navigation ──
    setUserStep(uid, step) { this.userState[uid] = step; },
    getUserStep(uid) { return this.userState[uid]; },
    clearUserStep(uid) { delete this.userState[uid]; },
};

module.exports = Object.assign(state, {
    initWebState, updateWebState, getWebState, cancelUser,
});
