// ============================================================
// Service Worker — アプリシェルのオフラインキャッシュ（PWA）
// ・自サイトの静的ファイルのみキャッシュ
// ・Firebase/フォント等のクロスオリジンは常にネットワーク
// ============================================================

const VERSION = 'v18';
const CACHE = 'zaiko-shohin-' + VERSION;

// アプリシェル（オフラインでも起動できる最小セット）
// ※ ?v= は index.html と 各jsファイルの import の ?v= に一致させること
//   （バージョンを上げるときは VERSION・index.html・js内import・この一覧を全て更新）
const SHELL = [
  './',
  './index.html',
  './app.css?v=18',
  './steel.css?v=18',
  './manifest.webmanifest',
  './firebase-config.js?v=18',
  './js/app.js?v=18',
  './js/util.js?v=18',
  './js/firebase.js?v=18',
  './js/store.js?v=18',
  './js/image.js?v=18',
  './js/home.js?v=18',
  './js/steel.js?v=18',
  './js/steel-util.js?v=18',
  './js/steel-store.js?v=18',
  './js/csv.js?v=18',
  './icons/icon-v2-48.png',
  './icons/icon-v2-120.png',
  './icons/icon-v2-180.png',
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

  // ページ遷移（ナビゲーション）: キャッシュ優先で即起動し、
  // 背後で最新の index.html を取得して次回起動に反映する
  // （PWA起動時にネットワーク待ちの白画面を出さないため）
  if (req.mode === 'navigate') {
    e.respondWith(
      caches.match('./index.html').then((cached) => {
        const network = fetch(req).then((res) => {
          if (res && res.status === 200 && res.type === 'basic') {
            const copy = res.clone();
            caches.open(CACHE).then((c) => c.put('./index.html', copy));
          }
          return res;
        }).catch(() => cached);
        return cached || network;
      })
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
