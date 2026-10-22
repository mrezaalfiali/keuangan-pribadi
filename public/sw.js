// Nexora Service Worker for PWA
const CACHE_NAME = "nexora-cache-v1";
const OFFLINE_FALLBACK = [
  "/favicon.ico",
  "/icons/icon-192x192.png",
  "/icons/icon-512x512.png"
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      return cache.addAll(OFFLINE_FALLBACK);
    }).then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) => {
      return Promise.all(
        keys.map((key) => {
          if (key !== CACHE_NAME) {
            return caches.delete(key);
          }
        })
      );
    }).then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (event) => {
  const { request } = event;

  // Only handle GET requests
  if (request.method !== "GET") {
    return;
  }

  const url = new URL(request.url);

  // Bypass API, Supabase, and auth requests
  if (
    url.pathname.startsWith("/api") ||
    url.pathname.startsWith("/auth") ||
    url.hostname.includes("supabase.co")
  ) {
    return;
  }

  // Network-first strategy with cache fallback
  event.respondWith(
    fetch(request)
      .then((networkResponse) => {
        // Cache static assets (fonts, images, icons, css, js)
        if (
          networkResponse.status === 200 &&
          (url.pathname.startsWith("/_next/static/") ||
            url.pathname.startsWith("/icons/") ||
            url.pathname.endsWith(".png") ||
            url.pathname.endsWith(".ico") ||
            url.pathname.endsWith(".svg"))
        ) {
          const responseToCache = networkResponse.clone();
          caches.open(CACHE_NAME).then((cache) => {
            cache.put(request, responseToCache);
          });
        }
        return networkResponse;
      })
      .catch(() => {
        // If offline and request is cached, serve from cache
        return caches.match(request);
      })
  );
});

