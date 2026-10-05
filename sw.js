/* Field Capture — offline shell.
   BUILD is bumped on every release. Changing this file byte-wise is what makes
   the browser install a new worker at all; a service worker whose file never
   changes is never replaced, and its cache is served forever. */
const BUILD = '3.0.2-2026-10-04';
const C = 'fieldcapture-' + BUILD;

/* The app is fetched fresh and stored the moment a release installs, so the
   first launch on a roof with no bars still opens. It is still served NETWORK
   FIRST below: serving index.html cache-first is what once pinned the app to
   whatever version happened to be cached. */
const MUST = ['./index.html', './config.js'];
const NICE = ['./manifest.webmanifest', './icon-192.png', './icon-512.png'];
const grab = u => fetch(new Request(u, { cache: 'reload' }));

/* A release only takes over once the whole app is stored. If the download is
   cut short the install FAILS, and the release already on the phone — with its
   complete copy — stays in charge. */
self.addEventListener('install', e => {
  e.waitUntil((async () => {
    const had = await caches.has(C);
    try {
      const c = await caches.open(C);
      for (const u of MUST) {
        const r = await grab(u);
        if (!r || !r.ok) throw new Error('could not store ' + u);
        await c.put(u, r);
      }
      await Promise.all(NICE.map(u => grab(u).then(r => { if (r && r.ok) return c.put(u, r); }).catch(() => {})));
    } catch (err) {
      if (!had) await caches.delete(C);                 // no half-filled copy left behind
      throw err;
    }
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      .then(ks => Promise.all(ks.filter(k => k !== C).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

/* A weak signal can hold a request open for a minute before it fails. Give the
   network a few seconds, then open from the stored copy. */
function fresh(req, ms) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('slow network')), ms);
    fetch(req, { cache: 'no-store' }).then(r => { clearTimeout(t); resolve(r); },
                                           e => { clearTimeout(t); reject(e); });
  });
}

self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET') return;
  if (url.origin !== location.origin) return;          // Microsoft sign-in, Graph, downloads

  const nav = e.request.mode === 'navigate' || url.pathname.endsWith('/');
  const isDoc = nav || /\.(html|webmanifest|js)$/i.test(url.pathname);

  if (isDoc) {
    /* Every way of opening the app (with or without index.html, with a sign-in
       ?code= on the end) is one stored page under one key. */
    const key = nav ? './index.html' : url.pathname.split('/').pop();
    e.respondWith((async () => {
      const c = await caches.open(C);
      const stored = () => c.match('./' + key.replace(/^\.\//, ''), { ignoreSearch: true });
      try {
        const res = await fresh(e.request, 4000);
        if (res && res.ok) { c.put('./' + key.replace(/^\.\//, ''), res.clone()); return res; }
        return (await stored()) || res;                 // a server error still opens the stored app
      } catch (err) {
        const hit = await stored();
        if (hit) return hit;
        throw err;
      }
    })());
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
