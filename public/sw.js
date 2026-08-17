/*
 * The offline shell.
 *
 * The app has no server to be offline from: her whole history is in IndexedDB
 * and the engine runs in the tab. The only thing a plane or a basement takes
 * away is the HTML and the JavaScript, so that is all this caches.
 *
 * Two strategies, chosen by what the URL is rather than by a rule that has to be
 * right about everything:
 *
 * - `/_next/static/*` is content-hashed. The bytes at one of those URLs never
 *   change, so cache-first is correct and a deploy cannot serve a stale one: a
 *   new build produces new URLs.
 * - Everything else is network-first, falling back to the cache. Online she
 *   always gets the deploy that is live, which is what keeps a cached page from
 *   asking for a chunk a later deploy has deleted. Offline she gets the last
 *   version she loaded, whole.
 *
 * Nothing is ever sent anywhere. There is no push handler, no sync handler, and
 * no fetch to any origin but this one.
 */

const VERSION = 'v1';
const CACHE = `rageflow-${VERSION}`;

/** The three screens, so a cold launch offline has something to render. */
const SHELL = ['/', '/log', '/history'];

self.addEventListener('install', (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(CACHE);
      // Individually, so one failing route cannot fail the whole install and
      // leave her with no offline shell at all.
      await Promise.all(
        SHELL.map((path) =>
          cache.add(new Request(path, { cache: 'reload' })).catch(() => undefined)
        )
      );
      await self.skipWaiting();
    })()
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const names = await caches.keys();
      await Promise.all(names.filter((name) => name !== CACHE).map((name) => caches.delete(name)));
      await self.clients.claim();
    })()
  );
});

function isImmutableAsset(url) {
  return url.pathname.startsWith('/_next/static/');
}

async function cacheFirst(request) {
  const cached = await caches.match(request);
  if (cached !== undefined) return cached;
  const response = await fetch(request);
  if (response.ok) {
    const cache = await caches.open(CACHE);
    await cache.put(request, response.clone());
  }
  return response;
}

async function networkFirst(request) {
  try {
    const response = await fetch(request);
    if (response.ok && response.type === 'basic') {
      const cache = await caches.open(CACHE);
      await cache.put(request, response.clone());
    }
    return response;
  } catch (error) {
    const cached = await caches.match(request);
    if (cached !== undefined) return cached;
    // A navigation to a screen she has never opened, offline. The shell for the
    // app's root is the closest thing to the right answer.
    if (request.mode === 'navigate') {
      const root = await caches.match('/');
      if (root !== undefined) return root;
    }
    throw error;
  }
}

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  event.respondWith(isImmutableAsset(url) ? cacheFirst(request) : networkFirst(request));
});
