
const CACHE_NAME = "medcbt-shell-v4";

const APP_FILES = [
  "./index.html",
  "./manifest.webmanifest",
  "./apple-touch-icon.png",
  "./icon-192.png",
  "./icon-512.png"
];

const INDEX_URL = new URL("./index.html", self.registration.scope).href;
const NETWORK_TIMEOUT_MS = 4000;

// 1. INSTALLATION
self.addEventListener("install", event => {
  event.waitUntil(
    caches.open(CACHE_NAME).then(cache =>
      Promise.all(
        APP_FILES.map(file => {
          const url = new URL(file, self.registration.scope).href;

          return cache.add(
            new Request(url, { cache: "reload" })
          ).catch(error => {
            console.warn("MedCBT: could not cache", file, error);
          });
        })
      )
    )
  );
});

// 2. ACTIVATION
self.addEventListener("activate", event => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys();

      await Promise.all(
        keys
          .filter(key =>
            key.startsWith("medcbt-shell-") &&
            key !== CACHE_NAME
          )
          .map(key => caches.delete(key))
      );

      // Allow the newly activated worker to control open pages.
      await self.clients.claim();
    })()
  );
});

// 3. UPDATE MESSAGE
self.addEventListener("message", event => {
  if (event.data && event.data.type === "SKIP_WAITING") {
    self.skipWaiting();
  }
});

// 4. FETCH STRATEGY
self.addEventListener("fetch", event => {
  const request = event.request;

  if (request.method !== "GET") return;

  const url = new URL(request.url);

  // Leave external requests untouched.
  if (url.origin !== self.location.origin) return;

  event.respondWith((async () => {
    const cache = await caches.open(CACHE_NAME);

    async function getCachedResponse() {
      const cached = await cache.match(request);

      if (cached) return cached;

      if (request.mode === "navigate") {
        return await cache.match(INDEX_URL);
      }

      return undefined;
    }

    const controller = new AbortController();
    let timedOut = false;

    const timeout = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, NETWORK_TIMEOUT_MS);

    try {
      const response = await fetch(request, {
        signal: controller.signal,
        cache: "no-cache"
      });

      clearTimeout(timeout);

      // Use saved content when the server is temporarily unavailable.
      if (
        response &&
        (response.status >= 500 || response.status === 429)
      ) {
        const saved = await getCachedResponse();
        if (saved) return saved;

        return response;
      }

      // Offline fallback for missing navigation pages.
      if (
        response &&
        response.status === 404 &&
        request.mode === "navigate"
      ) {
        const saved = await getCachedResponse();
        if (saved) return saved;

        return response;
      }

      // Save successful same-origin responses.
      if (
        response &&
        response.status === 200 &&
        response.type === "basic" &&
        !(response.headers.get("Cache-Control") || "")
          .toLowerCase()
          .includes("no-store")
      ) {
        const copy1 = response.clone();
        const copy2 =
          request.mode === "navigate"
            ? response.clone()
            : null;

        event.waitUntil((async () => {
          try {
            await cache.put(request, copy1);

            if (copy2) {
              await cache.put(INDEX_URL, copy2);
            }
          } catch (error) {
            console.warn(
              "MedCBT: cache update failed",
              error
            );
          }
        })());
      }

      return response;

    } catch (error) {
      clearTimeout(timeout);

      const saved = await getCachedResponse();
      if (saved) return saved;

      return new Response(
        timedOut
          ? "MedCBT could not connect within 4 seconds. Please check your internet connection."
          : "MedCBT is offline and this resource is not saved yet.",
        {
          status: 503,
          headers: {
            "Content-Type": "text/plain; charset=utf-8"
          }
        }
      );
    }
  })());
});
