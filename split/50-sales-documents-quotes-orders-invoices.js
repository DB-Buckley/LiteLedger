// ===========================================================================
// 50-sales-documents-quotes-orders-invoices.js
// Sales: Quotes / Orders / Invoices + Processing + Credit Notes
//
// Notes:
// - Uses <dialog> for top-layer item picker & PDF overlay
// - Qty inputs step in whole numbers (step="1")
// - Credit Notes show positive totals, post stock returns, and create CUSTOMER_CREDIT adjustments
// - Exposes router renderers and (NEW) legacy compat shims for 52-sales-routes.js
//
// Depends on: 01-db.js, 02-helpers.js
// Works with: 60-pdf.js (getInvoiceHTML, getDocEmailDraft)
// ===========================================================================

const __CREDIT_CFG = {
  CUSTOMER_INVOICE_TYPES: new Set(["INVOICE"]),
  CREDIT_DOC_TYPE: "SCN",
  MOVEMENT_TYPE_CREDIT: "SALE_RETURN", // stock back in
  MOVEMENT_TYPE_SALE: "SALE",          // stock out on invoice processing
};

// ---------- Top-layer PDF overlay (<dialog>) ----------
(function () {
  if (window.showPdfOverlay) return;
  window.showPdfOverlay = function showPdfOverlay(html, title, opts = {}) {
    document.getElementById("pdf_overlay_dlg")?.close();
    document.getElementById("pdf_overlay_dlg")?.remove();

    const dlg = document.createElement("dialog");
    dlg.id = "pdf_overlay_dlg";
    dlg.style.padding = "0";
    dlg.style.border = "0";
    dlg.style.width = "min(900px, 96vw)";
    dlg.style.height = "min(90vh, 900px)";
    dlg.innerHTML = `
      <form method="dialog" style="display:flex;flex-direction:column;min-height:100%;border:1px solid #1f2937;border-radius:12px;overflow:hidden">
        <div class="hd" style="display:flex;justify-content:space-between;align-items:center;gap:8px;padding:10px 12px;border-bottom:1px solid #e5e7eb">
          <b>${title || "Document"}</b>
          <div class="row" style="display:flex;gap:8px">
            ${opts.emailDraft ? `<button type="button" class="btn" id="doc_email">Email</button>` : ""}
            <button type="button" class="btn" id="doc_print">Print</button>
            <button type="button" class="btn" id="doc_newtab">Open in new tab</button>
            <button type="submit" class="btn" id="doc_close">Close</button>
          </div>
        </div>
        <div class="bd" style="flex:1;overflow:hidden;background:#fff">
          <iframe id="doc_iframe" style="width:100%;height:100%;border:0;background:#fff"></iframe>
        </div>
      </form>`;
    document.body.appendChild(dlg);

    const iframe = dlg.querySelector("#doc_iframe");
    try { iframe.contentDocument.open(); iframe.contentDocument.write(html); iframe.contentDocument.close(); } catch {}

    dlg.querySelector("#doc_print").onclick = () => { try { iframe.contentWindow.focus(); iframe.contentWindow.print(); } catch {} };
    dlg.querySelector("#doc_newtab").onclick = () => {
      const w = window.open("", "_blank", "noopener");
      if (w) { w.document.open(); w.document.write(html); w.document.close(); }
    };
    if (opts.emailDraft) {
      dlg.querySelector("#doc_email").onclick = () => {
        const { to, subject, body } = opts.emailDraft;
        const mailto = `mailto:${encodeURIComponent(to||"")}?subject=${encodeURIComponent(subject||"")}&body=${encodeURIComponent(body||"")}`;
        location.href = mailto;
      };
    }

    dlg.addEventListener("close", () => dlg.remove());
    dlg.showModal();
  };
})();

// ===========================================================================
// CREDIT NOTES (SCN)
// ===========================================================================

