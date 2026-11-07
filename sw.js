// Service worker de l'application Cats.
// - Cache-first pour un démarrage instantané et le hors-ligne.
// - Précache tolérant : un fichier manquant ne bloque plus l'installation.
// - Les requêtes portant le paramètre "__update" vont toujours au réseau
//   (utilisées par la page pour détecter et appliquer les mises à jour).
const CACHE='cats-v3';
const CORE=['./','./index.html','./app.js','./app.css','./scan.js','./lib/pdfjs/pdf.min.js','./lib/pdfjs/pdf.worker.min.js','./manifest.webmanifest','./icon-192.png','./icon-512.png','./avatar-alpha.png','./avatar-bebew.png'];
const PDFS=[
'./pdf/CR_Echo_cardio_du_19-06-2024_-_SPIKE_Mme_KEIB_Aurelie.pdf','./pdf/KEIB_SPIKE_20240619142638538.pdf',
'./pdf/CR_Echo_cardio_du_04-09-2024_-_SPIKE_Mme_KEIB_Aurelie.pdf','./pdf/KEIB_SPIKE_20240904145948957.pdf',
'./pdf/CR_Echo_cardio_du_01-10-2025_-_SPIKE_Mme_KEIB_Aurelie.pdf','./pdf/KEIB_SPIKE_20251001174555880.pdf',
'./pdf/CR_Echographie_cardiaque_chat_du_18-06-2026_-_SPIKE_Mme_KEIB_Aurelie.pdf','./pdf/KEIB_SPIKE_20260618112024156.pdf',
'./pdf/CONTESSE_Prise_de_sang_18-06-2026.pdf'];

async function precache(){
  const c=await caches.open(CACHE);
  await Promise.all([...CORE,...PDFS].map(u=>fetch(u+(u.includes('?')?'&':'?')+'__update='+Date.now(),{cache:'no-store'}).then(r=>{if(r.ok)return c.put(u,r)}).catch(()=>{})));
}
self.addEventListener('install',e=>{self.skipWaiting();e.waitUntil(precache())});
self.addEventListener('activate',e=>e.waitUntil(caches.keys().then(keys=>Promise.all(keys.filter(k=>k!==CACHE).map(k=>caches.delete(k)))).then(()=>self.clients.claim())));
self.addEventListener('message',e=>{if(e.data==='SKIP_WAITING')self.skipWaiting()});
self.addEventListener('fetch',e=>{
  const req=e.request;
  if(req.method!=='GET')return;
  const url=new URL(req.url);
  if(url.origin!==location.origin)return; // sites externes (Open Food Facts…) : jamais en cache
  if(url.searchParams.has('__update'))return; // toujours réseau
  // app.js?b=… / app.css?b=… : même entrée de cache que app.js / app.css
  const key=url.origin===location.origin&&url.searchParams.has('b')?url.origin+url.pathname:req;
  e.respondWith(caches.match(key).then(r=>r||fetch(req).then(resp=>{
    if(resp.ok||resp.type==='opaque'){const copy=resp.clone();caches.open(CACHE).then(c=>c.put(key,copy))}
    return resp;
  }).catch(()=>req.mode==='navigate'?caches.match('./index.html'):Response.error())));
});
