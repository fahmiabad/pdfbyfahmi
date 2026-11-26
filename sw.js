/* PocketPDF Scanner — service worker: offline app shell + cached libraries. */
const VERSION = 'v2.1.0'; // must match index.html, js/app.js and css/app.css (see set-version.sh)
const SHELL_CACHE = `pocketpdf-shell-${VERSION}`;
const LIB_CACHE = 'pocketpdf-libs-v1'; // bump only when files in vendor/ change

const SHELL = [
  './',
  'index.html',
  'about.html',
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

// Files that carry the version marker. If any of them comes back without it, the server
// (GitHub's CDN) hasn't caught up yet: the install is abandoned and retried later, so the
// offline copy is never a mix of old and new files.
const VERSIONED = ['index.html', 'css/app.css', 'js/app.js'];

/** Fetch a file straight from the origin: a never-seen query string misses every CDN cache. */
async function fetchFresh(path) {
  const url = new URL(path, self.location.href);
  url.searchParams.set('sw', VERSION);
  const res = await fetch(url.href, { cache: 'no-store' });
  if (!res.ok) throw new Error(`Fetch failed for ${path}: ${res.status}`);
  return res;
}

async function precache(cacheName, paths, checkVersion) {
  const responses = await Promise.all(paths.map(async (path) => {
    const res = await fetchFresh(path);
    if (checkVersion && VERSIONED.includes(path)) {
      const text = await res.clone().text();
      if (!text.includes(VERSION)) throw new Error(`Stale copy of ${path}; will retry later`);
    }
    return [path, res];
  }));
  const cache = await caches.open(cacheName);
  await Promise.all(responses.map(([path, res]) => cache.put(new URL(path, self.location.href).href, res)));
}

self.addEventListener('install', (event) => {
  event.waitUntil(
    Promise.all([
      precache(SHELL_CACHE, SHELL, true),
      precache(LIB_CACHE, LIBS, false),
    ]).catch(async (err) => {
      await caches.delete(SHELL_CACHE);
      throw err;
    })
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

  // Navigations: serve the requested page from the offline copy (the app itself for the start URL)
  if (req.mode === 'navigate') {
    event.respondWith((async () => {
      const opts = { cacheName: SHELL_CACHE, ignoreSearch: true };
      const hit = (await caches.match(req, opts)) ||
        (url.pathname.endsWith('/') ? await caches.match(new URL('index.html', self.location.href).href, opts) : undefined);
      return hit || fetch(req);
    })());
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
