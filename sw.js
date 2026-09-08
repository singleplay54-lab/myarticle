const CACHE_NAME = "gyantech-v1";

const STATIC_ASSETS = [
  "/",
  "/index.html",
  "/articles.html",
  "/article.html",
  "/offline.html",
  "/manifest.json",
  "/icon-192.png",
  "/icon-512.png"
];

// Install
self.addEventListener("install", event => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then(cache => cache.addAll(STATIC_ASSETS))
      .then(() => self.skipWaiting())
  );
});

// Activate
self.addEventListener("activate", event => {
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(
        keys
          .filter(key => key !== CACHE_NAME)
          .map(key => caches.delete(key))
      )
    ).then(() => self.clients.claim())
  );
});

// Fetch
self.addEventListener("fetch", event => {
  const request = event.request;

  // Sirf GET requests handle karo
  if (request.method !== "GET") return;

  event.respondWith(
    fetch(request)
      .then(response => {
        // Successful response ko cache karo
        if (response && response.status === 200) {
          const copy = response.clone();

          caches.open(CACHE_NAME).then(cache => {
            cache.put(request, copy);
          });
        }

        return response;
      })
      .catch(() => {
        // Internet nahi hai → cache se response
        return caches.match(request)
          .then(cachedResponse => {
            if (cachedResponse) {
              return cachedResponse;
            }

            // Page request hai to offline page
            if (request.mode === "navigate") {
              return caches.match("/offline.html");
            }

            return new Response("Offline", {
              status: 503,
              headers: {
                "Content-Type": "text/plain"
              }
            });
          });
      })
  );
});
