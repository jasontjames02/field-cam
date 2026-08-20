/* Field Cam — offline shell.
   BUILD is bumped on every release. Changing this file byte-wise is what makes
   the browser install a new worker at all; a service worker whose file never
   changes is never replaced, and its cache is served forever. */
const BUILD = 'v9-2026-08-20';
const C = 'fieldcam-' + BUILD;

/* Only genuinely static things are pre-cached. index.html deliberately is NOT
   served cache-first: doing that pinned the app to whatever version happened to
   be cached first and made updates a coin flip. */
const STATIC = ['./icon-192.png', './icon-512.png'];

self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(C)
      .then(c => c.addAll(STATIC).catch(() => {}))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      .then(ks => Promise.all(ks.filter(k => k !== C).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET') return;
  if (/login\.microsoftonline\.com|graph\.microsoft\.com/.test(url.host)) return;
  if (url.origin !== location.origin) return;

  const isDoc = e.request.mode === 'navigate' ||
                /\.(html|webmanifest|js)$/i.test(url.pathname) ||
                url.pathname.endsWith('/');

  if (isDoc) {
    // NETWORK FIRST: always take a fresh copy when there is signal, fall back to
    // cache on a roof with no bars. Updates can never get stuck again.
    e.respondWith(
      fetch(e.request, { cache: 'no-store' })
        .then(res => {
          if (res && res.ok) {
            const copy = res.clone();
            caches.open(C).then(c => c.put(e.request, copy));
          }
          return res;
        })
        .catch(() => caches.match(e.request).then(hit => hit || caches.match('./index.html')))
    );
    return;
  }

  // icons and the like: cache first is fine, they never change without a rename
  e.respondWith(
    caches.match(e.request).then(hit => hit || fetch(e.request).then(res => {
      if (res && res.ok) {
        const copy = res.clone();
        caches.open(C).then(c => c.put(e.request, copy));
      }
      return res;
    }))
  );
});