(function attachCreditsAPI() {
  if (window.openCreditNoteWizard) return;

  function ensureAppModal() {
    const m = document.getElementById("modal");
    const body = document.getElementById("modalBody");
    return (m && body) ? { m, body } : { m: null, body: null };
  }

  async function loadInvoice(invoiceId) {
    const inv = await get("docs", invoiceId);
    if (!inv) throw new Error("Invoice not found");
    if (!__CREDIT_CFG.CUSTOMER_INVOICE_TYPES.has(inv.type)) throw new Error("Not a customer invoice");
    if (inv.status !== "PROCESSED") throw new Error("Only processed invoices can be credited.");
    const lines = await whereIndex("lines", "by_doc", inv.id);
    return { inv, lines };
  }

  async function computeRemainingByLine(inv, lines) {
    const invByItem = new Map();
    for (const ln of lines) {
      const k = ln.itemId;
      invByItem.set(k, (invByItem.get(k) || 0) + Math.abs(Number(ln.qty) || 0));
    }

    const docs = await all("docs");
    const credits = (docs || []).filter(d => d.type === __CREDIT_CFG.CREDIT_DOC_TYPE && d.relatedDocId === inv.id);
    const creditedByItem = new Map();
    for (const scn of credits) {
      const cls = await whereIndex("lines", "by_doc", scn.id);
      for (const ln of cls) {
        const k = ln.itemId;
        const q = Math.abs(Number(ln.qty) || 0);
        creditedByItem.set(k, (creditedByItem.get(k) || 0) + q);
      }
    }

    const remainingByItem = new Map();
    for (const [k, totInv] of invByItem.entries()) {
      const cred = creditedByItem.get(k) || 0;
      remainingByItem.set(k, Math.max(0, round2(totInv - cred)));
    }

    const remainingPerLine = new Map();
    for (const ln of lines) {
      const k = ln.itemId;
      const leftForItem = remainingByItem.get(k) || 0;
      const lineMax = Math.max(0, Math.min(Math.abs(Number(ln.qty) || 0), leftForItem));
      remainingPerLine.set(ln.id, lineMax);
      remainingByItem.set(k, Math.max(0, round2(leftForItem - lineMax)));
    }
    return remainingPerLine;
  }

  function calcTotalsForLines(lines, vatDefault = 15) {
    return sumDoc(lines.map(ln => ({
      qty: ln.qty,
      unitPrice: ln.unitPrice ?? ln.unitCost ?? 0,
      discountPct: ln.discountPct ?? 0,
      taxRate: ln.taxRate ?? vatDefault,
    })));
  }

  async function createCreditNoteFromInvoice(invoiceId, creditQtyByLineId) {
    const { inv, lines } = await loadInvoice(invoiceId);
    const settings = (await get("settings", "app"))?.value || {};
    const vatDefault = settings.vatRate ?? 15;

    const creditLines = [];
    for (const ln of lines) {
      const qToCredit = Number(creditQtyByLineId[ln.id] || 0);
      if (!qToCredit) continue;
      creditLines.push({
        id: randId(),
        docId: null,
        itemId: ln.itemId,
        itemName: ln.itemName,
        qty: -Math.abs(qToCredit), // negative line qty for returns
        unitPrice: Number(ln.unitPrice ?? ln.unitCost ?? 0),
        discountPct: Number(ln.discountPct ?? 0),
        taxRate: Number(ln.taxRate ?? vatDefault),
        sourceLineId: ln.id,
      });
    }
    if (!creditLines.length) throw new Error("No quantities selected to credit.");

    // Totals shown as positive credit value
    const totalsAbs = calcTotalsForLines(
      creditLines.map(l => ({ ...l, qty: Math.abs(l.qty) })), vatDefault
    );

    const scn = {
      id: randId(),
      type: __CREDIT_CFG.CREDIT_DOC_TYPE,
      no: await nextDocNo(__CREDIT_CFG.CREDIT_DOC_TYPE),
      customerId: inv.customerId,
      warehouseId: inv.warehouseId || "WH1",
      dates: { issue: nowISO().slice(0,10) },
      status: "PROCESSED",
      readOnly: true,
      relatedDocId: inv.id,
      createdAt: nowISO(),
      processedAt: nowISO(),
      totals: totalsAbs,
      notes: `Credit for ${inv.type} ${inv.no}`,
    };
    await put("docs", scn);

    for (const cl of creditLines) { cl.docId = scn.id; await put("lines", cl); }

    // Stock back in
    for (const cl of creditLines) {
      const qty = Math.abs(cl.qty);
      if (qty > 0) {
        await add("movements", {
          id: randId(),
          itemId: cl.itemId,
          warehouseId: scn.warehouseId || "WH1",
          type: __CREDIT_CFG.MOVEMENT_TYPE_CREDIT,
          qtyDelta: qty,
          relatedDocId: scn.id,
          timestamp: nowISO(),
          note: `${__CREDIT_CFG.CREDIT_DOC_TYPE} ${scn.no} ${cl.itemId || ""}`,
        });
      }
    }

    // Reduce receivable on account
    try {
      await add("adjustments", {
        id: randId(),
        kind: "CUSTOMER_CREDIT",
        customerId: inv.customerId,
        docId: scn.id,
        relatedDocId: inv.id,
        amount: Math.abs(totalsAbs.grandTotal || 0),
        createdAt: nowISO(),
      });
    } catch {}

    // Preview
    try {
      const { title, html } = await getInvoiceHTML(scn.id, { doc: scn, lines: creditLines });
      let draft = null; try { draft = await getDocEmailDraft(scn.id, { doc: scn, lines: creditLines }); } catch {}
      window.showPdfOverlay?.(html, title, draft ? { emailDraft: draft } : {});
    } catch (e) {
      console.warn("[SCN] preview/email failed:", e);
      try { await downloadInvoicePDF(scn.id, { doc: scn, lines: creditLines }); } catch {}
    }

    toast?.(`Credit Note ${scn.no} created`, "success");
    window.renderCreditNotes?.();
    window.renderInvoicesProcessed?.();
    return scn;
  }

  window.openCreditNoteWizard = async function openCreditNoteWizard(invoiceId) {
    const { inv, lines } = await loadInvoice(invoiceId);
    const remainingPerLine = await computeRemainingByLine(inv, lines);
    const { m, body } = ensureAppModal();
    if (!m || !body) throw new Error("Modal container not found");

    const rows = lines.map(ln => {
      const invoiced = Math.abs(Number(ln.qty) || 0);
      const remaining = remainingPerLine.get(ln.id) || 0;
      return `
        <tr data-line="${ln.id}">
          <td>${ln.itemName || ln.itemId || ""}</td>
          <td class="r">${invoiced}</td>
          <td class="r">${remaining}</td>
          <td class="r"><input type="number" min="0" step="1" value="${remaining}" data-qty style="width:110px"></td>
        </tr>`;
    }).join("");

    body.innerHTML = `
      <div class="hd" style="display:flex;justify-content:space-between;align-items:center">
        <h3>Create Credit Note for ${inv.type} ${inv.no}</h3>
        <div class="row">
          <button class="btn success" id="scn_create" type="button">Create Credit</button>
          <button class="btn" id="scn_close" type="button">Close</button>
        </div>
      </div>
      <div class="bd">
        <div class="sub">Adjust quantities to credit (defaults are remaining creditable quantities).</div>
        <div style="max-height:52vh;overflow:auto;margin-top:8px">
          <table class="table">
            <thead><tr><th>Item</th><th class="r">Invoiced</th><th class="r">Remaining</th><th class="r">Credit Qty</th></tr></thead>
            <tbody id="scn_rows">${rows}</tbody>
          </table>
        </div>
      </div>
    `;

    $("#scn_close").onclick = () => m.close();
    $("#scn_create").onclick = async () => {
      const map = {};
      let any = false;
      $$('#scn_rows [data-line]').forEach(tr => {
        const lnId = tr.dataset.line;
        const input = tr.querySelector("[data-qty]");
        const max = Number(tr.children[2].textContent) || 0;
        const val = Math.min(max, Math.max(0, Number(input?.value || 0)));
        if (val > 0) { map[lnId] = round2(val); any = true; }
      });
      if (!any) { alert("Enter at least one quantity to credit."); return; }
      try {
        await createCreditNoteFromInvoice(inv.id, map);
        m.close();
      } catch (e) {
        console.error(e);
        alert(e?.message || e);
      }
    };

    m.showModal();
  };
})();

