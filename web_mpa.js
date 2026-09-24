// ============================================================
//   WS CHECKER v6 | web_mpa.js
//   Multi-Page Web — server-side page assembly
// ------------------------------------------------------------
//   index.html stays the SINGLE source of truth (all sections,
//   nav, CSS and JS). At startup this module splits it into:
//
//     /app.js  — the shared script + MPA runtime patch
//     /app.css — the shared stylesheet
//     /<route> — one HTML page per route, each containing ONLY
//                its own section (full page loads, real URLs)
//
//   Nav buttons become real navigations; in-page switchTab() calls
//   keep working via a runtime override that location.assign()s to
//   the target route. Cross-page input state (checker input, scan
//   options, failed numbers) is bridged through sessionStorage —
//   see the mpa_keep/mpa_failed keys + bridge edits in index.html.
// ============================================================

"use strict";

const fs = require("fs");
const path = require("path");

// tab -> route (mirrors the ROUTES map inside index.html)
const TAB_TO_ROUTE = {
    "tab-dashboard": "/dashboard",
    "tab-check": "/checker",
    "tab-history": "/history",
    "tab-session": "/sessions",
    "tab-profile": "/profile",
    "tab-sysinfo": "/system",
    "tab-jobs": "/jobs",
    "tab-lists": "/lists",
    "tab-templates": "/templates",
    "tab-files": "/files",
    "tab-proxies": "/proxies",
    "tab-webhook-logs": "/webhooks",
    "tab-docs": "/docs",
    "tab-settings": "/settings",
    "tab-audit": "/audit",
    "tab-vouchers": "/vouchers",
    "tab-stars": "/stars",
    "tab-branding": "/branding",
    "tab-forcejoin": "/force-join",
    "tab-security": "/security",
    "tab-help": "/help",
    "tab-status": "/status",
    "tab-changelog": "/changelog",
    "tab-support": "/support",
    "tab-admin": "/admin",
};

const TITLES = {
    "tab-dashboard": "Dashboard", "tab-check": "Checker", "tab-history": "History",
    "tab-session": "Sessions", "tab-profile": "API & Webhooks", "tab-sysinfo": "System",
    "tab-jobs": "Jobs & Queue", "tab-lists": "Saved Lists", "tab-templates": "Templates",
    "tab-files": "Files & Share", "tab-proxies": "Proxies", "tab-webhook-logs": "Webhook Logs",
    "tab-docs": "API Docs", "tab-settings": "Settings", "tab-audit": "Audit Logs",
    "tab-vouchers": "Vouchers", "tab-stars": "Stars Revenue", "tab-branding": "Branding",
    "tab-forcejoin": "Force Join", "tab-security": "Security", "tab-help": "Help",
    "tab-status": "Status", "tab-changelog": "Changelog", "tab-support": "Support Inbox",
    "tab-admin": "Admin Console",
};

// route -> tab (null = public shell without an app section)
const ROUTE_TABLE = {
    "/": "tab-dashboard", // shell shows landing when logged out; dashboard when in
    "/login": null,
    "/signup": null,
    "/api": "tab-profile",   // same alias the SPA used (tabFromLocation)
    "/plans": "tab-admin",   // plans UI lives inside the admin console
};
for (const [tab, route] of Object.entries(TAB_TO_ROUTE)) ROUTE_TABLE[route] = tab;

// Balance <div>/<\/div> from `openIdx` (index of "<div") -> index AFTER matching close.
function balancedDivEnd(html, openIdx) {
    const re = /<\/?div\b[^>]*>/g;
    re.lastIndex = openIdx;
    let depth = 0, m;
    while ((m = re.exec(html))) {
        if (m[0][1] === "/") depth -= 1;
        else depth += 1;
        if (depth === 0) return m.index + m[0].length;
    }
    return -1;
}

const MPA_PATCH = `
/* ============================================================
   MPA RUNTIME (injected by web_mpa.js — multi-page navigation)
   ============================================================ */
(function(){
  function readKeep(){ try{ return JSON.parse(sessionStorage.getItem('mpa_keep')||'{}'); }catch(e){ return {}; } }
  function writeKeep(k){ try{ sessionStorage.setItem('mpa_keep',JSON.stringify(k)); }catch(e){} }
  function persistPageState(){
    try{
      var keep=readKeep();
      ['numbers-input','scan-speed','list-name','list-desc','tpl-name','tpl-speed'].forEach(function(id){
        var el=document.getElementById(id); if(el&&el.value!==undefined) keep[id]=el.value;
      });
      ['deep-scan','tpl-deep'].forEach(function(id){
        var el=document.getElementById(id); if(el) keep[id]=el.checked?'1':'0';
      });
      writeKeep(keep);
    }catch(e){}
  }
  function restorePageState(){
    try{
      var keep=readKeep();
      Object.keys(keep).forEach(function(id){
        var el=document.getElementById(id); if(!el) return;
        if(el.type==='checkbox') el.checked=(keep[id]==='1');
        else if(!el.value) el.value=keep[id];
      });
    }catch(e){}
    try{ if(document.getElementById('numbers-input')&&typeof updateNumberPreview==='function') updateNumberPreview(); }catch(e){}
  }
  try{ window.addEventListener('beforeunload',persistPageState); }catch(e){}
  // In-page tab switches become real page loads unless the target
  // section is the one already in this DOM.
  try{
    var _origSwitchTab=(typeof switchTab==='function')?switchTab:null;
    switchTab=function(t, el, push){
      var tgt=null;
      try{ tgt=document.getElementById(t); }catch(e){}
      if(tgt&&t===window.PAGE_TAB&&_origSwitchTab){ return _origSwitchTab(t,el,false); }
      persistPageState();
      var url='/';
      try{ url=routeForTab(t)||'/'; }catch(e){}
      location.assign(url);
    };
  }catch(e){}
  if(document.readyState==='complete') setTimeout(restorePageState,800);
  else try{ window.addEventListener('load',function(){ setTimeout(restorePageState,800); }); }catch(e){}
})();
`;

