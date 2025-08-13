// ============================================================================
// 60-pdf.js — Minimal PDF/Print for Quotes / Orders / Invoices
// No external libs. Opens a print-ready window (users can "Save as PDF").
// Exposes: downloadInvoicePDF(id?, ctx?), exportInvoicePDF, generateInvoicePDF
// ctx = { doc, lines } is optional; if missing we load from IndexedDB.
// Depends on: get, all, whereIndex, currency, calcLineTotals, nowISO
// ============================================================================

(function () {
  async function loadContext(docId, ctx) {
    // Prefer provided doc/lines (unsaved docs) otherwise fetch from DB
    const doc = ctx?.doc || (docId ? await get("docs", docId) : null);
    if (!doc) throw new Error("Document not found or not provided");

    const lines = Array.isArray(ctx?.lines)
      ? ctx.lines
      : await whereIndex("lines", "by_doc", doc.id);

    const company = (await all("company"))?.[0] || {};
    const settings = (await get("settings", "app"))?.value || {};
    const customer = doc.customerId ? (await get("customers", doc.customerId)) : null;

    // Ensure totals exist
    const totals = lines && lines.length
      ? sumDoc(lines.map(ln => ({
          qty: ln.qty,
          unitPrice: ln.unitPrice ?? ln.unitCost ?? 0,
          discountPct: ln.discountPct ?? 0,
          taxRate: ln.taxRate ?? settings.vatRate ?? 15,
        })))
      : (doc.totals || { subTotal: 0, tax: 0, grandTotal: 0 });

    return { doc, lines, company, customer, settings, totals };
  }

  function fmtDate(s) {
    if (!s) return "";
    try { return new Date(s).toISOString().slice(0,10); } catch { return String(s).slice(0,10); }
  }

  function esc(s) {
    return String(s ?? "").replace(/[&<>"]/g, m => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[m]));
  }

  function lineTotalInc(ln, vatRate) {
    return calcLineTotals({
      qty: ln.qty,
      unitPrice: ln.unitPrice ?? ln.unitCost ?? 0,
      discountPct: ln.discountPct ?? 0,
      taxRate: ln.taxRate ?? vatRate ?? 15,
    }).incTax;
  }

  function buildHTML(ctx) {
    const { doc, lines = [], company = {}, customer = {}, settings = {}, totals } = ctx;
    const title = `${doc.type || "DOCUMENT"} ${doc.no || ""}`.trim();

    const rows = (lines || []).map(ln => `
      <tr>
        <td>${esc(ln.itemName || ln.name || ln.itemId || "")}</td>
        <td class="r">${esc(ln.qty ?? 0)}</td>
        <td class="r">${currency(ln.unitPrice ?? ln.unitCost ?? 0)}</td>
        <td class="r">${esc(ln.discountPct ?? 0)}%</td>
        <td class="r">${esc(ln.taxRate ?? settings.vatRate ?? 15)}%</td>
        <td class="r">${currency(lineTotalInc(ln, settings.vatRate))}</td>
      </tr>`).join("") || `<tr><td colspan="6" class="muted">No lines</td></tr>`;

    const html = `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<title>${esc(title)}</title>
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>
  :root { --fg:#111; --muted:#666; --line:#e5e5e5; --accent:#000; }
  * { box-sizing:border-box; }
  body { font: 12px/1.45 -apple-system, BlinkMacSystemFont, Segoe UI, Roboto, Helvetica, Arial, "Apple Color Emoji","Segoe UI Emoji"; color:var(--fg); margin:0; }
  .page { width: 210mm; min-height: 297mm; margin: 0 auto; padding: 18mm 16mm; background:#fff; }
  h1 { font-size: 22px; margin:0 0 8px; letter-spacing: .5px; }
  .muted { color: var(--muted); }
  .row { display:flex; gap:16px; align-items:flex-start; justify-content:space-between; }
  .col { flex: 1 1 0; }
  .r { text-align:right; }
  .t { margin-top: 14px; width: 100%; border-collapse: collapse; }
  .t th, .t td { border-bottom: 1px solid var(--line); padding: 8px 6px; vertical-align: top; }
  .t th { text-align:left; font-weight: 600; font-size: 11px; color:var(--muted); }
  .totalbox { margin-top: 10px; margin-left: auto; width: 320px; }
  .totalbox .row { gap: 12px; }
  .label { color:var(--muted); }
  .brand { font-weight:700; font-size: 18px; }
  .small { font-size: 11px; }
  .footer { margin-top: 18px; font-size: 11px; color: var(--muted); }
  @media print {
    body { margin:0; }
    .page { box-shadow:none; }
    .noprint { display:none !important; }
  }
</style>
</head>
<body>
  <div class="page">
    <div class="row">
      <div class="col">
        <div class="brand">${esc(company.tradingName || "Your Company")}</div>
        <div class="small">${esc(company.address || "")}</div>
        <div class="small">${esc(company.email || "")}</div>
        <div class="small">${esc(company.vatNo ? "VAT: "+company.vatNo : "")}</div>
      </div>
      <div class="col r">
        <h1>${esc(doc.type || "Document")}</h1>
        <div class="small"><span class="label">No:</span> <b>${esc(doc.no || "")}</b></div>
        <div class="small"><span class="label">Date:</span> ${esc(fmtDate(doc.dates?.issue))}</div>
        ${doc.dates?.due ? `<div class="small"><span class="label">Due:</span> ${esc(fmtDate(doc.dates?.due))}</div>` : ""}
      </div>
    </div>

    <div class="row" style="margin-top:14px">
      <div class="col">
        <div class="label">Bill To</div>
        <div><b>${esc(customer?.name || "")}</b></div>
        <div class="small">${esc(customer?.contact?.person || "")}</div>
        <div class="small">${esc(customer?.contact?.email || "")}</div>
        <div class="small">${esc(customer?.contact?.phone || "")}</div>
      </div>
      <div class="col"></div>
    </div>

    <table class="t" style="margin-top:12px">
      <thead>
        <tr>
          <th>Item</th><th class="r">Qty</th><th class="r">Unit</th><th class="r">Disc%</th><th class="r">VAT%</th><th class="r">Total (inc)</th>
        </tr>
      </thead>
      <tbody>${rows}</tbody>
    </table>

    <div class="totalbox">
      <div class="row"><div class="col label">Sub Total</div><div class="col r">${currency(totals.subTotal || 0)}</div></div>
      <div class="row"><div class="col label">VAT</div><div class="col r">${currency(totals.tax || 0)}</div></div>
      <div class="row"><div class="col"><b>Grand Total</b></div><div class="col r"><b>${currency(totals.grandTotal || 0)}</b></div></div>
    </div>

    ${settings.pdf?.sarsWording ? `
      <div class="footer">This is a tax invoice in terms of Section 20(4) of the VAT Act (RSA).</div>
    ` : ""}

    ${doc.notes ? `<div style="margin-top:10px">${esc(doc.notes)}</div>` : ""}

    <div class="noprint" style="margin-top:18px">
      <button onclick="window.print()">Print / Save as PDF</button>
    </div>
  </div>
</body>
</html>`;
    return { title, html };
  }

  function openPrintWindow(html, title) {
    const w = window.open("", "_blank", "noopener,noreferrer");
    if (!w) throw new Error("Popup blocked – please allow popups for this site.");
    w.document.open();
    w.document.write(html);
    w.document.close();
    // Try to auto-print after load
    w.addEventListener("load", () => {
      try { w.document.title = title || w.document.title; } catch {}
      setTimeout(() => { try { w.focus(); w.print(); } catch {} }, 200);
    });
  }

  async function downloadInvoicePDF(docId, ctx) {
    const data = await loadContext(docId, ctx);
    const { title, html } = buildHTML(data);
    openPrintWindow(html, title);
  }

  // Aliases some code already checks for
  async function exportInvoicePDF(docId, ctx) { return downloadInvoicePDF(docId, ctx); }
  async function generateInvoicePDF(docId, ctx) { return downloadInvoicePDF(docId, ctx); }

  // Expose globally
  window.downloadInvoicePDF = downloadInvoicePDF;
  window.exportInvoicePDF = exportInvoicePDF;
  window.generateInvoicePDF = generateInvoicePDF;
})();
