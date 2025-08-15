// ============================================================================
// Purchases (Supplier Invoices) + Supplier Payments / Allocations
// Depends on: 01-db.js, 02-helpers.js ($, $$, all, get, put, add, del, whereIndex,
//           nowISO, randId, round2, currency, toast, goto, balanceQty, sumDoc, calcLineTotals),
//           20-suppliers.js (optional window.getActiveSuppliers),
//           60-pdf.js (for getInvoiceHTML - same overlay UX as sales docs)
// Notes:
// - No top-level await
// - Exposes: window.renderPurchases, window.renderSupplierPayments
// - Stock is ONLY updated when user clicks "Process" (not on Create/Save).
// ============================================================================

(() => {
  let _showProcessed = false; // toolbar toggle

  // ------------------------------ STOCK / WAC --------------------------------
  async function previewStockOnPurchase(doc, lines) {
    const rows = [];
    for (const ln of (lines || [])) {
      const item = await get("items", ln.itemId);
      if (!item || item.nonStock) continue;

      const qty = Math.max(0, Number(ln.qty) || 0);
      const unitCostEx = Number(ln.unitCost) || 0;
      const discountPct = Number(ln.discountPct) || 0;
      const netUnit = round2(unitCostEx * (1 - (discountPct / 100)));

      const beforeQty = (Number(item.openingQty) || 0) + (await balanceQty(item.id));
      const oldAvg = Number(item.costAvg) || 0;
      const denominator = beforeQty + qty;
      const newAvg = denominator > 0
        ? round2(((oldAvg * beforeQty) + (netUnit * qty)) / denominator)
        : netUnit;

      rows.push({ item, qty, netUnit, beforeQty, afterQty: beforeQty + qty, oldAvg, newAvg });
    }
    return rows;
  }

  async function applyStockOnPurchase(doc, lines) {
    for (const ln of (lines || [])) {
      const item = await get("items", ln.itemId);
      if (!item || item.nonStock) continue;

      const wh = doc.warehouseId || "WH1";
      const qty = Math.max(0, Number(ln.qty) || 0);
      if (qty <= 0) continue;

      const unitCostEx = Number(ln.unitCost) || 0;
      const discountPct = Number(ln.discountPct) || 0;
      const netUnit = round2(unitCostEx * (discountPct ? (1 - discountPct / 100) : 1));
      const exLine = round2(netUnit * qty);

      // Weighted average using opening + movements (pre-receipt)
      const beforeQty = (Number(item.openingQty) || 0) + (await balanceQty(item.id));
      const oldAvg = Number(item.costAvg) || 0;
      const newOnHand = beforeQty + qty;

      if (newOnHand > 0) {
        const valueAfter = (oldAvg * Math.max(0, beforeQty)) + exLine;
        item.costAvg = round2(valueAfter / newOnHand);
        await put("items", item);
      }

      await add("movements", {
        id: randId(),
        itemId: item.id,
        warehouseId: wh,
        type: "PURCHASE",
        qtyDelta: qty,                // positive adds stock
        costImpact: exLine,           // ex-VAT total
        relatedDocId: doc.id,
        timestamp: nowISO(),
        note: `PINV ${doc.no || ""}`,
      });
    }
  }

  // --------------------------- ITEM PICKER (INSIDE MODAL) -------------------
  let _pickerPanel = null;

  function ensureItemPicker(hostEl = document.getElementById("modal")) {
    if (_pickerPanel && hostEl.contains(_pickerPanel)) return _pickerPanel;

    const hostStyle = getComputedStyle(hostEl);
    if (hostStyle.position === "static") hostEl.style.position = "relative";

    const panel = document.createElement("div");
    panel.id = "item_picker_panel";
    panel.style.cssText = `
      position:absolute; inset:0; z-index:9999; display:none;
      background:rgba(0,0,0,.45); align-items:center; justify-content:center;
    `;
    panel.innerHTML = `
      <div class="card" style="width:min(880px,94vw); max-height:80vh; overflow:auto; box-shadow:0 12px 40px rgba(0,0,0,.35)">
        <div class="hd" style="display:flex;align-items:center;justify-content:space-between;gap:8px">
          <b>Find Item</b>
          <div class="row" style="gap:8px">
            <input id="ip_query" placeholder="Search by code / SKU / name / barcode" style="min-width:320px">
            <button type="button" class="btn" id="ip_close">Close</button>
          </div>
        </div>
        <div class="bd">
          <div style="max-height:52vh; overflow:auto">
            <table class="table small">
              <thead>
                <tr><th>Code</th><th>Name</th><th class="r">Avg Cost</th><th class="r">On Hand</th><th class="r" style="width:120px">Qty</th><th class="r" style="width:90px"></th></tr>
              </thead>
              <tbody id="ip_rows"><tr><td colspan="6">Type to search…</td></tr></tbody>
            </table>
          </div>
        </div>
      </div>
    `;
    panel.addEventListener("click", (e) => { if (e.target === panel) panel.style.display = "none"; });
    panel.querySelector("#ip_close").onclick = () => { panel.style.display = "none"; };

    hostEl.appendChild(panel);
    _pickerPanel = panel;
    return _pickerPanel;
  }

  async function openItemPicker({ onPick, prefill = "", host } = {}) {
    const modalHost = host || document.getElementById("modal");
    const el = ensureItemPicker(modalHost);
    const q = el.querySelector("#ip_query");
    const rows = el.querySelector("#ip_rows");
    const items = (await all("items")).filter(i => !i.nonStock);

    async function render(needle = "") {
      const n = needle.toLowerCase().trim();
      const subset = !n
        ? items.slice(0, 50)
        : items.filter(i =>
            (i.sku || "").toLowerCase().includes(n) ||
            (i.barcode || "").toLowerCase().includes(n) ||
            (i.code || "").toLowerCase().includes(n) ||
            (i.name || "").toLowerCase().includes(n) ||
            (i.id || "").toString().toLowerCase().includes(n)
          ).slice(0, 50);

      if (!subset.length) {
        rows.innerHTML = `<tr><td colspan="6" class="muted">No matches</td></tr>`;
        return;
      }

      const qtyByItem = new Map();
      for (const it of subset) {
        // eslint-disable-next-line no-await-in-loop
        const bal = await balanceQty(it.id);
        const onHand = (Number(it.openingQty) || 0) + bal;
        qtyByItem.set(it.id, onHand);
      }

      rows.innerHTML = subset.map(it => `
        <tr data-id="${it.id}">
          <td>${it.code || it.sku || it.barcode || it.id || ""}</td>
          <td>${it.name || ""}</td>
          <td class="r">${currency(Number(it.costAvg) || 0)}</td>
          <td class="r">${qtyByItem.get(it.id) ?? 0}</td>
          <td class="r"><input type="number" min="1" step="1" value="1" data-qty style="width:70px"></td>
          <td class="r"><button type="button" class="btn" data-add>Add</button></td>
        </tr>
      `).join("");

      rows.querySelectorAll("tr[data-id]").forEach(tr => {
        const id = tr.dataset.id;
        const it = subset.find(x => x.id === id);
        const qtyEl = tr.querySelector("[data-qty]");

        const pick = (ev) => {
          ev?.preventDefault?.();
          ev?.stopPropagation?.();
          const qty = Math.max(1, Number(qtyEl.value) || 1);
          onPick?.(it, qty);
          el.style.display = "none"; // hide picker but keep main modal open
        };

        tr.querySelector("[data-add]").onclick = pick;
        tr.ondblclick = pick;
      });
    }

    el.style.display = "flex";
    rows.innerHTML = `<tr><td colspan="6">Type to search…</td></tr>`;
    q.value = prefill;
    q.oninput = () => render(q.value);
    q.onkeydown = (e) => { if (e.key === "Enter") render(q.value); };
    q.focus();
    render(prefill);
  }

  // ----------------------------- PDF helpers --------------------------------
  async function ensurePdfModule() {
    if (typeof window.getInvoiceHTML === "function") return true;
    if (window.__pdfModuleLoading) {
      await window.__pdfModuleLoading;
      return typeof window.getInvoiceHTML === "function";
    }
    const candidates = ["60-pdf.js", "/60-pdf.js", "/split/60-pdf.js"];
    window.__pdfModuleLoading = (async () => {
      for (const src of candidates) {
        try {
          await new Promise((resolve, reject) => {
            const s = document.createElement("script");
            s.src = src;
            s.defer = true;
            s.onload = resolve;
            s.onerror = reject;
            document.head.appendChild(s);
          });
          if (typeof window.getInvoiceHTML === "function") return true;
        } catch (_) {}
      }
      return false;
    })();
    const ok = await window.__pdfModuleLoading;
    return ok === true;
  }

  function showPdfOverlay(html, title) {
    const host = document.getElementById("modal") || document.body;
    const overlay = document.createElement("div");
    overlay.style.cssText = `
      position: fixed; inset: 0; background: rgba(0,0,0,.45);
      display:flex; align-items:center; justify-content:center; z-index:2147483647;`;
    overlay.innerHTML = `
      <div class="card" style="width:min(900px,96vw);height:min(90vh,900px);display:flex;flex-direction:column;overflow:hidden">
        <div class="hd" style="display:flex;justify-content:space-between;align-items:center;gap:8px">
          <b>${title || "Document"}</b>
          <div class="row" style="gap:8px">
            <button type="button" class="btn" id="pdf_print">Print</button>
            <button type="button" class="btn" id="pdf_close">Close</button>
          </div>
        </div>
        <div class="bd" style="flex:1;overflow:hidden">
          <iframe id="pdf_iframe" style="width:100%;height:100%;border:0;background:#fff"></iframe>
        </div>
      </div>`;
    host.appendChild(overlay);

    const iframe = overlay.querySelector("#pdf_iframe");
    const btnPrint = overlay.querySelector("#pdf_print");
    const btnClose = overlay.querySelector("#pdf_close");

    const idoc = iframe.contentDocument;
    try { idoc.open(); idoc.write(html); idoc.close(); } catch (e) { console.error(e); }

    btnPrint.onclick = () => { try { iframe.contentWindow.focus(); iframe.contentWindow.print(); } catch (e) { console.error(e); } };
    btnClose.onclick = () => overlay.remove();
  }

  // ----------------------------- LIST VIEW ----------------------------------
  async function renderPurchases() {
    const v = $("#view");
    if (!v) return;

    const [docs, suppliersAll] = await Promise.all([all("docs"), all("suppliers")]);
    const suppliers = suppliersAll || [];

    let pinvs = (docs || [])
      .filter(d => d.type === "PINV")
      .sort((a, b) => (b.dates?.issue || "").localeCompare(a.dates?.issue || ""));

    pinvs = _showProcessed ? pinvs.filter(d => d.status === "PROCESSED")
                           : pinvs.filter(d => d.status !== "PROCESSED");

    const supplierName = (id) => suppliers.find(s => s.id === id)?.name || "—";

    v.innerHTML = `
      <div class="card">
        <div class="hd">
          <b>Purchases — ${_showProcessed ? "Processed Supplier Invoices" : "Supplier Invoices"}</b>
          <div class="toolbar">
            <input id="p_search" placeholder="Search PINV no / supplier" style="min-width:240px">
            <button type="button" class="btn" id="p_toggle">${_showProcessed ? "Active Supplier Invoices" : "Processed Supplier Invoices"}</button>
            <button type="button" class="btn" id="p_payments">Supplier Payments / Allocations</button>
            <button type="button" class="btn primary" id="p_new">+ New Supplier Invoice</button>
          </div>
        </div>
        <div class="bd">
          <table class="table">
            <thead>
              <tr><th>No</th><th>Supplier</th><th>Date</th><th>Sub</th><th>VAT</th><th>Total</th><th>Status</th><th></th></tr>
            </thead>
            <tbody id="p_rows">
              ${pinvs.map(d => `
                <tr>
                  <td>${d.no || ""}</td>
                  <td>${supplierName(d.supplierId)}</td>
                  <td>${(d.dates?.issue || "").slice(0,10)}</td>
                  <td>${currency(d.totals?.subTotal || 0)}</td>
                  <td>${currency(d.totals?.tax || 0)}</td>
                  <td>${currency(d.totals?.grandTotal || 0)}</td>
                  <td>${d.status === "PROCESSED" ? '<span class="pill">processed</span>' : ""}</td>
                  <td><button type="button" class="btn" data-view="${d.id}">View</button></td>
                </tr>
              `).join("")}
            </tbody>
          </table>
        </div>
      </div>
    `;

    const filterRows = () => {
      const q = ($("#p_search").value || "").toLowerCase();
      $$("#p_rows tr").forEach(tr => {
        tr.style.display = tr.textContent.toLowerCase().includes(q) ? "" : "none";
      });
    };
    $("#p_search").oninput = filterRows;

    $("#p_new").onclick = () => openPurchaseForm();
    $("#p_payments").onclick = () => goto("/supplier-payments");
    $("#p_toggle").onclick = () => { _showProcessed = !_showProcessed; renderPurchases(); };
    $$("#p_rows [data-view]").forEach(b => b.onclick = () => openPurchaseForm(b.dataset.view));
  }

  // ----------------------------- FORM VIEW ----------------------------------
  async function openPurchaseForm(docId) {
    const editingDoc = docId ? await get("docs", docId) : null;
    const isProcessed = editingDoc?.status === "PROCESSED";

    const m = $("#modal"), body = $("#modalBody");
    if (!m || !body) return;

    const suppliersAll = (await all("suppliers")) || [];
    const activeSuppliers = typeof window.getActiveSuppliers === "function"
      ? await window.getActiveSuppliers()
      : suppliersAll.filter(s => !s.archived);

    const settings = (await get("settings", "app")).value;

    const doc = editingDoc || {
      id: randId(),
      type: "PINV",
      no: await nextDocNo("PINV"),
      supplierId: activeSuppliers[0]?.id || "",
      warehouseId: "WH1",
      dates: { issue: nowISO().slice(0,10), due: nowISO().slice(0,10) },
      totals: { subTotal: 0, tax: 0, grandTotal: 0 },
      notes: "",
      createdAt: nowISO(),
      status: "NEW"
    };

    const lines = editingDoc ? await whereIndex("lines", "by_doc", doc.id) : [];

    const supplierOpts = activeSuppliers
      .map(s => `<option value="${s.id}" ${s.id === doc.supplierId ? "selected" : ""}>${s.name}</option>`)
      .join("");

    const renderLineRow = (ln, idx, ro) => `
      <tr data-idx="${idx}">
        <td>
          ${ln.itemName || ""}
          <div class="sub">${ln.itemSku || ""}</div>
        </td>
        ${ro ? `
          <td class="r">${ln.qty || 0}</td>
          <td class="r">${currency(ln.unitCost ?? 0)}</td>
          <td class="r">${ln.discountPct || 0}%</td>
          <td class="r">${ln.taxRate ?? settings.vatRate}%</td>
        ` : `
          <td><input type="number" step="0.001" min="0" value="${ln.qty || 0}" data-edit="qty"></td>
          <td><input type="number" step="0.01"  min="0" value="${ln.unitCost ?? 0}" data-edit="unitCost"></td>
          <td><input type="number" step="0.01"  min="0" value="${ln.discountPct || 0}" data-edit="discountPct"></td>
          <td><input type="number" step="0.01"  min="0" value="${ln.taxRate ?? settings.vatRate}" data-edit="taxRate"></td>
        `}
        <td class="r">${currency(calcLineTotals({
          qty: ln.qty,
          unitPrice: ln.unitCost ?? 0,
          discountPct: ln.discountPct,
          taxRate: ln.taxRate ?? settings.vatRate,
        }).incTax)}</td>
        <td>${isProcessed ? "" : `<button type="button" class="btn warn" data-del="${idx}">×</button>`}</td>
      </tr>`;

    const recalc = () => {
      const t = sumDoc(lines.map(ln => ({
        qty: ln.qty,
        unitPrice: ln.unitCost ?? 0,
        discountPct: ln.discountPct,
        taxRate: ln.taxRate ?? settings.vatRate,
      })));
      doc.totals = t;
      $("#pinv_sub").textContent = currency(t.subTotal);
      $("#pinv_tax").textContent = currency(t.tax);
      $("#pinv_tot").textContent = currency(t.grandTotal);
    };

    let rowsTbodyEl = null;

    const draw = () => {
      body.innerHTML = `
        <div class="hd" style="display:flex;justify-content:space-between;align-items:center">
          <h3>${isProcessed ? "View" : (editingDoc ? "View/Edit" : "New")} Supplier Invoice ${isProcessed ? "(Processed)" : ""}</h3>
          <div class="row" style="gap:8px">
            <button type="button" class="btn" id="pinv_pdf">PDF</button>
            ${editingDoc && !isProcessed ? `<button type="button" class="btn warn" id="pinv_delete">Delete</button>` : ""}
            ${!isProcessed ? `<button type="button" class="btn success" id="pinv_save">${editingDoc ? "Save" : "Create"}</button>` : ""}
            ${editingDoc && !isProcessed ? `<button type="button" class="btn" id="pinv_process">Process</button>` : ""}
            <button type="button" class="btn" id="pinv_close">Close</button>
          </div>
        </div>
        <div class="bd">
          <div class="form-grid">
            <label class="input"><span>No</span><input id="pinv_no" value="${doc.no}" disabled></label>
            <label class="input"><span>Supplier</span>
              <select id="pinv_sup" ${isProcessed ? "disabled" : ""}>${supplierOpts}</select>
            </label>
            <label class="input"><span>Date</span><input id="pinv_date" type="date" value="${(doc.dates?.issue || "").slice(0,10)}" ${isProcessed ? "disabled" : ""}></label>
            <label class="input"><span>Warehouse</span><input id="pinv_wh" value="${doc.warehouseId || "WH1"}" ${isProcessed ? "disabled" : ""}></label>
            <label class="input" style="grid-column:1/-1"><span>Notes</span><input id="pinv_notes" value="${doc.notes || ""}" ${isProcessed ? "disabled" : ""}></label>
          </div>

          ${isProcessed ? "" : `
          <div class="toolbar" style="margin:12px 0; gap:8px">
            <input id="pinv_code" placeholder="Enter SKU / code and press Enter" style="min-width:220px">
            <button type="button" class="btn" id="pinv_add">+ Add Item</button>
          </div>`}

          <div style="overflow:auto;max-height:340px">
            <table class="table lines">
              <thead><tr><th>Item</th><th>Qty</th><th>Unit Cost</th><th>Disc %</th><th>VAT %</th><th>Total (inc)</th><th></th></tr></thead>
              <tbody id="pinv_rows" data-role="lines-tbody">
                ${lines.map((ln, i) => renderLineRow(ln, i, isProcessed)).join("")}
              </tbody>
            </table>
          </div>

          <div class="row" style="justify-content:flex-end;gap:18px;margin-top:10px">
            <div><div class="sub">Sub Total</div><div id="pinv_sub" class="r">${currency(doc.totals.subTotal)}</div></div>
            <div><div class="sub">VAT</div><div id="pinv_tax" class="r">${currency(doc.totals.tax)}</div></div>
            <div><div class="sub"><b>Grand Total</b></div><div id="pinv_tot" class="r"><b>${currency(doc.totals.grandTotal)}</b></div></div>
          </div>
        </div>`;
      m.showModal();

      rowsTbodyEl = document.getElementById("pinv_rows");

      // Close
      $("#pinv_close").onclick = () => m.close();

      // PDF (keep modal open)
      $("#pinv_pdf").onclick = async (e) => {
        e?.preventDefault?.();
        e?.stopPropagation?.();
        const ok = await ensurePdfModule();
        if (ok && typeof window.getInvoiceHTML === "function") {
          try {
            const { title, html } = await window.getInvoiceHTML(doc.id, { doc: { ...doc, type: "PINV" }, lines });
            showPdfOverlay(html, title);
          } catch (err) {
            console.error("PINV PDF (overlay) failed:", err);
            toast("PDF render failed");
          }
        } else if (typeof window.buildInvoicePDF_lib === "function") {
          try {
            const company = await get("company", "company");
            const supplier = activeSuppliers.find(s => s.id === doc.supplierId);
            const blob = await buildInvoicePDF_lib({
              doc: { ...doc, type: "PINV" },
              lines: lines.map(l => ({ ...l, unitPrice: l.unitCost })),
              company,
              customer: supplier ? { name: supplier.name, contact: supplier.contact } : null,
              settings: (await get("settings", "app")).value,
            });
            const a = document.createElement("a");
            a.href = URL.createObjectURL(blob);
            a.download = `${doc.type}-${doc.no}.pdf`;
            a.click();
          } catch (err) {
            console.error("PINV PDF (blob) failed:", err);
            toast("PDF not available");
          }
        } else {
          toast("PDF module not available (60-pdf.js)");
        }
      };

      if (!isProcessed) {
        // Delete (only when not processed)
        $("#pinv_delete")?.addEventListener("click", async () => {
          if (!confirm("Delete this supplier invoice?")) return;
          try {
            const existing = await whereIndex("lines", "by_doc", doc.id);
            await Promise.all(existing.map(ln => del("lines", ln.id)));
            const movs = await all("movements");
            const old = (movs || []).filter(m => m.relatedDocId === doc.id && m.type === "PURCHASE");
            await Promise.all(old.map(m => del("movements", m.id)));
            await del("docs", doc.id);
            toast("Supplier invoice deleted", "success");
            m.close();
            renderPurchases();
          } catch (err) {
            console.error("Delete PINV failed:", err);
            toast("Delete failed", "warn");
          }
        });

        // Field wiring
        $("#pinv_sup").onchange = () => (doc.supplierId = $("#pinv_sup").value);
        $("#pinv_date").onchange = () => (doc.dates.issue = $("#pinv_date").value);
        $("#pinv_wh").oninput  = () => (doc.warehouseId = $("#pinv_wh").value);
        $("#pinv_notes").oninput = () => (doc.notes = $("#pinv_notes").value);

        // Fast add by code/sku
        $("#pinv_code").onkeydown = async (e) => {
          if (e.key !== "Enter") return;
          const code = ($("#pinv_code").value || "").trim().toLowerCase();
          if (!code) return;
          const allItems = (await all("items")).filter(i => !i.nonStock);
          const it = allItems.find(i =>
            (i.sku || "").toLowerCase() === code ||
            (i.barcode || "").toLowerCase() === code ||
            (i.code || "").toLowerCase() === code ||
            (i.id || "").toLowerCase() === code
          );
          if (!it) {
            openItemPicker({ onPick: addLineFromItem, prefill: code, host: m });
            return;
          }
          addLineFromItem(it, 1);
          $("#pinv_code").value = "";
        };

        // Add Item (single binding; hosted on modal)
        $("#pinv_add").onclick = () => openItemPicker({ onPick: addLineFromItem, host: m });

        function addLineFromItem(it, qty = 1) {
          lines.push({
            id: randId(),
            docId: doc.id,
            itemId: it.id,
            itemSku: it.sku || it.code || "",
            itemName: it.name,
            qty: Number(qty) || 1,
            unitCost: Number(it.costAvg) || 0,
            discountPct: 0,
            taxRate: settings.vatRate,
          });

          if (!rowsTbodyEl || !document.body.contains(rowsTbodyEl)) {
            rowsTbodyEl = document.getElementById("pinv_rows");
          }
          if (!rowsTbodyEl) {
            console.warn("[PINV] Lines container not found; redrawing form.");
            draw();
            return;
          }
          rowsTbodyEl.insertAdjacentHTML("beforeend", renderLineRow(lines[lines.length - 1], lines.length - 1, false));
          wireRows();
          recalc();
        }

        function wireRows() {
          if (!rowsTbodyEl) return;
          rowsTbodyEl.querySelectorAll("[data-edit]").forEach(inp => {
            inp.oninput = () => {
              const tr = inp.closest("tr");
              if (!tr) return;
              const idx = +tr.dataset.idx;
              const key = inp.dataset.edit;
              lines[idx][key] = Number(inp.value);
              const t = calcLineTotals({
                qty: lines[idx].qty,
                unitPrice: lines[idx].unitCost ?? 0,
                discountPct: lines[idx].discountPct,
                taxRate: lines[idx].taxRate ?? settings.vatRate,
              }).incTax;
              const cell = tr.querySelector(".r");
              if (cell) cell.textContent = currency(t);
              recalc();
            };
          });
          rowsTbodyEl.querySelectorAll("[data-del]").forEach(b => {
            b.onclick = () => {
              const idx = +b.dataset.del;
              lines.splice(idx, 1);
              rowsTbodyEl.innerHTML = lines.map((ln, i) => renderLineRow(ln, i, false)).join("");
              wireRows();
              recalc();
            };
          });
        }
        wireRows();

        // Save (no stock update here)
        $("#pinv_save").onclick = async () => {
          recalc();
          await put("docs", doc);

          if (editingDoc) {
            const existing = await whereIndex("lines", "by_doc", doc.id);
            await Promise.all(existing.map(ln => del("lines", ln.id)));
          }
          for (const ln of lines) { ln.docId = doc.id; await put("lines", ln); }

          toast(editingDoc ? "Supplier invoice updated" : "Supplier invoice created", "success");
          m.close();
          renderPurchases();
        };

        // Process (stock update + stamp)
        const processBtn = $("#pinv_process");
        if (processBtn) {
          processBtn.onclick = async () => {
            if (!lines.length) return toast("Add at least one line first", "warn");
            await $("#pinv_save")?.click?.();

            const freshDoc = await get("docs", doc.id);
            const freshLines = await whereIndex("lines", "by_doc", doc.id);

            const preview = await previewStockOnPurchase(freshDoc, freshLines);

            const overlay = document.createElement("div");
            overlay.style.cssText = `
              position:fixed; inset:0; background:rgba(0,0,0,.45); display:flex;
              align-items:center; justify-content:center; z-index:2147483647;`;
            overlay.innerHTML = `
              <div class="card" style="width:min(900px,96vw);max-height:85vh;overflow:auto">
                <div class="hd" style="display:flex;justify-content:space-between;align-items:center;gap:8px">
                  <b>Process Supplier Invoice ${freshDoc.no}</b>
                  <div class="row" style="gap:8px">
                    <button type="button" class="btn success" id="pp_confirm">Confirm</button>
                    <button type="button" class="btn" id="pp_cancel">Cancel</button>
                  </div>
                </div>
                <div class="bd">
                  <div class="sub" style="margin-bottom:8px">This will update stock levels and weighted average costs.</div>
                  <table class="table small">
                    <thead>
                      <tr><th>Item</th><th class="r">Qty</th><th class="r">Net Unit</th><th class="r">On Hand (→)</th><th class="r">Avg Cost (→)</th></tr>
                    </thead>
                    <tbody>
                      ${preview.map(r => `
                        <tr>
                          <td>${r.item.name || ""}<div class="sub">${r.item.sku || r.item.code || ""}</div></td>
                          <td class="r">${r.qty}</td>
                          <td class="r">${currency(r.netUnit)}</td>
                          <td class="r">${r.beforeQty} → ${r.afterQty}</td>
                          <td class="r">${currency(r.oldAvg)} → ${currency(r.newAvg)}</td>
                        </tr>
                      `).join("")}
                    </tbody>
                  </table>
                </div>
              </div>`;
            document.body.appendChild(overlay);
            overlay.addEventListener("click", (e) => { if (e.target === overlay) overlay.remove(); });
            overlay.querySelector("#pp_cancel").onclick = () => overlay.remove();
            overlay.querySelector("#pp_confirm").onclick = async () => {
              try {
                await applyStockOnPurchase(freshDoc, freshLines);
                freshDoc.status = "PROCESSED";
                freshDoc.processedAt = nowISO();
                await put("docs", freshDoc);
                toast("Supplier invoice processed", "success");
              } catch (err) {
                console.error("Process PINV failed:", err);
                toast("Processing failed", "warn");
              } finally {
                overlay.remove();
                m.close();
                renderPurchases();
              }
            };
          };
        }
      }
    };

    draw();
  }

  // ---------------------- SUPPLIER PAYMENTS / ALLOCATIONS --------------------
  async function renderSupplierPayments() {
    const v = $("#view");
    if (!v) return;

    const [suppliersAll, docsAll, paysAll] = await Promise.all([
      all("suppliers"),
      all("docs"),
      all("supplierPayments"), // <— store name matches DB
    ]);

    const suppliers = (suppliersAll || []).filter(s => !s.archived);
    const pinvs = (docsAll || []).filter(d => d.type === "PINV");

    const paidByInv = new Map();
    for (const p of (paysAll || [])) {
      for (const a of (p.allocations || [])) {
        paidByInv.set(a.invoiceId, (paidByInv.get(a.invoiceId) || 0) + (Number(a.amount) || 0));
      }
    }
    const owing = (inv) => {
      const total = inv.totals?.grandTotal || 0;
      const paid  = paidByInv.get(inv.id) || 0;
      return Math.max(0, round2(total - paid));
    };

    const supOpts = suppliers.map(s => `<option value="${s.id}">${s.name}</option>`).join("");

    v.innerHTML = `
      <div class="card">
        <div class="hd">
          <b>Supplier Payments / Allocations</b>
          <div class="toolbar">
            <select id="sp_supplier" style="min-width:240px">
              <option value="">Choose supplier…</option>
              ${supOpts}
            </select>
            <button type="button" class="btn" id="sp_new" disabled>+ New Payment</button>
            <button type="button" class="btn" id="sp_back">Back to Purchases</button>
          </div>
        </div>
        <div class="bd">
          <div id="sp_content"><div class="sub">Pick a supplier to view open invoices and payments.</div></div>
        </div>
      </div>
    `;

    $("#sp_back").onclick = () => goto("/purchases");

    $("#sp_supplier").onchange = () => {
      const sid = $("#sp_supplier").value || "";
      $("#sp_new").disabled = !sid;
      drawSupplierView(sid);
    };

    $("#sp_new").onclick = () => {
      const sid = $("#sp_supplier").value || "";
      if (!sid) return;
      openSupplierPaymentForm(sid, { pinvs, paidByInv });
    };

    async function drawSupplierView(supplierId) {
      const content = $("#sp_content");
      const invs = pinvs.filter(d => d.supplierId === supplierId);

      const invRows = invs.map(d => `
        <tr>
          <td>${d.no || ""}</td>
          <td>${(d.dates?.issue || "").slice(0,10)}</td>
          <td class="r">${currency(d.totals?.grandTotal || 0)}</td>
          <td class="r">${currency(paidByInv.get(d.id) || 0)}</td>
          <td class="r">${currency(owing(d))}</td>
        </tr>
      `).join("");

      const pays = (paysAll || []).filter(p => p.supplierId === supplierId)
        .sort((a,b) => (b.date || "").localeCompare(a.date || ""));

      const payRows = pays.map(p => `
        <tr>
          <td>${(p.date || "").slice(0,10)}</td>
          <td class="r">${currency(p.amount || 0)}</td>
          <td>${p.ref || ""}</td>
          <td>${(p.allocations || []).map(a => a.invoiceId).length} allocations</td>
        </tr>
      `).join("");

      content.innerHTML = `
        <div class="row" style="gap:12px;align-items:flex-start;flex-wrap:wrap">
          <div class="card" style="flex:1; min-width:320px">
            <div class="hd"><b>Invoices</b></div>
            <div class="bd" style="max-height:45vh;overflow:auto">
              <table class="table small">
                <thead><tr><th>No</th><th>Date</th><th class="r">Total</th><th class="r">Paid</th><th class="r">Owing</th></tr></thead>
                <tbody>${invRows || '<tr><td colspan="5">No invoices</td></tr>'}</tbody>
              </table>
            </div>
          </div>
          <div class="card" style="flex:1; min-width:320px">
            <div class="hd"><b>Payments</b></div>
            <div class="bd" style="max-height:45vh;overflow:auto">
              <table class="table small">
                <thead><tr><th>Date</th><th class="r">Amount</th><th>Ref</th><th>Allocations</th></tr></thead>
                <tbody>${payRows || '<tr><td colspan="4">No payments yet</td></tr>'}</tbody>
              </table>
            </div>
          </div>
        </div>
      `;
    }

    async function openSupplierPaymentForm(supplierId, ctx) {
      const m = $("#modal"), body = $("#modalBody");
      if (!m || !body) return;

      const suppliersLive = await all("suppliers");
      const supplier = (suppliersLive || []).find(s => s.id === supplierId);
      const allInvs = (ctx?.pinvs || []).filter(d => d.supplierId === supplierId);

      const paysLive = await all("supplierPayments");
      const paidMap = new Map();
      for (const p of (paysLive || [])) for (const a of (p.allocations || [])) {
        paidMap.set(a.invoiceId, (paidMap.get(a.invoiceId) || 0) + (Number(a.amount) || 0));
      }

      const allocRows = allInvs.map(d => {
        const total = d.totals?.grandTotal || 0;
        const paid  = paidMap.get(d.id) || 0;
        const ow    = Math.max(0, round2(total - paid));
        return { id: d.id, no: d.no || "", date: (d.dates?.issue || "").slice(0,10), owing: ow };
      }).filter(r => r.owing > 0);

      const pay = {
        id: randId(),
        supplierId,
        date: nowISO().slice(0,10),
        amount: 0,
        ref: "",
        notes: "",
        allocations: [],
      };

      const renderAllocTable = () => `
        <table class="table small">
          <thead><tr><th>No</th><th>Date</th><th class="r">Owing</th><th class="r">Allocate</th></tr></thead>
          <tbody>
            ${allocRows.length ? allocRows.map(r => `
              <tr data-inv="${r.id}">
                <td>${r.no}</td>
                <td>${r.date}</td>
                <td class="r">${currency(r.owing)}</td>
                <td class="r"><input type="number" min="0" step="0.01" value="0" class="alloc_in"></td>
              </tr>
            `).join("") : `<tr><td colspan="4">No open invoices</td></tr>`}
          </tbody>
        </table>`;

      body.innerHTML = `
        <div class="hd" style="display:flex;justify-content:space-between;align-items:center">
          <h3>Supplier Payment — ${supplier?.name || ""}</h3>
          <div class="row">
            <button type="button" class="btn success" id="sp_save">Save Payment</button>
            <button type="button" class="btn" onclick="document.getElementById('modal').close()">Close</button>
          </div>
        </div>
        <div class="bd">
          <div class="form-grid">
            <label class="input"><span>Date</span><input id="sp_date" type="date" value="${pay.date}"></label>
            <label class="input"><span>Amount</span><input id="sp_amount" type="number" step="0.01" min="0" value="${pay.amount}"></label>
            <label class="input"><span>Reference</span><input id="sp_ref" value="${pay.ref}"></label>
            <label class="input" style="grid-column:1/-1"><span>Notes</span><input id="sp_notes" value="${pay.notes}"></label>
          </div>
          <div class="card" style="margin-top:12px">
            <div class="hd"><b>Allocate to Invoices</b></div>
            <div class="bd">${renderAllocTable()}</div>
          </div>
        </div>
      `;
      m.showModal();

      $("#sp_date").onchange = () => pay.date = $("#sp_date").value;
      $("#sp_amount").oninput = () => pay.amount = Number($("#sp_amount").value) || 0;
      $("#sp_ref").oninput = () => pay.ref = $("#sp_ref").value;
      $("#sp_notes").oninput = () => pay.notes = $("#sp_notes").value;

      $("#sp_save").onclick = async () => {
        const inputs = Array.from(m.querySelectorAll(".alloc_in"));
        const desired = inputs.map(inp => {
          const tr = inp.closest("tr");
          const invId = tr?.dataset?.inv;
          const row = allocRows.find(r => r.id === invId);
          const val = Math.max(0, Number(inp.value) || 0);
          return { invoiceId: invId, value: Math.min(val, row?.owing || 0) };
        }).filter(x => x.invoiceId && x.value > 0);

        let remaining = pay.amount;
        const finalAllocs = [];
        for (const a of desired) {
          if (remaining <= 0) break;
          const take = Math.min(remaining, a.value);
          remaining = round2(remaining - take);
          finalAllocs.push({ invoiceId: a.invoiceId, amount: round2(take) });
        }

        if ((pay.amount || 0) <= 0) return toast("Enter payment amount", "warn");
        if (!finalAllocs.length) return toast("Allocate at least part of the payment", "warn");

        pay.allocations = finalAllocs;

        await add("supplierPayments", pay); // <— store name matches DB
        toast("Supplier payment saved", "success");
        m.close();
        renderSupplierPayments();
      };
    }
  }

  // ------------------------------- EXPORTS -----------------------------------
  window.renderPurchases = renderPurchases;
  window.renderSupplierPayments = renderSupplierPayments;
})();
