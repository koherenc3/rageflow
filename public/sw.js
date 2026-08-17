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
 * The two live in separate caches because only one of them can grow. Every
 * deploy publishes chunks at new URLs, so a cache-first asset cache would keep
 * every build it ever saw: the shell is a fixed three entries, the assets are
 * capped, and anything left over from an older worker is deleted on activate.
 * Storage here is not free, it is the same origin quota as the IndexedDB holding
 * the only copy of her history, and losing that to a pile of dead JavaScript
 * would be an absurd way to lose it.
 *
 * Nothing is ever sent anywhere. There is no push handler, no sync handler, and
 * no fetch to any origin but this one.
 */

const VERSION = 'v2';
const PREFIX = 'rageflow-';
const SHELL_CACHE = `${PREFIX}shell-${VERSION}`;
const ASSET_CACHE = `${PREFIX}assets-${VERSION}`;
const CURRENT_CACHES = [SHELL_CACHE, ASSET_CACHE];

/**
 * How many content-hashed files to keep.
 *
 * Comfortably more than one build of this app needs, so the entries evicted are
 * the ones a previous deploy left behind. `keys()` is insertion order, so oldest
 * first is what falls off the end, and an eviction costs a refetch rather than
 * anything she typed.
 */
const MAX_ASSETS = 80;

/** The three screens, so a cold launch offline has something to render. */
const SHELL = ['/', '/log', '/history'];

async function trimAssets() {
  const cache = await caches.open(ASSET_CACHE);
  const keys = await cache.keys();
  const excess = keys.length - MAX_ASSETS;
  for (let index = 0; index < excess; index += 1) {
    await cache.delete(keys[index]);
  }
}

self.addEventListener('install', (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(SHELL_CACHE);
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
      // Everything this app ever wrote and no longer uses, including the single
      // cache the first version of this worker kept both kinds of thing in.
      await Promise.all(
        names
          .filter((name) => name.startsWith(PREFIX) && !CURRENT_CACHES.includes(name))
          .map((name) => caches.delete(name))
      );
      await trimAssets();
      await self.clients.claim();
    })()
  );
});

function isImmutableAsset(url) {
  return url.pathname.startsWith('/_next/static/');
}

async function cacheFirst(request) {
  const cache = await caches.open(ASSET_CACHE);
  const cached = await cache.match(request);
  if (cached !== undefined) return cached;
  const response = await fetch(request);
  if (response.ok) {
    await cache.put(request, response.clone());
    await trimAssets();
  }
  return response;
}

async function networkFirst(request) {
  const cache = await caches.open(SHELL_CACHE);
  try {
    const response = await fetch(request);
    if (response.ok && response.type === 'basic') {
      await cache.put(request, response.clone());
    }
    return response;
  } catch (error) {
    const cached = await cache.match(request);
    if (cached !== undefined) return cached;
    // A navigation to a screen she has never opened, offline. The shell for the
    // app's root is the closest thing to the right answer.
    if (request.mode === 'navigate') {
      const root = await cache.match('/');
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
