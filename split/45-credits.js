// ============================================================================
// 45-credits.js — Sales Credit Notes (SCN) + Delete lock for customer invoices
// Depends on: 01-db.js, 02-helpers.js, 60-pdf.js (for getInvoiceHTML)
// Exposes: window.openCreditNoteWizard(invoiceId), window.createCreditNoteFromInvoice(invoiceId, map)
// ============================================================================

(function () {
  // --- Config ----------------------------------------------------------------
  const CUSTOMER_INVOICE_TYPES = new Set(["SINV", "INV"]); // change if your type differs
  const CREDIT_DOC_TYPE = "SCN";                           // Sales Credit Note
  const MOVEMENT_TYPE = "SALE_RETURN";                     // movements.type for stock return

  // --- Local modal helpers ---------------------------------------------------
  function ensureAppModal() {
    const m = document.getElementById("modal");
    const body = document.getElementById("modalBody");
    return (m && body) ? { m, body } : { m: null, body: null };
  }

  function ensurePdfModal() {
    let dlg = document.getElementById("pdf_modal");
    if (!dlg) {
      dlg = document.createElement("dialog");
      dlg.id = "pdf_modal";
      dlg.style.cssText = "width:min(980px,96vw);max-width:96vw;padding:0;border:none;border-radius:12px;overflow:hidden";
      document.body.appendChild(dlg);
    }
    return dlg;
  }

  function openHtmlInPdfModal({ html, title = "Document" }) {
    const dlg = ensurePdfModal();
    dlg.innerHTML = `
      <div style="display:flex;align-items:center;justify-content:space-between;padding:10px 14px;background:#0b1220;color:#e5e7eb">
        <div style="font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${title}</div>
        <div style="display:flex;gap:8px">
          <button id="pdf_print" class="btn">Print / Save as PDF</button>
          <button id="pdf_tab" class="btn">Open in new tab</button>
          <button id="pdf_close" class="btn">Close</button>
        </div>
      </div>
      <div style="height:80vh;background:#111827">
        <iframe id="pdf_iframe" style="width:100%;height:100%;border:0" title="PDF Preview"></iframe>
      </div>
    `;
    const iframe = dlg.querySelector("#pdf_iframe");
    iframe.srcdoc = html;
    dlg.querySelector("#pdf_print").onclick = () => { try { iframe.contentWindow?.focus(); iframe.contentWindow?.print(); } catch {} };
    dlg.querySelector("#pdf_tab").onclick = () => { const w = window.open("", "_blank", "noopener"); if (w) { w.document.open(); w.document.write(html); w.document.close(); } };
    dlg.querySelector("#pdf_close").onclick = () => dlg.close();
    if (!dlg.open) dlg.showModal();
  }

  // --- Data helpers ----------------------------------------------------------
  async function loadInvoice(invoiceId) {
    const inv = await get("docs", invoiceId);
    if (!inv) throw new Error("Invoice not found");
    if (!CUSTOMER_INVOICE_TYPES.has(inv.type)) throw new Error("Not a customer invoice");
    const lines = await whereIndex("lines", "by_doc", inv.id);
    return { inv, lines };
  }

  async function alreadyCreditedQtyMap(invoiceId) {
    // Sum all SCN lines linked to this invoice (by relatedDocId) per original itemId
    const docs = await all("docs");
    const credits = docs.filter(d => d.type === CREDIT_DOC_TYPE && d.relatedDocId === invoiceId);
    const map = new Map(); // itemId -> qty credited (positive)
    for (const scn of credits) {
      const cls = await whereIndex("lines", "by_doc", scn.id);
      for (const ln of cls) {
        const k = ln.itemId;
        const q = Math.abs(Number(ln.qty) || 0);
        map.set(k, (map.get(k) || 0) + q);
      }
    }
    return map;
  }

  function calcTotalsForLines(lines, vatDefault = 15) {
    // Reuse your sumDoc if present (it handles discount & tax)
    return sumDoc(lines.map(ln => ({
      qty: ln.qty,
      unitPrice: ln.unitPrice ?? ln.unitCost ?? 0,
      discountPct: ln.discountPct ?? 0,
      taxRate: ln.taxRate ?? vatDefault,
    })));
  }

  // --- Core: create the Credit Note and process it --------------------------
  async function createCreditNoteFromInvoice(invoiceId, creditQtyByLineId) {
    const { inv, lines } = await loadInvoice(invoiceId);
    const settings = (await get("settings", "app"))?.value || {};
    const vatDefault = settings.vatRate ?? 15;

    // Build credit lines (qty negative to make totals negative)
    const creditLines = [];
    for (const ln of lines) {
      const qToCredit = Number(creditQtyByLineId[ln.id] || 0);
      if (!qToCredit) continue;

      const newLn = {
        id: randId(),
        docId: null, // set after doc is created
        itemId: ln.itemId,
        itemName: ln.itemName,
        qty: -Math.abs(qToCredit),                                 // NEGATIVE for credit
        unitPrice: Number(ln.unitPrice ?? ln.unitCost ?? 0),        // keep original price
        discountPct: Number(ln.discountPct ?? 0),
        taxRate: Number(ln.taxRate ?? vatDefault),
      };
      creditLines.push(newLn);
    }

    if (!creditLines.length) throw new Error("No quantities selected to credit.");

    // Totals (negative)
    const totals = calcTotalsForLines(creditLines, vatDefault);

    // Create SCN doc
    const scn = {
      id: randId(),
      type: CREDIT_DOC_TYPE,
      no: await nextDocNo(CREDIT_DOC_TYPE),
      customerId: inv.customerId,
      warehouseId: inv.warehouseId || "WH1",
      dates: { issue: nowISO().slice(0,10) },
      status: "PROCESSED",
      relatedDocId: inv.id,
      createdAt: nowISO(),
      processedAt: nowISO(),
      totals, // negative values expected
      notes: `Credit for ${inv.type} ${inv.no}`,
    };
    await put("docs", scn);

    // Persist lines
    for (const cl of creditLines) {
      cl.docId = scn.id;
      await put("lines", cl);
    }

    // Write stock return movements (qtyDelta > 0)
    for (const cl of creditLines) {
      const qty = Math.abs(cl.qty); // positive qty returned
      if (qty <= 0) continue;
      await add("movements", {
        id: randId(),
        itemId: cl.itemId,
        warehouseId: scn.warehouseId || "WH1",
        type: MOVEMENT_TYPE,
        qtyDelta: qty,                   // return to stock
        relatedDocId: scn.id,
        timestamp: nowISO(),
        note: `${CREDIT_DOC_TYPE} ${scn.no} ${cl.itemId || ""}`,
      });
    }

    // Record a financial adjustment so statements/outstandings can net this off
    try {
      await add("adjustments", {
        id: randId(),
        kind: "CUSTOMER_CREDIT",
        customerId: inv.customerId,
        docId: scn.id,
        relatedDocId: inv.id,
        amount: Math.abs(totals.grandTotal || 0), // positive amount that reduces balance
        createdAt: nowISO(),
      });
    } catch { /* store may not exist yet; safe to ignore */ }

    // PDF preview
    try {
      const data = await getInvoiceHTML(scn.id, { doc: scn, lines: creditLines });
      openHtmlInPdfModal({ html: data.html, title: data.title });
    } catch (e) {
      console.warn("[SCN] PDF preview failed, falling back:", e);
      try { await downloadInvoicePDF(scn.id, { doc: scn, lines: creditLines }); } catch {}
    }

    toast(`Credit Note ${scn.no} created`, "success");
    return scn;
  }
  window.createCreditNoteFromInvoice = createCreditNoteFromInvoice;

  // --- Wizard UI -------------------------------------------------------------
  async function openCreditNoteWizard(invoiceId) {
    const { inv, lines } = await loadInvoice(invoiceId);
    const creditedMap = await alreadyCreditedQtyMap(inv.id);
    const { m, body } = ensureAppModal();
    if (!m || !body) throw new Error("Modal container not found");

    const rows = lines.map(ln => {
      const invoiced = Number(ln.qty) || 0;
      const alreadyCred = creditedMap.get(ln.itemId) || 0;
      const remaining = Math.max(0, Math.abs(invoiced) - alreadyCred); // invoiced likely positive
      return `
        <tr data-line="${ln.id}" data-item="${ln.itemId}">
          <td>${ln.itemName || ln.itemId || ""}</td>
          <td class="r">${invoiced}</td>
          <td class="r">${alreadyCred}</td>
          <td class="r">${remaining}</td>
          <td class="r"><input type="number" min="0" step="0.001" value="${remaining}" data-qty></td>
        </tr>`;
    }).join("");

    body.innerHTML = `
      <div class="hd" style="display:flex;justify-content:space-between;align-items:center">
        <h3>Create Credit Note for ${inv.type} ${inv.no}</h3>
        <div class="row">
          <button class="btn success" id="scn_create">Create Credit</button>
          <button class="btn" id="scn_close">Close</button>
        </div>
      </div>
      <div class="bd">
        <div class="sub">Adjust quantities to credit (default = full remaining). Prices, VAT and discounts mirror the invoice.</div>
        <div style="max-height:52vh;overflow:auto;margin-top:8px">
          <table class="table">
            <thead>
              <tr><th>Item</th><th class="r">Invoiced</th><th class="r">Credited</th><th class="r">Remaining</th><th class="r">Credit Qty</th></tr>
            </thead>
            <tbody id="scn_rows">${rows}</tbody>
          </table>
        </div>
      </div>
    `;

    $("#scn_close").onclick = () => m.close();
    $("#scn_create").onclick = async () => {
      const map = {};
      $$('#scn_rows [data-line]').forEach(tr => {
        const lnId = tr.dataset.line;
        const qty = Number(tr.querySelector("[data-qty]")?.value || 0);
        if (qty > 0) map[lnId] = qty;
      });
      try {
        await createCreditNoteFromInvoice(inv.id, map);
        m.close();
        // refresh underlying views if they exist
        if (typeof window.renderSales === "function") renderSales();
        if (typeof window.renderInvoices === "function") renderInvoices();
      } catch (e) {
        console.error(e);
        alert(e?.message || e);
      }
    };

    m.showModal();
  }
  window.openCreditNoteWizard = openCreditNoteWizard;

  // --- Deletion lock helper (use inside your Sales modal) --------------------
  // Hide or block deletion of customer invoices from UI and code paths
  window.blockCustomerInvoiceDelete = function (doc) {
    if (!doc || !CUSTOMER_INVOICE_TYPES.has(doc.type)) return false;
    const delBtn = document.getElementById("sinv_delete") || document.getElementById("inv_delete");
    if (delBtn) {
      delBtn.disabled = true;
      delBtn.title = "Customer invoices cannot be deleted. Use Credit instead.";
      delBtn.style.display = "none";
    }
    return true;
  };
})();
