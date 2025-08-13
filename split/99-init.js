// ============================================================================
// App Init
// Depends on: 01-db.js, 02-helpers.js, 03-bootstrap.js, 95-router.js, 98-pwa.js
// Exposes: window.startApp()

(function () {
  function ready(fn) {
    if (document.readyState === "loading") {
      document.addEventListener("DOMContentLoaded", fn, { once: true });
    } else {
      fn();
    }
  }

  // Minimal guard: ensure $ / $$ exist even if helpers didn't load for some reason
  if (typeof window.$ !== "function") window.$ = (sel) => document.querySelector(sel);
  if (typeof window.$$ !== "function") window.$$ = (sel) => Array.from(document.querySelectorAll(sel));

  // ------------------------- Header actions & helpers -------------------------

  async function quickAdd() {
    const type = (prompt("Quick add: item / customer / supplier", "item") || "")
      .trim().toLowerCase();
    if (!type) return;

    if (type.startsWith("i")) {
      const name = prompt("Item name?");
      if (!name) return;
      const sell = Number(prompt("Sell price (ex VAT)?", "0")) || 0;
      const rec = {
        id: randId(),
        sku: "",
        barcode: "",
        name,
        description: "",
        category: "",
        unit: "ea",
        costAvg: 0,
        costMethod: "AVG",
        sellPrice: sell,
        vatApplies: true,
        reOrderLevel: 0,
        openingQty: 0,
        warehouseId: "WH1",
        nonStock: false,
      };
      await add("items", rec);
      toast("Item added", "success");
      goto("/items");
      return;
    }

    if (type.startsWith("c")) {
      const name = prompt("Customer name?");
      if (!name) return;
      const rec = {
        id: randId(),
        code: "",
        name,
        contact: { person: "", phone: "", email: "" },
        termsDays: 30,
        creditLimit: 0,
        taxExempt: false,
        openingBalance: 0,
        archived: false,
        createdAt: nowISO(),
      };
      await add("customers", rec);
      toast("Customer added", "success");
      goto("/customers");
      return;
    }

    if (type.startsWith("s")) {
      const name = prompt("Supplier name?");
      if (!name) return;
      const rec = {
        id: randId(),
        code: "",
        name,
        contact: { person: "", phone: "", email: "" },
        termsDays: 30,
        notes: "",
        archived: false,
      };
      await add("suppliers", rec);
      toast("Supplier added", "success");
      goto("/suppliers");
      return;
    }

    toast("Unknown type. Use item / customer / supplier", "warn");
  }

  function setupInstallButton() {
    const btn = document.getElementById("btnInstall");

    function onPrompt(e) {
      e?.preventDefault?.();
      window.__deferredInstallPrompt = e;
      if (btn) btn.hidden = false;
    }

    window.addEventListener("beforeinstallprompt", onPrompt);
    window.addEventListener("appinstalled", () => {
      window.__deferredInstallPrompt = null;
      if (btn) btn.hidden = true;
      toast("App installed 🎉", "success");
    });

    if (btn) {
      btn.onclick = async () => {
        const e = window.__deferredInstallPrompt;
        if (!e) return toast("Install not available", "warn");
        try { await e.prompt(); await e.userChoice; } catch {}
      };
    }
  }

  function wireHeaderButtons() {
    const q = (id) => document.getElementById(id);

    const customize = q("btnCustomize");
    if (customize) customize.onclick = () => goto("/layouts");

    const addQuick = q("btnAddQuick");
    if (addQuick) addQuick.onclick = () => quickAdd();

    const backup = q("btnBackup");
    if (backup) backup.onclick = async () => {
      try {
        const pass = prompt("Optional backup password (leave blank for unencrypted):", "") || "";
        if (typeof exportAllData !== "function") {
          toast("Opening Settings → Backup …", "info");
          goto("/settings");
          return;
        }
        const json = await exportAllData(pass);
        const blob = new Blob([json], { type: "application/json" });
        const a = document.createElement("a");
        a.href = URL.createObjectURL(blob);
        a.download = `liteledger-backup-${nowISO().slice(0,10)}.json`;
        a.click();
      } catch (e) {
        console.error(e);
        toast("Backup failed", "warn");
      }
    };

    const restore = q("btnRestore");
    if (restore) restore.onclick = async () => {
      if (typeof importAllData !== "function") {
        toast("Opening Settings → Restore …", "info");
        goto("/settings");
        return;
      }
      const inp = document.createElement("input");
      inp.type = "file";
      inp.accept = ".json,application/json";
      inp.onchange = async () => {
        const f = inp.files?.[0];
        if (!f) return;
        try {
          const txt = await f.text();
          const pass = prompt("Enter password if backup was encrypted (otherwise leave blank):", "") || "";
          await importAllData(txt, pass);
          toast("Restore complete", "success");
          location.reload();
        } catch (e) {
          console.error(e);
          toast("Restore failed", "warn");
        }
      };
      inp.click();
    };

    setupInstallButton();

    // Offline pill (single place to manage its visibility)
    const badge = document.getElementById("offlineBadge");
    const update = () => { if (badge) badge.hidden = navigator.onLine; };
    window.addEventListener("online", update);
    window.addEventListener("offline", update);
    update();
  }

  // --------------------------------- Startup ---------------------------------

  async function startApp() {
    // Basic platform checks
    if (!("indexedDB" in window)) {
      const v = $("#view");
      if (v) {
        v.innerHTML = `
          <div class="card">
            <div class="hd"><b>Unsupported Browser</b></div>
            <div class="bd">
              <p>Your browser does not support IndexedDB, which this app requires.</p>
              <p>Please try a modern browser like Chrome, Edge, Firefox, or Safari.</p>
            </div>
          </div>`;
      }
      return;
    }

    // Seed defaults (company, settings, layouts, sample data, etc.)
    try {
      await ensureBootstrap();
    } catch (e) {
      console.error("ensureBootstrap failed:", e);
      if (typeof toast === "function") toast("Startup: bootstrap failed", "warn");
    }

    // Render banner once at startup
    try {
      if (typeof mountCompanyBanner === "function") {
        await mountCompanyBanner();
      }
    } catch (e) {
      console.warn("mountCompanyBanner failed:", e);
    }

    // Register Service Worker & install prompt handling
    try {
      if (typeof registerPWA === "function") {
        await registerPWA();
      }
    } catch (e) {
      console.warn("PWA registration error:", e);
    }

    // Wire hash router and render current route
    try {
      if (typeof initRouter === "function") {
        await initRouter();
      } else {
        console.warn("initRouter() not found — rendering dashboard fallback");
        if (typeof renderDashboard === "function") await renderDashboard();
      }
    } catch (e) {
      console.error("Initial route render failed:", e);
      const v = $("#view");
      if (v) {
        v.innerHTML = `
          <div class="card">
            <div class="hd"><b>Error</b></div>
            <div class="bd">
              <div class="sub">Something went wrong while loading the app. Check the console for details.</div>
            </div>
          </div>`;
      }
    }

    // Wire header buttons & offline indicator
    try { wireHeaderButtons(); } catch (e) { console.warn(e); }

    // Global safety nets
    window.addEventListener("unhandledrejection", (ev) => {
      console.error("Unhandled promise rejection:", ev.reason);
      if (typeof toast === "function") toast("Unexpected error occurred", "warn");
    });
    window.addEventListener("error", (ev) => {
      // Avoid double-reporting same message repeatedly
      if (!window.__errOnce) window.__errOnce = new Set();
      const key = String(ev.message || "") + "@" + String(ev.filename || "");
      if (!window.__errOnce.has(key)) {
        window.__errOnce.add(key);
        console.error("Unhandled error:", ev.message, ev.filename, ev.lineno, ev.colno, ev.error);
      }
    });
  }

  // Expose & autostart
  window.startApp = startApp;
  ready(startApp);
})();
