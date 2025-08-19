// ============================================================================
// 60-pdf.js — Print HTML for Quotes / Orders / Invoices / Credit Notes
// Responsive-on-screen (fills iframe) + A4-at-print.
// For SCN we compute totals from ABS(qty) and prefer stored doc.totals.
// ============================================================================

(function () {
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

  const sumFromLines = (lines, vatRate) => {
    let sub = 0, tax = 0;
    for (const ln of lines) {
      const t = safeCalcTotals(ln, vatRate);
      sub += t.exTax; tax += t.tax;
    }
    return { subTotal: sub, tax, grandTotal: sub + tax };
  };

  const safeSumDoc = (lines, vatRate) => {
    if (hasFn("sumDoc")) return window.sumDoc(lines.map(l => ({
      qty: l.qty, unitPrice: l.unitPrice ?? l.unitCost ?? 0,
      discountPct: l.discountPct ?? 0, taxRate: l.taxRate ?? vatRate ?? 15,
    })));
    return sumFromLines(lines, vatRate);
  };

  const fmtDate = (s) => {
    if (!s) return "";
    try { return new Date(s).toISOString().slice(0,10); } catch { return String(s).slice(0,10); }
  };

  const esc = (s) => String(s ?? "").replace(/[&<>"]/g, m => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[m]));

  async function loadContext(docId, ctx) {
    const doc = ctx?.doc || (docId ? await get("docs", docId) : null);
    if (!doc) throw new Error("Document not found or not provided.");
    const lines = Array.isArray(ctx?.lines) ? ctx.lines : await whereIndex("lines", "by_doc", doc.id);
    const company = (await all("company"))?.[0] || {};
    const settings = (await get("settings", "app"))?.value || {};
    const customer = doc.customerId ? (await get("customers", doc.customerId)) : null;

    // For Credit Notes, display totals should be based on ABS(qty)
    const displayLinesForTotals = (doc.type === "SCN")
      ? (lines || []).map(l => ({ ...l, qty: Math.abs(Number(l.qty) || 0) }))
      : (lines || []);

    const computedTotals = safeSumDoc(displayLinesForTotals, settings.vatRate ?? 15);
    const totals =
      (doc.totals && Number(doc.totals.grandTotal) > 0)
        ? doc.totals
        : computedTotals;

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

    const rows = (lines.length
      ? lines.map(ln => lineHTML(ln, settings.vatRate)).join("")
      : `<tr><td colspan="6" class="muted">No lines</td></tr>`);

    const typeLabel = (doc.type === "SCN") ? "Credit Note" : (doc.type || "Document");

    const html = `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<title>${esc(title)}</title>
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>
  :root { --fg:#111; --muted:#666; --line:#e5e5e5; }
  * { box-sizing:border-box; }
  body { font: 13px/1.5 -apple-system, BlinkMacSystemFont, Segoe UI, Roboto, Helvetica, Arial, "Apple Color Emoji","Segoe UI Emoji"; color:var(--fg); margin:0; background:#fff; }
  .page { margin: 0 auto; padding: 24px 20px; width: min(960px, 94vw); }
  @media print {
    .page { width: 210mm; padding: 18mm 16mm; }
  }
  h1 { font-size: 22px; margin:0 0 8px; letter-spacing: .5px; }
  .muted { color: var(--muted); }
  .row { display:flex; gap:16px; align-items:flex-start; justify-content:space-between; }
  .col { flex: 1 1 0; }
  .r { text-align:right; }
  .t { margin-top: 14px; width: 100%; border-collapse: collapse; }
  .t th, .t td { border-bottom: 1px solid var(--line); padding: 8px 6px; vertical-align: top; }
  .t th { text-align:left; font-weight: 600; font-size: 11px; color:var(--muted); }
  .totalbox { margin-top: 12px; margin-left: auto; width: 360px; max-width: 100%; }
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
        <h1>${esc(typeLabel)}</h1>
        <div class="small"><span class="label">No:</span> <b>${esc(doc.no || "")}</b></div>
        <div class="small"><span class="label">Date:</span> ${esc(fmtDate(doc.dates?.issue))}</div>
        ${doc.dates?.due ? `<div class="small"><span class="label">Due:</span> ${esc(fmtDate(doc.dates?.due))}</div>` : ""}
        ${doc.relatedDocId ? `<div class="small"><span class="label">Ref:</span> ${esc(doc.relatedDocId)}</div>` : ""}
      </div>
    </div>

    <div class="row" style="margin-top:14px">
      <div class="col">
        <div class="label">${doc.type === "SCN" ? "Credit To" : "Bill To"}</div>
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

  async function getInvoiceHTML(docId, ctx) {
    const data = await loadContext(docId, ctx);
    return buildHTML(data);
  }
  window.getInvoiceHTML = getInvoiceHTML;

  async function getDocEmailDraft(docId, ctx) {
    const data = await loadContext(docId, ctx);
    const { doc, company = {}, customer = {}, totals } = data;
    const typeLabel = (doc.type === "SCN") ? "Credit Note" : (doc.type || "Document");
    const to = customer?.contact?.email || "";
    const subject = `${typeLabel} ${doc.no || ""} — ${company.tradingName || "from us"}`;
    const bodyLines = [
      customer?.contact?.person ? `Hi ${customer.contact.person},` : `Hello,`,
      "",
      `Please find attached your ${typeLabel.toLowerCase()} ${doc.no || ""}.`,
      `Date: ${fmtDate(doc.dates?.issue)}`,
      `Amount: ${safeCurrency(totals?.grandTotal || 0)}`,
      doc.type === "SCN" && doc.relatedDocId ? `Original Invoice Ref: ${doc.relatedDocId}` : "",
      "",
      (company.tradingName ? `${company.tradingName}` : ""),
      (company.email ? `Email: ${company.email}` : ""),
    ].filter(Boolean);
    return { to, subject, body: bodyLines.join("\n") };
  }
  window.getDocEmailDraft = getDocEmailDraft;

  function openShellWindow(title = "Document") {
    const w = window.open("", "_blank", "noopener,noreferrer");
    if (!w) throw new Error("Popup blocked – allow popups for this site.");
    w.document.open();
    w.document.write(`<!doctype html><title>${esc(title)}</title><meta charset="utf-8"><div>Generating…</div>`);
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
      w.document.write(`<!doctype html><meta charset="utf-8"><pre>${esc(message || "Unknown error")}</pre>`);
      w.document.close();
    } catch {}
  }

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
  window.downloadInvoicePDF = downloadInvoicePDF;

})();
