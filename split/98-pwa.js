// ============================================================================
// PWA registration + install prompt
// Exposes: window.registerPWA()
// Uses: toast() if available

(function () {
  // Hold the deferred install prompt so Settings can trigger it
  window.__deferredInstallPrompt = null;

  // Capture install prompt for later use
  window.addEventListener("beforeinstallprompt", (e) => {
    // Some browsers require preventing the mini-infobar
    e.preventDefault?.();
    window.__deferredInstallPrompt = e;
    if (typeof toast === "function") toast("App can be installed via Settings → Install", "success");
  });

  // App installed
  window.addEventListener("appinstalled", () => {
    window.__deferredInstallPrompt = null;
    if (typeof toast === "function") toast("App installed 🎉", "success");
  });

  async function registerServiceWorker() {
    if (!("serviceWorker" in navigator)) {
      // Not supported
      return;
    }

    try {
      // Register the service worker at site root or relative path
      const reg = await navigator.serviceWorker.register("sw.js", { scope: "./" });

      // If a new worker is found, listen for its lifecycle
      reg.addEventListener("updatefound", () => {
        const sw = reg.installing;
        if (!sw) return;

        sw.addEventListener("statechange", () => {
          // When the new SW is installed:
          if (sw.state === "installed") {
            if (navigator.serviceWorker.controller) {
              // New content is available; ask it to activate immediately
              try { sw.postMessage({ type: "SKIP_WAITING" }); } catch {}
              if (typeof toast === "function") {
                toast("Update downloaded. Reloading…", "success");
              }
              // Once the new worker takes control, reload
              navigator.serviceWorker.addEventListener("controllerchange", () => {
                // Avoid multiple reloads
                if (window.__reloadingForSW) return;
                window.__reloadingForSW = true;
                location.reload();
              });
            } else {
              // First install
              if (typeof toast === "function") toast("App is ready for offline use", "success");
            }
          }
        });
      });

      // Optionally, ping for updates shortly after load
      setTimeout(() => {
        reg.update?.().catch(() => {});
      }, 3000);
    } catch (err) {
      console.error("SW registration failed:", err);
      if (typeof toast === "function") toast("Service Worker registration failed", "warn");
    }
  }

  // Public entry
  window.registerPWA = async function registerPWA() {
    await registerServiceWorker();
  };
})();
