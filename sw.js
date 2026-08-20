/* Field Cam — offline shell.
   Cache-first for the app files so the page loads with no signal on a roof. */
const C = 'fieldcam-v1';
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

self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  // never cache auth or Graph traffic
  if (e.request.method !== 'GET' ||
      /login\.microsoftonline\.com|graph\.microsoft\.com/.test(url.host)) return;
  if (url.origin !== location.origin) return;

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
