// ===========================================================================
// 50-sales-documents-quotes-orders-invoices.js
// Sales Documents (Quotes / Orders / Invoices), item picker, conversions.
// Credits: processed, read-only SCN (no editing), printable & emailable.
//
// Depends on: 01-db.js, 02-helpers.js
// Works with: 60-pdf.js (getInvoiceHTML + getDocEmailDraft)
// ===========================================================================

const __CREDIT_CFG = {
  CUSTOMER_INVOICE_TYPES: new Set(["INVOICE"]), // add "SINV" if you use it
  CREDIT_DOC_TYPE: "SCN",
  MOVEMENT_TYPE: "SALE_RETURN",
};

// ---------- Lightweight document overlay (inline preview) ----------
(function () {
  if (window.showPdfOverlay) return; // singleton

  window.showPdfOverlay = function showPdfOverlay(html, title, opts = {}) {
    const host = document.getElementById("modal") || document.body;

    // Remove any existing overlay first (clean reopen)
    document.getElementById("doc_overlay_portal")?.remove();

    const overlay = document.createElement("div");
    overlay.id = "doc_overlay_portal";
    overlay.style.cssText = `
      position: fixed; inset: 0; background: rgba(0,0,0,.45);
      display:flex; align-items:center; justify-content:center; z-index:2147483647;`;
    overlay.innerHTML = `
      <div class="card" style="width:min(900px,96vw);height:min(90vh,900px);display:flex;flex-direction:column;overflow:hidden">
        <div class="hd" style="display:flex;justify-content:space-between;align-items:center;gap:8px">
          <b>${title || "Document"}</b>
          <div class="row" style="gap:8px">
            ${opts.emailDraft ? `<button type="button" class="btn" id="doc_email">Email</button>` : ""}
            <button type="button" class="btn" id="doc_print">Print</button>
            <button type="button" class="btn" id="doc_newtab">Open in new tab</button>
            <button type="button" class="btn" id="doc_close">Close</button>
          </div>
        </div>
        <div class="bd" style="flex:1;overflow:hidden">
          <iframe id="doc_iframe" style="width:100%;height:100%;border:0;background:#fff"></iframe>
        </div>
      </div>`;
    host.appendChild(overlay);

    const iframe = overlay.querySelector("#doc_iframe");
    const idoc = iframe.contentDocument;
    try { idoc.open(); idoc.write(html); idoc.close(); } catch (e) { console.error(e); }

    overlay.querySelector("#doc_print").onclick = () => {
      try { iframe.contentWindow.focus(); iframe.contentWindow.print(); } catch (e) { console.error(e); }
    };
    overlay.querySelector("#doc_newtab").onclick = () => {
      const w = window.open("", "_blank", "noopener");
      if (w) { w.document.open(); w.document.write(html); w.document.close(); }
    };
    overlay.querySelector("#doc_close").onclick = () => overlay.remove();

    if (opts.emailDraft) {
      overlay.querySelector("#doc_email").onclick = () => {
        const { to, subject, body } = opts.emailDraft;
        const mailto = [
          "mailto:",
          encodeURIComponent(to || ""),
          "?subject=",
          encodeURIComponent(subject || ""),
          "&body=",
          encodeURIComponent(body || "")
        ].join("");
        window.location.href = mailto;
      };
    }
  };
})();

