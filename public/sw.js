// Minimal service worker: caches the app shell so the PWA opens offline.
// This is intentionally simple for v1 — no runtime caching strategy tuning yet.

// Bumped to v9: the fetch handler now bails out for any cross-origin
// request before it can reach the caching logic at all — v7/v8 cached
// EVERY successful same-page GET indiscriminately, which included the
// Supabase client's own API calls (e.g. pullAndReplay's GET to
// /rest/v1/events — a fetch event fires for every request a controlled
// page makes, not just same-origin ones). Once cached, the cache-first
// check above would keep serving that first-ever response forever, so a
// sync pull would silently stop ever seeing new events from other devices
// — while fully online. Bumping the cache name also purges any such
// already-poisoned entries from v7/v8 installs.
const CACHE_NAME = 'flashcard-app-v9';
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
  // Only ever intercept same-origin http(s) requests. A service worker's
  // fetch event fires for every request a controlled page makes — not just
  // same-origin ones — so this single guard rules out two different
  // problems at once: extension content-script requests (chrome-extension://,
  // moz-extension://), whose scheme makes cache.put() throw synchronously,
  // and any cross-origin API call (Supabase, etc.), which must always hit
  // the network live rather than risk being cache-first'd from a stale
  // snapshot — see the CACHE_NAME comment above for what that broke.
  const requestUrl = new URL(event.request.url);
  if (requestUrl.origin !== self.location.origin) return;

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

  // Write-through caching helper shared by both strategies below: on a
  // successful GET, cache under the exact URL and (if this is a dynamic
  // /review/<deckId>[...] route) also under its id-normalized shell key.
  async function cacheResponse(response) {
    if (!(response.ok && event.request.method === 'GET')) return;
    const cache = await caches.open(CACHE_NAME);
    cache.put(event.request, response.clone());
    const shellKey = findShellKey(event.request);
    if (shellKey) cache.put(shellKey, response.clone());
  }

  async function fallbackResponse() {
    const shellKey = findShellKey(event.request);
    const shell = shellKey && (await caches.match(shellKey));
    if (shell) return shell;
    if (event.request.mode === 'navigate') {
      const appShell = await caches.match('/');
      if (appShell) return appShell;
    }
    return null;
  }

  // Top-level navigations (typing a URL, reopening a tab, following a link
  // as a full page load — as opposed to Next's client-side RSC data
  // fetches) stay network-first, matching this app's pre-existing behavior
  // before offline-routing support was added here: a document can change
  // and the server's middleware needs to actually run on every normal
  // online visit (e.g. to refresh the session cookie), so unlike static
  // assets a navigation must not silently start being served from a
  // months-old cache entry just because one was written once. The cache is
  // still populated and still used as the offline fallback, in both
  // directions — the shell-key fallback for a page pattern only tested
  // offline is what fixed the original "can't route to /review/[id] while
  // offline" bug, and that fallback path is unaffected by this being
  // network-first for the happy path.
  if (event.request.mode === 'navigate') {
    event.respondWith(
      (async () => {
        try {
          const response = await fetch(event.request);
          await cacheResponse(response);
          return response;
        } catch (err) {
          const fallback = await fallbackResponse();
          if (fallback) return fallback;
          throw err;
        }
      })()
    );
    return;
  }

  // Everything else (Next's client-navigation RSC data fetches, fingerprinted
  // JS/CSS bundles, etc.) stays cache-first, write-through on a successful
  // fetch. Previously this only ever read from the cache — nothing populated
  // it (APP_SHELL precaches just '/' and '/manifest.json' at install time),
  // so Next's fingerprinted bundles (_next/static/...) were fetched live on
  // literally every visit and never available offline, even after having
  // been fetched successfully many times before. Safe here specifically
  // because Next fingerprints these URLs per build (the hash is in the
  // filename) — a given URL's content is immutable, so a stale *previous*
  // build's chunks just become dead weight once a new deploy's HTML stops
  // referencing their (now different) hashed filenames, not a source of
  // serving outdated code under a live URL. RSC data fetches aren't
  // fingerprinted the same way, but their content is driven entirely by
  // client-side IndexedDB state (see findShellKey's comment), so serving a
  // cached one is never actually wrong, just occasionally a version behind.
  event.respondWith(
    (async () => {
      const cached = await caches.match(event.request);
      if (cached) return cached;
      try {
        const response = await fetch(event.request);
        await cacheResponse(response);
        return response;
      } catch (err) {
        const fallback = await fallbackResponse();
        if (fallback) return fallback;
        throw err;
      }
    })()
  );
});
