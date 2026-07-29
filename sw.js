// ============================================================
// Service Worker — アプリシェルのオフラインキャッシュ（PWA）
// ・自サイトの静的ファイルのみキャッシュ
// ・Firebase/フォント等のクロスオリジンは常にネットワーク
// ============================================================

const VERSION = 'v11';
const CACHE = 'zaiko-shohin-' + VERSION;

// アプリシェル（オフラインでも起動できる最小セット）
// ※ ?v= は index.html と 各jsファイルの import の ?v= に一致させること
//   （バージョンを上げるときは VERSION・index.html・js内import・この一覧を全て更新）
const SHELL = [
  './',
  './index.html',
  './app.css?v=11',
  './manifest.webmanifest',
  './firebase-config.js?v=11',
  './js/app.js?v=11',
  './js/util.js?v=11',
  './js/firebase.js?v=11',
  './js/store.js?v=11',
  './js/image.js?v=11',
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
