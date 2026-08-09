const CACHE='cats-v1.1';
const ASSETS=['./','./index.html','./manifest.webmanifest','./icon-192.png','./icon-512.png','./avatar-alpha.png','./avatar-bebew.png',
'./pdf/CR_Echo_cardio_du_19-06-2024_-_SPIKE_Mme_KEIB_Aurelie.pdf','./pdf/KEIB_SPIKE_20240619142638538.pdf',
'./pdf/CR_Echo_cardio_du_04-09-2024_-_SPIKE_Mme_KEIB_Aurelie.pdf','./pdf/KEIB_SPIKE_20240904145948957.pdf',
'./pdf/CR_Echo_cardio_du_01-10-2025_-_SPIKE_Mme_KEIB_Aurelie.pdf','./pdf/KEIB_SPIKE_20251001174555880.pdf',
'./pdf/CR_Echographie_cardiaque_chat_du_18-06-2026_-_SPIKE_Mme_KEIB_Aurelie.pdf','./pdf/KEIB_SPIKE_20260618112024156.pdf'];
self.addEventListener('install',e=>e.waitUntil(caches.open(CACHE).then(c=>c.addAll(ASSETS))));
self.addEventListener('activate',e=>e.waitUntil(caches.keys().then(keys=>Promise.all(keys.filter(k=>k!==CACHE).map(k=>caches.delete(k))))));
self.addEventListener('fetch',e=>{if(e.request.method!=='GET')return;e.respondWith(caches.match(e.request).then(r=>r||fetch(e.request).then(resp=>{const copy=resp.clone();caches.open(CACHE).then(c=>c.put(e.request,copy));return resp}).catch(()=>caches.match('./index.html'))))});
