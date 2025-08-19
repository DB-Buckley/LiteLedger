// ============================================================================
// 52-sales-routes.js  —  Minimal delegators to the new Sales module
// Purpose: keep legacy entry points but route them to the modern API.
// This file intentionally contains NO logic beyond delegation.
// ============================================================================

(function () {
  // Small helper: call fn if it exists
  function call(fn, ...args) {
    if (typeof fn === "function") return fn(...args);
    // If the sales module hasn't loaded yet, fail gracefully into invoices.
    console.warn("[sales-routes] Missing renderer; loading invoices as fallback.");
    return (typeof window.renderSales === "function")
      ? window.renderSales("INVOICE", { invoiceView: "active" })
      : void 0;
  }

  // Primary entry points used by the router
  if (typeof window.renderQuotes !== "function") {
    window.renderQuotes = () => call(window.renderSales, "QUOTE", { history: false });
  }
  if (typeof window.renderQuotesHistory !== "function") {
    window.renderQuotesHistory = () => call(window.renderSales, "QUOTE", { history: true });
  }
  if (typeof window.renderOrders !== "function") {
    window.renderOrders = () => call(window.renderSales, "ORDER", { history: false });
  }
  if (typeof window.renderOrdersHistory !== "function") {
    window.renderOrdersHistory = () => call(window.renderSales, "ORDER", { history: true });
  }
  if (typeof window.renderInvoices !== "function") {
    window.renderInvoices = () => call(window.renderSales, "INVOICE", { invoiceView: "active" });
  }
  if (typeof window.renderInvoicesProcessed !== "function") {
    window.renderInvoicesProcessed = () => call(window.renderSales, "INVOICE", { invoiceView: "processed" });
  }
  // Credit Notes is a separate screen in the new module — delegate directly if present.
  if (typeof window.renderCreditNotes !== "function") {
    window.renderCreditNotes = () =>
      (typeof window.renderCreditNotes === "function")
        ? window.renderCreditNotes()
        : call(window.renderSalesList, "credit-notes"); // last-ditch fallback if a compat shim exists
  }

  // Legacy compat (some old code calls these). We normalize the input and forward.
  if (typeof window.renderSalesList !== "function") {
    window.renderSalesList = function renderSalesList(section) {
      const key = (typeof section === "string" ? section : (section?.section || section?.path || ""))
        .toString().toLowerCase();

      if (key === "quotes" || /^quotes(\/|$)/.test(key)) return call(window.renderSales, "QUOTE", { history: false });
      if (key === "quotes-history") return call(window.renderSales, "QUOTE", { history: true });

      if (key === "orders" || /^orders(\/|$)/.test(key)) return call(window.renderSales, "ORDER", { history: false });
      if (key === "orders-history") return call(window.renderSales, "ORDER", { history: true });

      if (key === "invoices-processed") return call(window.renderSales, "INVOICE", { invoiceView: "processed" });
      if (key === "credit-notes" || key === "invoices-credited") {
        return (typeof window.renderCreditNotes === "function")
          ? window.renderCreditNotes()
          : call(window.renderSales, "INVOICE", { invoiceView: "processed" }); // safe fallback
      }

      // Default → active invoices
      return call(window.renderSales, "INVOICE", { invoiceView: "active" });
    };
  }

  if (typeof window.renderSalesDocuments !== "function") {
    window.renderSalesDocuments = function renderSalesDocuments(opts = {}) {
      const type = String(opts.type || opts.kind || "INVOICE").toUpperCase();
      const view = String(opts.view || "").toLowerCase();
      const history = !!opts.history;

      if (type === "QUOTE") return call(window.renderSales, "QUOTE", { history });
      if (type === "ORDER") return call(window.renderSales, "ORDER", { history });
      return call(window.renderSales, "INVOICE", { invoiceView: (view === "processed" ? "processed" : "active") });
    };
  }

  console.debug("[sales-routes] Delegators installed.");
})();
