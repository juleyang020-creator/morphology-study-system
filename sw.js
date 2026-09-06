/* 形态学学习系统 — service worker (offline support)
 * v6 更新策略（修复手机卡旧版）：
 *  - install 只缓存 app shell（html/css/js，秒级完成）→ 新 SW 能立即激活
 *  - 题库图片不再阻塞 install：activate 后后台分批补缓存（try/catch 单张失败不中断）
 *  - 图片 fetch 保持 cache-first；外壳 stale-while-revalidate
 *  - 版本号绑定：每次发版 bump VERSION，activate 清旧缓存
 *  - 图片 fetch 失败返回 1x1 透明占位图
 *  - skipWaiting + clients.claim + 页面 controllerchange 自动刷新
 */
const VERSION = 'morph-pwa-v6';
const SHELL_CACHE = 'morph-shell-' + VERSION;
const IMG_CACHE = 'morph-img-' + VERSION;
const IMG_CACHE_MAX = 900;

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
  if (!/^(images|images_x6)\/[^\/]/i.test(imgPath)) return null;
  return new URL(source.base + imgPath, self.registration.scope).toString();
}

function discoverImageUrls() {
  return Promise.all(IMAGE_DATA_SOURCES.map(function (source) {
    return fetch(source.url, { cache: 'reload' }).then(function (res) {
      if (!res || !res.ok) return [];
      return res.text();
    }).then(function (text) {
      const re = /["']((?:images|images_x6)\/[^"']+\.(?:png|jpe?g|gif|webp|svg))["']/ig;
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

// 后台分批补缓存图片：不阻塞 install/activate，失败静默跳过
// 仅预缓存两个模块的 images/（约 70MB）；images_x6（新题库 400MB+）改为浏览时按需缓存，
// 避免手机流量被静默消耗。看过的新题图片会自动进入缓存，下次离线可用。
function precacheImagesBackground() {
  return discoverImageUrls().then(function (urls) {
    const light = urls.filter(function (u) { return u.indexOf('/images_x6/') === -1; });
    return caches.open(IMG_CACHE).then(function (c) {
      let i = 0;
      const BATCH = 4;
      function step() {
        if (i >= light.length) { trimImageCache(c); return Promise.resolve(); }
        const batch = light.slice(i, i + BATCH);
        i += BATCH;
        return Promise.allSettled(batch.map(function (url) {
          return c.add(new Request(url, { cache: 'reload' })).catch(function () {});
        })).then(step);
      }
      return step();
    });
  }).catch(function () {});
}

self.addEventListener('install', function (e) {
  e.waitUntil(
    caches.open(SHELL_CACHE).then(function (c) {
      return c.addAll(PRECACHE);
    }).then(function () { return self.skipWaiting(); })
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
      .then(function () {
        // 外壳就绪后再后台补图片缓存（不阻塞激活）
        precacheImagesBackground();
      })
  );
});

function isStaticImage(url) {
  return /\/(images|images_x6|icons)\//.test(url.pathname) || /\.(png|jpe?g|gif|webp|svg)$/i.test(url.pathname);
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
