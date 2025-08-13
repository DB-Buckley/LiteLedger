// ===========================================================================
// Sales Documents (Quotes / Orders / Invoices)
// Depends on: 01-db.js, 02-helpers.js ( $, $$, all, get, put, add, del,
// whereIndex, nextDocNo, randId, nowISO, sumDoc, calcLineTotals, currency, toast )
// Optional: adjustStockOnInvoice, downloadInvoicePDF/exportInvoicePDF/generateInvoicePDF
// ===========================================================================

async function renderSales(kind = "INVOICE") {
  const v = $("#view");
  if (!v) return;

  const docs = (await all("docs"))
    .filter((d) => d.type === kind)
    .sort((a, b) => (b.dates?.issue || "").localeCompare(a.dates?.issue || ""));
  const customers = await all("customers");
  const cname = (id) => customers.find((c) => c.id === id)?.name || "—";

  v.innerHTML = `
  <div class="card">
    <div class="hd">
      <b>${kind}s</b>
      <div class="toolbar">
        <input id="d_search" placeholder="Search no / customer" style="min-width:240px">
        <button type="button" class="btn primary" id="d_new">+ New ${kind}</button>
      </div>
    </div>
    <div class="bd">
      <table class="table">
        <thead><tr><th>No</th><th>Customer</th><th>Date</th><th>Sub</th><th>VAT</th><th>Total</th><th></th></tr></thead>
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
    $$("#d_rows tr").forEach((tr) => {
      tr.style.display = tr.textContent.toLowerCase().includes(q) ? "" : "none";
    });
  };

  $("#d_new").onclick = () => openDocForm(kind);
  $$("#d_rows [data-view]").forEach((b) => (b.onclick = () => openDocForm(kind, b.dataset.view)));
}

async function openDocForm(kind, docId) {
  const editing = docId ? await get("docs", docId) : null;
  const customers = await all("customers");
  const settingsRec = await get("settings", "app");
  const settings = settingsRec?.value || {};
  const allItemsRaw = await all("items");

  // Normalize items for fast lookups and search
  const items = (allItemsRaw || []).map((raw) => ({
    raw,
    id: raw.id ?? raw.itemId ?? raw.sku ?? raw.code ?? null,
    name: raw.name ?? raw.title ?? raw.label ?? String(raw.sku || raw.code || "Item"),
    code: (raw.code ?? raw.sku ?? raw.id ?? "").toString(),
    sku: (raw.sku ?? "").toString(),
    barcode: (raw.barcode ?? raw.ean ?? "").toString(),
    sellPrice: Number(raw.sellPrice ?? raw.price ?? raw.unitPrice ?? raw.defaultPrice ?? 0) || 0,
  }));

  const doc = editing || {
    id: randId(),
    type: kind,
    no: await nextDocNo(kind),
    customerId: customers[0]?.id || "",
    warehouseId: "WH1",
    dates: { issue: nowISO().slice(0, 10), due: nowISO().slice(0, 10) },
    totals: { subTotal: 0, tax: 0, grandTotal: 0 },
    notes: "",
    createdAt: nowISO(),
  };
  const lines = editing ? await whereIndex("lines", "by_doc", doc.id) : [];

  const m = $("#modal"), body = $("#modalBody");
  if (!m || !body) {
    console.error("[SalesDoc] Modal elements #modal/#modalBody not found.");
    return;
  }

  const custOpts = (customers || [])
    .map((c) => `<option value="${c.id}" ${c.id === doc.customerId ? "selected" : ""}>${c.name}</option>`)
    .join("");

  const renderLineRow = (ln, idx) => `
    <tr data-idx="${idx}">
      <td>${ln.itemName || ""}</td>
      <td><input type="number" step="0.001" min="0" value="${ln.qty || 0}" data-edit="qty"></td>
      <td><input type="number" step="0.01"  min="0" value="${ln.unitPrice ?? 0}" data-edit="unitPrice"></td>
      <td><input type="number" step="0.01"  min="0" value="${ln.discountPct || 0}" data-edit="discountPct"></td>
      <td><input type="number" step="0.01"  min="0" value="${ln.taxRate ?? settings.vatRate ?? 15}" data-edit="taxRate"></td>
      <td class="r">${currency(calcLineTotals({
        qty: ln.qty,
        unitPrice: ln.unitPrice ?? 0,
        discountPct: ln.discountPct,
        taxRate: ln.taxRate ?? settings.vatRate ?? 15,
      }).incTax)}</td>
      <td><button type="button" class="btn warn" data-del="${idx}">×</button></td>
    </tr>`;

  const recalc = () => {
    const t = sumDoc(lines.map((ln) => ({
      qty: ln.qty,
      unitPrice: ln.unitPrice ?? 0,
      discountPct: ln.discountPct,
      taxRate: ln.taxRate ?? settings.vatRate ?? 15,
    })));
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
          tbody.innerHTML = lines.map((ln, i) => renderLineRow(ln, i)).join("");
          wireAllRows();
          recalc();
        }
      };
    }
  }

  function wireAllRows() {
    const tbody = document.getElementById("sd_rows");
    if (!tbody) return;
    tbody.querySelectorAll("tr[data-idx]").forEach(wireRowEvents);
  }

  function addLineFromItem(it, qty = 1) {
    if (!it) return;
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
    return items.filter(it =>
      it.id?.toString().toLowerCase() === q ||
      it.barcode?.toLowerCase() === q ||
      it.sku?.toLowerCase() === q ||
      it.code?.toLowerCase() === q
    );
  }

  // Single, built-in item picker overlay (search by code/name/barcode, Add buttons)
// MOUNT INSIDE #modal (dialog) so it sits on the same top layer and appears above.
// Replace your existing openItemPicker(...) with this version
function openItemPicker({ initialQuery = "" } = {}) {
  const host = document.getElementById("modal") || document.body;

  const wrap = document.createElement("div");
  wrap.className = "picker-overlay";
  wrap.style.cssText = `
    position: fixed; inset: 0;
    background: rgba(0,0,0,.35);
    display:flex; align-items:center; justify-content:center;
    z-index: 2147483647;
  `;
  wrap.innerHTML = `
    <div class="card" style="width:min(880px,94vw); max-height:80vh; overflow:auto; padding:12px; position:relative; z-index:2147483647;">
      <div class="hd" style="display:flex;justify-content:space-between;align-items:center;gap:8px">
        <b>Find Item</b>
        <div class="row" style="gap:8px">
          <input id="ip_search" placeholder="Search code, name, or barcode" style="min-width:320px">
          <button type="button" class="btn" id="ip_done">Done</button>
        </div>
      </div>
      <div class="bd">
        <table class="table small">
          <thead>
            <tr><th>Code</th><th>Name</th><th class="r">Price</th><th class="r" style="width:120px">Qty</th><th class="r" style="width:90px"></th></tr>
          </thead>
          <tbody id="ip_rows"></tbody>
        </table>
      </div>
    </div>
  `;
  host.appendChild(wrap);

  const rows = wrap.querySelector("#ip_rows");
  const search = wrap.querySelector("#ip_search");
  const btnDone = wrap.querySelector("#ip_done");
  const closePicker = () => wrap.remove();

  const render = (q = "") => {
    const qq = q.toLowerCase().trim();
    const filtered = !qq ? items : items.filter(it =>
      (it.name || "").toLowerCase().includes(qq) ||
      (it.code || "").toLowerCase().includes(qq) ||
      (it.sku || "").toLowerCase().includes(qq) ||
      (it.barcode || "").toLowerCase().includes(qq) ||
      (it.id || "").toString().toLowerCase().includes(qq)
    );
    rows.innerHTML = filtered.map((it, i) => `
      <tr data-i="${i}">
        <td>${it.code || it.sku || it.id || ""}</td>
        <td>${it.name}</td>
        <td class="r">${currency(it.sellPrice)}</td>
        <td class="r"><input type="number" min="1" step="1" value="1" data-qty style="width:70px"></td>
        <td class="r"><button type="button" class="btn" data-add>Add</button></td>
      </tr>
    `).join("") || `<tr><td colspan="5" class="muted">No matches</td></tr>`;

    rows.querySelectorAll("tr[data-i]").forEach((tr) => {
      const idx = +tr.dataset.i;
      const it = filtered[idx];
      const qtyEl = tr.querySelector("[data-qty]");
      const addBtn = tr.querySelector("[data-add]");
      const getQty = () => Number(qtyEl?.value || 1) || 1;

      addBtn.onclick = (e) => {
        e.preventDefault(); e.stopPropagation();
        addLineFromItem(it, getQty());
        closePicker(); // <-- close after adding
      };
      tr.ondblclick = () => { addLineFromItem(it, getQty()); closePicker(); }; // <-- close on dblclick
    });

    search.onkeydown = (e) => {
      if (e.key === "Enter" && filtered.length === 1) {
        e.preventDefault(); e.stopPropagation();
        addLineFromItem(filtered[0], 1);
        closePicker(); // <-- close on Enter single match
      }
    };
  };

  // click backdrop to close
  wrap.addEventListener("click", (e) => { if (e.target === wrap) closePicker(); });

  btnDone.onclick = (e) => { e.preventDefault(); e.stopPropagation(); closePicker(); };
  search.oninput = () => render(search.value);

  render(initialQuery);
  search.value = initialQuery;
  setTimeout(() => search.focus(), 0);
}


  
async function ensurePdfModule() {
  // Already present?
  if (typeof window.downloadInvoicePDF === "function" ||
      typeof window.exportInvoicePDF === "function" ||
      typeof window.generateInvoicePDF === "function") return true;

  // Try to lazy-load 60-pdf.js
  try {
    await new Promise((resolve, reject) => {
      const s = document.createElement("script");
      s.src = "split/60-pdf.js";            // adjust path if your file lives in /split/ or /assets/
      s.defer = true;
      s.onload = resolve;
      s.onerror = reject;
      document.head.appendChild(s);
    });
    return (typeof window.downloadInvoicePDF === "function" ||
            typeof window.exportInvoicePDF === "function" ||
            typeof window.generateInvoicePDF === "function");
  } catch {
    return false;
  }
}
  // ---------- Render ----------
  const draw = () => {
  body.innerHTML = `
  <div class="hd" style="display:flex;justify-content:space-between;align-items:center;gap:8px">
    <h3>${editing ? "View/Edit" : "New"} ${kind}</h3>
    <div class="row" id="sd_actions" style="gap:8px">
      <input id="sd_code" placeholder="Enter/scan product code" style="min-width:220px">
      <button type="button" class="btn" id="sd_add">+ Add Item</button>
      <button type="button" class="btn" id="sd_pdf">PDF</button>
      ${editing ? `<button type="button" class="btn warn" id="sd_delete">Delete</button>` : ""}
      <button type="button" class="btn success" id="sd_save">${editing ? "Save" : "Create"}</button>
      <button type="button" class="btn" id="sd_close">Close</button>
    </div>
  </div>
  <div class="bd" data-lines-wrap>
    <div class="form-grid" style="margin-bottom:10px">
      <label class="input"><span>No</span><input id="sd_no" value="${doc.no}" disabled></label>
      <label class="input"><span>Customer</span>
        <select id="sd_cust">${custOpts}</select>
      </label>
      <label class="input"><span>Date</span><input id="sd_date" type="date" value="${(doc.dates?.issue || "").slice(0, 10)}"></label>
      <label class="input"><span>Due</span><input id="sd_due" type="date" value="${(doc.dates?.due || "").slice(0, 10)}"></label>
      <label class="input"><span>Warehouse</span><input id="sd_wh" value="${doc.warehouseId || "WH1"}"></label>
      <label class="input" style="grid-column:1/-1"><span>Notes</span><input id="sd_notes" value="${doc.notes || ""}"></label>
    </div>

    <div style="overflow:auto;max-height:340px">
      <table class="table lines">
        <thead><tr><th>Item (ex VAT)</th><th>Qty</th><th>Unit Price</th><th>Disc %</th><th>VAT %</th><th>Total (inc)</th><th></th></tr></thead>
        <tbody id="sd_rows" data-role="lines-tbody">
          ${lines.map((ln, i) => renderLineRow(ln, i)).join("")}
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

  // Add Item (opens our single in-dialog picker)
  actions.querySelector("#sd_add").addEventListener("click", (e) => {
    e.preventDefault(); e.stopPropagation(); openItemPicker();
  });

  // Code entry (Enter to add or open picker prefilled)
  const codeEl = $("#sd_code");
  codeEl.addEventListener("keydown", (e) => {
    if (e.key !== "Enter") return;
    e.preventDefault(); e.stopPropagation();
    const code = (codeEl.value || "").trim();
    if (!code) return;
    const matches = findMatchesByCode(code);
    if (matches.length === 1) {
      addLineFromItem(matches[0], 1);
      codeEl.value = "";
    } else {
      openItemPicker({ initialQuery: code });
    }
  });

  // Header inputs
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
    for (const ln of lines) {
      ln.docId = doc.id;
      await put("lines", ln);
    }
    if (kind === "INVOICE" && typeof adjustStockOnInvoice === "function") {
      await adjustStockOnInvoice(doc, lines);
    }

    toast(editing ? `${kind} updated` : `${kind} created`);

    // Offer PDF immediately after save
    if (await ensurePdfModule()) {
      const pdfFn = window.downloadInvoicePDF || window.exportInvoicePDF || window.generateInvoicePDF;
      if (typeof pdfFn === "function" && confirm("Open PDF now?")) {
        try { await pdfFn(doc.id, { doc, lines }); }
        catch (err) { console.error(err); toast?.("PDF export failed"); }
      }
    }

    m.close();
    renderSales(kind);
  });

  // PDF (always shown; we lazy-load the module on demand)
  actions.querySelector("#sd_pdf").addEventListener("click", async (e) => {
    e.preventDefault(); e.stopPropagation();
    const ok = await ensurePdfModule();
    if (!ok) { toast?.("PDF module not available (60-pdf.js)."); return; }
    const pdfFn = window.downloadInvoicePDF || window.exportInvoicePDF || window.generateInvoicePDF;
    if (typeof pdfFn !== "function") { toast?.("PDF export not available"); return; }
    try { await pdfFn(doc.id, { doc, lines }); }
    catch (err) { console.error(err); toast?.("PDF export failed"); }
  });

  // DELETE (now wired)
  const delBtn = $("#sd_delete");
  if (delBtn) {
    delBtn.addEventListener("click", async (e) => {
      e.preventDefault(); e.stopPropagation();
      if (!confirm(`Delete this ${kind}?`)) return;

      if (kind === "INVOICE") {
        for (const ln of lines) {
          const item = await get("items", ln.itemId);
          if (!item || item.nonStock) continue;
          await add("movements", {
            id: randId(),
            itemId: item.id,
            warehouseId: doc.warehouseId || "WH1",
            type: "SALE_REVERSE",
            qtyDelta: +ln.qty,
            costImpact: -round2((item.costAvg || 0) * (+ln.qty || 0)),
            relatedDocId: doc.id,
            timestamp: nowISO(),
            note: `Delete ${doc.no}`,
          });
        }
      }
      const exLines = await whereIndex("lines", "by_doc", doc.id);
      await Promise.all(exLines.map((l) => del("lines", l.id)));
      await del("docs", doc.id);

      toast(`${kind} deleted`);
      m.close();
      renderSales(kind);
    });
  }

  // Wire rows present after render
  wireAllRows();
};

  draw();
}

// Expose for router
window.renderSales = renderSales;
