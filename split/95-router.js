// ============================================================================
// Router (hash-based)
// Depends on: page renderers exposed on window, e.g. window.renderDashboard()
// Supports lazy-loading split bundles when a route fn isn't present yet.
// ============================================================================

(function () {
  // Route map: path -> window function name
  const ROUTES = {
    "/": "renderDashboard",
    "/dashboard": "renderDashboard",

    "/customers": "renderCustomers",
    "/customers-archived": "renderCustomersArchived",

    "/suppliers": "renderSuppliers",
    "/suppliers-archived": "renderSuppliersArchived",

    "/items": "renderItems",

    // Purchases
    "/purchases": "renderPurchases",
    "/purchases-processed": "renderPurchasesProcessed",
    "/supplier-payments": "renderSupplierPayments",

    // Sales
    "/quotes": "renderQuotes",
    "/quotes-history": "renderQuotesHistory",
    "/orders": "renderOrders",
    "/orders-history": "renderOrdersHistory",
    "/invoices": "renderInvoices",

    "/layouts": "renderLayouts",
    "/payments": "renderPayments",
    "/settings": "renderSettings",
    "/about": "renderAbout",
  };

  // Which chunk(s) to load for a given path group (tries in order)
  const LAZY = [
    { test: /^\/(quotes|quotes-history|orders|orders-history|invoices)(\/|$)?/i,
      files: ["/split/50-sales-documents-quotes-orders-invoices.js", "/50-sales-documents-quotes-orders-invoices.js"] },

    { test: /^\/(purchases|purchases-processed|supplier-payments)(\/|$)?/i,
      files: ["/split/50-purchases.js", "/50-purchases.js"] },

    { test: /^\/(customers|customers-archived)(\/|$)?/i,
      files: ["/20-customers.js"] },

    { test: /^\/(suppliers|suppliers-archived)(\/|$)?/i,
      files: ["/20-suppliers.js"] },

    { test: /^\/items(\/|$)?/i,
      files: ["/30-items.js"] },

    { test: /^\/layouts(\/|$)?/i,
      files: ["/40-layouts.js"] },

    { test: /^\/payments(\/|$)?/i,
      files: ["/70-payments.js"] },

    { test: /^\/settings(\/|$)?/i,
      files: ["/80-settings.js"] },

    { test: /^\/about(\/|$)?/i,
      files: ["/90-about.js"] },

    { test: /^\/(dashboard|)$/i,
      files: ["/10-dashboard.js"] },
  ];

  function getPath() {
    const h = (location.hash || "").replace(/^#/, "");
    return h ? (h.startsWith("/") ? h : `/${h}`) : "/dashboard";
  }

  function loadScriptOnce(src) {
    return new Promise((resolve, reject) => {
      // Already present?
      const already = Array.from(document.scripts).some(s => s.src && s.src.endsWith(src));
      if (already) return resolve(true);
      const s = document.createElement("script");
      s.src = src;
      s.async = false; // preserve execution order
      s.onload = () => resolve(true);
      s.onerror = () => reject(new Error(`Failed to load ${src}`));
      document.head.appendChild(s);
    });
  }

  async function ensureChunkFor(path) {
    const group = LAZY.find(g => g.test.test(path));
    if (!group) return false;
    for (const f of group.files) {
      try {
        await loadScriptOnce(f);
        return true;
      } catch {
        // try next candidate
      }
    }
    return false;
  }

  async function renderRouteFromHash() {
    const path = getPath();
    const fnName = ROUTES[path] || "renderDashboard";

    try {
      let fn = window[fnName];
      if (typeof fn !== "function") {
        // Try to lazy-load a chunk for this path, then re-check
        await ensureChunkFor(path);
        fn = window[fnName];
      }

      if (typeof fn === "function") {
        await fn();
      } else {
        console.warn(`Route "${path}" -> ${fnName} not available; falling back to dashboard.`);
        await window.renderDashboard?.();
      }
    } catch (e) {
      console.error("Route render failed:", e);
      const v = document.getElementById("view");
      if (v) {
        v.innerHTML = `
          <div class="card">
            <div class="hd"><b>Error</b></div>
            <div class="bd">
              <div class="sub">Sorry, something went wrong rendering <code>${path}</code>.</div>
            </div>
          </div>`;
      }
    }

    setActiveNav(path);
  }

  function setActiveNav(path) {
    document.querySelectorAll('a[href^="#/"]').forEach((a) => {
      const ap = a.getAttribute("href").replace(/^#/, "");
      a.classList.toggle("active", ap === path);
    });
  }

  // Public helpers
  window.goto = function goto(path) {
    if (!path.startsWith("/")) path = "/" + path;
    location.hash = "#" + path;
  };

  window.initRouter = function initRouter() {
    // Intercept in-app nav clicks so they don't jump the page
    document.body.addEventListener("click", (e) => {
      const a = e.target.closest('a[href^="#/"]');
      if (!a) return;
      e.preventDefault();
      const href = a.getAttribute("href");
      if (href !== location.hash) location.hash = href;
    });

    window.addEventListener("hashchange", renderRouteFromHash);
    // Initial render
    return renderRouteFromHash();
  };
})();
