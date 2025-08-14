// ============================================================================
// Purchases (Supplier Invoices) + Supplier Payments / Allocations
// Depends on: 01-db.js, 02-helpers.js ($, $$, all, get, put, add, del, whereIndex,
//           nowISO, randId, round2, currency, toast, goto),
//           20-suppliers.js (for window.getActiveSuppliers if available),
//           60-pdf.js (for buildInvoicePDF_lib)
// Notes:
// - No top-level await
// - Exposes: window.renderPurchases, window.renderSupplierPayments
// ============================================================================

(() => {
  // ------------------------------ STOCK / WAC --------------------------------
  async function adjustStockOnPurchase(doc, lines) {
    // For each line: update item's weighted average cost, then add a PURCHASE movement.
    for (const ln of (lines || [])) {
      const item = await get("items", ln.itemId);
      if (!item || item.nonStock) continue;

      const wh = doc.warehouseId || "WH1";
      const qty = Math.max(0, Number(ln.qty) || 0);

      // cost used for WAC must be net of discount, excl VAT
      const unitCostEx = Number(ln.unitCost) || 0;
      const discountPct = Number(ln.discountPct) || 0;
      const netUnit = round2(unitCostEx * (1 - (discountPct / 100)));

      // On hand BEFORE this purchase (opening + movements so far)
      const beforeQty = (Number(item.openingQty) || 0) + (await balanceQty(item.id));
      const oldAvg = Number(item.costAvg) || 0;

      const denominator = beforeQty + qty;
      const newAvg = denominator > 0
        ? round2(((oldAvg * beforeQty) + (netUnit * qty)) / denominator)
        : netUnit; // if nothing on hand before, new avg is this cost

      item.costAvg = newAvg;
      await put("items", item);

      // Record stock movement
      await add("movements", {
        id: randId(),
        itemId: item.id,
        warehouseId: wh,
        type: "PURCHASE",
        qtyDelta: qty,
        costImpact: round2(netUnit * qty),
        relatedDocId: doc.id,
        timestamp: nowISO(),
        note: `PINV ${doc.no}`,
      });
    }
  }

  // --------------------------- ITEM PICKER (ONE) -----------------------------
  // A single overlay picker we can reuse. High z-index so it sits above the modal.
  let _pickerEl = null;
  function ensureItemPicker() {
    if (_pickerEl && document.body.contains(_pickerEl)) return _pickerEl;

    const wrap = document.createElement("div");
    wrap.id = "item_picker_overlay";
    wrap.style.cssText = `
      position:fixed; inset:0; z-index:99999; display:none;
      background:rgba(0,0,0,.45); align-items:center; justify-content:center;
    `;
    wrap.innerHTML = `
      <div class="card" style="width:min(720px,90vw); max-height:80vh; overflow:auto; box-shadow:0 12px 40px rgba(0,0,0,.35)">
        <div class="hd" style="display:flex;align-items:center;justify-content:space-between">
          <b>Find Item</b>
          <button class="btn" id="ip_close">Close</button>
        </div>
        <div class="bd">
          <div class="row" style="gap:8px;margin-bottom:8px">
            <input id="ip_query" placeholder="Search by code / SKU / name…" style="flex:1; min-width:260px">
          </div>
          <div style="max-height:52vh; overflow:auto">
            <table class="table small">
              <thead><tr><th>SKU</th><th>Name</th><th class="r">Cost (avg)</th><th class="r">On Hand</th><th></th></tr></thead>
              <tbody id="ip_rows"><tr><td colspan="5">Type to search…</td></tr></tbody>
            </table>
          </div>
        </div>
      </div>
    `;
    document.body.appendChild(wrap);

    const close = () => { wrap.style.display = "none"; };
    wrap.querySelector("#ip_close").onclick = close;
    wrap.addEventListener("click", (e) => {
      if (e.target === wrap) close();
    });
    document.addEventListener("keydown", (e) => {
      if (wrap.style.display !== "none" && e.key === "Escape") close();
    });

    _pickerEl = wrap;
    return _pickerEl;
  }

  async function openItemPicker({ onPick, prefill = "" } = {}) {
    const el = ensureItemPicker();
    const q = el.querySelector("#ip_query");
    const rows = el.querySelector("#ip_rows");

    // Load stock once (non-stock excluded)
    const items = (await all("items")).filter(i => !i.nonStock);

    const render = async (needle = "") => {
      const n = needle.toLowerCase().trim();
      const subset = !n
        ? []
        : items.filter(i =>
            (i.sku || "").toLowerCase().includes(n) ||
            (i.barcode || "").toLowerCase().includes(n) ||
            (i.name || "").toLowerCase().includes(n)
          ).slice(0, 50);

      if (!subset.length) {
        rows.innerHTML = `<tr><td colspan="5">No matches</td></tr>`;
        return;
      }

      // compute qty on hand for visible items
      const qtyByItem = new Map();
      for (const it of subset) {
        // balanceQty exists in helpers/db layer
        // eslint-disable-next-line no-await-in-loop
        const bal = await balanceQty(it.id);
        const onHand = (Number(it.openingQty) || 0) + bal;
        qtyByItem.set(it.id, onHand);
      }

      rows.innerHTML = subset.map(it => `
        <tr>
          <td>${it.sku || ""}</td>
          <td>${it.name || ""}</td>
          <td class="r">${currency(Number(it.costAvg) || 0)}</td>
          <td class="r">${qtyByItem.get(it.id) ?? 0}</td>
          <td class="r"><button class="btn" data-pick="${it.id}">Add</button></td>
        </tr>
      `).join("");

      rows.querySelectorAll("[data-pick]").forEach(btn => {
        btn.onclick = () => {
          const it = items.find(x => x.id === btn.dataset.pick);
          if (!it) return;
          onPick?.(it);
          el.style.display = "none";
        };
      });
    };

    q.oninput = () => render(q.value);
    q.onkeydown = (e) => {
      if (e.key === "Enter") {
        render(q.value);
      }
    };

    el.style.display = "flex";
    rows.innerHTML = `<tr><td colspan="5">Type to search…</td></tr>`;
    q.value = prefill;
    q.focus();
    if (prefill) render(prefill);
  }

  // ----------------------------- PURCHASE LIST ------------------------------
  async function renderPurchases() {
    const v = $("#view");
    if (!v) return;

    const [docs, suppliersAll] = await Promise.all([all("docs"), all("suppliers")]);
    const suppliers = (suppliersAll || []);
    const pinvs = (docs || [])
      .filter(d => d.type === "PINV")
      .sort((a, b) => (b.dates?.issue || "").localeCompare(a.dates?.issue || ""));

    const supplierName = (id) => suppliers.find(s => s.id === id)?.name || "—";

    v.innerHTML = `
      <div class="card">
        <div class="hd">
          <b>Purchases (Supplier Invoices)</b>
          <div class="toolbar">
            <input id="p_search" placeholder="Search PINV no / supplier" style="min-width:240px">
            <button class="btn" id="p_payments">Supplier Payments / Allocations</button>
            <button class="btn primary" id="p_new">+ New Supplier Invoice</button>
          </div>
        </div>
        <div class="bd">
          <table class="table">
            <thead>
              <tr><th>No</th><th>Supplier</th><th>Date</th><th>Sub</th><th>VAT</th><th>Total</th><th></th></tr>
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
                  <td><button class="btn" data-view="${d.id}">View</button></td>
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
    $$("#p_rows [data-view]").forEach(b => b.onclick = () => openPurchaseForm(b.dataset.view));
  }

  // ----------------------------- PURCHASE FORM ------------------------------
  async function openPurchaseForm(docId) {
    const editing = !!docId;
    const m = $("#modal"), body = $("#modalBody");
    if (!m || !body) return;

    const suppliersAll = (await all("suppliers")) || [];
    const activeSuppliers = typeof window.getActiveSuppliers === "function"
      ? await window.getActiveSuppliers()
      : suppliersAll.filter(s => !s.archived);

    const settings = (await get("settings", "app")).value;
    const editingDoc = docId ? await get("docs", docId) : null;

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
    };

    const lines = editing ? await whereIndex("lines", "by_doc", doc.id) : [];

    const supplierOpts = activeSuppliers
      .map(s => `<option value="${s.id}" ${s.id === doc.supplierId ? "selected" : ""}>${s.name}</option>`)
      .join("");

    const renderLineRow = (ln, idx) => `
      <tr data-idx="${idx}">
        <td>
          ${ln.itemName || ""}
          <div class="sub">${ln.itemSku || ""}</div>
        </td>
        <td><input type="number" step="0.001" min="0" value="${ln.qty || 0}" data-edit="qty"></td>
        <td><input type="number" step="0.01"  min="0" value="${ln.unitCost ?? 0}" data-edit="unitCost"></td>
        <td><input type="number" step="0.01"  min="0" value="${ln.discountPct || 0}" data-edit="discountPct"></td>
        <td><input type="number" step="0.01"  min="0" value="${ln.taxRate ?? settings.vatRate}" data-edit="taxRate"></td>
        <td class="r">${currency(calcLineTotals({
          qty: ln.qty,
          unitPrice: ln.unitCost ?? 0,
          discountPct: ln.discountPct,
          taxRate: ln.taxRate ?? settings.vatRate,
        }).incTax)}</td>
        <td><button class="btn warn" data-del="${idx}">×</button></td>
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
          <h3>${editing ? "View/Edit" : "New"} Supplier Invoice</h3>
          <div class="row">
            ${editing ? `<button class="btn" id="pinv_pdf">PDF</button>` : ""}
            <button class="btn success" id="pinv_save">${editing ? "Save" : "Create"}</button>
            <button class="btn" onclick="document.getElementById('modal').close()">Close</button>
          </div>
        </div>
        <div class="bd">
          <div class="form-grid">
            <label class="input"><span>No</span><input id="pinv_no" value="${doc.no}" disabled></label>
            <label class="input"><span>Supplier</span>
              <select id="pinv_sup">${supplierOpts}</select>
            </label>
            <label class="input"><span>Date</span><input id="pinv_date" type="date" value="${(doc.dates?.issue || "").slice(0,10)}"></label>
            <label class="input"><span>Warehouse</span><input id="pinv_wh" value="${doc.warehouseId || "WH1"}"></label>
            <label class="input" style="grid-column:1/-1"><span>Notes</span><input id="pinv_notes" value="${doc.notes || ""}"></label>
          </div>

          <div class="toolbar" style="margin:12px 0; gap:8px">
            <input id="pinv_code" placeholder="Enter SKU / code and press Enter" style="min-width:220px">
            <button class="btn" id="pinv_add">+ Add Item</button>
          </div>

          <div style="overflow:auto;max-height:340px">
            <table class="table lines">
              <thead><tr><th>Item</th><th>Qty</th><th>Unit Cost</th><th>Disc %</th><th>VAT %</th><th>Total (inc)</th><th></th></tr></thead>
              <tbody id="pinv_rows" data-role="lines-tbody">
                ${lines.map((ln, i) => renderLineRow(ln, i)).join("")}
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

      // Field wiring
      $("#pinv_sup").onchange = () => (doc.supplierId = $("#pinv_sup").value);
      $("#pinv_date").onchange = () => (doc.dates.issue = $("#pinv_date").value);
      $("#pinv_wh").oninput = () => (doc.warehouseId = $("#pinv_wh").value);
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
          (i.id || "").toLowerCase() === code
        );
        if (!it) {
          openItemPicker({ onPick: addLineFromItem, prefill: code });
          return;
        }
        addLineFromItem(it);
        $("#pinv_code").value = "";
      };

      // Open picker
      $("#pinv_add").onclick = () => openItemPicker({ onPick: addLineFromItem });

      function addLineFromItem(it) {
        lines.push({
          id: randId(),
          docId: doc.id,
          itemId: it.id,
          itemSku: it.sku || "",
          itemName: it.name,
          qty: 1,
          unitCost: Number(it.costAvg) || 0,
          discountPct: 0,
          taxRate: settings.vatRate,
        });

        // ensure tbody exists
        if (!rowsTbodyEl || !document.body.contains(rowsTbodyEl)) {
          rowsTbodyEl = document.getElementById("pinv_rows");
        }
        if (!rowsTbodyEl) {
          console.warn("[PINV] Lines container not found; redrawing form.");
          draw();
          return;
        }
        rowsTbodyEl.insertAdjacentHTML("beforeend", renderLineRow(lines[lines.length - 1], lines.length - 1));
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
            rowsTbodyEl.innerHTML = lines.map((ln, i) => renderLineRow(ln, i)).join("");
            wireRows();
            recalc();
          };
        });
      }
      wireRows();

      // Save
      $("#pinv_save").onclick = async () => {
        recalc();
        await put("docs", doc);

        // Replace lines when editing
        if (editing) {
          const existing = await whereIndex("lines", "by_doc", doc.id);
          await Promise.all(existing.map(ln => del("lines", ln.id)));
        }
        for (const ln of lines) {
          ln.docId = doc.id;
          await put("lines", ln);
        }

        // Remove previous purchase movements if editing, then re-apply WAC + movements
        if (editing) {
          const movs = await all("movements");
          const old = (movs || []).filter(m => m.relatedDocId === doc.id && m.type === "PURCHASE");
          await Promise.all(old.map(m => del("movements", m.id)));
        }
        await adjustStockOnPurchase(doc, lines);

        toast(editing ? "Supplier invoice updated" : "Supplier invoice created", "success");
        m.close();
        renderPurchases();
      };

      // PDF (optional)
      if ($("#pinv_pdf")) {
        $("#pinv_pdf").onclick = async () => {
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
            console.error("PINV PDF failed:", err);
            toast("Please allow pop-ups to view/download PDF");
          }
        };
      }
    };

    draw();
  }

  // ---------------------- SUPPLIER PAYMENTS / ALLOCATIONS --------------------
  // Store: "spayments" (supplier payments)
  // Record: { id, supplierId, date, amount, ref, notes, allocations:[{invoiceId, amount}] }
  async function renderSupplierPayments() {
    const v = $("#view");
    if (!v) return;

    const [suppliersAll, docsAll, spays] = await Promise.all([
      all("suppliers"),
      all("docs"),
      all("spayments"),
    ]);

    const suppliers = (suppliersAll || []).filter(s => !s.archived);
    const pinvs = (docsAll || []).filter(d => d.type === "PINV");

    // Compute paid per PINV from supplier payments
    const paidByInv = new Map();
    for (const p of (spays || [])) {
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
            <button class="btn" id="sp_new" disabled>+ New Payment</button>
            <button class="btn" id="sp_back">Back to Purchases</button>
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

      // Simple table of invoices with paid/owing
      const invRows = invs.map(d => `
        <tr>
          <td>${d.no || ""}</td>
          <td>${(d.dates?.issue || "").slice(0,10)}</td>
          <td class="r">${currency(d.totals?.grandTotal || 0)}</td>
          <td class="r">${currency(paidByInv.get(d.id) || 0)}</td>
          <td class="r">${currency(owing(d))}</td>
        </tr>
      `).join("");

      // Payments list for supplier
      const pays = (spays || []).filter(p => p.supplierId === supplierId)
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

      const supplier = suppliers.find(s => s.id === supplierId);
      const allInvs = (ctx?.pinvs || []).filter(d => d.supplierId === supplierId);

      // Recompute paid for safety
      const spaysLive = await all("spayments");
      const paidMap = new Map();
      for (const p of (spaysLive || [])) for (const a of (p.allocations || [])) {
        paidMap.set(a.invoiceId, (paidMap.get(a.invoiceId) || 0) + (Number(a.amount) || 0));
      }

      // Build rows with max alloc = owing
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
        allocations: [], // { invoiceId, amount }
      };

      const renderAllocTable = () => {
        return `
          <table class="table small">
            <thead><tr><th>No</th><th>Date</th><th class="r">Owing</th><th class="r">Allocate</th></tr></thead>
            <tbody>
              ${allocRows.length ? allocRows.map(r => `
                <tr data-inv="${r.id}">
                  <td>${r.no}</td>
                  <td>${r.date}</td>
                  <td class="r">${currency(r.owing)}</td>
                  <td class="r">
                    <input type="number" min="0" step="0.01" value="0" class="alloc_in">
                  </td>
                </tr>
              `).join("") : `<tr><td colspan="4">No open invoices</td></tr>`}
            </tbody>
          </table>
        `;
      };

      body.innerHTML = `
        <div class="hd" style="display:flex;justify-content:space-between;align-items:center">
          <h3>Supplier Payment — ${supplier?.name || ""}</h3>
          <div class="row">
            <button class="btn success" id="sp_save">Save Payment</button>
            <button class="btn" onclick="document.getElementById('modal').close()">Close</button>
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

      // Bind
      $("#sp_date").onchange = () => pay.date = $("#sp_date").value;
      $("#sp_amount").oninput = () => pay.amount = Number($("#sp_amount").value) || 0;
      $("#sp_ref").oninput = () => pay.ref = $("#sp_ref").value;
      $("#sp_notes").oninput = () => pay.notes = $("#sp_notes").value;

      // Save
      $("#sp_save").onclick = async () => {
        // Build allocations from inputs; cap at owing; cap total <= payment amount
        const inputs = Array.from(m.querySelectorAll(".alloc_in"));
        const desired = inputs.map(inp => {
          const tr = inp.closest("tr");
          const invId = tr?.dataset?.inv;
          const row = allocRows.find(r => r.id === invId);
          const val = Math.max(0, Number(inp.value) || 0);
          return { invoiceId: invId, value: Math.min(val, row?.owing || 0) };
        }).filter(x => x.invoiceId && x.value > 0);

        // Cap by payment amount
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

        await add("spayments", pay);
        toast("Supplier payment saved", "success");
        m.close();
        renderSupplierPayments(); // refresh page
      };
    }
  }

  // ------------------------------- EXPORTS -----------------------------------
  window.renderPurchases = renderPurchases;
  window.renderSupplierPayments = renderSupplierPayments;
})();
