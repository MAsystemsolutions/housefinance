/* =============================================================================
 * HOUSEHOLD FINANCES — service-worker.js
 * Caches ONLY the application shell (HTML, manifest, icons) and web fonts so the
 * app opens with no internet. Financial data is never cached here: it lives in
 * IndexedDB (managed by index.html) and API calls to Google Apps Script always go
 * straight to the network.
 *
 * Bump CACHE_VERSION whenever you deploy a new index.html so clients update.
 * ========================================================================== */
const CACHE_VERSION = 'hf-shell-v1.0.0';
const FONT_CACHE = 'hf-fonts-v1';
const SHELL = [
  './',
  './index.html',
  './manifest.json',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/maskable-512.png',
  './icons/apple-touch-icon.png'
];
const API_HOSTS = ['script.google.com', 'script.googleusercontent.com'];
const FONT_HOSTS = ['fonts.googleapis.com', 'fonts.gstatic.com'];

self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_VERSION)
      .then(cache => cache.addAll(SHELL.map(u => new Request(u, { cache: 'reload' }))))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE_VERSION && k !== FONT_CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', event => {
  const req = event.request;
  if (req.method !== 'GET') return;                       // POSTs (API calls) are never intercepted
  const url = new URL(req.url);
  if (API_HOSTS.some(h => url.hostname === h || url.hostname.endsWith('.' + h))) return;   // data: network only, never cached

  if (FONT_HOSTS.includes(url.hostname)) {
    event.respondWith(staleWhileRevalidate(req, FONT_CACHE));
    return;
  }
  if (url.origin !== self.location.origin) return;

  // App navigation: answer from cache instantly (works offline), refresh the cache in the background.
  if (req.mode === 'navigate') {
    event.respondWith((async () => {
      const cache = await caches.open(CACHE_VERSION);
      const cached = await cache.match('./index.html');
      const network = fetch(req).then(res => {
        if (res && res.ok && res.type === 'basic') cache.put('./index.html', res.clone());
        return res;
      }).catch(() => null);
      if (cached) { event.waitUntil(network); return cached; }
      const res = await network;
      return res || new Response('<!doctype html><meta charset="utf-8"><title>Offline</title><p style="font-family:sans-serif;padding:24px">Household Finances is offline and has not been cached yet. Open it once while online.</p>', { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
    })());
    return;
  }

  // Other same-origin shell files (icons, manifest): cache first, then network.
  event.respondWith(staleWhileRevalidate(req, CACHE_VERSION));
});

async function staleWhileRevalidate(req, cacheName) {
  const cache = await caches.open(cacheName);
  const cached = await cache.match(req, { ignoreSearch: req.mode === 'navigate' });
  const network = fetch(req).then(res => {
    if (res && (res.ok || res.type === 'opaque')) cache.put(req, res.clone());
    return res;
  }).catch(() => null);
  if (cached) return cached;
  const res = await network;
  return res || new Response('', { status: 504, statusText: 'Offline' });
}

self.addEventListener('message', event => {
  if (event.data === 'SKIP_WAITING') self.skipWaiting();
});
