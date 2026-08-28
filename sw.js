/* 形态学学习系统 — service worker (offline support)
 * 改进点（对照 CHANGES.md）：
 *  - 预缓存列表补全：含两模块的 index.html / app.js / style.css / 数据 JS / 共享资源
 *  - 图片用独立 cache + FIFO 淘汰，并从数据文件中扫描图片路径做离线预缓存
 *  - 版本号绑定：每次发版 bump VERSION，activate 时清旧缓存
 *  - 图片 fetch 失败返回 1x1 透明占位图（避免白屏叉）
 *  - skipWaiting + clients.claim 已有，配合 controllerchange 页面自动刷新
 */
const VERSION = 'morph-pwa-v4';
const SHELL_CACHE = 'morph-shell-' + VERSION;
const IMG_CACHE = 'morph-img-' + VERSION;
const IMG_CACHE_MAX = 700;

const PRECACHE = [
  './',
  './index.html',
  './manifest.webmanifest',
  './shared/base.css',
  './shared/ui.js',
  './标签库/index.html',
  './标签库/app.js',
  './标签库/style.css',
  './标签库/entries.js',
  './练习系统/index.html',
  './练习系统/app.js',
  './练习系统/style.css',
  './练习系统/questions.js',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/apple-touch-icon.png',
];

const IMAGE_DATA_SOURCES = [
  { url: './标签库/entries.js', base: './标签库/' },
  { url: './练习系统/questions.js', base: './练习系统/' },
];

function trimImageCache(c) {
  return c.keys().then(function (keys) {
    if (keys.length <= IMG_CACHE_MAX) return null;
    return Promise.all(keys.slice(0, keys.length - IMG_CACHE_MAX).map(function (k) { return c.delete(k); }));
  });
}

function imageUrlFromDataPath(source, imgPath) {
  if (!/^(images|images_2024)\//i.test(imgPath)) return null;
  return new URL(source.base + imgPath, self.registration.scope).toString();
}

function discoverImageUrls() {
  return Promise.all(IMAGE_DATA_SOURCES.map(function (source) {
    return fetch(source.url, { cache: 'reload' }).then(function (res) {
      if (!res || !res.ok) return [];
      return res.text();
    }).then(function (text) {
      const re = /["']((?:images|images_2024)\/[^"']+\.(?:png|jpe?g|gif|webp|svg))["']/ig;
      const urls = [];
      let m;
      while ((m = re.exec(text))) {
        const url = imageUrlFromDataPath(source, m[1]);
        if (url) urls.push(url);
      }
      return urls;
    }).catch(function () { return []; });
  })).then(function (groups) {
    const seen = {};
    return groups.flat().filter(function (url) {
      if (seen[url]) return false;
      seen[url] = true;
      return true;
    });
  });
}

function precacheImages() {
  return discoverImageUrls().then(function (urls) {
    return caches.open(IMG_CACHE).then(function (c) {
      return Promise.allSettled(urls.map(function (url) {
        return c.add(new Request(url, { cache: 'reload' }));
      })).then(function () { return trimImageCache(c); });
    });
  });
}

self.addEventListener('install', function (e) {
  e.waitUntil(
    caches.open(SHELL_CACHE).then(function (c) {
      return c.addAll(PRECACHE);
    }).then(precacheImages).then(function () { return self.skipWaiting(); })
  );
});

self.addEventListener('activate', function (e) {
  e.waitUntil(
    caches.keys()
      .then(function (keys) {
        return Promise.all(keys.map(function (k) {
          // 清掉所有非当前版本的缓存（shell + img 一起）
          if (k === SHELL_CACHE || k === IMG_CACHE) return null;
          return caches.delete(k);
        }));
      })
      .then(function () { return self.clients.claim(); })
  );
});

function isStaticImage(url) {
  return /\/(images|images_2024|icons)\//.test(url.pathname) || /\.(png|jpe?g|gif|webp|svg)$/i.test(url.pathname);
}

// 写入图片缓存 + FIFO 淘汰
function imgCachePut(req, res) {
  if (!res || res.status !== 200 || res.type !== 'basic') return res;
  const copy = res.clone();
  caches.open(IMG_CACHE).then(function (c) {
    c.put(req, copy);
    trimImageCache(c);
  });
  return res;
}

function shellCachePut(req, res) {
  if (!res || res.status !== 200 || res.type !== 'basic') return res;
  const copy = res.clone();
  caches.open(SHELL_CACHE).then(function (c) { c.put(req, copy); });
  return res;
}

// 1x1 透明 PNG（图片 fetch 失败时返回，避免白屏叉）
const PLACEHOLDER_PNG_BASE64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=';
function placeholderResponse() {
  const bin = atob(PLACEHOLDER_PNG_BASE64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new Response(bytes, { headers: { 'Content-Type': 'image/png', 'Cache-Control': 'no-store' } });
}

self.addEventListener('fetch', function (e) {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== location.origin) return;   // only handle same-origin

  if (isStaticImage(url)) {
    // 图片：cache-first；失败时回退占位图
    e.respondWith(
      caches.match(req).then(function (hit) {
        if (hit) return hit;
        return fetch(req).then(function (res) { return imgCachePut(req, res); })
          .catch(function () {
            return caches.match(req).then(function (h2) { return h2 || placeholderResponse(); });
          });
      })
    );
    return;
  }

  // app shell (html/css/js/json) → stale-while-revalidate
  e.respondWith(
    caches.match(req).then(function (hit) {
      const net = fetch(req)
        .then(function (res) { return shellCachePut(req, res); })
        .catch(function () { return hit || caches.match('./index.html'); });
      return hit || net;
    })
  );
});
