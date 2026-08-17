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
 * The two live in separate caches because they grow for different reasons and
 * are worth different amounts. Every deploy publishes chunks at new URLs, so a
 * cache-first asset cache would keep every build it ever saw. The shell cache is
 * not the fixed three routes either: it also takes the manifest, the icons, and
 * one entry per prefetched route payload, which is a new URL each build. So both
 * are capped, oldest first, and anything left over from an older worker is
 * deleted on activate. The three screen documents are pinned against the shell
 * cap, because they are what an offline cold launch has to render.
 *
 * Storage here is not free, it is the same origin quota as the IndexedDB holding
 * the only copy of her history, and losing that to a pile of dead JavaScript
 * would be an absurd way to lose it.
 *
 * Nothing is ever sent anywhere. There is no push handler, no sync handler, and
 * no fetch to any origin but this one.
 */

/**
 * Bump this whenever what is kept in a cache changes shape, not merely when the
 * app does. The names below are derived from it, and `activate` deletes every
 * `rageflow-` cache that is not one of them, so a bump is how a worker written
 * against the old layout stops being read by this one. v1 kept both kinds of
 * thing in a single cache.
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

/**
 * How many of the shell cache's other entries to keep, on top of the three
 * screens, which never count against it and are never evicted.
 */
const MAX_SHELL = 24;

/** The three screens, so a cold launch offline has something to render. */
const SHELL = ['/', '/log', '/history'];

/**
 * A screen document, as opposed to the route payload the router prefetches for
 * the same screen, which carries a query and is a separate cache entry.
 */
function isShellDocument(request) {
  const url = new URL(request.url);
  return url.search === '' && SHELL.includes(url.pathname);
}

async function trim(name, max, isPinned) {
  const cache = await caches.open(name);
  const keys = await cache.keys();
  const evictable = keys.filter((request) => !isPinned(request));
  const excess = evictable.length - max;
  for (let index = 0; index < excess; index += 1) {
    await cache.delete(evictable[index]);
  }
}

function trimAssets() {
  return trim(ASSET_CACHE, MAX_ASSETS, () => false);
}

function trimShell() {
  return trim(SHELL_CACHE, MAX_SHELL, isShellDocument);
}

/**
 * Housekeeping, off the path the page is waiting on.
 *
 * A trim is worth doing eventually and worth nothing immediately: the response
 * is already in hand, and making her wait for a full enumeration of the cache
 * before she gets it would be a cost with no matching benefit. `waitUntil` keeps
 * the worker alive long enough to finish, and a failed trim stays a failed trim
 * rather than becoming a failed fetch.
 */
function afterwards(event, work) {
  const settled = work.catch(() => undefined);
  try {
    event.waitUntil(settled);
  } catch {
    // The event is no longer active, so the worker is not obliged to stay up for
    // this. It runs anyway if it can, and activate does it again regardless.
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
      await trimShell();
      await self.clients.claim();
    })()
  );
});

function isImmutableAsset(url) {
  return url.pathname.startsWith('/_next/static/');
}

async function cacheFirst(request, event) {
  const cache = await caches.open(ASSET_CACHE);
  const cached = await cache.match(request);
  if (cached !== undefined) return cached;
  const response = await fetch(request);
  if (response.ok) {
    await cache.put(request, response.clone());
    afterwards(event, trimAssets());
  }
  return response;
}

async function networkFirst(request, event) {
  const cache = await caches.open(SHELL_CACHE);
  try {
    const response = await fetch(request);
    if (response.ok && response.type === 'basic') {
      await cache.put(request, response.clone());
      afterwards(event, trimShell());
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

  event.respondWith(
    isImmutableAsset(url) ? cacheFirst(request, event) : networkFirst(request, event)
  );
});
