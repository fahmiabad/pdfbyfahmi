/* PocketPDF Scanner — service worker: offline app shell + cached libraries. */
const VERSION = 'v2.0.0';
const SHELL_CACHE = `pocketpdf-shell-${VERSION}`;
const LIB_CACHE = 'pocketpdf-libs-v1'; // bump only when files in vendor/ change

const SHELL = [
  './',
  'index.html',
  'css/app.css',
  'js/app.js',
  'js/imaging.js',
  'js/worker.js',
  'manifest.webmanifest',
  'icons/icon-192.png',
  'icons/icon-512.png',
  'icons/apple-touch-icon.png',
  'fonts/bricolage-grotesque-latin-700-normal.woff2',
  'fonts/bricolage-grotesque-latin-800-normal.woff2',
  'fonts/figtree-latin-400-normal.woff2',
  'fonts/figtree-latin-500-normal.woff2',
  'fonts/figtree-latin-600-normal.woff2',
  'fonts/figtree-latin-700-normal.woff2',
];
// Small libraries cached up-front; OpenCV (~10 MB) and heic2any are cached the first time they are used.
const LIBS = ['vendor/Sortable.min.js', 'vendor/jspdf.umd.min.js'];

self.addEventListener('install', (event) => {
  event.waitUntil(
    Promise.all([
      // cache: 'reload' bypasses the browser's HTTP cache so an update never stores stale files
      caches.open(SHELL_CACHE).then((c) => c.addAll(SHELL.map((u) => new Request(u, { cache: 'reload' })))),
      caches.open(LIB_CACHE).then((c) => c.addAll(LIBS.map((u) => new Request(u, { cache: 'reload' })))),
    ])
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== SHELL_CACHE && k !== LIB_CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('message', (event) => {
  if (event.data === 'skipWaiting') self.skipWaiting();
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;

  const isLib = url.pathname.includes('/vendor/');
  const cacheName = isLib ? LIB_CACHE : SHELL_CACHE;

  // Navigations: serve the cached shell so the app opens offline
  if (req.mode === 'navigate') {
    event.respondWith(
      caches.match('index.html', { cacheName: SHELL_CACHE }).then((hit) => hit || fetch(req))
    );
    return;
  }

  // Cache-first, then network (and store the result)
  event.respondWith(
    caches.open(cacheName).then(async (cache) => {
      const hit = await cache.match(req, { ignoreSearch: true });
      if (hit) return hit;
      const res = await fetch(req);
      if (res && res.ok && res.type === 'basic') cache.put(req, res.clone());
      return res;
    })
  );
});
