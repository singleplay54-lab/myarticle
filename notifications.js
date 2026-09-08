/* =========================
   GYANTECH PUSH NOTIFICATIONS
========================= */

(function(){

  "use strict";


  const BUTTON_ID =
    "enableNotificationsBtn";


  function createButton(){

    if(
      document.getElementById(
        BUTTON_ID
      )
    ){

      return;

    }


    const button =
      document.createElement(
        "button"
      );


    button.id =
      BUTTON_ID;


    button.type =
      "button";


    button.textContent =
      "🔔 Enable Notifications";


    button.style.cssText = `

      position:fixed;

      right:20px;

      bottom:90px;

      z-index:9999;

      border:0;

      border-radius:14px;

      padding:13px 18px;

      background:#0f172a;

      color:white;

      font-size:14px;

      font-weight:700;

      cursor:pointer;

      box-shadow:
        0 8px 25px
        rgba(0,0,0,.18);

    `;


    button.addEventListener(
      "click",
      enableNotifications
    );


    document.body.appendChild(
      button
    );

  }


  async function enableNotifications(){

    const button =
      document.getElementById(
        BUTTON_ID
      );


    try{

      if(
        !("Notification" in window)
      ){

        alert(
          "This browser does not support notifications."
        );

        return;

      }


      if(
        !("serviceWorker" in navigator)
      ){

        alert(
          "Service Worker is not supported."
        );

        return;

      }


      if(
        !window.isSecureContext
      ){

        alert(
          "Notifications require HTTPS."
        );

        return;

      }


      button.disabled =
        true;


      button.textContent =
        "⏳ Enabling...";


      /* =========================
         PERMISSION
      ========================= */

      let permission =
        Notification.permission;


      if(
        permission === "default"
      ){

        permission =
          await Notification.requestPermission();

      }


      if(
        permission !== "granted"
      ){

        button.disabled =
          false;

        button.textContent =
          "🔔 Enable Notifications";

        alert(
          "Notification permission was not granted."
        );

        return;

      }


      /* =========================
         SERVICE WORKER
      ========================= */

      const registration =
        await navigator.serviceWorker.ready;


      /* =========================
         GET VAPID PUBLIC KEY
      ========================= */

      const keyResponse =
        await fetch(
          "/api/push/public-key",
          {
            cache:"no-store"
          }
        );


      if(
        !keyResponse.ok
      ){

        throw new Error(
          "Push notifications are not configured on the server."
        );

      }


      const keyData =
        await keyResponse.json();


      if(
        !keyData.publicKey
      ){

        throw new Error(
          "VAPID public key is missing."
        );

      }


      /* =========================
         CONVERT PUBLIC KEY
      ========================= */

      const applicationServerKey =
        urlBase64ToUint8Array(
          keyData.publicKey
        );


      /* =========================
         CREATE SUBSCRIPTION
      ========================= */

      let subscription =
        await registration.pushManager
          .getSubscription();


      if(!subscription){

        subscription =
          await registration.pushManager
            .subscribe({

              userVisibleOnly:true,

              applicationServerKey

            });

      }


      /* =========================
         SEND TO SERVER
      ========================= */

      const response =
        await fetch(
          "/api/push/subscribe",
          {

            method:"POST",

            headers:{
              "Content-Type":
                "application/json"
            },

            body:
              JSON.stringify(
                subscription
              )

          }
        );


      const result =
        await response
          .json()
          .catch(
            () => ({})
          );


      if(
        !response.ok
      ){

        throw new Error(
          result.error ||
          "Could not save notification subscription."
        );

      }


      button.textContent =
        "✅ Notifications Enabled";


      button.disabled =
        true;


      button.style.background =
        "#16a34a";


    }catch(error){

      console.error(
        "Push notification error:",
        error
      );


      button.disabled =
        false;


      button.textContent =
        "🔔 Enable Notifications";


      alert(
        error.message ||
        "Could not enable notifications."
      );

    }

  }


  /* =========================
     UNSUBSCRIBE
  ========================= */

  async function disableNotifications(){

    try{

      const registration =
        await navigator.serviceWorker.ready;


      const subscription =
        await registration.pushManager
          .getSubscription();


      if(!subscription){

        return;

      }


      await fetch(
        "/api/push/unsubscribe",
        {

          method:"POST",

          headers:{
            "Content-Type":
              "application/json"
          },

          body:
            JSON.stringify({
              endpoint:
                subscription.endpoint
            })

        }
      );


      await subscription.unsubscribe();


    }catch(error){

      console.error(
        "Push unsubscribe error:",
        error
      );

    }

  }


  /* =========================
     BASE64 → UINT8ARRAY
  ========================= */

  function urlBase64ToUint8Array(
    base64String
  ){

    const padding =
      "=".repeat(
        (4 -
          base64String.length % 4
        ) % 4
      );


    const base64 =
      (
        base64String +
        padding
      )
      .replace(
        /-/g,
        "+"
      )
      .replace(
        /_/g,
        "/"
      );


    const rawData =
      window.atob(
        base64
      );


    const outputArray =
      new Uint8Array(
        rawData.length
      );


    for(
      let i=0;
      i<rawData.length;
      ++i
    ){

      outputArray[i] =
        rawData.charCodeAt(i);

    }


    return outputArray;

  }


  /* =========================
     SERVICE WORKER REGISTER
  ========================= */

  async function registerServiceWorker(){

    if(
      !("serviceWorker" in navigator)
    ){

      return;

    }


    try{

      await navigator.serviceWorker
        .register(
          "/sw.js"
        );


      console.log(
        "GyanTech Service Worker registered."
      );


      createButton();


    }catch(error){

      console.error(
        "Service Worker registration failed:",
        error
      );

    }

  }


  /* =========================
     START
  ========================= */

  if(
    document.readyState ===
    "loading"
  ){

    document.addEventListener(
      "DOMContentLoaded",
      registerServiceWorker
    );

  }else{

    registerServiceWorker();

  }


  /* =========================
     GLOBAL FUNCTIONS
  ========================= */

  window.enableGyanTechNotifications =
    enableNotifications;


  window.disableGyanTechNotifications =
    disableNotifications;

})();
