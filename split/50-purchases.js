// ============================================================================
// Purchases (Supplier Invoices / PINV) + Supplier Payments
// Depends on: 01-db.js, 02-helpers.js, 60-pdf.js
// Exposes: window.renderPurchases, window.renderSupplierPayments,
//          window.processSupplierInvoice
// ============================================================================

(() => {
  // ------------------------------ Small utils --------------------------------
  const PRIMARY_VIEW_KEY = "purchases_view"; // 'active' | 'processed'
  const fmtDate = (d) => (d || "").slice(0, 10);
  const byIssueDesc = (a, b) => {
    const ad = a.dates?.issue || a.createdAt || "";
    const bd = b.dates?.issue || b.createdAt || "";
    return bd.localeCompare(ad);
  };

  async function getPurchasesView() {
    try {
      const rec = await get("primary", PRIMARY_VIEW_KEY);
      const v = rec?.value;
      return v === "processed" ? "processed" : "active";
    } catch { return "active"; }
  }
  async function setPurchasesView(v) {
    await put("primary", { id: PRIMARY_VIEW_KEY, value: v === "processed" ? "processed" : "active" });
  }

  // Ensure our app modal exists
  function ensureAppModal() {
    const m = document.getElementById("modal");
    const body = document.getElementById("modalBody");
    return (m && body) ? { m, body } : { m: null, body: null };
  }

  // --------------------------- Purchases list --------------------------------
  window.renderPurchases = async function renderPurchases() {
    const v = $("#view");
    if (!v) return;
    const view = await getPurchasesView();
    const [docs, suppliers] = await Promise.all([all("docs"), all("suppliers")]);
    const sname = (id) => (suppliers || []).find((s) => s.id === id)?.name || "—";

    const shown = (docs || [])
      .filter(d => d.type === "PINV" && (view === "processed" ? d.status === "PROCESSED" : d.status !== "PROCESSED"))
      .sort(byIssueDesc);

    const rows = shown.map((d) => `
      <tr>
        <td>${d.no || ""}</td>
        <td>${sname(d.supplierId)}</td>
        <td>${fmtDate(d.dates?.issue || d.createdAt)}</td>
        <td class="r">${currency(d.totals?.subTotal || 0)}</td>
        <td class="r">${currency(d.totals?.tax || 0)}</td>
        <td class="r">${currency(d.totals?.grandTotal || 0)}</td>
        <td class="r">
          <span class="pill" style="background:${d.status==='PROCESSED' ? '#14532d' : '#334155'};color:#fff">
            ${d.status || 'DRAFT'}
          </span>
        </td>
        <td class="r"><button type="button" class="btn" data-view="${d.id}">View</button></td>
      </tr>
    `).join("");

    v.innerHTML = `
      <div class="card">
        <div class="hd">
          <b>Supplier Invoices</b>
          <div class="toolbar">
            <input id="p_search" placeholder="Search no / supplier" style="min-width:260px">
            <button type="button" class="btn primary" id="p_new">+ New Supplier Invoice</button>
            <button type="button" class="btn" id="p_toggle">${view === "processed" ? "Active Supplier Invoices" : "Processed Supplier Invoices"}</button>
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

    $("#p_search").oninput = () => {
      const q = ($("#p_search").value || "").toLowerCase();
      $$("#p_rows tr").forEach((tr) => {
        tr.style.display = tr.textContent.toLowerCase().includes(q) ? "" : "none";
      });
    };
    $("#p_new").onclick = () => openSupplierInvoiceForm();
    $("#p_toggle").onclick = async () => {
      const cur = await getPurchasesView();
      const next = cur === "processed" ? "active" : "processed";
      await setPurchasesView(next);
      renderPurchases();
    };
    $$("#p_rows [data-view]").forEach((b) => { b.onclick = () => openSupplierInvoiceForm(b.dataset.view); });
  };

  // ---------------------- Supplier Invoice (PINV) modal ----------------------
  async function openSupplierInvoiceForm(docId) {
    const isEditingInitial = !!docId;
    const [suppliers, settings] = await Promise.all([all("suppliers"), get("settings", "app")]);
    const sVal = settings?.value || {};
    const vatDefault = sVal.vatRate ?? 15;

    // Load or start fresh
    const doc = isEditingInitial
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

    const lines = isEditingInitial ? await whereIndex("lines", "by_doc", doc.id) : [];

    // Helpers
    async function saveInvoiceAndLines({ replaceLines }) {
      // Recalc totals
      const t = sumDoc(lines.map((ln) => ({
        qty: ln.qty,
        unitPrice: ln.unitCost ?? ln.unitPrice ?? 0,
        discountPct: ln.discountPct,
        taxRate: ln.taxRate ?? vatDefault,
      })));
      doc.totals = t;
      await put("docs", doc);

      if (replaceLines) {
        const existing = await whereIndex("lines", "by_doc", doc.id);
        await Promise.all(existing.map((ln) => del("lines", ln.id)));
      }
      for (const ln of lines) {
        ln.docId = doc.id;
        await put("lines", ln);
      }
      return doc;
    }

    function showMovementSummary(summary) {
      const { m, body } = ensureAppModal();
      if (!m || !body) return;

      const title = `Stock movements for PINV ${doc?.no || doc?.id || ""}`;
      const rows = (summary || []).map(r => `
        <tr>
          <td style="white-space:nowrap">${r.sku}</td>
          <td>${r.itemName || ""}</td>
          <td class="r">${r.qty}</td>
          <td class="r">${r.prevOnHand}</td>
          <td class="r">${r.newOnHand}</td>
          <td class="r">${(r.unitCost ?? 0).toFixed(2)}</td>
        </tr>
      `).join("");

      const textExport = [
        title,
        "",
        "SKU\tName\tQty\tPrev\tNew\tUnitCost",
        ...summary.map(r => [r.sku, r.itemName || "", r.qty, r.prevOnHand, r.newOnHand, r.unitCost ?? ""].join("\t"))
      ].join("\n");

      body.innerHTML = `
        <div class="hd" style="display:flex;justify-content:space-between;align-items:center">
          <h3>${title}</h3>
          <div class="row">
            <button class="btn" id="mov_copy" type="button">Copy</button>
            <button class="btn" id="mov_close" type="button">Close</button>
          </div>
        </div>
        <div class="bd" style="max-height:60vh;overflow:auto">
          ${(summary && summary.length) ? `
          <table class="table">
            <thead>
              <tr><th>SKU</th><th>Item</th><th class="r">Qty (+)</th><th class="r">Prev</th><th class="r">New</th><th class="r">Unit Cost</th></tr>
            </thead>
            <tbody>${rows}</tbody>
          </table>` : `<div class="sub">Nothing to process (no stock lines?)</div>`}
        </div>
      `;
      $("#mov_close").onclick = () => document.getElementById("modal").close();
      $("#mov_copy").onclick = async () => {
        try {
          await navigator.clipboard.writeText(textExport);
          $("#mov_copy").textContent = "Copied!";
          setTimeout(() => ($("#mov_copy").textContent = "Copy"), 1200);
        } catch {
          alert("Copy failed. Select the table and copy manually.");
        }
      };
      m.showModal();
    }

    // Draw form
    const { m, body } = ensureAppModal();
    if (!m || !body) return;

    const supOpts = (suppliers || [])
      .map(s => `<option value="${s.id}" ${s.id === doc.supplierId ? "selected" : ""}>${s.name}</option>`)
      .join("");

    const renderLineRow = (ln, idx) => `
      <tr data-idx="${idx}">
        <td>${ln.itemName || ""}</td>
        <td><input type="number" step="0.001" min="0" value="${ln.qty || 0}" data-edit="qty"></td>
        <td><input type="number" step="0.01"  min="0" value="${ln.unitCost ?? ln.unitPrice ?? 0}" data-edit="unitCost"></td>
        <td><input type="number" step="0.01"  min="0" value="${ln.discountPct || 0}" data-edit="discountPct"></td>
        <td><input type="number" step="0.01"  min="0" value="${ln.taxRate ?? vatDefault}" data-edit="taxRate"></td>
        <td class="r">${currency(calcLineTotals({
          qty: ln.qty,
          unitPrice: ln.unitCost ?? ln.unitPrice ?? 0,
          discountPct: ln.discountPct,
          taxRate: ln.taxRate ?? vatDefault,
        }).incTax)}</td>
        <td><button type="button" class="btn warn" data-del="${idx}">×</button></td>
      </tr>`;

    const recalc = () => {
      const t = sumDoc(lines.map((ln) => ({
        qty: ln.qty,
        unitPrice: ln.unitCost ?? ln.unitPrice ?? 0,
        discountPct: ln.discountPct,
        taxRate: ln.taxRate ?? vatDefault,
      })));
      doc.totals = t;
      $("#pinv_sub").textContent = currency(t.subTotal);
      $("#pinv_tax").textContent = currency(t.tax);
      $("#pinv_tot").textContent = currency(t.grandTotal);
    };

    const draw = () => {
      body.innerHTML = `
        <div class="hd" style="display:flex;justify-content:space-between;align-items:center">
          <h3>${isEditingInitial ? "View/Edit" : "New"} Supplier Invoice</h3>
          <div class="row">
            <button class="btn" id="pinv_pdf" type="button">PDF</button>
            ${doc.status === "PROCESSED" ? "" : `<button class="btn warn" id="pinv_delete" type="button">Delete</button>`}
            ${doc.status === "PROCESSED" ? "" : `<button class="btn primary" id="pinv_process" type="button" title="Save & Process">Process</button>`}
            <button class="btn success" id="pinv_save" type="button">${isEditingInitial ? "Save" : "Create"}</button>
            <button class="btn" id="pinv_close" type="button" onclick="document.getElementById('modal').close()">Close</button>
          </div>
        </div>

        <div class="bd" data-lines-wrap>
          <div class="form-grid">
            <label class="input"><span>No</span><input id="pinv_no" value="${doc.no}" disabled></label>
            <label class="input"><span>Supplier</span>
              <select id="pinv_sup">${supOpts}</select>
            </label>
            <label class="input"><span>Date</span><input id="pinv_date" type="date" value="${(doc.dates?.issue || "").slice(0,10)}"></label>
            <label class="input"><span>Warehouse</span><input id="pinv_wh" value="${doc.warehouseId || "WH1"}"></label>
            <label class="input" style="grid-column:1/-1"><span>Notes</span><input id="pinv_notes" value="${doc.notes || ""}"></label>
          </div>

          <div class="toolbar" style="margin:12px 0; gap:8px">
            <input id="pi_code" placeholder="Scan / enter item code (SKU) and press Enter" style="min-width:320px">
            <button class="btn" type="button" id="pinv_add">+ Add Item</button>
          </div>

          <div style="overflow:auto;max-height:340px">
            <table class="table">
              <thead><tr><th>Item (ex VAT)</th><th>Qty</th><th>Unit Cost</th><th>Disc %</th><th>VAT %</th><th>Total (inc)</th><th></th></tr></thead>
              <tbody id="pinv_rows">
                ${lines.map((ln, i) => renderLineRow(ln, i)).join("")}
              </tbody>
            </table>
          </div>

          <div class="row" style="justify-content:flex-end;gap:18px;margin-top:10px">
            <div><div class="sub">Sub Total</div><div id="pinv_sub" class="r">${currency(doc.totals.subTotal)}</div></div>
            <div><div class="sub">VAT</div><div id="pinv_tax" class="r">${currency(doc.totals.tax)}</div></div>
            <div><div class="sub"><b>Grand Total</b></div><div id="pinv_tot" class="r"><b>${currency(doc.totals.grandTotal)}</b></div></div>
          </div>
        </div>
      `;
      m.showModal();

      // Cache tbody
      let rowsTbodyEl = document.getElementById("pinv_rows");

      // Bind form fields
      $("#pinv_sup").onchange = () => (doc.supplierId = $("#pinv_sup").value);
      $("#pinv_date").onchange = () => (doc.dates.issue = $("#pinv_date").value);
      $("#pinv_wh").oninput = () => (doc.warehouseId = $("#pinv_wh").value);
      $("#pinv_notes").oninput = () => (doc.notes = $("#pinv_notes").value);

      // Quick add by code / name / barcode
      $("#pi_code").addEventListener("keydown", async (e) => {
        if (e.key !== "Enter") return;
        const code = ($("#pi_code").value || "").trim().toLowerCase();
        if (!code) return;
        const items = await all("items");
        const it = items.find(x => (x.sku || "").toLowerCase() === code) ||
                   items.find(x => (x.barcode || "").toLowerCase() === code) ||
                   items.find(x => (x.name || "").toLowerCase().includes(code));
        if (!it) return toast("Item not found", "warn");
        addLineFromItem(it);
        $("#pi_code").value = "";
      });

      // Open picker
      $("#pinv_add").onclick = () => openItemPickerOverlayPurchases({
        onPick: (it) => addLineFromItem(it)
      });

      function addLineFromItem(it) {
        lines.push({
          id: randId(),
          docId: doc.id,
          itemId: it.id,
          itemName: it.name,
          qty: 1,
          unitCost: +it.costAvg || +it.sellPrice || 0,
          discountPct: 0,
          taxRate: vatDefault,
        });
        rowsTbodyEl = document.getElementById("pinv_rows") || rowsTbodyEl;
        if (!rowsTbodyEl) return;
        rowsTbodyEl.insertAdjacentHTML("beforeend", renderLineRow(lines[lines.length - 1], lines.length - 1));
        wireRows();
        recalc();
      }

      function wireRows() {
        if (!rowsTbodyEl) return;
        rowsTbodyEl.querySelectorAll("[data-edit]").forEach((inp) => {
          inp.oninput = () => {
            const tr = inp.closest("tr");
            if (!tr) return;
            const idx = +tr.dataset.idx;
            const key = inp.dataset.edit;
            lines[idx][key] = +inp.value;

            const t = calcLineTotals({
              qty: lines[idx].qty,
              unitPrice: lines[idx].unitCost ?? 0,
              discountPct: lines[idx].discountPct,
              taxRate: lines[idx].taxRate ?? vatDefault,
            }).incTax;

            const totalCell = tr.querySelector(".r");
            if (totalCell) totalCell.textContent = currency(t);
            recalc();
          };
        });
        rowsTbodyEl.querySelectorAll("[data-del]").forEach((b) => {
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

      // Save (Create/Update)
      $("#pinv_save").onclick = async () => {
        await saveInvoiceAndLines({ replaceLines: isEditingInitial });
        toast(isEditingInitial ? "Supplier invoice saved" : "Supplier invoice created", "success");
        m.close();
        renderPurchases();
      };

      // PDF
      $("#pinv_pdf")?.addEventListener("click", async () => {
        await downloadInvoicePDF(doc.id, { doc, lines });
      });

      // Delete (only if not processed)
      if ($("#pinv_delete")) {
        $("#pinv_delete").onclick = async () => {
          if (doc.status === "PROCESSED") return toast("Cannot delete a processed invoice", "warn");
          if (!confirm("Delete this supplier invoice?")) return;
          const ex = await whereIndex("lines", "by_doc", doc.id);
          await Promise.all(ex.map((l) => del("lines", l.id)));
          await del("docs", doc.id);
          toast("Supplier invoice deleted", "success");
          m.close();
          renderPurchases();
        };
      }

      // Process (Save if needed, then process; show movement summary)
      const btnProc = document.getElementById("pinv_process");
      if (btnProc) {
        btnProc.type = "button";
        btnProc.onclick = async (ev) => {
          ev.preventDefault();
          ev.stopPropagation();
          try {
            // Save first if this is a brand new invoice (not yet in DB)
            const exists = isEditingInitial || !!(await get("docs", doc.id));
            if (!exists) {
              await saveInvoiceAndLines({ replaceLines: false });
              toast("Supplier invoice created", "success");
            } else {
              // If editing existing draft, persist any current edits before processing
              await saveInvoiceAndLines({ replaceLines: true });
              toast("Supplier invoice saved", "success");
            }

            const summary = await window.processSupplierInvoice(doc.id); // returns array
            showMovementSummary(summary);

            // Refresh list behind the modal
            renderPurchases();
          } catch (err) {
            console.error("[PINV] processing failed:", err);
            alert(`Failed to process invoice: ${err?.message || err}`);
          }
        };
      }
    };

    draw();
  }

  // ---------------------- Item Picker Overlay (purchases) --------------------
  async function openItemPickerOverlayPurchases({ onPick }) {
    const items = await all("items");
    const modal = document.getElementById("modal");
    const host = modal || document.body;

    // Remove any stale overlay
    $("#pi_picker_overlay")?.remove();

    const wrap = document.createElement("div");
    wrap.id = "pi_picker_overlay";
    wrap.tabIndex = -1;
    wrap.style.cssText = `
      position:fixed; inset:0; z-index:100000;
      background:rgba(2,6,23,.85);
      display:flex; align-items:center; justify-content:center;
    `;
    // Stop ESC from closing parent dialog
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
        <button type="button" class="btn" id="pi_picker_close">Close</button>
      </div>
      <div style="padding:12px 16px; display:grid; gap:10px; background:#0f172a">
        <input id="pi_picker_q" placeholder="Search code / name / barcode"
               style="min-width:320px;background:#0b1220;color:#e2e8f0;border:1px solid #1f2937;border-radius:8px;padding:8px 10px;">
        <div style="overflow:auto; max-height:52vh; border:1px solid #1f2937; border-radius:10px">
          <table class="table" style="width:100%">
            <thead>
              <tr style="background:#0b1220"><th>SKU</th><th>Name</th><th class="r">On Hand</th><th class="r">Cost</th><th></th></tr>
            </thead>
            <tbody id="pi_picker_rows"></tbody>
          </table>
        </div>
      </div>
    `;
    wrap.appendChild(card);
    host.appendChild(wrap);

    const closeOverlay = () => wrap.remove();
    $("#pi_picker_close").onclick = (e) => { e.preventDefault(); e.stopPropagation(); closeOverlay(); };

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
      tbody.querySelectorAll("[data-pick]").forEach((btn) => {
        btn.addEventListener("click", (e) => {
          e.preventDefault();
          e.stopPropagation();
          const it = list.find((x) => x.id === btn.dataset.pick);
          if (it) {
            onPick?.(it);
            closeOverlay();
          }
        }, { capture: true });
      });
    }

    const base = items.slice();
    const q = $("#pi_picker_q");
    const doSearch = () => {
      const s = (q.value || "").toLowerCase();
      const filtered = base.filter((i) =>
        (i.sku || "").toLowerCase().includes(s) ||
        (i.name || "").toLowerCase().includes(s) ||
        String(i.barcode || "").toLowerCase().includes(s)
      );
      wireList(filtered);
    };
    q.oninput = doSearch;
    doSearch();

    // Fill on-hand
    (async () => {
      for (const it of base) {
        const el = wrap.querySelector(`[data-oh="oh-${it.id}"]`);
        if (!el) continue;
        const bal = await balanceQty(it.id);
        el.textContent = (Number(it.openingQty) || 0) + bal;
      }
    })();
  }

  // ---------------------- Processing (movements write) -----------------------
  // Returns a summary array [{ sku, itemName, qty, prevOnHand, newOnHand, unitCost, lineId }]
  window.processSupplierInvoice = async function processSupplierInvoice(docId) {
    const doc = await get("docs", docId);
    if (!doc) throw new Error("Supplier invoice not found");
    if (doc.type !== "PINV") throw new Error("Wrong document type");
    if (doc.status === "PROCESSED") return []; // already done

    const [lines, settings] = await Promise.all([
      whereIndex("lines", "by_doc", doc.id),
      get("settings", "app"),
    ]);
    const vatRateDefault = settings?.value?.vatRate ?? 15;
    const wh = doc.warehouseId || "WH1";

    const summary = [];
    let created = 0;

    for (const ln of lines) {
      const item = await get("items", ln.itemId);
      if (!item || item.nonStock) continue;

      const qty = Number(ln.qty) || 0;
      if (qty <= 0) continue;

      const unit = Number(ln.unitCost ?? ln.unitPrice ?? 0);
      const discPct = Number(ln.discountPct) || 0;
      const netUnitExVat = unit * (1 - discPct / 100); // ex VAT
      // Derive on-hand before write
      const prevOnHand = (Number(item.openingQty) || 0) + (await balanceQty(item.id));
      const newOnHand = prevOnHand + qty;

      await add("movements", {
        id: randId(),
        itemId: item.id,
        warehouseId: wh,
        type: "PURCHASE",              // qtyDelta > 0 for supplier invoices
        qtyDelta: qty,
        costImpact: round2(netUnitExVat * qty),
        relatedDocId: doc.id,
        timestamp: nowISO(),
        note: `PINV ${doc.no} ${item.sku || item.name || ""}`,
      });

      summary.push({
        sku: item.sku || "",
        itemName: item.name || "",
        qty,
        prevOnHand,
        newOnHand,
        unitCost: round2(netUnitExVat),
        lineId: ln.id,
      });
      created++;
    }

    if (created > 0) {
      doc.status = "PROCESSED";
      doc.processedAt = nowISO();
      await put("docs", doc);
    }

    return summary;
  };

  // --------------------------- Supplier Payments -----------------------------
  window.renderSupplierPayments = async function renderSupplierPayments() {
    const v = $("#view");
    if (!v) return;

    const [suppliers, docs, payments] = await Promise.all([
      all("suppliers"),
      all("docs"),
      all("supplierPayments").catch(() => []),
    ]);

    // Balances: processed PINVs total - allocations
    const pinvs = (docs || []).filter(d => d.type === "PINV" && d.status === "PROCESSED");
    const totalBySupp = new Map();
    for (const d of pinvs) {
      const k = d.supplierId || "unknown";
      totalBySupp.set(k, (totalBySupp.get(k) || 0) + (d.totals?.grandTotal || 0));
    }

    const allocBySupp = new Map();
    for (const p of payments || []) {
      if (!Array.isArray(p.allocations)) continue;
      const k = p.supplierId || "unknown";
      const amt = p.allocations.reduce((s,a)=> s + (Number(a.amount)||0), 0);
      allocBySupp.set(k, (allocBySupp.get(k)||0) + amt);
    }

    const balBySupp = new Map();
    const allSuppIds = new Set([...totalBySupp.keys(), ...allocBySupp.keys()]);
    for (const sid of allSuppIds) {
      const due = (totalBySupp.get(sid) || 0) - (allocBySupp.get(sid) || 0);
      balBySupp.set(sid, round2(due));
    }

    const sname = (id) => (suppliers || []).find(s=>s.id===id)?.name || "—";

    const rows = Array.from(allSuppIds).map(sid => `
      <tr>
        <td>${(suppliers.find(s=>s.id===sid)?.code)||""}</td>
        <td>${sname(sid)}</td>
        <td class="r">${currency(balBySupp.get(sid) || 0)}</td>
        <td class="r"><button class="btn" type="button" data-pay="${sid}">Record Payment</button></td>
      </tr>
    `).join("");

    v.innerHTML = `
      <div class="card">
        <div class="hd">
          <b>Supplier Payments / Allocations</b>
          <div class="toolbar">
            <a class="btn" href="#/purchases">Back to Purchases</a>
          </div>
        </div>
        <div class="bd">
          <div style="max-height:60vh;overflow:auto">
            <table class="table">
              <thead><tr><th>Code</th><th>Supplier</th><th class="r">Outstanding</th><th></th></tr></thead>
              <tbody>${rows || `<tr><td colspan="4">No supplier balances found</td></tr>`}</tbody>
            </table>
          </div>
        </div>
      </div>
    `;

    $("[data-pay]") && $$("#view [data-pay]").forEach(btn => {
      btn.onclick = () => openSupplierPaymentForm(btn.dataset.pay, suppliers, pinvs);
    });
  };

  async function openSupplierPaymentForm(supplierId, suppliers, pinvs) {
    const { m, body } = ensureAppModal();
    if (!m || !body) return;

    const supplier = suppliers.find(s => s.id === supplierId);
    const supplierPINVs = pinvs.filter(d => d.supplierId === supplierId);

    // Remaining per PINV = total - allocations
    const allocs = await all("supplierPayments").catch(()=>[]);
    const remainingByDoc = new Map();
    for (const d of supplierPINVs) {
      let rem = d.totals?.grandTotal || 0;
      for (const p of allocs) {
        if (p.supplierId !== supplierId) continue;
        for (const a of (p.allocations || [])) {
          if (a.docId === d.id) rem -= (Number(a.amount) || 0);
        }
      }
      remainingByDoc.set(d.id, round2(rem));
    }

    const rows = supplierPINVs.map(d => `
      <tr data-doc="${d.id}">
        <td>${d.no}</td>
        <td>${fmtDate(d.dates?.issue || d.createdAt)}</td>
        <td class="r">${currency(remainingByDoc.get(d.id) || 0)}</td>
        <td class="r"><input type="number" min="0" step="0.01" data-alloc="${d.id}" value="0"></td>
      </tr>
    `).join("");

    body.innerHTML = `
      <div class="hd" style="display:flex;justify-content:space-between;align-items:center">
        <h3>Record Payment — ${supplier?.name || "Supplier"}</h3>
        <div class="row">
          <button class="btn success" id="sp_save" type="button">Save</button>
          <button class="btn" type="button" onclick="document.getElementById('modal').close()">Close</button>
        </div>
      </div>
      <div class="bd">
        <div class="form-grid">
          <label class="input"><span>Date</span><input id="sp_date" type="date" value="${nowISO().slice(0,10)}"></label>
          <label class="input"><span>Amount</span><input id="sp_amt" type="number" min="0" step="0.01" value="0"></label>
          <label class="input" style="grid-column:1/-1"><span>Reference</span><input id="sp_ref" placeholder="EFT ref / Notes"></label>
        </div>

        <div class="sub" style="margin-top:10px">Allocate to processed supplier invoices</div>
        <div style="max-height:300px; overflow:auto">
          <table class="table">
            <thead><tr><th>No</th><th>Date</th><th class="r">Remaining</th><th class="r">Allocate</th></tr></thead>
            <tbody>${rows || `<tr><td colspan="4">No processed supplier invoices</td></tr>`}</tbody>
          </table>
        </div>
      </div>
    `;
    m.showModal();

    $("#sp_save").onclick = async () => {
      const amount = round2($("#sp_amt").value || 0);
      const date = $("#sp_date").value || nowISO().slice(0,10);
      const ref = $("#sp_ref").value || "";

      if (amount <= 0) return toast("Enter a payment amount", "warn");

      const allocations = [];
      let sumAlloc = 0;
      $$('#modal [data-alloc]').forEach(inp => {
        const docId = inp.dataset.alloc;
        const val = round2(inp.value || 0);
        if (val > 0) {
          const remaining = remainingByDoc.get(docId) || 0;
          if (val > remaining) return; // silently allow; or show warn if preferred
          allocations.push({ docId, amount: val });
          sumAlloc += val;
        }
      });

      if (sumAlloc > amount) return toast("Allocations exceed payment amount", "warn");

      const payment = {
        id: randId(),
        supplierId,
        date,
        amount,
        reference: ref,
        allocations,
        createdAt: nowISO(),
      };
      await add("supplierPayments", payment);
      toast("Supplier payment recorded", "success");
      m.close();
      renderSupplierPayments();
    };
  }
})();
