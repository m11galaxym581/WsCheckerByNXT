"use strict";

const LANGS = {
  en: {
    start_checker: "🔍 START CHECKER", dashboard_login: "🅆 Dashboard Login", upgrade: "💎 Upgrade Tier", redeem: "🎁 Redeem Code",
    connect_node: "📱 Connect Private Node", history: "📜 Check History", api_webhooks: "⚙️ API & Webhooks", info: "ℹ️ System Info", support: "💬 Support",
    language: "🌐 Language", admin: "👑 ADMIN CONSOLE", owner: "⚡ GOD MODE (OWNER)", back: "🔙 Back", lang_saved: "✅ Language updated.", choose_lang: "🌐 Choose your language:",
    welcome: "Welcome", your_id: "Your ID", status: "Status", system_mode: "System Mode", nodes_active: "Nodes Active", web_dashboard: "Web Dashboard",
    send_numbers: "Send numbers — one per line.", your_limit: "Your Limit", no_nodes: "No Nodes Available. Please connect a Private Session using the menu.", scan_complete: "Scan Complete!"
  },
  hi: {
    start_checker: "🔍 चेकर शुरू करें", dashboard_login: "🅆 डैशबोर्ड लॉगिन", upgrade: "💎 अपग्रेड", redeem: "🎁 कोड रिडीम",
    connect_node: "📱 प्राइवेट नोड जोड़ें", history: "📜 हिस्ट्री", api_webhooks: "⚙️ API और Webhooks", info: "ℹ️ सिस्टम जानकारी", support: "💬 सपोर्ट",
    language: "🌐 भाषा", admin: "👑 एडमिन कंसोल", owner: "⚡ ओनर मोड", back: "🔙 वापस", lang_saved: "✅ भाषा अपडेट हो गई।", choose_lang: "🌐 अपनी भाषा चुनें:",
    welcome: "स्वागत है", your_id: "आपकी ID", status: "स्टेटस", system_mode: "सिस्टम मोड", nodes_active: "एक्टिव नोड्स", web_dashboard: "वेब डैशबोर्ड",
    send_numbers: "नंबर भेजें — एक लाइन में एक।", your_limit: "आपकी लिमिट", no_nodes: "कोई नोड उपलब्ध नहीं। मेनू से प्राइवेट सेशन जोड़ें।", scan_complete: "स्कैन पूरा हुआ!"
  },
  ar: {
    start_checker: "🔍 بدء الفحص", dashboard_login: "🅆 دخول اللوحة", upgrade: "💎 ترقية", redeem: "🎁 استرداد كود",
    connect_node: "📱 ربط عقدة خاصة", history: "📜 السجل", api_webhooks: "⚙️ API و Webhooks", info: "ℹ️ معلومات النظام", support: "💬 الدعم",
    language: "🌐 اللغة", admin: "👑 لوحة الإدارة", owner: "⚡ وضع المالك", back: "🔙 رجوع", lang_saved: "✅ تم تحديث اللغة.", choose_lang: "🌐 اختر لغتك:",
    welcome: "مرحبا", your_id: "معرفك", status: "الحالة", system_mode: "وضع النظام", nodes_active: "العقد النشطة", web_dashboard: "لوحة الويب",
    send_numbers: "أرسل الأرقام — رقم واحد في كل سطر.", your_limit: "حدك", no_nodes: "لا توجد عقد متاحة. اربط جلسة خاصة من القائمة.", scan_complete: "اكتمل الفحص!"
  },
  es: {
    start_checker: "🔍 INICIAR CHECKER", dashboard_login: "🅆 Login Panel", upgrade: "💎 Mejorar", redeem: "🎁 Canjear código",
    connect_node: "📱 Conectar nodo privado", history: "📜 Historial", api_webhooks: "⚙️ API y Webhooks", info: "ℹ️ Info sistema", support: "💬 Soporte",
    language: "🌐 Idioma", admin: "👑 CONSOLA ADMIN", owner: "⚡ MODO OWNER", back: "🔙 Atrás", lang_saved: "✅ Idioma actualizado.", choose_lang: "🌐 Elige tu idioma:",
    welcome: "Bienvenido", your_id: "Tu ID", status: "Estado", system_mode: "Modo del sistema", nodes_active: "Nodos activos", web_dashboard: "Panel web",
    send_numbers: "Envía números — uno por línea.", your_limit: "Tu límite", no_nodes: "No hay nodos disponibles. Conecta una sesión privada.", scan_complete: "¡Escaneo completo!"
  },
  pt: {
    start_checker: "🔍 INICIAR CHECKER", dashboard_login: "🅆 Login Painel", upgrade: "💎 Upgrade", redeem: "🎁 Resgatar código",
    connect_node: "📱 Conectar nó privado", history: "📜 Histórico", api_webhooks: "⚙️ API e Webhooks", info: "ℹ️ Info sistema", support: "💬 Suporte",
    language: "🌐 Idioma", admin: "👑 CONSOLE ADMIN", owner: "⚡ MODO OWNER", back: "🔙 Voltar", lang_saved: "✅ Idioma atualizado.", choose_lang: "🌐 Escolha seu idioma:",
    welcome: "Bem-vindo", your_id: "Seu ID", status: "Status", system_mode: "Modo do sistema", nodes_active: "Nós ativos", web_dashboard: "Painel web",
    send_numbers: "Envie números — um por linha.", your_limit: "Seu limite", no_nodes: "Nenhum nó disponível. Conecte uma sessão privada.", scan_complete: "Verificação concluída!"
  },
  id: {
    start_checker: "🔍 MULAI CHECKER", dashboard_login: "🅆 Login Dashboard", upgrade: "💎 Upgrade", redeem: "🎁 Redeem kode",
    connect_node: "📱 Hubungkan node privat", history: "📜 Riwayat", api_webhooks: "⚙️ API & Webhooks", info: "ℹ️ Info sistem", support: "💬 Support",
    language: "🌐 Bahasa", admin: "👑 KONSOL ADMIN", owner: "⚡ MODE OWNER", back: "🔙 Kembali", lang_saved: "✅ Bahasa diperbarui.", choose_lang: "🌐 Pilih bahasa:",
    welcome: "Selamat datang", your_id: "ID Anda", status: "Status", system_mode: "Mode sistem", nodes_active: "Node aktif", web_dashboard: "Dashboard web",
    send_numbers: "Kirim nomor — satu per baris.", your_limit: "Limit Anda", no_nodes: "Tidak ada node tersedia. Hubungkan sesi privat.", scan_complete: "Scan selesai!"
  }
};

const LABELS = { en:"🇬🇧 English", hi:"🇮🇳 हिंदी", ar:"🇸🇦 العربية", es:"🇪🇸 Español", pt:"🇧🇷 Português", id:"🇮🇩 Indonesia" };
function normalizeLang(lang) { return LANGS[lang] ? lang : "en"; }
function tr(lang, key) { lang = normalizeLang(lang); return LANGS[lang][key] || LANGS.en[key] || key; }
function langKeyboard(prefix = "set_lang") { return Object.entries(LABELS).map(([code,label]) => [{ text: label, callback_data: `${prefix}_${code}` }]); }
module.exports = { LANGS, LABELS, normalizeLang, tr, langKeyboard };
