/* Field Capture — offline shell.
   The app files are cached so the page loads with no signal on a roof.

   Navigations are network-first (falling back to cache) so a new deploy is picked up
   the next time the phone has signal — cache-first left installed phones pinned to an
   old build forever. Everything else stays cache-first for speed. */
const C = 'fieldcapture-v2';
const FILES = ['./', './index.html', './manifest.webmanifest'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(C).then(c => c.addAll(FILES)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      .then(ks => Promise.all(ks.filter(k => k !== C).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('message', e => { if (e.data === 'skipWaiting') self.skipWaiting(); });

self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);

  // never touch auth or Graph traffic
  if (e.request.method !== 'GET' ||
      /login\.microsoftonline\.com|graph\.microsoft\.com/.test(url.host)) return;
  if (url.origin !== location.origin) return;

  // the OAuth redirect comes back as ./?code=... — always let it hit the network
  if (url.searchParams.has('code') || url.searchParams.has('error')) return;

  const isNav = e.request.mode === 'navigate';

  if (isNav) {
    e.respondWith(
      fetch(e.request)
        .then(res => {
          if (res && res.ok) { const copy = res.clone(); caches.open(C).then(c => c.put('./index.html', copy)); }
          return res;
        })
        .catch(() => caches.match('./index.html').then(hit => hit || caches.match('./')))
    );
    return;
  }

  e.respondWith(
    caches.match(e.request).then(hit => hit || fetch(e.request).then(res => {
      if (res && res.ok) {
        const copy = res.clone();
        caches.open(C).then(c => c.put(e.request, copy));
      }
      return res;
    }).catch(() => caches.match('./index.html')))
  );
});