// ===========================================================================
// PROCESSING — mark invoice as PROCESSED (readOnly), post stock + adjustment
// Public: window.processInvoiceById(id), window.batchProcessInvoicesByDate(isoDate)
// ===========================================================================

(async function attachProcessingAPI() {
  if (window.processInvoiceById) return;

  async function hasMovementsForDoc(docId) {
    try { const ms = await whereIndex("movements", "by_doc", docId); return (ms && ms.length > 0); }
    catch { return false; }
  }
  async function hasAdjustmentForDoc(docId) {
    try { const adj = await all("adjustments"); return (adj || []).some(a => a.docId === docId && a.kind === "CUSTOMER_INVOICE"); }
    catch { return false; }
  }
  async function postInvoiceMovements(doc, lines) {
    const already = await hasMovementsForDoc(doc.id);
    if (already) return;
    for (const ln of lines) {
      const qty = Number(ln.qty) || 0;
      if (qty > 0) {
        await add("movements", {
          id: randId(),
          itemId: ln.itemId,
          warehouseId: doc.warehouseId || "WH1",
          type: __CREDIT_CFG.MOVEMENT_TYPE_SALE,
          qtyDelta: -Math.abs(qty),
          relatedDocId: doc.id,
          timestamp: nowISO(),
          note: `INVOICE ${doc.no} ${ln.itemId || ""}`,
        });
      }
    }
  }
  async function postInvoiceAdjustment(doc, totals) {
    const already = await hasAdjustmentForDoc(doc.id);
    if (already) return;
    try {
      await add("adjustments", {
        id: randId(),
        kind: "CUSTOMER_INVOICE",
        customerId: doc.customerId,
        docId: doc.id,
        amount: Math.abs(totals?.grandTotal || 0), // increases receivable
        createdAt: nowISO(),
      });
    } catch {}
  }
  async function loadDocLines(docId) {
    const doc = await get("docs", docId);
    if (!doc) throw new Error("Invoice not found");
    const lines = await whereIndex("lines", "by_doc", doc.id);
    return { doc, lines };
  }
  async function computeTotals(lines) {
    return sumDoc(lines.map(l => ({
      qty: l.qty, unitPrice: l.unitPrice ?? 0, discountPct: l.discountPct ?? 0, taxRate: l.taxRate ?? 15,
    })));
  }
  async function processInvoice(doc, lines) {
    if (doc.type !== "INVOICE") throw new Error("Not an invoice");
    if (doc.status === "PROCESSED") return false;
    const totals = await computeTotals(lines);
    doc.totals = totals;
    doc.status = "PROCESSED";
    doc.readOnly = true;
    doc.processedAt = nowISO();
    await put("docs", doc);
    await postInvoiceMovements(doc, lines);
    await postInvoiceAdjustment(doc, totals);
    return true;
  }
  window.processInvoiceById = async function processInvoiceById(invoiceId) {
    const { doc, lines } = await loadDocLines(invoiceId);
    const changed = await processInvoice(doc, lines);
    if (changed) toast?.(`Invoice ${doc.no} processed`, "success");
    return changed;
  };
  window.batchProcessInvoicesByDate = async function batchProcessInvoicesByDate(isoDate) {
    const allDocs = await all("docs");
    const target = (allDocs || []).filter(d =>
      d.type === "INVOICE" && d.status !== "PROCESSED" && (d.dates?.issue || "").slice(0,10) === isoDate
    );
    if (!target.length) { toast?.("No unprocessed invoices for that date.", "warn"); return 0; }
    if (!confirm(`Process ${target.length} invoice(s) dated ${isoDate}? This cannot be undone.`)) return 0;
    let count = 0;
    for (const d of target) {
      try {
        const lines = await whereIndex("lines", "by_doc", d.id);
        const ok = await processInvoice(d, lines);
        if (ok) count++;
      } catch (e) { console.error("Batch process failed for", d.id, e); }
    }
    toast?.(`Processed ${count} invoice(s) for ${isoDate}`, "success");
    return count;
  };
})();

// ===========================================================================
// SALES LISTS + FORMS
// ===========================================================================

