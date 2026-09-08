const CACHE_NAME = "gyantech-v2";

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


/* =========================
   INSTALL
========================= */

self.addEventListener("install", event => {

  event.waitUntil(

    caches.open(CACHE_NAME)

      .then(cache =>
        cache.addAll(STATIC_ASSETS)
      )

      .then(() =>
        self.skipWaiting()
      )

  );

});


/* =========================
   ACTIVATE
========================= */

self.addEventListener("activate", event => {

  event.waitUntil(

    caches.keys()

      .then(keys =>

        Promise.all(

          keys

            .filter(key =>
              key !== CACHE_NAME
            )

            .map(key =>
              caches.delete(key)
            )

        )

      )

      .then(() =>
        self.clients.claim()
      )

  );

});


/* =========================
   FETCH / OFFLINE
========================= */

self.addEventListener("fetch", event => {

  const request = event.request;

  if(request.method !== "GET"){
    return;
  }


  event.respondWith(

    fetch(request)

      .then(response => {

        if(
          response &&
          response.status === 200
        ){

          const copy =
            response.clone();

          caches.open(CACHE_NAME)

            .then(cache => {

              cache.put(
                request,
                copy
              );

            })

            .catch(() => {});

        }

        return response;

      })

      .catch(() => {

        return caches.match(request)

          .then(cachedResponse => {

            if(cachedResponse){

              return cachedResponse;

            }


            if(
              request.mode === "navigate"
            ){

              return caches.match(
                "/offline.html"
              );

            }


            return new Response(
              "Offline",
              {
                status:503,
                headers:{
                  "Content-Type":
                    "text/plain"
                }
              }
            );

          });

      })

  );

});


/* =========================
   PUSH NOTIFICATION
========================= */

self.addEventListener(
  "push",
  event => {

    let data = {};

    try{

      data =
        event.data
          ? event.data.json()
          : {};

    }catch{

      data = {};

    }


    const title =
      data.title ||
      "GyanTech Blog";


    const options = {

      body:
        data.body ||
        "New article published.",

      icon:
        data.icon ||
        "/icon-192.png",

      badge:
        data.badge ||
        "/icon-192.png",

      data:{
        url:
          data.url ||
          "/"
      },

      vibrate:[
        200,
        100,
        200
      ]

    };


    event.waitUntil(

      self.registration
        .showNotification(
          title,
          options
        )

    );

  }
);


/* =========================
   NOTIFICATION CLICK
========================= */

self.addEventListener(
  "notificationclick",
  event => {

    event.notification.close();


    const url =
      event.notification
        .data?.url ||
      "/";


    event.waitUntil(

      clients.matchAll({

        type:"window",

        includeUncontrolled:true

      })

      .then(list => {

        for(
          const client
          of list
        ){

          if(
            "focus" in client
          ){

            if(
              "navigate" in client
            ){

              client.navigate(url);

            }

            return client.focus();

          }

        }


        return clients.openWindow(
          url
        );

      })

    );

  }
);
