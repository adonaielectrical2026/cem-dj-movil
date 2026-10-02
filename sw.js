'use strict';
// Guarda la app en el equipo para que abra sin internet.
// Primero intenta traer la versión nueva de internet (así las actualizaciones se ven al abrir la app);
// si no hay conexión, usa la copia guardada.
const CACHE = 'cem-dj-movil-12';
const FILES = ['./', 'index.html', 'app.js', 'styles.css', 'lufs.js', 'bpm.js', 'manifest.webmanifest', 'logo.jpg', 'icon-192.png', 'icon-512.png'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(FILES.map((f) => new Request(f, { cache: 'reload' })))).then(() => self.skipWaiting()));
});
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET' || new URL(req.url).origin !== location.origin) return;
  e.respondWith((async () => {
    const cache = await caches.open(CACHE);
    try {
      const ctl = new AbortController(), t = setTimeout(() => ctl.abort(), 4000); // sin esperar de más con mala señal
      const res = await fetch(req.url, { cache: 'no-cache', credentials: 'same-origin', signal: ctl.signal });
      clearTimeout(t);
      if (res.ok) cache.put(req, res.clone());
      return res;
    } catch {
      return (await cache.match(req, { ignoreSearch: true })) || (await cache.match('index.html')) || Response.error();
    }
  })());
});
