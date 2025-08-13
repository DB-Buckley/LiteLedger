// ============================================================================
// Purchases (Supplier Invoices - Weighted Average Cost)

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

async function renderPurchases() {
  const v = $("#view");
  const [docs, suppliers] = await Promise.all([all("docs"), all("suppliers")]);

  const pinvs = docs
    .filter(d => d.type === "PINV")
    .sort((a, b) => (b.dates?.issue || "").localeCompare(a.dates?.issue || ""));

  const supplierName = (id) => suppliers.find(s => s.id === id)?.name || "—";

  v.innerHTML = `
    <div class="card">
      <div class="hd">
        <b>Purchases (Supplier Invoices)</b>
        <div class="toolbar">
          <input id="p_search" placeholder="Search PINV no / supplier" style="min-width:240px">
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
  $$("#p_rows [data-view]").forEach(b => b.onclick = () => openPurchaseForm(b.dataset.view));
}

async function openPurchaseForm(docId) {
  const editing = docId ? await get("docs", docId) : null;
  const m = $("#modal"), body = $("#modalBody");
  const suppliers = await all("suppliers");
  const items = await all("items");
  const settings = (await get("settings", "app")).value;

  const doc = editing || {
    id: randId(),
    type: "PINV",
    no: await nextDocNo("PINV"),
    supplierId: suppliers[0]?.id || "",
    warehouseId: "WH1",
    dates: { issue: nowISO().slice(0,10), due: nowISO().slice(0,10) },
    totals: { subTotal: 0, tax: 0, grandTotal: 0 },
    notes: "",
    createdAt: nowISO(),
  };

  const lines = editing ? await whereIndex("lines", "by_doc", doc.id) : [];

  const supplierOpts = suppliers
    .map(s => `<option value="${s.id}" ${s.id === doc.supplierId ? "selected" : ""}>${s.name}</option>`)
    .join("");

  const renderLineRow = (ln, idx) => `
    <tr data-idx="${idx}">
      <td>${ln.itemName || ""}<div class="sub">${items.find(i => i.id === ln.itemId)?.sku || ""}</div></td>
      <td><input type="number" step="0.001" min="0" value="${ln.qty || 0}" data-edit="qty"></td>
      <td><input type="number" step="0.01" min="0" value="${ln.unitCost || 0}" data-edit="unitCost"></td>
      <td><input type="number" step="0.01" min="0" value="${ln.discountPct || 0}" data-edit="discountPct"></td>
      <td><input type="number" step="0.01" min="0" value="${ln.taxRate ?? settings.vatRate}" data-edit="taxRate"></td>
      <td class="r">${currency(calcLineTotals({
        qty: ln.qty,
        unitPrice: ln.unitCost,
        discountPct: ln.discountPct,
        taxRate: ln.taxRate ?? settings.vatRate,
      }).incTax)}</td>
      <td><button class="btn warn" data-del="${idx}">×</button></td>
    </tr>`;

  const recalc = () => {
    const t = sumDoc(lines.map(ln => ({
      qty: ln.qty,
      unitPrice: ln.unitCost,
      discountPct: ln.discountPct,
      taxRate: ln.taxRate ?? settings.vatRate,
    })));
    doc.totals = t;
    $("#pinv_sub").textContent = currency(t.subTotal);
    $("#pinv_tax").textContent = currency(t.tax);
    $("#pinv_tot").textContent = currency(t.grandTotal);
  };

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

        <div class="toolbar" style="margin:12px 0">
          <button class="btn" id="pinv_add">+ Add Item</button>
        </div>

        <div style="overflow:auto;max-height:340px">
          <table class="table">
            <thead><tr><th>Item</th><th>Qty</th><th>Unit Cost</th><th>Disc %</th><th>VAT %</th><th>Total (inc)</th><th></th></tr></thead>
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
      </div>`;
    m.showModal();

    // Field wiring
    $("#pinv_sup").onchange = () => (doc.supplierId = $("#pinv_sup").value);
    $("#pinv_date").onchange = () => (doc.dates.issue = $("#pinv_date").value);
    $("#pinv_wh").oninput = () => (doc.warehouseId = $("#pinv_wh").value);
    $("#pinv_notes").oninput = () => (doc.notes = $("#pinv_notes").value);

    // Add item
    $("#pinv_add").onclick = () =>
      openItemFinder({
        onPick: (it) => {
          lines.push({
            id: randId(),
            docId: doc.id,
            itemId: it.id,
            itemName: it.name,
            qty: 1,
            unitCost: Number(it.costAvg) || 0,
            discountPct: 0,
            taxRate: settings.vatRate,
          });
          $("#pinv_rows").insertAdjacentHTML("beforeend", renderLineRow(lines[lines.length - 1], lines.length - 1));
          wireRows();
          recalc();
        },
      });

    function wireRows() {
      $$("#pinv_rows [data-edit]").forEach(inp => {
        inp.oninput = () => {
          const tr = inp.closest("tr");
          const idx = Number(tr.dataset.idx);
          const key = inp.dataset.edit;
          const val = inp.type === "number" ? Number(inp.value) : inp.value;
          lines[idx][key] = val;
          const t = calcLineTotals({
            qty: lines[idx].qty,
            unitPrice: lines[idx].unitCost,
            discountPct: lines[idx].discountPct,
            taxRate: lines[idx].taxRate ?? settings.vatRate,
          }).incTax;
          tr.querySelector(".r").textContent = currency(t);
          recalc();
        };
      });
      $$("#pinv_rows [data-del]").forEach(b => b.onclick = () => {
        const idx = Number(b.dataset.del);
        lines.splice(idx, 1);
        $("#pinv_rows").innerHTML = lines.map((ln, i) => renderLineRow(ln, i)).join("");
        wireRows();
        recalc();
      });
    }
    wireRows();

    $("#pinv_save").onclick = async () => {
      recalc();
      await put("docs", doc);

      // Replace line set on edit
      if (editing) {
        const existing = await whereIndex("lines", "by_doc", doc.id);
        await Promise.all(existing.map(ln => del("lines", ln.id)));
      }
      for (const ln of lines) {
        ln.docId = doc.id;
        await put("lines", ln);
      }

      // Remove any previous movements for this doc (if editing), then write fresh movements & WAC
      if (editing) {
        const movs = await all("movements");
        const old = movs.filter(m => m.relatedDocId === doc.id && m.type === "PURCHASE");
        await Promise.all(old.map(m => del("movements", m.id)));
      }
      await adjustStockOnPurchase(doc, lines);

      toast(editing ? "Supplier invoice updated" : "Supplier invoice created", "success");
      m.close();
      renderPurchases();
    };

    if ($("#pinv_pdf")) {
      $("#pinv_pdf").onclick = async () => {
        const company = await get("company", "company");
        const supplier = suppliers.find(s => s.id === doc.supplierId);
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
      };
    }
  };

  draw();
}
