// ============================================================================
// Purchases (Supplier Invoices / PINV) + Supplier Payments stub
// Depends on: 01-db.js, 02-helpers.js, 60-pdf.js
// Exposes: window.renderPurchases, window.processSupplierInvoice, window.renderSupplierPayments
// ============================================================================

(() => {
  // ------------------------------ Utilities ---------------------------------

  const PRIMARY_VIEW_KEY = "purchases_view"; // in 'primary' store: {id: 'purchases_view', value: 'active'|'processed'}

  async function getPurchasesView() {
    try {
      const rec = await get("primary", PRIMARY_VIEW_KEY);
      const v = rec?.value;
      return v === "processed" ? "processed" : "active";
    } catch {
      return "active";
    }
  }

  async function setPurchasesView(v) {
    await put("primary", { id: PRIMARY_VIEW_KEY, value: v === "processed" ? "processed" : "active" });
  }

  function fmtDate(d) {
    return (d || "").slice(0, 10);
  }

  function byIssueDesc(a, b) {
    const ad = a.dates?.issue || a.createdAt || "";
    const bd = b.dates?.issue || b.createdAt || "";
    return bd.localeCompare(ad);
  }

  // --------------------------- Main: Purchases list --------------------------

  window.renderPurchases = async function renderPurchases() {
    const v = $("#view");
    if (!v) return;

    const view = await getPurchasesView(); // 'active' | 'processed'
    const [docs, suppliers] = await Promise.all([all("docs"), all("suppliers")]);

    const isProcessed = (d) => (d.type === "PINV" && d.status === "PROCESSED");
    const isActive = (d) => (d.type === "PINV" && d.status !== "PROCESSED");

    const shown = (docs || []).filter(view === "processed" ? isProcessed : isActive).sort(byIssueDesc);

    const sname = (id) => (suppliers || []).find((s) => s.id === id)?.name || "—";

    const rows = shown.map((d) => `
      <tr>
        <td>${d.no || ""}</td>
        <td>${sname(d.supplierId)}</td>
        <td>${fmtDate(d.dates?.issue || d.createdAt)}</td>
        <td class="r">${currency(d.totals?.subTotal || 0)}</td>
        <td class="r">${currency(d.totals?.tax || 0)}</td>
        <td class="r">${currency(d.totals?.grandTotal || 0)}</td>
        <td class="r">
          <span class="pill" style="background:${d.status==='PROCESSED' ? '#14532d' : '#334155'};color:#fff">${d.status || 'DRAFT'}</span>
        </td>
        <td class="r"><button class="btn" data-view="${d.id}">View</button></td>
      </tr>
    `).join("");

    v.innerHTML = `
      <div class="card">
        <div class="hd">
          <b>Supplier Invoices</b>
          <div class="toolbar">
            <input id="p_search" placeholder="Search no / supplier" style="min-width:260px">
            <button class="btn primary" id="p_new">+ New Supplier Invoice</button>
            <button class="btn" id="p_toggle">${view === "processed" ? "Active Supplier Invoices" : "Processed Supplier Invoices"}</button>
            <a class="btn" href="#/supplier-payments" id="p_payments">Supplier Payments / Allocations</a>
          </div>
        </div>
        <div class="bd">
          <div style="max-height:60vh;overflow:auto">
            <table class="table">
              <thead>
                <tr><th>No</th><th>Supplier</th><th>Date</th><th>Sub</th><th>VAT</th><th>Total</th><th>Status</th><th></th></tr>
              </thead>
              <tbody id="p_rows">${rows || `<tr><td colspan="8">No ${view === "processed" ? "processed" : "active"} supplier invoices</td></tr>`}</tbody>
            </table>
          </div>
        </div>
      </div>
    `;

    // Search filter
    $("#p_search").oninput = () => {
      const q = ($("#p_search").value || "").toLowerCase();
      $$("#p_rows tr").forEach((tr) => {
        tr.style.display = tr.textContent.toLowerCase().includes(q) ? "" : "none";
      });
    };

    // New
    $("#p_new").onclick = () => openSupplierInvoiceForm();

    // Toggle
    $("#p_toggle").onclick = async () => {
      const cur = await getPurchasesView();
      const next = cur === "processed" ? "active" : "processed";
      await setPurchasesView(next);
      renderPurchases();
    };

    // View
    $$("#p_rows [data-view]").forEach((b) => {
      b.onclick = () => openSupplierInvoiceForm(b.dataset.view);
    });
  };

  // ---------------------- Supplier Invoice (PINV) modal ----------------------

  async function openSupplierInvoiceForm(docId) {
    const editing = !!docId;
    const [suppliers, settings] = await Promise.all([all("suppliers"), get("settings", "app")]);
    const sVal = settings?.value || {};
    const vatDefault = sVal.vatRate ?? 15;

    const doc = editing
      ? (await get("docs", docId))
      : {
          id: randId(),
          type: "PINV",
          no: await nextDocNo("PINV"),
          supplierId: suppliers[0]?.id || "",
          warehouseId: "WH1",
          dates: { issue: nowISO().slice(0, 10) },
          totals: { subTotal: 0, tax: 0, grandTotal: 0 },
          notes: "",
          status: "DRAFT",
          createdAt: nowISO(),
        };

    let lines = editing ? await whereIndex("lines", "by_doc", doc.id) : [];

    const m = $("#modal"), body = $("#modalBody");
    if (!m || !body) {
      console.error("[Purchases] Missing #modal/#modalBody");
      return;
    }

    const suppOpts = (suppliers || [])
      .sort((a, b) => (a.name || "").localeCompare(b.name || ""))
      .map((s) => `<option value="${s.id}" ${s.id === doc.supplierId ? "selected" : ""}>${s.name}</option>`)
      .join("");

    const renderLineRow = (ln, idx) => {
      const unit = Number(ln.unitCost ?? ln.unitPrice ?? 0) || 0;
      const t = calcLineTotals({
        qty: ln.qty,
        unitPrice: unit,
        discountPct: ln.discountPct ?? 0,
        taxRate: ln.taxRate ?? vatDefault,
      });
      return `
        <tr data-idx="${idx}">
          <td>${ln.itemName || ""}</td>
          <td><input type="number" step="0.001" min="0" value="${ln.qty || 0}" data-edit="qty"></td>
          <td><input type="number" step="0.01"  min="0" value="${unit}" data-edit="unitCost"></td>
          <td><input type="number" step="0.01"  min="0" value="${ln.discountPct || 0}" data-edit="discountPct"></td>
          <td><input type="number" step="0.01"  min="0" value="${ln.taxRate ?? vatDefault}" data-edit="taxRate"></td>
          <td class="r">${currency(t.incTax)}</td>
          <td><button class="btn warn" data-del="${idx}">×</button></td>
        </tr>
      `;
    };

    const sum = () => {
      const tots = sumDoc(
        lines.map((ln) => ({
          qty: ln.qty,
          unitPrice: Number(ln.unitCost ?? ln.unitPrice ?? 0) || 0,
          discountPct: ln.discountPct ?? 0,
          taxRate: ln.taxRate ?? vatDefault,
        }))
      );
      doc.totals = tots;
      const sub = $("#pi_sub"), tax = $("#pi_tax"), tot = $("#pi_tot");
      if (sub) sub.textContent = currency(tots.subTotal);
      if (tax) tax.textContent = currency(tots.tax);
      if (tot) tot.textContent = currency(tots.grandTotal);
    };

    function draw() {
      body.innerHTML = `
        <div class="hd" style="display:flex;justify-content:space-between;align-items:center">
          <h3>${editing ? "View/Edit" : "New"} Supplier Invoice</h3>
          <div class="row">
            ${editing ? `<button class="btn" id="pi_pdf">PDF</button>` : ""}
            ${doc.status !== "PROCESSED" ? `<button class="btn" id="pi_process">Process</button>` : ""}
            ${doc.status !== "PROCESSED" ? `<button class="btn warn" id="pi_delete">Delete</button>` : ""}
            <button class="btn success" id="pi_save">${editing ? "Save" : "Create"}</button>
            <button class="btn" id="pi_close">Close</button>
          </div>
        </div>
        <div class="bd">
          <div class="form-grid">
            <label class="input"><span>No</span><input id="pi_no" value="${doc.no}" disabled></label>
            <label class="input"><span>Supplier</span>
              <select id="pi_supplier">${suppOpts}</select>
            </label>
            <label class="input"><span>Date</span><input id="pi_date" type="date" value="${(doc.dates?.issue || "").slice(0,10)}"></label>
            <label class="input"><span>Warehouse</span><input id="pi_wh" value="${doc.warehouseId || "WH1"}"></label>
            <label class="input" style="grid-column:1/-1"><span>Notes</span><input id="pi_notes" value="${doc.notes || ""}"></label>
          </div>

          <div class="toolbar" style="margin:12px 0; gap:8px; display:flex; align-items:center">
            <input id="pi_code" placeholder="Enter SKU/Barcode, press Enter" style="min-width:240px">
            <button class="btn" id="pi_add">+ Add Item</button>
          </div>

          <div style="overflow:auto;max-height:44vh">
            <table class="table">
              <thead>
                <tr><th>Item</th><th>Qty</th><th>Unit Cost (ex)</th><th>Disc %</th><th>VAT %</th><th>Total (inc)</th><th></th></tr>
              </thead>
              <tbody id="pi_rows">
                ${lines.map((ln, i) => renderLineRow(ln, i)).join("")}
              </tbody>
            </table>
          </div>

          <div class="row" style="justify-content:flex-end;gap:18px;margin-top:10px">
            <div><div class="sub">Sub Total</div><div id="pi_sub" class="r">${currency(doc.totals.subTotal)}</div></div>
            <div><div class="sub">VAT</div><div id="pi_tax" class="r">${currency(doc.totals.tax)}</div></div>
            <div><div class="sub"><b>Grand Total</b></div><div id="pi_tot" class="r"><b>${currency(doc.totals.grandTotal)}</b></div></div>
          </div>
        </div>
      `;

      m.showModal();

      // Bind basics
      $("#pi_close").onclick = () => m.close();
      $("#pi_supplier").onchange = () => (doc.supplierId = $("#pi_supplier").value);
      $("#pi_date").onchange = () => (doc.dates.issue = $("#pi_date").value);
      $("#pi_wh").oninput = () => (doc.warehouseId = $("#pi_wh").value);
      $("#pi_notes").oninput = () => (doc.notes = $("#pi_notes").value);

      // Code -> add directly
      $("#pi_code").addEventListener("keydown", async (e) => {
        if (e.key !== "Enter") return;
        e.preventDefault();
        const code = ($("#pi_code").value || "").trim();
        if (!code) return;
        const items = await all("items");
        const it = items.find((x) =>
          (x.sku && x.sku.toLowerCase() === code.toLowerCase()) ||
          (x.barcode && String(x.barcode).toLowerCase() === code.toLowerCase())
        );
        if (!it) {
          toast("Item not found, opening picker…", "warn");
          openItemPickerOverlay({ preset: code, onPick: (picked) => addLineFromItem(picked) });
          return;
        }
        addLineFromItem(it);
        $("#pi_code").value = "";
      });

      // Add button -> open picker
      $("#pi_add").onclick = () => openItemPickerOverlay({ onPick: (picked) => addLineFromItem(picked) });

      // PDF
      if ($("#pi_pdf")) {
        $("#pi_pdf").onclick = async () => {
          const company = (await all("company"))?.[0] || {};
          const supplier = suppliers.find((s) => s.id === doc.supplierId) || {};
          const freshLines = await whereIndex("lines", "by_doc", doc.id);
          await downloadInvoicePDF(doc.id, {
            doc,
            lines: freshLines,
            company,
            customer: supplier, // reuse 'customer' slot to render "To:"
          });
        };
      }

      // Delete (only when not processed)
      if ($("#pi_delete")) {
        $("#pi_delete").onclick = async () => {
          if (!confirm("Delete this supplier invoice?")) return;
          // Ensure no movements linked (shouldn't be any if not processed, but safe to clear)
          const movs = await whereIndex("movements", "by_doc", doc.id);
          await Promise.all(movs.map((m) => del("movements", m.id)));
          const exLines = await whereIndex("lines", "by_doc", doc.id);
          await Promise.all(exLines.map((l) => del("lines", l.id)));
          await del("docs", doc.id);
          toast("Supplier invoice deleted", "success");
          m.close();
          renderPurchases();
        };
      }

      // Save/Create
      $("#pi_save").onclick = async () => {
        // Persist doc + lines
        await put("docs", doc);
        if (editing) {
          const existing = await whereIndex("lines", "by_doc", doc.id);
          await Promise.all(existing.map((ln) => del("lines", ln.id)));
        }
        for (const ln of lines) {
          ln.docId = doc.id;
          await put("lines", ln);
        }
        toast(editing ? "Supplier invoice saved" : "Supplier invoice created", "success");
        // stay in modal, but refresh totals from saved lines
        lines = await whereIndex("lines", "by_doc", doc.id);
        $("#pi_rows").innerHTML = lines.map((ln, i) => renderLineRow(ln, i)).join("");
        wireRows();
        sum();
      };

      // Process -> write movements + close + refresh list
      if ($("#pi_process")) {
        $("#pi_process").onclick = async () => {
          // Ensure current edits are saved first
          await put("docs", doc);
          const existing = await whereIndex("lines", "by_doc", doc.id);
          await Promise.all(existing.map((ln) => del("lines", ln.id)));
          for (const ln of lines) { ln.docId = doc.id; await put("lines", ln); }

          await window.processSupplierInvoice(doc.id);
          m.close();
          renderPurchases(); // remain on Purchases
        };
      }

      // Wire line edits/removals
      wireRows();
      sum();
    }

    function wireRows() {
      const rowsHost = $("#pi_rows");
      if (!rowsHost) return;

      rowsHost.querySelectorAll("[data-edit]").forEach((inp) => {
        inp.oninput = () => {
          const tr = inp.closest("tr");
          if (!tr) return;
          const idx = +tr.dataset.idx;
          const key = inp.dataset.edit;
          // Persist as numbers
          lines[idx][key] = +inp.value;
          // Update total cell for this row
          const unit = Number(lines[idx].unitCost ?? lines[idx].unitPrice ?? 0) || 0;
          const t = calcLineTotals({
            qty: lines[idx].qty,
            unitPrice: unit,
            discountPct: lines[idx].discountPct ?? 0,
            taxRate: lines[idx].taxRate ?? vatDefault,
          });
          const totalCell = tr.querySelector(".r");
          if (totalCell) totalCell.textContent = currency(t.incTax);
          sum();
        };
      });

      rowsHost.querySelectorAll("[data-del]").forEach((b) => {
        b.onclick = () => {
          const idx = +b.dataset.del;
          lines.splice(idx, 1);
          rowsHost.innerHTML = lines.map((ln, i) => renderLineRow(ln, i)).join("");
          wireRows();
          sum();
        };
      });
    }

    function addLineFromItem(it) {
      lines.push({
        id: randId(),
        docId: doc.id,
        itemId: it.id,
        itemName: it.name,
        qty: 1,
        unitCost: Number(it.costAvg ?? it.sellPrice ?? 0) || 0,
        discountPct: 0,
        taxRate: vatDefault,
      });
      const rowsHost = $("#pi_rows");
      if (rowsHost) {
        rowsHost.insertAdjacentHTML("beforeend", renderLineRow(lines[lines.length - 1], lines.length - 1));
        wireRows();
        sum();
      }
    }

    // Lightweight overlay picker that sits above the modal
// --- Drop-in replacement: Midnight-themed item picker overlay
//     mounted INSIDE #modal to avoid closing the parent dialog.
async function openItemPickerOverlay({ preset = "", onPick }) {
  const items = await all("items");

  // Mount inside the <dialog id="modal"> if present; else fallback to body.
  const modal = document.getElementById("modal");
  const host = modal || document.body;

  // Fullscreen overlay (fixed works fine even inside dialog)
  const wrap = document.createElement("div");
  wrap.id = "pi_picker_overlay";
  wrap.tabIndex = -1;
  wrap.style.cssText = `
    position:fixed; inset:0; z-index:100000; 
    background:rgba(2,6,23,.85);
    display:flex; align-items:center; justify-content:center;
  `;

  // Stop any events from bubbling to global handlers that might close the dialog
  const stopAll = (e) => { e.preventDefault(); e.stopPropagation(); };
  ["click","mousedown","mouseup","keydown","keyup"].forEach(evt =>
    wrap.addEventListener(evt, stopAll, true) // capture phase
  );

  // Container card
  const card = document.createElement("div");
  card.style.cssText = `
    width:min(900px,94vw); max-height:80vh;
    background:#0f172a; color:#e2e8f0;
    border:1px solid #1f2937; border-radius:14px;
    box-shadow:0 20px 60px rgba(0,0,0,.55);
    display:flex; flex-direction:column; overflow:hidden;
  `;
  card.innerHTML = `
    <div style="display:flex; align-items:center; justify-content:space-between; padding:12px 16px; background:#0b1220; border-bottom:1px solid #1f2937">
      <b style="letter-spacing:.2px">Select Item</b>
      <button type="button" class="btn" id="pi_picker_close">Close</button>
    </div>

    <div style="padding:12px 16px; display:grid; gap:10px; background:#0f172a">
      <input id="pi_picker_q" placeholder="Search code / name / barcode" value="${preset || ""}"
             style="min-width:320px; background:#0b1220; color:#e2e8f0; border:1px solid #1f2937; border-radius:8px; padding:8px 10px;">
      <div style="overflow:auto; max-height:52vh; border:1px solid #1f2937; border-radius:10px">
        <table class="table" style="width:100%">
          <thead>
            <tr style="background:#0b1220">
              <th>SKU</th><th>Name</th><th class="r">On Hand</th><th class="r">Price</th><th></th>
            </tr>
          </thead>
          <tbody id="pi_picker_rows"></tbody>
        </table>
      </div>
    </div>
  `;

  wrap.appendChild(card);
  host.appendChild(wrap); // <-- mount inside the dialog

  const closeOverlay = () => wrap.remove();

  // Ensure close button doesn’t bubble
  document.getElementById("pi_picker_close").onclick = (e) => {
    e.preventDefault(); e.stopPropagation();
    closeOverlay();
  };

  // Render rows helper
  function rowsHtml(list) {
    return (list || []).map((it) => `
      <tr data-id="${it.id}">
        <td>${it.sku || ""}</td>
        <td>${it.name || ""}</td>
        <td class="r" data-oh="oh-${it.id}">…</td>
        <td class="r">${currency(it.costAvg ?? it.sellPrice ?? 0)}</td>
        <td><button type="button" class="btn" data-pick="${it.id}">Add</button></td>
      </tr>
    `).join("");
  }

  async function wireList(list) {
    const tbody = document.getElementById("pi_picker_rows");
    if (!tbody) return;
    tbody.innerHTML = rowsHtml(list);

    // Bind "Add" buttons — triple-stop events so parent dialog stays open
    tbody.querySelectorAll("[data-pick]").forEach((btn) => {
      btn.addEventListener("click", (e) => {
        e.preventDefault();
        e.stopPropagation();
        e.stopImmediatePropagation();
        const it = list.find((x) => x.id === btn.dataset.pick);
        if (it) {
          onPick?.(it);    // add to the invoice
          closeOverlay();  // close only the overlay
        }
      }, { capture: true });
    });
  }

  // Initial list + search
  const baseList = items.slice();
  const search = document.getElementById("pi_picker_q");
  const doSearch = () => {
    const q = (search.value || "").toLowerCase();
    const filtered = baseList.filter((i) =>
      (i.sku || "").toLowerCase().includes(q) ||
      (i.name || "").toLowerCase().includes(q) ||
      String(i.barcode || "").toLowerCase().includes(q)
    );
    wireList(filtered);
  };
  search.oninput = doSearch;
  doSearch();

  // Fill on-hand asynchronously
  (async () => {
    for (const it of baseList) {
      const el = wrap.querySelector(`[data-oh="oh-${it.id}"]`);
      if (!el) continue;
      const bal = await balanceQty(it.id);
      el.textContent = (Number(it.openingQty) || 0) + bal;
    }
  })();
}


    draw();
  }

  // -------------------- Processor: writes movements & costAvg ----------------

 // --- Replace your existing processSupplierInvoice with this ---
window.processSupplierInvoice = async function processSupplierInvoice(docId) {
  try {
    const doc = await get("docs", docId);
    if (!doc) return toast("Supplier invoice not found", "warn");
    if (doc.status === "PROCESSED") return toast("Already processed", "warn");

    const [lines, settings] = await Promise.all([
      whereIndex("lines", "by_doc", doc.id),
      get("settings", "app"),
    ]);
    const vatRateDefault = settings?.value?.vatRate ?? 15;
    const wh = doc.warehouseId || "WH1";

    let created = 0;
    for (const ln of lines) {
      // Pull the item; skip if missing / non-stock
      const item = await get("items", ln.itemId);
      if (!item || item.nonStock) continue;

      // Quantities/costs as numbers
      const qty = Number(ln.qty) || 0;
      if (qty <= 0) continue; // nothing to add

      const unit = Number(ln.unitCost ?? ln.unitPrice ?? 0);
      const discPct = Number(ln.discountPct) || 0;
      const taxRate = Number(ln.taxRate ?? vatRateDefault) || 0;

      // Net EX VAT unit: apply discount, do NOT add VAT
      const unitAfterDisc = unit * (1 - discPct / 100);
      // If the line value was captured VAT-inclusive, remove VAT here.
      // (Most PINV capture is EX VAT, so this is fine.)
      const netUnitExVat = unitAfterDisc; // adjust if your UI is inc-VAT

      const qtyDelta = qty; // purchases ADD stock
      const costImpact = round2(netUnitExVat * qty);

      await add("movements", {
        id: randId(),
        itemId: item.id,
        warehouseId: wh,
        type: "PURCHASE",     // free-form label
        qtyDelta,             // IMPORTANT: positive -> adds stock
        costImpact,           // accounting/COGS analytics later
        relatedDocId: doc.id, // link back to the PINV
        timestamp: nowISO(),
        note: `PINV ${doc.no} ${item.sku || item.name || ""}`,
      });
      created++;
    }

    // Mark the doc processed only if we actually wrote movements
    if (created > 0) {
      doc.status = "PROCESSED";
      doc.processedAt = nowISO();
      await put("docs", doc);
    }

    console.log("[PINV process] wrote movements:", created, "for doc", { id: doc.id, no: doc.no });
    toast(created ? `Processed ${created} line(s)` : "Nothing to process (no stock lines?)", created ? "success" : "warn");

    // Re-render the purchases list (stay on the same view)
    renderPurchases();
  } catch (err) {
    console.error("processSupplierInvoice failed:", err);
    toast("Failed to process supplier invoice", "warn");
  }
};


  // ------------------ Supplier Payments (minimal stub screen) ----------------

  if (typeof window.renderSupplierPayments !== "function") {
    window.renderSupplierPayments = async function renderSupplierPayments() {
      const v = $("#view");
      const [suppliers, pays] = await Promise.all([all("suppliers"), all("supplierPayments").catch(()=>[])]);
      const sname = (id) => (suppliers || []).find((s) => s.id === id)?.name || "—";

      const rows = (pays || []).sort((a,b) => (b.date || "").localeCompare(a.date || "")).map(p => `
        <tr>
          <td>${fmtDate(p.date)}</td>
          <td>${sname(p.supplierId)}</td>
          <td class="r">${currency(p.amount || 0)}</td>
          <td>${p.ref || ""}</td>
        </tr>
      `).join("");

      v.innerHTML = `
        <div class="card">
          <div class="hd">
            <b>Supplier Payments / Allocations</b>
            <div class="toolbar">
              <a class="btn" href="#/purchases">Back to Purchases</a>
              <button class="btn primary" id="sp_new">+ New Supplier Payment</button>
            </div>
          </div>
          <div class="bd">
            <div style="max-height:60vh;overflow:auto">
              <table class="table">
                <thead><tr><th>Date</th><th>Supplier</th><th>Amount</th><th>Ref</th></tr></thead>
                <tbody>${rows || '<tr><td colspan="4">No supplier payments yet</td></tr>'}</tbody>
              </table>
            </div>
            <div class="sub" style="margin-top:8px">Allocations UI coming next — this stub is here so your route works.</div>
          </div>
        </div>
      `;

      // Quick create (no allocations yet)
      $("#sp_new").onclick = async () => {
        const m = $("#modal"), body = $("#modalBody");
        const suppOpts = (suppliers || []).map(s => `<option value="${s.id}">${s.name}</option>`).join("");
        body.innerHTML = `
          <div class="hd" style="display:flex;justify-content:space-between;align-items:center">
            <h3>New Supplier Payment</h3>
            <button class="btn" onclick="document.getElementById('modal').close()">Close</button>
          </div>
          <div class="bd">
            <div class="form-grid">
              <label class="input"><span>Date</span><input id="sp_date" type="date" value="${nowISO().slice(0,10)}"></label>
              <label class="input"><span>Supplier</span><select id="sp_supplier">${suppOpts}</select></label>
              <label class="input"><span>Amount</span><input id="sp_amt" type="number" step="0.01" min="0" value="0"></label>
              <label class="input"><span>Reference</span><input id="sp_ref"></label>
              <label class="input" style="grid-column:1/-1"><span>Note</span><input id="sp_note"></label>
            </div>
            <div class="row" style="justify-content:flex-end; gap:10px; margin-top:12px">
              <button class="btn success" id="sp_save">Create</button>
            </div>
          </div>
        `;
        m.showModal();

        $("#sp_save").onclick = async () => {
          const pay = {
            id: randId(),
            supplierId: $("#sp_supplier").value,
            date: $("#sp_date").value,
            amount: round2($("#sp_amt").value || 0),
            ref: $("#sp_ref").value || "",
            note: $("#sp_note").value || "",
            allocations: [], // to be added later
            createdAt: nowISO(),
          };
          await add("supplierPayments", pay);
          toast("Supplier payment created", "success");
          m.close();
          renderSupplierPayments();
        };
      };
    };
  }
})();
