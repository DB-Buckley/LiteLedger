// ============================================================================
// Sales routes adapters
// Looks for a generic sales renderer and exposes per-type renderers.
// Accepts any of: renderSalesList(kind), renderSalesDocuments(kind), renderSales(kind)

(function () {
  function callSales(kind) {
    if (typeof renderSalesList === "function") return renderSalesList(kind);
    if (typeof renderSalesDocuments === "function") return renderSalesDocuments(kind);
    if (typeof renderSales === "function") return renderSales(kind);
    throw new Error("Sales module not loaded: expected renderSalesList/renderSalesDocuments");
  }

  window.renderQuotes = () => callSales("QUOTE");
  window.renderOrders  = () => callSales("ORDER");
  window.renderInvoices= () => callSales("INVOICE");
})();
