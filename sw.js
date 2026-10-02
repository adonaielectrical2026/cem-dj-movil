'use strict';
// Guarda la app en el equipo para que abra sin internet. Subir el número de versión cuando se cambie algún archivo.
const CACHE = 'cem-dj-movil-9';
const FILES = ['./', 'index.html', 'app.js', 'styles.css', 'lufs.js', 'bpm.js', 'manifest.webmanifest', 'logo.jpg', 'icon-192.png', 'icon-512.png'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(FILES)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', (e) => {
  if (e.request.method !== 'GET') return;
  e.respondWith(caches.match(e.request, { ignoreSearch: true }).then((hit) => hit || fetch(e.request)));
});
