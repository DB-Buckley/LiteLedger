// ============================================================================
// 60-pdf.js — Minimal PDF/Print for Quotes / Orders / Invoices (resilient)
// Opens a print-ready window (users can "Save as PDF").
// Exposes: downloadInvoicePDF(id?, ctx?), exportInvoicePDF, generateInvoicePDF
// ctx = { doc, lines } optional; if missing we load from IndexedDB.
// Depends on: get, all, whereIndex; optional: currency, calcLineTotals, sumDoc
// ============================================================================

(function () {
  // --- Safe helpers (work even if helpers are missing) ----------------------
  const hasFn = (n) => typeof window[n] === "function";

  const safeCurrency = (v) => {
    if (hasFn("currency")) return window.currency(v);
    try { return new Intl.NumberFormat(undefined, { style: "currency", currency: "ZAR" }).format(Number(v||0)); }
    catch { return (Number(v||0)).toFixed(2); }
  };

  const safeCalcTotals = (ln, vatRate) => {
    if (hasFn("calcLineTotals")) return window.calcLineTotals(ln);
    const qty = Number(ln.qty || 0);
    const unit = Number((ln.unitPrice ?? ln.unitCost) || 0);
    const discPct = Number(ln.discountPct || 0);
    const rate = Number((ln.taxRate ?? vatRate ?? 15) || 0);
    const ex = qty * unit * (1 - discPct / 100);
    const tax = ex * (rate / 100);
    const inc = ex + tax;
    return { exTax: ex, tax, incTax: inc };
  };

  const safeSumDoc = (lines, vatRate) => {
    if (hasFn("sumDoc")) return window.sumDoc(lines.map(l => ({
      qty: l.qty, unitPrice: l.unitPrice ?? l.unitCost ?? 0,
      discountPct: l.discountPct ?? 0, taxRate: l.taxRate ?? vatRate ?? 15,
    })));
    let sub = 0, tax = 0;
    for (const ln of lines) {
      const t = safeCalcTotals(ln, vatRate);
      sub += t.exTax; tax += t.tax;
    }
    return { subTotal: sub, tax, grandTotal: sub + tax };
  };

  const fmtDate = (s) => {
    if (!s) return "";
    try { return new Date(s).toISOString().slice(0,10); } catch { return String(s).slice(0,10); }
  };

  const esc = (s) => String(s ?? "").replace(/[&<>"]/g, m => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[m]));

  // --- Window lifecycle -----------------------------------------------------
  function openShellWindow(title = "Document") {
    const w = window.open("", "_blank", "noopener,noreferrer");
    if (!w) throw new Error("Popup blocked – allow popups for this site.");
    w.document.open();
    w.document.write(`<!doctype html><title>${esc(title)}</title><meta charset="utf-8"><style>
      body{font:14px/1.45 -apple-system,BlinkMacSystemFont,Segoe UI,Roboto,Helvetica,Arial;margin:24px;color:#222}
      .muted{color:#777}
      </style><div id="root" class="muted">Generating PDF…</div>`);
    w.document.close();
    return w;
  }

  function writeHTML(w, html, title) {
    try { w.document.open(); w.document.write(html); w.document.close(); } catch {}
    try { w.document.title = title || w.document.title; } catch {}
    try { w.addEventListener("load", () => setTimeout(() => { try { w.focus(); w.print(); } catch {} }, 200)); } catch {}
  }

  function writeError(w, message) {
    try {
      w.document.open();
      w.document.write(`<!doctype html><meta charset="utf-8"><style>
        body{font:14px/1.5 -apple-system,BlinkMacSystemFont,Segoe UI,Roboto,Helvetica,Arial;margin:24px;color:#222}
        pre{white-space:pre-wrap;background:#f6f8fa;padding:12px;border-radius:6px;border:1px solid #e5e7eb}
        .bad{color:#b00020}
      </style>
      <h2 class="bad">Could not generate PDF</h2>
      <p>${esc(message || "Unknown error")}</p>
      <p class="muted">Check the console for details.</p>`);
      w.document.close();
    } catch {}
  }

  // --- Data load & HTML build ----------------------------------------------
  async function loadContext(docId, ctx) {
    const doc = ctx?.doc || (docId ? await get("docs", docId) : null);
    if (!doc) throw new Error("Document not found or not provided.");
    const lines = Array.isArray(ctx?.lines) ? ctx.lines : await whereIndex("lines", "by_doc", doc.id);
    const company = (await all("company"))?.[0] || {};
    const settings = (await get("settings", "app"))?.value || {};
    const customer = doc.customerId ? (await get("customers", doc.customerId)) : null;

    const totals = safeSumDoc(lines || [], settings.vatRate ?? 15);
    return { doc, lines, company, customer, settings, totals };
  }

  function lineHTML(ln, vatRate) {
    const t = safeCalcTotals(ln, vatRate);
    return `
      <tr>
        <td>${esc(ln.itemName || ln.name || ln.itemId || "")}</td>
        <td class="r">${esc(ln.qty ?? 0)}</td>
        <td class="r">${safeCurrency(ln.unitPrice ?? ln.unitCost ?? 0)}</td>
        <td class="r">${esc(ln.discountPct ?? 0)}%</td>
        <td class="r">${esc(ln.taxRate ?? vatRate ?? 15)}%</td>
        <td class="r">${safeCurrency(t.incTax)}</td>
      </tr>`;
  }

  function buildHTML(ctx) {
    const { doc, lines = [], company = {}, customer = {}, settings = {}, totals } = ctx;
    const title = `${doc.type || "DOCUMENT"} ${doc.no || ""}`.trim();
    const rows = (lines.length ? lines.map(ln => lineHTML(ln, settings.vatRate)).join("") :
      `<tr><td colspan="6" class="muted">No lines</td></tr>`);

    const html = `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<title>${esc(title)}</title>
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>
  :root { --fg:#111; --muted:#666; --line:#e5e5e5; }
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
  @media print { .noprint { display:none !important; } }
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
      <div class="row"><div class="col label">Sub Total</div><div class="col r">${safeCurrency(totals.subTotal || 0)}</div></div>
      <div class="row"><div class="col label">VAT</div><div class="col r">${safeCurrency(totals.tax || 0)}</div></div>
      <div class="row"><div class="col"><b>Grand Total</b></div><div class="col r"><b>${safeCurrency(totals.grandTotal || 0)}</b></div></div>
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

 // --- Public API -----------------------------------------------------------

// Write into a window you already opened (prevents popup blockers)
async function downloadInvoicePDFInto(targetWindow, docId, ctx) {
  const w = targetWindow;
  if (!w) throw new Error("No target window");
  try {
    const data = await loadContext(docId, ctx);
    const { title, html } = buildHTML(data);
    writeHTML(w, html, title);
  } catch (err) {
    console.error("[PDF]", err);
    writeError(w, err?.message || String(err));
  }
}

// Classic API (will open its own window)
async function downloadInvoicePDF(docId, ctx) {
  const w = openShellWindow("Generating…");
  try {
    const data = await loadContext(docId, ctx);
    const { title, html } = buildHTML(data);
    writeHTML(w, html, title);
  } catch (err) {
    console.error("[PDF]", err);
    writeError(w, err?.message || String(err));
  }
}
async function exportInvoicePDF(docId, ctx)  { return downloadInvoicePDF(docId, ctx); }
async function generateInvoicePDF(docId, ctx){ return downloadInvoicePDF(docId, ctx); }

window.downloadInvoicePDFInto = downloadInvoicePDFInto;
window.downloadInvoicePDF     = downloadInvoicePDF;
window.exportInvoicePDF       = exportInvoicePDF;
window.generateInvoicePDF     = generateInvoicePDF;

})();