async function renderSales(kind = "INVOICE", opts = {}) {
  const invoiceView = opts.invoiceView || "active"; // 'active' | 'processed'
  const history = !!opts.history;

  const v = $("#view"); if (!v) return;

  const allDocs = await all("docs");
  let docs = (allDocs || []).filter((d) => d.type === kind);

  if (kind === "INVOICE") {
    docs = (invoiceView === "processed")
      ? docs.filter(d => d.status === "PROCESSED")
      : docs.filter(d => d.status !== "PROCESSED");
  } else if (kind === "QUOTE" || kind === "ORDER") {
    docs = history
      ? docs.filter(d => d.status === "CONVERTED" || d.readOnly || d.convertedToId)
      : docs.filter(d => !(d.status === "CONVERTED" || d.readOnly || d.convertedToId));
  }

  docs.sort((a, b) => (b.dates?.issue || "").localeCompare(a.dates?.issue || ""));

  const customers = await all("customers");
  const cname = (id) => customers.find((c) => c.id === id)?.name || "—";

  const isQuotes = kind === "QUOTE";
  const isOrders = kind === "ORDER";
  const isInvoices = kind === "INVOICE";
  const label =
    isQuotes ? (history ? "Quotes History" : "Quotes") :
    isOrders ? (history ? "Sales Order History" : "Sales Orders") :
    (invoiceView === "processed" ? "Processed Invoices" : "Active Invoices");

  const salesButtons = isQuotes
    ? (history
        ? `<button type="button" class="btn" id="d_back_active">Active Quotes</button>`
        : `<button type="button" class="btn" id="d_history">Quotes History</button>
           <button type="button" class="btn primary" id="d_new">+ New Quote</button>`)
    : isOrders
    ? (history
        ? `<button type="button" class="btn" id="d_back_orders">Active Orders</button>`
        : `<button type="button" class="btn" id="d_orders_history">Sales Order History</button>
           <button type="button" class="btn primary" id="d_new">+ New Order</button>`)
    : (invoiceView === "processed"
        ? `<button type="button" class="btn" id="d_invoices_active">Active Invoices</button>
           <button type="button" class="btn" id="d_credit_notes">Credit Notes</button>`
        : `<button type="button" class="btn" id="d_invoices_processed">Processed Invoices</button>
           <button type="button" class="btn" id="d_credit_notes">Credit Notes</button>
           <button type="button" class="btn primary" id="d_new">+ New Invoice</button>
           <input id="batch_date" type="date" style="margin-left:8px">
           <button type="button" class="btn" id="batch_process">Batch Process (date)</button>`);

  v.innerHTML = `
  <div class="card">
    <div class="hd">
      <b>${label}</b>
      <div class="toolbar">
        <input id="d_search" placeholder="Search no / customer" style="min-width:240px">
        ${salesButtons}
      </div>
    </div>
    <div class="bd">
      <table class="table">
        <thead>
          <tr><th>No</th><th>Customer</th><th>Date</th><th>Sub</th><th>VAT</th><th>Total</th><th></th></tr>
        </thead>
        <tbody id="d_rows">
          ${docs.map(d => `
            <tr>
              <td>${d.no || ""}</td>
              <td>${cname(d.customerId)}</td>
              <td>${(d.dates?.issue || "").slice(0, 10)}</td>
              <td>${currency(d.totals?.subTotal || 0)}</td>
              <td>${currency(d.totals?.tax || 0)}</td>
              <td>${currency(d.totals?.grandTotal || 0)}</td>
              <td><button type="button" class="btn" data-view="${d.id}">View</button></td>
            </tr>`).join("")}
        </tbody>
      </table>
    </div>
  </div>`;

  $("#d_search").oninput = () => {
    const q = ($("#d_search").value || "").toLowerCase();
    $$("#d_rows tr").forEach((tr) => tr.style.display = tr.textContent.toLowerCase().includes(q) ? "" : "none");
  };

  $("#d_history")?.addEventListener("click", () => (location.hash = "#/quotes-history"));
  $("#d_back_active")?.addEventListener("click", () => (location.hash = "#/quotes"));
  $("#d_orders_history")?.addEventListener("click", () => (location.hash = "#/orders-history"));
  $("#d_back_orders")?.addEventListener("click", () => (location.hash = "#/orders"));
  $("#d_invoices_processed")?.addEventListener("click", () => (location.hash = "#/invoices-processed"));
  $("#d_invoices_active")?.addEventListener("click", () => (location.hash = "#/invoices"));
  $("#d_credit_notes")?.addEventListener("click", () => (location.hash = "#/credit-notes"));

  if (isInvoices && invoiceView === "active") {
    const d = $("#batch_date");
    if (d && !d.value) d.value = nowISO().slice(0,10);
    $("#batch_process")?.addEventListener("click", async () => {
      const day = $("#batch_date")?.value || nowISO().slice(0,10);
      await batchProcessInvoicesByDate(day);
      location.hash = "#/invoices-processed";
    });
  }

  $("#d_new")?.addEventListener("click", () => openDocForm(kind));

  $$("#d_rows [data-view]").forEach((b) =>
    (b.onclick = () => {
      const ro = (kind === "QUOTE" || kind === "ORDER") ? history : false;
      openDocForm(kind, b.dataset.view, { readOnly: ro });
    })
  );
}

async function renderCreditNotes() {
  const v = $("#view"); if (!v) return;
  const docs = (await all("docs") || [])
    .filter(d => d.type === __CREDIT_CFG.CREDIT_DOC_TYPE)
    .sort((a,b) => (b.dates?.issue || "").localeCompare(a.dates?.issue || ""));

  const customers = await all("customers");
  const cname = (id) => customers.find((c) => c.id === id)?.name || "—";

  v.innerHTML = `
  <div class="card">
    <div class="hd">
      <b>Credit Notes</b>
      <div class="toolbar">
        <input id="cn_search" placeholder="Search no / customer" style="min-width:240px">
        <button type="button" class="btn" id="cn_invoices">Active Invoices</button>
        <button type="button" class="btn" id="cn_invoices_processed">Processed Invoices</button>
      </div>
    </div>
    <div class="bd">
      <table class="table">
        <thead><tr><th>No</th><th>Customer</th><th>Date</th><th>Total</th><th>From Invoice</th><th></th></tr></thead>
        <tbody id="cn_rows">
          ${docs.map(d => `
            <tr>
              <td>${d.no || ""}</td>
              <td>${cname(d.customerId)}</td>
              <td>${(d.dates?.issue || "").slice(0,10)}</td>
              <td>${currency(d.totals?.grandTotal || 0)}</td>
              <td>${d.relatedDocId ? d.relatedDocId.slice(0,8) : ""}</td>
              <td><button class="btn" data-view="${d.id}">View</button></td>
            </tr>`).join("")}
        </tbody>
      </table>
    </div>
  </div>`;

  $("#cn_search").oninput = () => {
    const q = ($("#cn_search").value || "").toLowerCase();
    $$("#cn_rows tr").forEach((tr) => tr.style.display = tr.textContent.toLowerCase().includes(q) ? "" : "none");
  };
  $("#cn_invoices").onclick = () => (location.hash = "#/invoices");
  $("#cn_invoices_processed").onclick = () => (location.hash = "#/invoices-processed");

  $$("#cn_rows [data-view]").forEach(btn => btn.onclick = async () => {
    const id = btn.dataset.view;
    try {
      const doc = await get("docs", id);
      const lines = await whereIndex("lines", "by_doc", id);
      const { title, html } = await getInvoiceHTML(id, { doc, lines });
      let draft = null; try { draft = await getDocEmailDraft(id, { doc, lines }); } catch {}
      window.showPdfOverlay?.(html, title, draft ? { emailDraft: draft } : {});
    } catch (e) { console.error(e); toast?.("Could not render Credit Note PDF", "warn"); }
  });
}

