/* RECIKLA · Service Worker
   Cachea el armazón de la app para que abra rápido y funcione offline
   en lo básico. Los datos siempre se piden a la red. */

const CACHE = 'recikla-v1';
const BASICOS = [
  './',
  './index.html',
  './app.js',
  './config.js',
  './manifest.json',
  './iconos/icono-192.png',
  './iconos/icono-512.png'
];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(BASICOS)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(ks => Promise.all(ks.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  // Nunca cachear llamadas a Supabase ni peticiones que no sean GET
  if (e.request.method !== 'GET' || url.hostname.includes('supabase')) return;

  e.respondWith(
    fetch(e.request)
      .then(r => {
        if (r.ok && url.origin === location.origin) {
          const copia = r.clone();
          caches.open(CACHE).then(c => c.put(e.request, copia));
        }
        return r;
      })
      .catch(() => caches.match(e.request).then(r => r || caches.match('./index.html')))
  );
});
