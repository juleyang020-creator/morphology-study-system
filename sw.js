/* 形态学学习系统 — service worker (offline support) */
const CACHE = 'morph-pwa-v1';
const PRECACHE = [
  './', './index.html', './manifest.webmanifest',
  './icons/icon-192.png', './icons/icon-512.png', './icons/apple-touch-icon.png'
];

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(CACHE).then((c) => c.addAll(PRECACHE)).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.map((k) => (k === CACHE ? null : caches.delete(k)))))
      .then(() => self.clients.claim())
  );
});

function cachePut(req, res) {
  if (res && res.status === 200 && res.type === 'basic') {
    const copy = res.clone();
    caches.open(CACHE).then((c) => c.put(req, copy));
  }
  return res;
}

function isStaticImage(url) {
  return /\/(images|images_2024|icons)\//.test(url.pathname) || /\.(png|jpe?g|gif|webp|svg)$/i.test(url.pathname);
}

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== location.origin) return;   // only handle same-origin

  if (isStaticImage(url)) {
    // images never change (filename = content) → cache-first, fetch once
    e.respondWith(caches.match(req).then((hit) => hit || fetch(req).then((res) => cachePut(req, res))));
    return;
  }

  // app shell (html/css/js/json) → stale-while-revalidate so updates propagate
  e.respondWith(
    caches.match(req).then((hit) => {
      const net = fetch(req)
        .then((res) => cachePut(req, res))
        .catch(() => hit || caches.match('./index.html'));
      return hit || net;
    })
  );
});
