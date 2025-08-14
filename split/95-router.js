// ============================================================================
// Router (hash-based)
// Depends on: page renderers exposed on window, e.g. window.renderDashboard()
// ============================================================================

(function () {
  const ROUTES = {
    "/": "renderDashboard",
    "/dashboard": "renderDashboard",

    "/customers": "renderCustomers",
    "/customers-archived": "renderCustomersArchived",


    "/suppliers": "renderSuppliers",
    "/suppliers-archived": "renderSuppliersArchived",
    
    "/items": "renderItems",
    "/purchases": "renderPurchases",
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

  function getPath() {
    const h = (location.hash || "").replace(/^#/, "");
    return h ? (h.startsWith("/") ? h : `/${h}`) : "/dashboard";
  }

  async function renderRouteFromHash() {
    const path = getPath();
    const fnName = ROUTES[path] || "renderDashboard";
    try {
      const fn = window[fnName];
      if (typeof fn === "function") {
        await fn();
      } else {
        console.warn(`Route "${path}" -> ${fnName} not loaded yet; falling back to dashboard.`);
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
