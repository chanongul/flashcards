// Minimal service worker: caches the app shell so the PWA opens offline.
// This is intentionally simple for v1 — no runtime caching strategy tuning yet.

// Bumped to v8: dynamic routes (/review/<deckId>[...]) are now also cached
// under a normalized "shell" key (deck id replaced with a placeholder) — see
// findShellKey()/the fetch handler below — plus the fetch handler no longer
// lets a failed request reject uncaught.
const CACHE_NAME = 'flashcard-app-v8';
// Separate from CACHE_NAME so bumping the app-shell version above doesn't
// also evict previously-downloaded images/audio (see the activate handler).
// Bumped to v2 to purge any audio responses cached under the old
// range-oblivious fetch handler (see the fetch handler's comment above).
const MEDIA_CACHE_NAME = 'flashcard-media-v2';
const APP_SHELL = ['/', '/manifest.json'];

// Every /review/<deckId>[...] route is a 'use client' page whose real
// content comes entirely from IndexedDB via useParams(), not from anything
// deck-specific baked into the server response — so a cached response for
// ANY deck's route is a valid offline stand-in for a different deck's same
// route; the page re-renders correctly from local data once its JS runs.
// findShellKey() normalizes a request's deck-id path segment (and adds a
// synthetic 'kind' marker distinguishing a full HTML navigation from a
// Next.js client-navigation data fetch, which return different formats for
// the same URL) into a second, id-agnostic cache key. Caching under that key
// too means visiting *any* deck's review/all/browse page while online makes
// that whole route pattern available offline for *every* deck, instead of
// only the exact deck id that happened to be visited.
const UUID_PATTERN = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const UUID_TEST_RE = new RegExp(UUID_PATTERN, 'i');
const UUID_REPLACE_RE = new RegExp(UUID_PATTERN, 'gi');

function findShellKey(request) {
  const url = new URL(request.url);
  if (!UUID_TEST_RE.test(url.pathname)) return null;
  const isRSC =
    request.headers.has('RSC') || (request.headers.get('accept') || '').includes('text/x-component');
  url.pathname = url.pathname.replace(UUID_REPLACE_RE, '__id__');
  url.search = `?__kind=${isRSC ? 'rsc' : 'doc'}`;
  return url.toString();
}

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(APP_SHELL))
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(
        keys
          .filter((k) => k !== CACHE_NAME && k !== MEDIA_CACHE_NAME)
          .map((k) => caches.delete(k))
      )
    )
  );
  self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  // Media is immutable per URL (every upload gets a fresh UUID filename), so
  // it's safe to cache-first and never revalidate. Write-through on a
  // successful fetch — unlike the generic fallback below, this is the one
  // path that actually populates a cache from a live network response.
  //
  // Range requests (Safari's <audio>/<video> send these to probe/seek) are
  // excluded entirely: the Cache API keys by URL, not by Range header, so a
  // cached whole-file 200 and a partial 206 would collide under the same
  // key — whichever gets cached first would wrongly get served for both
  // kinds of request later. Simplest safe fix is to never involve the cache
  // for a ranged request; the route handler itself sets a long-lived
  // Cache-Control, so the browser's own HTTP cache still avoids re-fetching.
  if (event.request.url.includes('/api/media/')) {
    if (event.request.headers.has('range')) {
      event.respondWith(fetch(event.request));
      return;
    }
    event.respondWith(
      caches.open(MEDIA_CACHE_NAME).then(async (cache) => {
        const cached = await cache.match(event.request);
        if (cached) return cached;
        const response = await fetch(event.request);
        if (response.ok) cache.put(event.request, response.clone());
        return response;
      })
    );
    return;
  }

  // Cache-first, write-through on a successful fetch, with a network-failure
  // fallback (in priority order: exact URL, id-normalized shell key, cached
  // app shell for a navigation). Previously this only ever read from the
  // cache — nothing populated it (APP_SHELL precaches just '/' and
  // '/manifest.json' at install time), so Next's fingerprinted JS/CSS
  // bundles (_next/static/...) were fetched live on literally every visit
  // and never available offline, even after having been fetched
  // successfully many times before. Safe to cache broadly the same way
  // media is above: Next.js fingerprints these URLs per build (the hash is
  // in the filename), so a given URL's content is immutable — a stale
  // *previous* build's chunks just become dead weight once a new deploy's
  // HTML stops referencing their (now different) hashed filenames, not a
  // source of serving outdated code under a live URL.
  event.respondWith(
    (async () => {
      const cached = await caches.match(event.request);
      if (cached) return cached;

      const shellKey = findShellKey(event.request);
      try {
        const response = await fetch(event.request);
        if (response.ok && event.request.method === 'GET') {
          const cache = await caches.open(CACHE_NAME);
          cache.put(event.request, response.clone());
          if (shellKey) cache.put(shellKey, response.clone());
        }
        return response;
      } catch (err) {
        const shell = shellKey && (await caches.match(shellKey));
        if (shell) return shell;
        if (event.request.mode === 'navigate') {
          const appShell = await caches.match('/');
          if (appShell) return appShell;
        }
        throw err;
      }
    })()
  );
});