// ---------- Sales Doc Form ----------
async function openDocForm(kind, docId, opts = {}) {
  const editing = !!docId;
  const existing = editing ? await get("docs", docId) : null;

  const allCustomers = (await all("customers")) || [];
  const activeCustomers = allCustomers.filter((c) => !c.archived);

  const settingsRec = await get("settings", "app");
  const settings = settingsRec?.value || {};
  const allItemsRaw = await all("items");

  const items = (allItemsRaw || []).map((raw) => ({
    raw,
    id: raw.id ?? raw.itemId ?? raw.sku ?? raw.code ?? null,
    name: raw.name ?? raw.title ?? raw.label ?? String(raw.sku || raw.code || "Item"),
    code: (raw.code ?? raw.sku ?? raw.id ?? "").toString(),
    sku: (raw.sku ?? "").toString(),
    barcode: (raw.barcode ?? raw.ean ?? "").toString(),
    sellPrice: Number(raw.sellPrice ?? raw.price ?? raw.unitPrice ?? raw.defaultPrice ?? 0) || 0,
  }));

  const doc = existing || {
    id: randId(),
    type: kind,
    no: await nextDocNo(kind),
    customerId: activeCustomers[0]?.id || "",
    warehouseId: "WH1",
    dates: { issue: nowISO().slice(0, 10), due: nowISO().slice(0, 10) },
    totals: { subTotal: 0, tax: 0, grandTotal: 0 },
    notes: "",
    createdAt: nowISO(),
  };
  const lines = editing ? await whereIndex("lines", "by_doc", doc.id) : [];

  const theCustomer = allCustomers.find((c) => c.id === doc.customerId);
  const customerIsArchived = !!theCustomer?.archived;

  const readOnly =
    !!opts.readOnly ||
    doc.status === "CONVERTED" ||
    !!doc.readOnly ||
    !!doc.convertedToId ||
    doc.status === "PROCESSED";

  const m = $("#modal"), body = $("#modalBody");
  if (!m || !body) { console.error("[SalesDoc] Modal elements not found."); return; }

  const custOptsActive = activeCustomers
    .map(
      (c) => `<option value="${c.id}" ${c.id === doc.customerId ? "selected" : ""}>${c.name}</option>`
    )
    .join("");

  const custArchivedOption =
    customerIsArchived ? `<option value="${theCustomer.id}" selected disabled>${theCustomer.name} (archived)</option>` : "";

  const custSelectHtml = `<select id="sd_cust" ${readOnly ? "disabled" : ""}>${custArchivedOption}${custOptsActive}</select>`;

  const renderLineRow = (ln, idx, ro) =>
    ro
      ? `
    <tr data-idx="${idx}">
      <td>${ln.itemName || ""}</td>
      <td class="r">${ln.qty ?? 0}</td>
      <td class="r">${currency(ln.unitPrice ?? 0)}</td>
      <td class="r">${ln.discountPct ?? 0}%</td>
      <td class="r">${ln.taxRate ?? settings.vatRate ?? 15}%</td>
      <td class="r">${currency(calcLineTotals({
        qty: ln.qty, unitPrice: ln.unitPrice ?? 0, discountPct: ln.discountPct ?? 0, taxRate: ln.taxRate ?? settings.vatRate ?? 15
      }).incTax)}</td>
      <td></td>
    </tr>`
      : `
    <tr data-idx="${idx}">
      <td>${ln.itemName || ""}</td>
      <td><input type="number" step="1"  min="0" value="${ln.qty || 0}" data-edit="qty"></td>
      <td><input type="number" step="0.01"  min="0" value="${ln.unitPrice ?? 0}" data-edit="unitPrice"></td>
      <td><input type="number" step="0.01"  min="0" value="${ln.discountPct || 0}" data-edit="discountPct"></td>
      <td><input type="number" step="0.01"  min="0" value="${ln.taxRate ?? settings.vatRate ?? 15}" data-edit="taxRate"></td>
      <td class="r">${currency(calcLineTotals({
        qty: ln.qty, unitPrice: ln.unitPrice ?? 0, discountPct: ln.discountPct ?? 0, taxRate: ln.taxRate ?? 15
      }).incTax)}</td>
      <td><button type="button" class="btn warn" data-del="${idx}">×</button></td>
    </tr>`;

  const recalc = () => {
    const t = sumDoc(
      lines.map((ln) => ({
        qty: ln.qty,
        unitPrice: ln.unitPrice ?? 0,
        discountPct: ln.discountPct ?? 0,
        taxRate: ln.taxRate ?? settings.vatRate ?? 15,
      }))
    );
    doc.totals = t;
    $("#sd_sub").textContent = currency(t.subTotal);
    $("#sd_tax").textContent = currency(t.tax);
    $("#sd_tot").textContent = currency(t.grandTotal);
  };

  function wireRowEvents(tr) {
    if (!tr) return;
    const idx = +tr.dataset.idx;
    tr.querySelectorAll("[data-edit]").forEach((inp) => {
      inp.oninput = () => {
        const key = inp.dataset.edit;
        lines[idx][key] = +inp.value;
        const t = calcLineTotals({
          qty: lines[idx].qty,
          unitPrice: lines[idx].unitPrice ?? 0,
          discountPct: lines[idx].discountPct ?? 0,
          taxRate: lines[idx].taxRate ?? settings.vatRate ?? 15,
        }).incTax;
        const totalCell = tr.querySelector(".r");
        if (totalCell) totalCell.textContent = currency(t);
        recalc();
      };
    });
    tr.querySelector("[data-del]")?.addEventListener("click", () => {
      lines.splice(idx, 1);
      const tbody = document.getElementById("sd_rows");
      if (tbody) {
        tbody.innerHTML = lines.map((ln, i) => renderLineRow(ln, i, readOnly)).join("");
        if (!readOnly) wireAllRows();
        recalc();
      }
    });
  }
  function wireAllRows() { if (!readOnly) document.querySelectorAll("#sd_rows tr[data-idx]")?.forEach(wireRowEvents); }

  function addLineFromItem(it, qty = 1) {
    if (!it || readOnly) return;
    lines.push({
      id: randId(),
      docId: doc.id,
      itemId: it.id,
      itemName: it.name,
      qty: Number(qty) || 1,
      unitPrice: +it.sellPrice || 0,
      discountPct: 0,
      taxRate: settings.vatRate ?? 15,
    });
    draw(); recalc();
  }

  function findMatchesByCode(input) {
    const q = (input || "").trim().toLowerCase();
    if (!q) return [];
    return items.filter(
      (it) =>
        (it.id && it.id.toString().toLowerCase() === q) ||
        (it.barcode && it.barcode.toLowerCase() === q) ||
        (it.sku && it.sku.toLowerCase() === q) ||
        (it.code && it.code.toLowerCase() === q)
    );
  }

  // ---- Item Picker Overlay — <dialog> on top of form ----
  function openItemPicker(opts = {}) {
    document.getElementById("sd_picker_dlg")?.close();
    document.getElementById("sd_picker_dlg")?.remove();

    const initialQuery = (opts.initialQuery || "").toLowerCase();
    const dlg = document.createElement("dialog");
    dlg.id = "sd_picker_dlg";
    dlg.style.padding = "0"; dlg.style.border = "0"; dlg.style.width = "min(900px,94vw)";
    dlg.innerHTML = `
      <form method="dialog" style="display:flex;flex-direction:column;min-height:0;background:#0f172a;color:#e2e8f0;border:1px solid #1f2937;border-radius:14px;overflow:hidden">
        <div style="display:flex;align-items:center;justify-content:space-between;padding:12px 16px;background:#0b1220;border-bottom:1px solid #1f2937">
          <b>Select Item</b><button type="submit" class="btn">Close</button>
        </div>
        <div style="padding:12px 16px; display:grid; gap:10px; background:#0f172a">
          <input id="sd_picker_q" placeholder="Search code / name / barcode"
                 style="min-width:320px;background:#0b1220;color:#e2e8f0;border:1px solid #1f2937;border-radius:8px;padding:8px 10px;">
          <div style="overflow:auto; max-height:52vh; border:1px solid #1f2937; border-radius:10px">
            <table class="table" style="width:100%">
              <thead>
                <tr style="background:#0b1220"><th>SKU</th><th>Name</th><th class="r">On Hand</th><th class="r">Price</th><th></th></tr>
              </thead>
              <tbody id="sd_picker_rows"></tbody>
            </table>
          </div>
        </div>
      </form>`;
    document.body.appendChild(dlg);

    const rowsHtml = (list) => (list || []).map((it) => `
      <tr data-id="${it.id}">
        <td>${it.sku || it.code || ""}</td>
        <td>${it.name || ""}</td>
        <td class="r" data-oh="oh-${it.id}">…</td>
        <td class="r">${currency(it.sellPrice ?? 0)}</td>
        <td><button type="button" class="btn" data-pick="${it.id}">Add</button></td>
      </tr>
    `).join("");

    function wireList(list) {
      const tbody = dlg.querySelector("#sd_picker_rows");
      tbody.innerHTML = rowsHtml(list);
      tbody.querySelectorAll("[data-pick]").forEach((btn) => {
        btn.addEventListener("click", async (e) => {
          e.preventDefault(); e.stopPropagation();
          const it = list.find((x) => x.id === btn.dataset.pick);
          if (it) { addLineFromItem(it, 1); dlg.close(); }
        }, { capture: true });
      });
    }

    const base = items.slice();
    const q = dlg.querySelector("#sd_picker_q");
    q.oninput = () => {
      const s = (q.value || "").toLowerCase();
      wireList(base.filter((i) =>
        (i.sku || i.code || "").toLowerCase().includes(s) ||
        (i.name || "").toLowerCase().includes(s) ||
        String(i.barcode || "").toLowerCase().includes(s)
      ));
    };
    q.value = initialQuery; q.oninput();

    (async () => {
      for (const it of base) {
        const el = dlg.querySelector(`[data-oh="oh-${it.id}"]`);
        if (!el) continue;
        try { const bal = await balanceQty(it.id); el.textContent = (Number(it.openingQty) || 0) + bal; }
        catch { el.textContent = "—"; }
      }
    })();

    dlg.addEventListener("close", () => dlg.remove());
    dlg.showModal();
  }

  // ---------- draw ----------
  const draw = () => {
    body.innerHTML = `
      <div class="hd" style="display:flex;justify-content:space-between;align-items:center;gap:8px">
        <h3>${readOnly ? "View" : editing ? "View/Edit" : "New"} ${kind}${doc.status === "PROCESSED" ? " (Processed)" : ""}${readOnly && doc.status === "CONVERTED" ? " (Converted)" : ""}</h3>
        <div class="row" id="sd_actions" style="gap:8px">
          ${readOnly ? "" : `<input id="sd_code" placeholder="Enter/scan product code" style="min-width:220px">`}
          ${readOnly ? "" : `<button type="button" class="btn" id="sd_add">+ Add Item</button>`}
          <button type="button" class="btn" id="sd_pdf">PDF</button>
          ${editing && kind === "INVOICE" && doc.status === "PROCESSED" ? `<button type="button" class="btn" id="sd_credit">Credit</button>` : ""}
          ${!readOnly && editing && kind === "INVOICE" && doc.status !== "PROCESSED" ? `<button type="button" class="btn success" id="sd_process">Process</button>` : ""}
          ${!readOnly && editing && kind === "QUOTE" ? `<button type="button" class="btn" id="sd_convert">Convert → Sales Order</button>` : ""}
          ${!readOnly && editing && kind === "ORDER" ? `<button type="button" class="btn" id="sd_convert">Convert → Invoice</button>` : ""}
          ${!readOnly && editing && kind !== "INVOICE" ? `<button type="button" class="btn warn" id="sd_delete">Delete</button>` : ""}
          ${!readOnly ? `<button type="button" class="btn" id="sd_save">${editing ? "Save" : "Create"}</button>` : ""}
          <button type="button" class="btn" id="sd_close">Close</button>
        </div>
      </div>
      <div class="bd">
        <div class="form-grid" style="margin-bottom:10px">
          <label class="input"><span>No</span><input id="sd_no" value="${doc.no}" disabled></label>
          <label class="input"><span>Customer</span>${custSelectHtml}</label>
          <label class="input"><span>Date</span><input id="sd_date" type="date" value="${(doc.dates?.issue || "").slice(0, 10)}" ${readOnly ? "disabled" : ""}></label>
          <label class="input"><span>Due</span><input id="sd_due" type="date" value="${(doc.dates?.due || "").slice(0, 10)}" ${readOnly ? "disabled" : ""}></label>
          <label class="input"><span>Warehouse</span><input id="sd_wh" value="${doc.warehouseId || "WH1"}" ${readOnly ? "disabled" : ""}></label>
          <label class="input" style="grid-column:1/-1"><span>Notes</span><input id="sd_notes" value="${doc.notes || ""}" ${readOnly ? "disabled" : ""}></label>
        </div>

        <div style="overflow:auto;max-height:340px">
          <table class="table lines">
            <thead><tr><th>Item (ex VAT)</th><th>Qty</th><th>Unit Price</th><th>Disc %</th><th>VAT %</th><th>Total (inc)</th><th></th></tr></thead>
            <tbody id="sd_rows">
              ${lines.map((ln, i) => renderLineRow(ln, i, readOnly)).join("")}
            </tbody>
          </table>
        </div>

        <div class="row" style="justify-content:flex-end;gap:18px;margin-top:10px">
          <div><div class="sub">Sub Total</div><div id="sd_sub" class="r">${currency(doc.totals.subTotal)}</div></div>
          <div><div class="sub">VAT</div><div id="sd_tax" class="r">${currency(doc.totals.tax)}</div></div>
          <div><div class="sub"><b>Grand Total</b></div><div id="sd_tot" class="r"><b>${currency(doc.totals.grandTotal)}</b></div></div>
        </div>
      </div>`;
    m.showModal();

    const actions = $("#sd_actions");
    actions.querySelector("#sd_close").addEventListener("click", (e) => { e.preventDefault(); e.stopPropagation(); m.close(); });

    if (!readOnly) {
      actions.querySelector("#sd_add")?.addEventListener("click", (e) => { e.preventDefault(); e.stopPropagation(); openItemPicker(); });
      const codeEl = $("#sd_code");
      codeEl?.addEventListener("keydown", (e) => {
        if (e.key !== "Enter") return;
        e.preventDefault(); e.stopPropagation();
        const code = (codeEl.value || "").trim();
        if (!code) return;
        const matches = findMatchesByCode(code);
        if (matches.length === 1) { addLineFromItem(matches[0], 1); codeEl.value = ""; }
        else { openItemPicker({ initialQuery: code }); }
      });

      $("#sd_cust").onchange = () => (doc.customerId = $("#sd_cust").value);
      $("#sd_date").onchange = () => (doc.dates.issue = $("#sd_date").value);
      $("#sd_due").onchange = () => (doc.dates.due = $("#sd_due").value);
      $("#sd_wh").oninput = () => (doc.warehouseId = $("#sd_wh").value);
      $("#sd_notes").oninput = () => (doc.notes = $("#sd_notes").value);

      actions.querySelector("#sd_save").addEventListener("click", async (e) => {
        e.preventDefault(); e.stopPropagation();
        recalc();
        await put("docs", doc);

        if (editing) {
          const existing = await whereIndex("lines", "by_doc", doc.id);
          await Promise.all(existing.map((ln) => del("lines", ln.id)));
        }
        for (const ln of lines) { ln.docId = doc.id; await put("lines", ln); }

        toast(editing ? `${kind} updated` : `${kind} created`);
        m.close();
        renderSales(kind, { invoiceView: "active" });
      });

      const convertBtn = $("#sd_convert");
      if (convertBtn && kind === "QUOTE") {
        convertBtn.onclick = async (e) => {
          e.preventDefault(); e.stopPropagation();
          if (doc.convertedToId) { toast("Already converted to Sales Order"); m.close(); renderSales("QUOTE"); return; }
          if (!confirm("Convert this Quote to a Sales Order?")) return;
          const newId = randId();
          const soNo = await nextDocNo("ORDER");
          const issue = nowISO().slice(0, 10);
          const order = { id:newId,type:"ORDER",no:soNo,customerId:doc.customerId,warehouseId:doc.warehouseId||"WH1",dates:{issue,due:issue},totals:{subTotal:0,tax:0,grandTotal:0},notes:doc.notes||"",createdAt:nowISO(),sourceId:doc.id,sourceType:"QUOTE" };
          await put("docs", order);
          for (const ln of lines) await put("lines", { ...ln, id: randId(), docId: newId });
          const soLines = await whereIndex("lines", "by_doc", newId);
          const totals = sumDoc(soLines.map(l => ({ qty:l.qty, unitPrice:l.unitPrice??0, discountPct:l.discountPct??0, taxRate:l.taxRate??(settings.vatRate??15) })));
          order.totals = totals; await put("docs", order);
          doc.convertedToId = newId; doc.status = "CONVERTED"; doc.readOnly = true; await put("docs", doc);
          toast("Sales Order created from Quote"); m.close(); renderSales("QUOTE");
        };
      } else if (convertBtn && kind === "ORDER") {
        convertBtn.onclick = async (e) => {
          e.preventDefault(); e.stopPropagation();
          if (doc.convertedToId) { toast("Already converted to Invoice"); m.close(); renderSales("ORDER"); return; }
          if (!confirm("Convert this Sales Order to an Invoice?")) return;
          const newId = randId();
          const invNo = await nextDocNo("INVOICE");
          const issue = nowISO().slice(0, 10);
          let due = issue;
          try { const cust = doc.customerId ? await get("customers", doc.customerId) : null; const days = Number(cust?.termsDays) || 0; if (days > 0) { const dt = new Date(issue); dt.setDate(dt.getDate()+days); due = dt.toISOString().slice(0,10); } } catch {}
          const inv = { id:newId,type:"INVOICE",no:invNo,customerId:doc.customerId,warehouseId:doc.warehouseId||"WH1",dates:{issue,due},totals:{subTotal:0,tax:0,grandTotal:0},notes:doc.notes||"",createdAt:nowISO(),sourceId:doc.id,sourceType:"ORDER" };
          await put("docs", inv);
          for (const ln of lines) await put("lines", { ...ln, id: randId(), docId: newId });
          const invLines = await whereIndex("lines", "by_doc", newId);
          const totals = sumDoc(invLines.map(l => ({ qty:l.qty, unitPrice:l.unitPrice??0, discountPct:l.discountPct??0, taxRate:l.taxRate??(settings.vatRate??15) })));
          inv.totals = totals; await put("docs", inv);
          doc.convertedToId = newId; doc.status = "CONVERTED"; doc.readOnly = true; await put("docs", doc);
          toast("Invoice created from Sales Order"); m.close(); renderSales("ORDER");
        };
      }

      const delBtn = $("#sd_delete");
      if (delBtn) {
        delBtn.addEventListener("click", async (e) => {
          e.preventDefault(); e.stopPropagation();
          if (kind === "INVOICE") { toast("Customer invoices cannot be deleted. Use Credit instead.", "warn"); return; }
          if (!confirm(`Delete this ${kind}?`)) return;
          const exLines = await whereIndex("lines", "by_doc", doc.id);
          await Promise.all(exLines.map((l) => del("lines", l.id)));
          await del("docs", doc.id);
          toast(`${kind} deleted`); m.close(); renderSales(kind);
        });
      }

      const procBtn = $("#sd_process");
      if (procBtn) {
        procBtn.onclick = async (e) => {
          e.preventDefault(); e.stopPropagation();
          if (!confirm(`Process invoice ${doc.no}? This will finalize it.`)) return;
          try {
            await processInvoiceById(doc.id);
            m.close();
            location.hash = "#/invoices-processed";
          } catch (err) {
            console.error(err);
            alert(err?.message || err);
          }
        };
      }
    }

    actions.querySelector("#sd_pdf").addEventListener("click", async (e) => {
      e.preventDefault(); e.stopPropagation();
      try {
        const { title, html } = await window.getInvoiceHTML(doc.id, { doc, lines });
        let emailDraft = null; try { emailDraft = await getDocEmailDraft(doc.id, { doc, lines }); } catch {}
        window.showPdfOverlay?.(html, title, emailDraft ? { emailDraft } : {});
      } catch (err) { console.error(err); toast?.("PDF render failed"); }
    });

    document.getElementById("sd_credit")?.addEventListener("click", (e) => {
      e.preventDefault(); e.stopPropagation();
      try { window.openCreditNoteWizard(doc.id); } catch (err) { console.error(err); alert(err?.message || err); }
    });

    wireAllRows();
  };

  draw();
}