// ===========================================================================
// Credits (SCN) — processed, read-only; print/email; never editable
// Public: window.openCreditNoteWizard(invoiceId)
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
    const lines = await whereIndex("lines", "by_doc", inv.id);
    return { inv, lines };
  }

  // Snapshot remaining per line (handles repeated items across lines)
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

    // Build SCN lines (negative qty)
    const creditLines = [];
    for (const ln of lines) {
      const qToCredit = Number(creditQtyByLineId[ln.id] || 0);
      if (!qToCredit) continue;
      creditLines.push({
        id: randId(),
        docId: null, // set after SCN doc is created
        itemId: ln.itemId,
        itemName: ln.itemName,
        qty: -Math.abs(qToCredit),       // negative on the doc
        unitPrice: Number(ln.unitPrice ?? ln.unitCost ?? 0),
        discountPct: Number(ln.discountPct ?? 0),
        taxRate: Number(ln.taxRate ?? vatDefault),
        sourceLineId: ln.id,
      });
    }

    if (!creditLines.length) throw new Error("No quantities selected to credit.");

    // Totals (negative)
    const totals = calcTotalsForLines(creditLines, vatDefault);

    // Create SCN doc (read-only + processed)
    const scn = {
      id: randId(),
      type: __CREDIT_CFG.CREDIT_DOC_TYPE,
      no: await nextDocNo(__CREDIT_CFG.CREDIT_DOC_TYPE),
      customerId: inv.customerId,
      warehouseId: inv.warehouseId || "WH1",
      dates: { issue: nowISO().slice(0,10) },
      status: "PROCESSED",
      readOnly: true,                  // <- ensure not editable if ever opened
      relatedDocId: inv.id,
      createdAt: nowISO(),
      processedAt: nowISO(),
      totals,                          // negative values expected
      notes: `Credit for ${inv.type} ${inv.no}`,
    };
    await put("docs", scn);

    // Persist lines
    for (const cl of creditLines) { cl.docId = scn.id; await put("lines", cl); }

    // Write stock return movements (qtyDelta > 0 puts stock back)
    for (const cl of creditLines) {
      const qty = Math.abs(cl.qty);
      if (qty <= 0) continue;
      await add("movements", {
        id: randId(),
        itemId: cl.itemId,
        warehouseId: scn.warehouseId || "WH1",
        type: __CREDIT_CFG.MOVEMENT_TYPE,
        qtyDelta: qty,
        relatedDocId: scn.id,
        timestamp: nowISO(),
        note: `${__CREDIT_CFG.CREDIT_DOC_TYPE} ${scn.no} ${cl.itemId || ""}`,
      });
    }

    // Record adjustment to reduce customer balance (if adjustments store exists)
    try {
      await add("adjustments", {
        id: randId(),
        kind: "CUSTOMER_CREDIT",
        customerId: inv.customerId,
        docId: scn.id,
        relatedDocId: inv.id,
        amount: Math.abs(totals.grandTotal || 0), // positive amount reduces balance
        createdAt: nowISO(),
      });
    } catch { /* optional store */ }

    // Build preview + email draft and show overlay
    try {
      const { title, html } = await getInvoiceHTML(scn.id, { doc: scn, lines: creditLines });
      const draft = await getDocEmailDraft(scn.id, { doc: scn, lines: creditLines });
      window.showPdfOverlay?.(html, title, { emailDraft: draft });
    } catch (e) {
      console.warn("[SCN] overlay/email failed; falling back to window:", e);
      try { await downloadInvoicePDF(scn.id, { doc: scn, lines: creditLines }); } catch {}
    }

    toast?.(`Credit Note ${scn.no} created`, "success");
    return scn;
  }

  // Wizard to choose credit quantities; after create → preview/email only (no editor)
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
          <td class="r"><input type="number" min="0" step="0.001" value="${remaining}" data-qty style="width:110px"></td>
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
        <div class="sub">Adjust quantities to credit (default = remaining). Prices, VAT and discounts mirror the invoice.</div>
        <div style="max-height:52vh;overflow:auto;margin-top:8px">
          <table class="table">
            <thead>
              <tr><th>Item</th><th class="r">Invoiced</th><th class="r">Remaining</th><th class="r">Credit Qty</th></tr>
            </thead>
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
        // Stay on the invoice; the SCN is processed and only shown as preview/email
        m.close();
        window.renderInvoices?.();
      } catch (e) {
        console.error(e);
        alert(e?.message || e);
      }
    };

    m.showModal();
  };
})();

// ===========================================================================
// Sales list + forms (Quotes / Orders / Invoices) + item picker + credited toggle
// ===========================================================================

