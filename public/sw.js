/* CalDrop service worker: offline shell + Web Share Target receiver. */
const CACHE = 'caldrop-v1';
const SHARE_CACHE = 'caldrop-share';

self.addEventListener('install', () => self.skipWaiting());

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(keys.filter((k) => k !== CACHE && k !== SHARE_CACHE).map((k) => caches.delete(k))),
      )
      .then(() => self.clients.claim()),
  );
});

/**
 * The share sheet POSTs here. A service worker cannot hand data to a page
 * directly, so the payload is parked in a cache and the browser is redirected
 * to the app, which picks it up on load.
 */
async function receiveShare(request) {
  const form = await request.formData();
  const cache = await caches.open(SHARE_CACHE);
  const files = form.getAll('file').filter((f) => f && typeof f !== 'string');

  await Promise.all(
    files.map((file, i) =>
      cache.put(
        `/__share/file-${i}`,
        new Response(file, {
          headers: {
            'content-type': file.type || 'application/octet-stream',
            'x-filename': encodeURIComponent(file.name || `shared-${i}`),
          },
        }),
      ),
    ),
  );

  await cache.put(
    '/__share/meta',
    Response.json({
      count: files.length,
      title: form.get('title') || '',
      text: form.get('text') || '',
      url: form.get('url') || '',
    }),
  );

  const base = new URL('./', request.url);
  return Response.redirect(`${base.pathname}?shared=1`, 303);
}

self.addEventListener('fetch', (event) => {
  const { request } = event;
  const url = new URL(request.url);

  if (request.method === 'POST' && url.pathname.endsWith('/share-target')) {
    event.respondWith(receiveShare(request));
    return;
  }

  if (request.method !== 'GET' || url.origin !== self.location.origin) return;

  // Hashed build assets never change under the same name: serve them from cache.
  if (/\/assets\//.test(url.pathname)) {
    event.respondWith(
      caches.match(request).then(
        (hit) =>
          hit ||
          fetch(request).then((res) => {
            const copy = res.clone();
            caches.open(CACHE).then((c) => c.put(request, copy));
            return res;
          }),
      ),
    );
    return;
  }

  // Everything else (the shell) is network-first so a deploy is picked up at once.
  event.respondWith(
    fetch(request)
      .then((res) => {
        const copy = res.clone();
        caches.open(CACHE).then((c) => c.put(request, copy));
        return res;
      })
      .catch(() => caches.match(request).then((hit) => hit || caches.match('./index.html'))),
  );
});