// Expose for router (primary API)
window.renderSales = renderSales;
window.renderQuotes = () => renderSales("QUOTE", { history: false });
window.renderQuotesHistory = () => renderSales("QUOTE", { history: true });
window.renderOrders = () => renderSales("ORDER", { history: false });
window.renderOrdersHistory = () => renderSales("ORDER", { history: true });
window.renderInvoices = () => renderSales("INVOICE", { invoiceView: "active" });
window.renderInvoicesProcessed = () => renderSales("INVOICE", { invoiceView: "processed" });
window.renderCreditNotes = renderCreditNotes;

// ---------------------------------------------------------------------------
// COMPAT SHIMS for legacy 52-sales-routes.js
// Provides `renderSalesList` and `renderSalesDocuments` so older wrappers don't throw.
// ---------------------------------------------------------------------------
(function salesCompatShims(){
  if (typeof window.renderSalesList !== "function") {
    window.renderSalesList = function renderSalesList(section) {
      const s = (typeof section === "string"
        ? section
        : (section && (section.section || section.path)) || (location.hash || "").replace(/^#\//,'')
      ).toLowerCase();

      if (/^quotes-history/.test(s) || s === "quotes-history") return window.renderSales("QUOTE", { history: true });
      if (/^quotes/.test(s) || s === "quotes") return window.renderSales("QUOTE", { history: false });
      if (/^orders-history/.test(s) || s === "orders-history") return window.renderSales("ORDER", { history: true });
      if (/^orders/.test(s) || s === "orders") return window.renderSales("ORDER", { history: false });
      if (/^invoices-processed/.test(s) || s === "invoices-processed") return window.renderSales("INVOICE", { invoiceView: "processed" });
      if (/^(credit-notes|invoices-credited)/.test(s)) return window.renderCreditNotes();
      // default
      return window.renderSales("INVOICE", { invoiceView: "active" });
    };
  }

  if (typeof window.renderSalesDocuments !== "function") {
    window.renderSalesDocuments = function renderSalesDocuments(opts = {}) {
      const type = (opts.type || opts.kind || "INVOICE").toUpperCase();
      const view = (opts.view || (type === "INVOICE" ? "active" : null))?.toLowerCase();
      const history = !!opts.history;

      if (type === "QUOTE") return window.renderSales("QUOTE", { history });
      if (type === "ORDER") return window.renderSales("ORDER", { history });
      return window.renderSales("INVOICE", { invoiceView: (view === "processed" ? "processed" : "active") });
    };
  }
})();
