// ============================================================
// Service Worker — アプリシェルのオフラインキャッシュ（PWA）
// ・自サイトの静的ファイルのみキャッシュ
// ・Firebase/フォント等のクロスオリジンは常にネットワーク
// ============================================================

const VERSION = 'v1';
const CACHE = 'zaiko-shohin-' + VERSION;

// アプリシェル（オフラインでも起動できる最小セット）
const SHELL = [
  './',
  './index.html',
  './app.css',
  './manifest.webmanifest',
  './firebase-config.js',
  './js/app.js',
  './js/util.js',
  './js/firebase.js',
  './js/store.js',
  './js/image.js',
  './icons/icon-9a-48.png',
  './icons/icon-9a-120.png',
  './icons/icon-9a-180.png',
];

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);

  // 自オリジン以外（Firebase, Google Fonts 等）はネットワーク優先で素通し
  if (url.origin !== self.location.origin) return;

  // ページ遷移（ナビゲーション）: ネットワーク優先、失敗時 index.html
  if (req.mode === 'navigate') {
    e.respondWith(
      fetch(req).catch(() => caches.match('./index.html'))
    );
    return;
  }

  // 静的アセット: キャッシュ優先 + 背後で更新（stale-while-revalidate）
  e.respondWith(
    caches.match(req).then((cached) => {
      const network = fetch(req).then((res) => {
        if (res && res.status === 200 && res.type === 'basic') {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(req, copy));
        }
        return res;
      }).catch(() => cached);
      return cached || network;
    })
  );
});
