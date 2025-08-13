    // ===========================================================================
    // Items
    async function renderItems() {
        const v = $("#view");
        v.innerHTML = `
  <div class="card">
    <div class="hd">
      <b>Items</b>
      <div class="toolbar">
        <input id="i_search" placeholder="Search name/sku/barcode" style="min-width:260px">
        <select id="i_cat"><option value="">All categories</option></select>
        <button class="btn" id="i_new">+ New</button>
        <label class="btn ghost"><input type="file" id="i_csv" accept=".csv" hidden> Import CSV</label>
      </div>
    </div>
    <div class="bd">
      <table class="table">
        <thead><tr><th>SKU</th><th>Name</th><th>Category</th><th>On Hand</th><th>Sell</th><th>Low?</th><th></th></tr></thead>
        <tbody id="i_rows"></tbody>
      </table>
    </div>
  </div>`;

        const items = await all("items");
        const cats = [...new Set(items.map((i) => i.category).filter(Boolean))].sort();
        const catSel = $("#i_cat");
        catSel.innerHTML += cats.map((c) => `<option>${c}</option>`).join("");

        const refresh = async () => {
            const q = ($("#i_search").value || "").toLowerCase();
            const cat = $("#i_cat").value;
            let rows = [];
            for (const i of await all("items")) {
                if (cat && i.category !== cat) continue;
                const hay = [i.sku, i.barcode, i.name].map((s) => String(s || "").toLowerCase());
                if (q && !hay.some((h) => h.includes(q))) continue;
                const on = i.nonStock ? "—" : i.openingQty + (await balanceQty(i.id));
                const low = !i.nonStock && on <= (i.reOrderLevel || 0);
                rows.push(`
        <tr>
          <td>${i.sku}</td>
          <td>${i.name}</td>
          <td>${i.category || ""}</td>
          <td>${on}</td>
          <td>${currency(i.sellPrice)}</td>
          <td>${low ? `<span class="pill low-badge">LOW</span>` : ""}</td>
          <td><button class="btn" data-edit="${i.id}">Edit</button></td>
        </tr>`);
            }
            $("#i_rows").innerHTML = rows.join("") || `<tr><td colspan="7">No items</td></tr>`;
            $$("#i_rows [data-edit]").forEach((b) => (b.onclick = () => openItemForm(b.dataset.edit)));
        };

        $("#i_new").onclick = () => openItemForm();
        $("#i_search").oninput = refresh;
        $("#i_cat").onchange = refresh;
        $("#i_csv").onchange = (e) => importItemsCSV(e.target.files[0]);
        refresh();
    }
    async function openItemForm(id) {
        const editing = id ? await get("items", id) : null;
        const m = $("#modal"),
            body = $("#modalBody");
        const i =
            editing || {
                id: randId(),
                sku: "",
                barcode: "",
                name: "",
                description: "",
                category: "",
                unit: "ea",
                costAvg: 0,
                costMethod: "AVG",
                sellPrice: 0,
                vatApplies: true,
                reOrderLevel: 0,
                openingQty: 0,
                warehouseId: "WH1",
                nonStock: false,
            };
        body.innerHTML = `
  <div class="hd" style="display:flex;justify-content:space-between;align-items:center">
    <h3>${editing ? "Edit" : "New"} Item</h3>
    <div class="row">
      ${editing ? `<button class="btn warn" id="i_delete">Delete</button>` : ""}
      <button class="btn success" id="i_save">Save</button>
      <button class="btn" onclick="document.getElementById('modal').close()">Close</button>
    </div>
  </div>
  <div class="bd">
    <div class="form-grid">
      <label class="input"><span>SKU</span><input id="i_sku" value="${i.sku || ""}"></label>
      <label class="input"><span>Barcode</span><input id="i_bar" value="${i.barcode || ""}"></label>
      <label class="input" style="grid-column:1/-1"><span>Name</span><input id="i_name" value="${i.name || ""}"></label>
      <label class="input" style="grid-column:1/-1"><span>Description</span><input id="i_desc" value="${i.description || ""}"></label>
      <label class="input"><span>Category</span><input id="i_cat2" value="${i.category || ""}"></label>
      <label class="input"><span>Unit</span><input id="i_unit" value="${i.unit || "ea"}"></label>
      <label class="input"><span>Cost AVG</span><input id="i_cost" type="number" step="0.01" value="${i.costAvg || 0}"></label>
      <label class="input"><span>Sell price</span><input id="i_sell" type="number" step="0.01" value="${i.sellPrice || 0}"></label>
      <label class="input"><span>VAT applies</span><input type="checkbox" id="i_vat" ${i.vatApplies ? "checked" : ""}></label>
      <label class="input"><span>Reorder level</span><input id="i_reo" type="number" value="${i.reOrderLevel || 0}"></label>
      <label class="input"><span>Opening qty</span><input id="i_open" type="number" step="0.001" value="${i.openingQty || 0}"></label>
      <label class="input"><span>Non-stock</span><input type="checkbox" id="i_ns" ${i.nonStock ? "checked" : ""}></label>
    </div>
  </div>`;
        m.showModal();
        $("#i_save").onclick = async () => {
            i.sku = $("#i_sku").value.trim();
            i.barcode = $("#i_bar").value.trim();
            i.name = $("#i_name").value.trim();
            i.description = $("#i_desc").value.trim();
            i.category = $("#i_cat2").value.trim();
            i.unit = $("#i_unit").value.trim();
            i.costAvg = +$("#i_cost").value || 0;
            i.sellPrice = +$("#i_sell").value || 0;
            i.vatApplies = $("#i_vat").checked;
            i.reOrderLevel = +$("#i_reo").value || 0;
            i.openingQty = +$("#i_open").value || 0;
            i.nonStock = $("#i_ns").checked;
            if (!i.sku || !i.name) return toast("SKU and Name are required");
            await put("items", i);
            toast("Item saved");
            m.close();
            renderItems();
        };
        if ($("#i_delete"))
            $("#i_delete").onclick = async () => {
                const movs = await whereIndex("movements", "by_item", i.id);
                if (movs.length) {
                    i.nonStock = true;
                    await put("items", i);
                    toast("Item has movements → marked Non-stock");
                } else {
                    await del("items", i.id);
                    toast("Item deleted");
                }
                m.close();
                renderItems();
            };
    }
    async function importItemsCSV(file) {
        if (!file) return;
        const txt = await file.text();
        const rows = parseCSV(txt);
        const [h, ...lines] = rows;
        const idx = (n) => h.findIndex((x) => x.trim().toLowerCase() === n);
        let count = 0;
        for (const r of lines) {
            const sku = r[idx("sku")]?.trim();
            const name = r[idx("name")]?.trim();
            if (!sku || !name) continue;
            await put("items", {
                id: randId(),
                sku,
                barcode: r[idx("barcode")] || "",
                name,
                description: r[idx("description")] || "",
                category: r[idx("category")] || "",
                unit: r[idx("unit")] || "ea",
                costAvg: +(r[idx("cost")] || 0),
                costMethod: "AVG",
                sellPrice: +(r[idx("sell")] || 0),
                vatApplies: true,
                reOrderLevel: +(r[idx("reorder")] || 0),
                openingQty: +(r[idx("opening")] || 0),
                warehouseId: "WH1",
                nonStock: false,
            });
            count++;
        }
        toast(`Imported ${count} items`);
        renderItems();
    }
