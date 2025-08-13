// ===========================================================================
// Sales Documents (Quotes / Orders / Invoices)
async function renderSales(kind = "INVOICE") {
  const v = $("#view");
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
        <button class="btn primary" id="d_new">+ New ${kind}</button>
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
              <td><button class="btn" data-view="${d.id}">View</button></td>
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
  const settings = (await get("settings", "app")).value;

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

  const custOpts = customers
    .map((c) => `<option value="${c.id}" ${c.id === doc.customerId ? "selected" : ""}>${c.name}</option>`)
    .join("");

  const renderLineRow = (ln, idx) => `
    <tr data-idx="${idx}">
      <td>${ln.itemName || ""}</td>
      <td><input type="number" step="0.001" min="0" value="${ln.qty || 0}" data-edit="qty"></td>
      <td><input type="number" step="0.01"  min="0" value="${ln.unitPrice ?? 0}" data-edit="unitPrice"></td>
      <td><input type="number" step="0.01"  min="0" value="${ln.discountPct || 0}" data-edit="discountPct"></td>
      <td><input type="number" step="0.01"  min="0" value="${ln.taxRate ?? settings.vatRate}" data-edit="taxRate"></td>
      <td class="r">${currency(calcLineTotals({
        qty: ln.qty,
        unitPrice: ln.unitPrice ?? 0,
        discountPct: ln.discountPct,
        taxRate: ln.taxRate ?? settings.vatRate,
      }).incTax)}</td>
      <td><button class="btn warn" data-del="${idx}">×</button></td>
    </tr>`;

  const recalc = () => {
    const t = sumDoc(lines.map((ln) => ({
      qty: ln.qty,
      unitPrice: ln.unitPrice ?? 0,
      discountPct: ln.discountPct,
      taxRate: ln.taxRate ?? settings.vatRate,
    })));
    doc.totals = t;
    $("#sd_sub").textContent = currency(t.subTotal);
    $("#sd_tax").textContent = currency(t.tax);
    $("#sd_tot").textContent = currency(t.grandTotal);
  };

  // helper: wire one row's events
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
          taxRate: lines[idx].taxRate ?? settings.vatRate,
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

  const draw = () => {
    const hasPdf =
      (typeof window.downloadInvoicePDF === "function") ||
      (typeof window.exportInvoicePDF === "function");

    body.innerHTML = `
    <div class="hd" style="display:flex;justify-content:space-between;align-items:center">
      <h3>${editing ? "View/Edit" : "New"} ${kind}</h3>
      <div class="row">
        ${editing && hasPdf ? `<button class="btn" id="sd_pdf">PDF</button>` : ""}
        ${editing ? `<button class="btn warn" id="sd_delete">Delete</button>` : ""}
        <button class="btn success" id="sd_save">${editing ? "Save" : "Create"}</button>
        <button class="btn" onclick="document.getElementById('modal').close()">Close</button>
      </div>
    </div>
    <div class="bd" data-lines-wrap>
      <div class="form-grid">
        <label class="input"><span>No</span><input id="sd_no" value="${doc.no}" disabled></label>
        <label class="input"><span>Customer</span>
          <select id="sd_cust">${custOpts}</select>
        </label>
        <label class="input"><span>Date</span><input id="sd_date" type="date" value="${(doc.dates?.issue || "").slice(0, 10)}"></label>
        <label class="input"><span>Due</span><input id="sd_due" type="date" value="${(doc.dates?.due || "").slice(0, 10)}"></label>
        <label class="input"><span>Warehouse</span><input id="sd_wh" value="${doc.warehouseId || "WH1"}"></label>
        <label class="input" style="grid-column:1/-1"><span>Notes</span><input id="sd_notes" value="${doc.notes || ""}"></label>
      </div>

      <div class="toolbar" style="margin:12px 0">
        <button class="btn" id="sd_add">+ Add Item</button>
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

    $("#sd_cust").onchange = () => (doc.customerId = $("#sd_cust").value);
    $("#sd_date").onchange = () => (doc.dates.issue = $("#sd_date").value);
    $("#sd_due").onchange = () => (doc.dates.due = $("#sd_due").value);
    $("#sd_wh").oninput = () => (doc.warehouseId = $("#sd_wh").value);
    $("#sd_notes").oninput = () => (doc.notes = $("#sd_notes").value);

    // Add item: update state, then redraw form (avoids tbody race entirely)
    $("#sd_add").onclick = () =>
      openItemFinder({
        onPick: (it) => {
          lines.push({
            id: randId(),
            docId: doc.id,
            itemId: it.id,
            itemName: it.name,
            qty: 1,
            unitPrice: +it.sellPrice || 0,
            discountPct: 0,
            taxRate: settings.vatRate,
          });
          draw();   // re-render from state; tbody guaranteed to exist
          recalc();
        },
      });

    // Wire current rows
    wireAllRows();

    // Save
    $("#sd_save").onclick = async () => {
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
      if (kind === "INVOICE") await adjustStockOnInvoice(doc, lines);
      toast(editing ? `${kind} updated` : `${kind} created`);
      m.close();
      renderSales(kind);
    };

    // PDF (only if function exists)
    if ($("#sd_pdf")) {
      $("#sd_pdf").onclick = async () => {
        const pdfFn = window.downloadInvoicePDF || window.exportInvoicePDF;
        if (typeof pdfFn !== "function") {
          if (typeof toast === "function") toast("PDF export not available");
          return;
        }
        await pdfFn(doc.id, { doc, lines });
      };
    }

    // Delete
    if ($("#sd_delete")) {
      $("#sd_delete").onclick = async () => {
        if (!confirm(`Delete this ${kind}?`)) return;

        // Reverse stock if invoice
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
      };
    }
  };

  draw();
}