let cache = null;

function build() {
    if (cache) return cache;
    const src = fs.readFileSync(path.join(__dirname, "index.html"), "utf-8");

    // ── 1. Extract CSS ──
    const cssM = src.match(/<style>([\s\S]*?)<\/style>/);
    if (!cssM) throw new Error("[MPA] <style> block not found in index.html");
    const css = cssM[1];
    let html = src.replace(cssM[0], '<link rel="stylesheet" href="/app.css">');

    // ── 2. Extract the main script ──
    const jsM = html.match(/<script>([\s\S]*?)<\/script>/);
    if (!jsM) throw new Error("[MPA] main <script> block not found in index.html");
    const js = jsM[1] + MPA_PATCH;
    html = html.replace(jsM[0], '<script src="/app.js"></script>\n<!--MPA_TAB_BOOT-->');

    // ── 3. Split around #app-container ──
    const openTag = '<div id="app-container"';
    const openIdx = html.indexOf(openTag);
    if (openIdx === -1) throw new Error("[MPA] #app-container not found");
    const openEnd = html.indexOf(">", openIdx) + 1;
    const containerEnd = balancedDivEnd(html, openIdx);
    if (containerEnd === -1) throw new Error("[MPA] unbalanced #app-container");
    const prefix = html.slice(0, openEnd);
    const inner = html.slice(openEnd, containerEnd);
    const suffix = html.slice(containerEnd);

    // ── 4. Extract each tab section ──
    const sections = {};
    const secRe = /<div id="(tab-[a-z0-9-]+)"[^>]*>/g;
    let m;
    while ((m = secRe.exec(inner))) {
        const end = balancedDivEnd(inner, m.index);
        if (end === -1) throw new Error("[MPA] unbalanced section " + m[1]);
        sections[m[1]] = inner.slice(m.index, end);
    }
    const missing = Object.keys(TAB_TO_ROUTE).filter(t => !sections[t]);
    if (missing.length) throw new Error("[MPA] sections missing from index.html: " + missing.join(", "));

    cache = { prefix, suffix, sections, css, js };
    console.log(`🧩 [MPA] ${Object.keys(sections).length} pages assembled from index.html (single source).`);
    return cache;
}

// Nav: buttons navigate for real; highlight the current page's button.
function navFor(prefix, tab) {
    let nav = prefix.replace(/class="nav-item active"/g, 'class="nav-item"');
    nav = nav.replace(/onclick="switchTab\('([^']+)'(?:, this)?\)"/g, (mm, t) => {
        const route = TAB_TO_ROUTE[t] || "/";
        return `onclick="location.assign('${route}')" data-tab="${t}"`;
    });
    if (tab) {
        nav = nav.replace(
            new RegExp(`<button class="nav-item"((?:[^>]*)data-tab="${tab}")`),
            '<button class="nav-item active"$1'
        );
    }
    return nav;
}

function page(tab, route) {
    const { prefix, suffix, sections } = build();
    const body = tab && sections[tab]
        ? sections[tab].replace('class="tab-section"', 'class="tab-section active"')
        : "";
    let out = navFor(prefix, tab);
    const title = (tab && TITLES[tab]) || (route === "/login" ? "Login" : route === "/signup" ? "Sign Up" : "WS CHECKER");
    out = out.replace(/<title>.*?<\/title>/, `<title>${title} — WS CHECKER</title>`);
    out = out.replace(/Route: <b>\/checker<\/b>/, `Route: <b>${route || "/"}</b>`);
    const boot = `<script>window.PAGE_TAB=${tab ? `'${tab}'` : "null"};<\/script>`;
    return out + "\n" + body + "\n" + suffix.replace("<!--MPA_TAB_BOOT-->", boot);
}

function routeList() {
    return Object.entries(ROUTE_TABLE).map(([path, tab]) => ({ path, tab }));
}

module.exports = {
    build,
    page,
    routeList,
    get css() { return build().css; },
    get js() { return build().js; },
    TAB_TO_ROUTE,
};
