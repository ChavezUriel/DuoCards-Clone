/* Heron service worker.
 * Strategy:
 *  - App shell (navigations): network-first, fall back to the cached shell so
 *    the installed PWA opens offline.
 *  - Same-origin static assets (Vite's hashed JS/CSS/icons): stale-while-revalidate.
 *  - Everything cross-origin (Supabase Auth/RPC, Google Fonts CSS) is left to the
 *    network — we never cache auth/data responses.
 * Bump CACHE_VERSION to force old caches out on the next activation.
 */
const CACHE_VERSION = 'heron-v1';
const SHELL_CACHE = `${CACHE_VERSION}-shell`;
const ASSET_CACHE = `${CACHE_VERSION}-assets`;
const SHELL_URL = '/index.html';

// Minimal precache so the very first offline launch has something to render.
const PRECACHE = ['/', SHELL_URL, '/manifest.webmanifest', '/icons/icon-192.png'];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(SHELL_CACHE)
      .then((cache) => cache.addAll(PRECACHE).catch(() => undefined))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(
          keys
            .filter((key) => !key.startsWith(CACHE_VERSION))
            .map((key) => caches.delete(key))
        )
      )
      .then(() => self.clients.claim())
  );
});

// Let the page tell a waiting worker to take over immediately.
self.addEventListener('message', (event) => {
  if (event.data === 'SKIP_WAITING') self.skipWaiting();
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  const sameOrigin = url.origin === self.location.origin;

  // App-shell navigations: network-first with an offline fallback to the shell.
  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request)
        .then((response) => {
          const copy = response.clone();
          caches.open(SHELL_CACHE).then((cache) => cache.put(SHELL_URL, copy));
          return response;
        })
        .catch(() =>
          caches
            .match(SHELL_URL)
            .then((cached) => cached || caches.match('/'))
        )
    );
    return;
  }

  // Only manage our own static assets; leave cross-origin (Supabase, fonts) alone.
  if (!sameOrigin) return;

  event.respondWith(
    caches.open(ASSET_CACHE).then((cache) =>
      cache.match(request).then((cached) => {
        const network = fetch(request)
          .then((response) => {
            if (response && response.status === 200 && response.type === 'basic') {
              cache.put(request, response.clone());
            }
            return response;
          })
          .catch(() => cached);
        return cached || network;
      })
    )
  );
});
