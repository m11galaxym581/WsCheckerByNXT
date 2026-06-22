const CACHE='ws-checker-v5-01-49';
self.addEventListener('install',e=>{e.waitUntil(caches.open(CACHE).then(c=>c.addAll(['/dashboard'])));self.skipWaiting();});
self.addEventListener('fetch',e=>{ if(e.request.method!=='GET') return; e.respondWith(fetch(e.request).catch(()=>caches.match(e.request).then(r=>r||caches.match('/dashboard')))); });
