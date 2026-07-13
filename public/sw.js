// Minimal service worker: caches the app shell so the PWA opens offline.
// This is intentionally simple for v1 — no runtime caching strategy tuning yet.

// Bumped to v7: the generic fetch handler below now writes successful
// responses through to this cache (previously only /api/media/ did), so a
// cold offline launch can actually serve the JS/CSS it already fetched
// once while online instead of failing outright — see that handler's own
// comment.
const CACHE_NAME = 'flashcard-app-v7';
// Separate from CACHE_NAME so bumping the app-shell version above doesn't
// also evict previously-downloaded images/audio (see the activate handler).
// Bumped to v2 to purge any audio responses cached under the old
// range-oblivious fetch handler (see the fetch handler's comment above).
const MEDIA_CACHE_NAME = 'flashcard-media-v2';
const APP_SHELL = ['/', '/manifest.json'];

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
  // Network-first for navigation requests, falling back to cache when offline.
  if (event.request.mode === 'navigate') {
    event.respondWith(
      fetch(event.request).catch(() => caches.match('/'))
    );
    return;
  }

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

  // Cache-first, write-through on a successful fetch. Previously this only
  // ever read from the cache — nothing populated it (APP_SHELL precaches
  // just '/' and '/manifest.json' at install time), so Next's fingerprinted
  // JS/CSS bundles (_next/static/...) were fetched live on literally every
  // visit and never available offline, even after having been fetched
  // successfully many times before. Safe to cache broadly the same way
  // media is above: Next.js fingerprints these URLs per build (the hash is
  // in the filename), so a given URL's content is immutable — a stale
  // *previous* build's chunks just become dead weight once a new deploy's
  // HTML stops referencing their (now different) hashed filenames, not a
  // source of serving outdated code under a live URL.
  event.respondWith(
    caches.match(event.request).then(async (cached) => {
      if (cached) return cached;
      const response = await fetch(event.request);
      if (response.ok && event.request.method === 'GET') {
        const cache = await caches.open(CACHE_NAME);
        cache.put(event.request, response.clone());
      }
      return response;
    })
  );
});
