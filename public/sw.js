// Service worker of the friends' web (registered only there: see main.js). Network first, always: online you
// get what was published last, never an old copy; with no connection, the pages and classes already opened
// on this device still open (in the train, in a basement library).
const CACHE = 'lectures-v1';

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  const url = new URL(req.url);
  if (req.method !== 'GET' || url.origin !== self.location.origin) return;
  event.respondWith(
    fetch(req)
      .then((res) => {
        if (res.ok) {
          const copy = res.clone();
          caches.open(CACHE).then((cache) => cache.put(req, copy)).catch(() => {});
        }
        return res;
      })
      .catch(() => caches.match(req, { ignoreSearch: url.pathname.endsWith('.html') || url.pathname === '/' })
        .then((hit) => hit || caches.match('/index.html'))
        .then((hit) => hit || Response.error()))
  );
});
