// sw.js
const CACHE = "ll-shell-v3";
const CORE_ASSETS = [
  "./",
  "./index.html",
  "./styles.css",
  "./manifest.webmanifest",
  "./favicon.svg",
  // Optional: add icons if they exist
  "./icons/icon-192.png",
  "./icons/icon-512.png",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE).then((c) => c.addAll(CORE_ASSETS)).catch(() => {})
  );
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys();
      await Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)));
      await self.clients.claim();
    })()
  );
});

// Support SKIP_WAITING from the app (98-pwa.js posts this)
self.addEventListener("message", (event) => {
  if (event?.data?.type === "SKIP_WAITING") self.skipWaiting();
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  const url = new URL(req.url);

  // Only same-origin GET requests are cached
  if (req.method !== "GET" || url.origin !== location.origin) return;

  // SPA navigation fallback: if requesting the app shell (HTML), serve index.html
  const isHTML =
    req.headers.get("accept")?.includes("text/html") &&
    (url.pathname === "/" || url.pathname.endsWith("/") || !url.pathname.includes("."));

  if (isHTML) {
    event.respondWith(
      (async () => {
        try {
          // Try network first for fresh HTML
          const fresh = await fetch(req);
          // Update cache asynchronously
          const cache = await caches.open(CACHE);
          cache.put("./index.html", fresh.clone());
          return fresh;
        } catch {
          // Offline: return cached shell
          const cached = await caches.match("./index.html");
          return cached || new Response("Offline", { status: 503 });
        }
      })()
    );
    return;
  }

  // Static assets: stale-while-revalidate
  event.respondWith(
    (async () => {
      const cache = await caches.open(CACHE);
      const cached = await cache.match(req);
      const networkFetch = fetch(req)
        .then((resp) => {
          // Only cache successful, basic/opaque same-origin responses
          if (resp && (resp.ok || resp.type === "opaque")) {
            cache.put(req, resp.clone()).catch(() => {});
          }
          return resp;
        })
        .catch(() => undefined);

      return cached || (await networkFetch) || new Response("Offline", { status: 503 });
    })()
  );
});