async function renderSales(kind = "INVOICE", opts = {}) {
  const credited = !!opts.credited;      // for Invoices: show only those with credits
  const history = !!opts.history;        // for Quotes/Orders older/converted
  const v = $("#view");
  if (!v) return;

  const allDocs = await all("docs");
  let docs = (allDocs || []).filter((d) => d.type === kind);

  // For INVOICE: credited toggle
  if (kind === "INVOICE") {
    const credits = (allDocs || []).filter(d => d.type === __CREDIT_CFG.CREDIT_DOC_TYPE);
    const creditedSet = new Set(credits.map(c => c.relatedDocId).filter(Boolean));
    if (credited) {
      docs = docs.filter(d => creditedSet.has(d.id));
    } else {
      docs = docs.filter(d => !creditedSet.has(d.id));
    }
  }

  // Active vs History split for Quotes/Orders
  if (kind === "QUOTE" || kind === "ORDER") {
    if (history) {
      docs = docs.filter((d) => d.status === "CONVERTED" || d.readOnly || d.convertedToId);
    } else {
      docs = docs.filter((d) => !(d.status === "CONVERTED" || d.readOnly || d.convertedToId));
    }
  }

  docs.sort((a, b) => (b.dates?.issue || "").localeCompare(a.dates?.issue || ""));

  const customers = await all("customers");
  const cname = (id) => customers.find((c) => c.id === id)?.name || "—";

  const isQuotes = kind === "QUOTE";
  const isOrders = kind === "ORDER";
  const isInvoices = kind === "INVOICE";
  const label =
    isQuotes ? (history ? "Quotes History" : "Quotes")
    : isOrders ? (history ? "Sales Order History" : "Sales Orders")
    : (credited ? "Credited Invoices" : "Invoices");

  v.innerHTML = `
  <div class="card">
    <div class="hd">
      <b>${label}</b>
      <div class="toolbar">
        <input id="d_search" placeholder="Search no / customer" style="min-width:240px">
        ${
          isQuotes
            ? (history
                ? `<button type="button" class="btn" id="d_back_active">Active Quotes</button>`
                : `<button type="button" class="btn" id="d_history">Quotes History</button>
                   <button type="button" class="btn primary" id="d_new">+ New Quote</button>`)
            : isOrders
            ? (history
                ? `<button type="button" class="btn" id="d_back_orders">Active Orders</button>`
                : `<button type="button" class="btn" id="d_orders_history">Sales Order History</button>
                   <button type="button" class="btn primary" id="d_new">+ New Order</button>`)
            : (credited
                ? `<button type="button" class="btn" id="d_invoices_active">Active Invoices</button>`
                : `<button type="button" class="btn" id="d_invoices_credited">Credited Invoices</button>
                   <button type="button" class="btn primary" id="d_new">+ New Invoice</button>`)
        }
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

  // Search
  $("#d_search").oninput = () => {
    const q = ($("#d_search").value || "").toLowerCase();
    $$("#d_rows tr").forEach((tr) => {
      tr.style.display = tr.textContent.toLowerCase().includes(q) ? "" : "none";
    });
  };

  // Toolbar nav
  $("#d_history")?.addEventListener("click", () => (location.hash = "#/quotes-history"));
  $("#d_back_active")?.addEventListener("click", () => (location.hash = "#/quotes"));
  $("#d_orders_history")?.addEventListener("click", () => (location.hash = "#/orders-history"));
  $("#d_back_orders")?.addEventListener("click", () => (location.hash = "#/orders"));
  $("#d_invoices_credited")?.addEventListener("click", () => (location.hash = "#/invoices-credited"));
  $("#d_invoices_active")?.addEventListener("click", () => (location.hash = "#/invoices"));

  // New
  $("#d_new")?.addEventListener("click", () => openDocForm(kind));

  // View
  $$("#d_rows [data-view]").forEach((b) =>
    (b.onclick = () => {
      const ro = history && (isQuotes || isOrders);
      openDocForm(kind, b.dataset.view, { readOnly: ro });
    })
  );
}

async function openDocForm(kind, docId, opts = {}) {
  const editing = !!docId;
  const existing = editing ? await get("docs", docId) : null;

  // Customers: exclude archived for new docs (show archived if doc uses one)
  const allCustomers = (await all("customers")) || [];
  const activeCustomers = allCustomers.filter((c) => !c.archived);

  const settingsRec = await get("settings", "app");
  const settings = settingsRec?.value || {};
  const allItemsRaw = await all("items");

  // Normalize items
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
    !!opts.readOnly || doc.status === "CONVERTED" || !!doc.readOnly || !!doc.convertedToId;

  const m = $("#modal"), body = $("#modalBody");
  if (!m || !body) {
    console.error("[SalesDoc] Modal elements #modal/#modalBody not found.");
    return;
  }

  // ---------- helpers ----------
  const custOptsActive = activeCustomers
    .map(
      (c) => `<option value="${c.id}" ${c.id === doc.customerId ? "selected" : ""}>${c.name}</option>`
    )
    .join("");

  const custArchivedOption =
    customerIsArchived
      ? `<option value="${theCustomer.id}" selected disabled>${theCustomer.name} (archived)</option>`
      : "";

  const custSelectHtml = `
    <select id="sd_cust" ${readOnly ? "disabled" : ""}>
      ${custArchivedOption}${custOptsActive}
    </select>`;

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
        qty: ln.qty, unitPrice: ln.unitPrice ?? 0, discountPct: ln.discountPct, taxRate: ln.taxRate ?? settings.vatRate ?? 15
      }).incTax)}</td>
      <td></td>
    </tr>`
      : `
    <tr data-idx="${idx}">
      <td>${ln.itemName || ""}</td>
      <td><input type="number" step="0.001" min="0" value="${ln.qty || 0}" data-edit="qty"></td>
      <td><input type="number" step="0.01"  min="0" value="${ln.unitPrice ?? 0}" data-edit="unitPrice"></td>
      <td><input type="number" step="0.01"  min="0" value="${ln.discountPct || 0}" data-edit="discountPct"></td>
      <td><input type="number" step="0.01"  min="0" value="${ln.taxRate ?? settings.vatRate ?? 15}" data-edit="taxRate"></td>
      <td class="r">${currency(calcLineTotals({
        qty: ln.qty, unitPrice: ln.unitPrice ?? 0, discountPct: ln.discountPct, taxRate: ln.taxRate ?? 15
      }).incTax)}</td>
      <td><button type="button" class="btn warn" data-del="${idx}">×</button></td>
    </tr>`;

  const recalc = () => {
    const t = sumDoc(
      lines.map((ln) => ({
        qty: ln.qty,
        unitPrice: ln.unitPrice ?? 0,
        discountPct: ln.discountPct,
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
          discountPct: lines[idx].discountPct,
          taxRate: lines[idx].taxRate ?? settings.vatRate ?? 15,
        }).incTax;
        const totalCell = tr.querySelector(".r");
        if (totalCell) totalCell.textContent = currency(t);
        recalc();
      };
    });
    const del = tr.querySelector("[data-del]");
    if (del) {
      del.onclick = () => {
        lines.splice(idx, 1);
        const tbody = document.getElementById("sd_rows");
        if (tbody) {
          tbody.innerHTML = lines.map((ln, i) => renderLineRow(ln, i, readOnly)).join("");
          if (!readOnly) wireAllRows();
          recalc();
        }
      };
    }
  }

  function wireAllRows() {
    if (readOnly) return;
    const tbody = document.getElementById("sd_rows");
    if (!tbody) return;
    tbody.querySelectorAll("tr[data-idx]").forEach(wireRowEvents);
  }

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
    draw();
    recalc();
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

  // ---- Item Picker Overlay (sales) ----
  function openItemPicker(opts = {}) {
    const initialQuery = (opts.initialQuery || "").toLowerCase();
    const host = document.getElementById("modal") || document.body;

    document.getElementById("sd_picker_overlay")?.remove();

    const wrap = document.createElement("div");
    wrap.id = "sd_picker_overlay";
    wrap.tabIndex = -1;
    wrap.style.cssText = `
      position:fixed; inset:0; z-index:100000;
      background:rgba(2,6,23,.85);
      display:flex; align-items:center; justify-content:center;
    `;
    wrap.addEventListener("keydown", (e) => e.stopPropagation(), { capture: true });

    const card = document.createElement("div");
    card.style.cssText = `
      width:min(900px,94vw); max-height:80vh;
      background:#0f172a; color:#e2e8f0;
      border:1px solid #1f2937; border-radius:14px;
      box-shadow:0 20px 60px rgba(0,0,0,.55);
      display:flex; flex-direction:column; overflow:hidden;
    `;
    card.innerHTML = `
      <div style="display:flex;align-items:center;justify-content:space-between;padding:12px 16px;background:#0b1220;border-bottom:1px solid #1f2937">
        <b>Select Item</b>
        <button type="button" class="btn" id="sd_picker_close">Close</button>
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
    `;
    wrap.appendChild(card);
    host.appendChild(wrap);

    const close = () => wrap.remove();
    document.getElementById("sd_picker_close").onclick = (e) => { e.preventDefault(); e.stopPropagation(); close(); };

    function rowsHtml(list) {
      return (list || []).map((it) => `
        <tr data-id="${it.id}">
          <td>${it.sku || it.code || ""}</td>
          <td>${it.name || ""}</td>
          <td class="r" data-oh="oh-${it.id}">…</td>
          <td class="r">${currency(it.sellPrice ?? 0)}</td>
          <td><button type="button" class="btn" data-pick="${it.id}">Add</button></td>
        </tr>
      `).join("");
    }

    function wireList(list) {
      const tbody = document.getElementById("sd_picker_rows");
      if (!tbody) return;
      tbody.innerHTML = rowsHtml(list);
      tbody.querySelectorAll("[data-pick]").forEach((btn) => {
        btn.addEventListener("click", async (e) => {
          e.preventDefault();
          e.stopPropagation();
          const it = list.find((x) => x.id === btn.dataset.pick);
          if (it) {
            addLineFromItem(it, 1);
            close();
          }
        }, { capture: true });
      });
    }

    const base = items.slice();
    const q = document.getElementById("sd_picker_q");
    const doSearch = () => {
      const s = (q.value || "").toLowerCase();
      const filtered = base.filter((i) =>
        (i.sku || i.code || "").toLowerCase().includes(s) ||
        (i.name || "").toLowerCase().includes(s) ||
        String(i.barcode || "").toLowerCase().includes(s)
      );
      wireList(filtered);
    };
    q.oninput = doSearch;
    q.value = initialQuery;
    doSearch();

    // Fill on-hand
    (async () => {
      for (const it of base) {
        const el = wrap.querySelector(`[data-oh="oh-${it.id}"]`);
        if (!el) continue;
        try {
          const bal = await balanceQty(it.id);
          el.textContent = (Number(it.openingQty) || 0) + bal;
        } catch { el.textContent = "—"; }
      }
    })();
  }

  // ---------- draw ----------
  const draw = () => {
    body.innerHTML = `
      <div class="hd" style="display:flex;justify-content:space-between;align-items:center;gap:8px">
        <h3>${readOnly ? "View" : editing ? "View/Edit" : "New"} ${kind}${readOnly && doc.status === "CONVERTED" ? " (Converted)" : ""}</h3>
        <div class="row" id="sd_actions" style="gap:8px">
          ${readOnly ? "" : `<input id="sd_code" placeholder="Enter/scan product code" style="min-width:220px">`}
          ${readOnly ? "" : `<button type="button" class="btn" id="sd_add">+ Add Item</button>`}
          <button type="button" class="btn" id="sd_pdf">PDF</button>
          ${editing && kind === "INVOICE" ? `<button type="button" class="btn" id="sd_credit">Credit</button>` : ""}
          ${!readOnly && editing && kind === "QUOTE" ? `<button type="button" class="btn" id="sd_convert">Convert → Sales Order</button>` : ""}
          ${!readOnly && editing && kind === "ORDER" ? `<button type="button" class="btn" id="sd_convert">Convert → Invoice</button>` : ""}
          ${!readOnly && editing && kind !== "INVOICE" ? `<button type="button" class="btn warn" id="sd_delete">Delete</button>` : ""}
          ${!readOnly ? `<button type="button" class="btn success" id="sd_save">${editing ? "Save" : "Create"}</button>` : ""}
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

    // Close
    actions.querySelector("#sd_close").addEventListener("click", (e) => {
      e.preventDefault(); e.stopPropagation(); m.close();
    });

    if (!readOnly) {
      // Add item & code entry
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

      // Save / Create
      actions.querySelector("#sd_save").addEventListener("click", async (e) => {
        e.preventDefault(); e.stopPropagation();
        recalc();
        await put("docs", doc);

        if (editing) {
          const existing = await whereIndex("lines", "by_doc", doc.id);
          await Promise.all(existing.map((ln) => del("lines", ln.id)));
        }
        for (const ln of lines) { ln.docId = doc.id; await put("lines", ln); }
        if (kind === "INVOICE" && typeof adjustStockOnInvoice === "function") {
          await adjustStockOnInvoice(doc, lines);
        }
        toast(editing ? `${kind} updated` : `${kind} created`);
        m.close();
        renderSales(kind); // stay in the current list section
      });

      // Convert buttons
      const convertBtn = $("#sd_convert");
      if (convertBtn && kind === "QUOTE") {
        convertBtn.onclick = async (e) => {
          e.preventDefault(); e.stopPropagation();
          if (doc.convertedToId) { toast("Already converted to Sales Order"); m.close(); renderSales("QUOTE"); return; }
          if (!confirm("Convert this Quote to a Sales Order?")) return;

          const newId = randId();
          const soNo = await nextDocNo("ORDER");
          const issue = nowISO().slice(0, 10);
          const order = {
            id: newId, type: "ORDER", no: soNo,
            customerId: doc.customerId, warehouseId: doc.warehouseId || "WH1",
            dates: { issue, due: issue }, totals: { subTotal: 0, tax: 0, grandTotal: 0 },
            notes: doc.notes || "", createdAt: nowISO(), sourceId: doc.id, sourceType: "QUOTE",
          };
          await put("docs", order);
          for (const ln of lines) await put("lines", { ...ln, id: randId(), docId: newId });

          const soLines = await whereIndex("lines", "by_doc", newId);
          const totals = sumDoc(soLines.map(l => ({
            qty: l.qty, unitPrice: l.unitPrice ?? 0, discountPct: l.discountPct, taxRate: l.taxRate ?? (settings.vatRate ?? 15),
          })));
          order.totals = totals; await put("docs", order);

          doc.convertedToId = newId; doc.status = "CONVERTED"; doc.readOnly = true; await put("docs", doc);

          toast("Sales Order created from Quote");
          m.close(); renderSales("QUOTE");
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
          try {
            const cust = doc.customerId ? await get("customers", doc.customerId) : null;
            const days = Number(cust?.termsDays) || 0;
            if (days > 0) { const d = new Date(issue); d.setDate(d.getDate() + days); due = d.toISOString().slice(0, 10); }
          } catch (_) {}

          const inv = {
            id: newId, type: "INVOICE", no: invNo,
            customerId: doc.customerId, warehouseId: doc.warehouseId || "WH1",
            dates: { issue, due }, totals: { subTotal: 0, tax: 0, grandTotal: 0 },
            notes: doc.notes || "", createdAt: nowISO(), sourceId: doc.id, sourceType: "ORDER",
          };
          await put("docs", inv);
          for (const ln of lines) await put("lines", { ...ln, id: randId(), docId: newId });

          const invLines = await whereIndex("lines", "by_doc", newId);
          const totals = sumDoc(invLines.map(l => ({
            qty: l.qty, unitPrice: l.unitPrice ?? 0, discountPct: l.discountPct, taxRate: l.taxRate ?? (settings.vatRate ?? 15),
          })));
          inv.totals = totals; await put("docs", inv);

          doc.convertedToId = newId; doc.status = "CONVERTED"; doc.readOnly = true; await put("docs", doc);

          toast("Invoice created from Sales Order");
          m.close(); renderSales("ORDER");
        };
      }

      // Delete (hidden for INVOICE; guard anyway)
      const delBtn = $("#sd_delete");
      if (delBtn) {
        delBtn.addEventListener("click", async (e) => {
          e.preventDefault(); e.stopPropagation();
          if (kind === "INVOICE") {
            toast("Customer invoices cannot be deleted. Use Credit instead.", "warn");
            return;
          }
          if (!confirm(`Delete this ${kind}?`)) return;

          const exLines = await whereIndex("lines", "by_doc", doc.id);
          await Promise.all(exLines.map((l) => del("lines", l.id)));
          await del("docs", doc.id);

          toast(`${kind} deleted`);
          m.close();
          renderSales(kind);
        });
      }
    }

    // PDF
    actions.querySelector("#sd_pdf").addEventListener("click", async (e) => {
      e.preventDefault(); e.stopPropagation();
      try {
        const { title, html } = await window.getInvoiceHTML(doc.id, { doc, lines });
        // Also offer email from here (nice bonus)
        let emailDraft = null;
        try { emailDraft = await getDocEmailDraft(doc.id, { doc, lines }); } catch {}
        window.showPdfOverlay?.(html, title, emailDraft ? { emailDraft } : {});
      } catch (err) { console.error(err); toast?.("PDF render failed"); }
    });

    // Credit (Invoices) — creates processed, read-only SCN; preview/email only
    document.getElementById("sd_credit")?.addEventListener("click", (e) => {
      e.preventDefault(); e.stopPropagation();
      try { window.openCreditNoteWizard(doc.id); }
      catch (err) { console.error(err); alert(err?.message || err); }
    });

    wireAllRows();
  };

  draw();
}

// Expose for router
window.renderSales = renderSales;
window.renderSalesDocuments = renderSales;
window.renderSalesList = renderSales;

window.renderQuotes = () => renderSales("QUOTE", { history: false });
window.renderQuotesHistory = () => renderSales("QUOTE", { history: true });
window.renderOrders = () => renderSales("ORDER", { history: false });
window.renderOrdersHistory = () => renderSales("ORDER", { history: true });
window.renderInvoices = () => renderSales("INVOICE", { credited: false });
window.renderInvoicesCredited = () => renderSales("INVOICE", { credited: true });
