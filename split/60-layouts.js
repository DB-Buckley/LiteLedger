// ============================================================================
// Layouts Editor UI (no duplicate singleton blocks)
// Depends on: 01-db.js, 02-helpers.js, 03-bootstrap.js

async function renderLayouts() {
  const v = $("#view");
  const [settingsRec, allLayouts] = await Promise.all([get("settings", "app"), all("docLayouts")]);
  const settings = settingsRec?.value || {};
  const current = (settings.pdf && settings.pdf.layouts) ? settings.pdf.layouts : {};
  const types = ["QUOTE", "ORDER", "INVOICE"];

  const optionsFor = (docType, selVal) =>
    allLayouts
      .filter(l => l.type === docType)
      .map(l => `<option value="${l.id}" ${l.id === selVal ? "selected" : ""}>${l.name}</option>`)
      .join("");

  v.innerHTML = `
    <div class="card">
      <div class="hd">
        <b>Layouts</b>
        <div class="toolbar">
          <button class="btn primary" id="l_new">+ New Layout</button>
        </div>
      </div>
      <div class="bd">
        <div class="form-grid">
          ${types.map(t => `
            <label class="input">
              <span>${t} layout</span>
              <select id="l_sel_${t}">${optionsFor(t, current[t])}</select>
            </label>
          `).join("")}
        </div>

        <div class="card" style="margin-top:12px">
          <div class="hd">
            <b>Edit Blocks</b>
            <div class="toolbar">
              <select id="blk_add">
                <option value="">+ Add block…</option>
                <option value="logo">Logo</option>
                <option value="company">Company info</option>
                <option value="docHeader">Document header</option>
                <option value="customer">Customer</option>
                <option value="lines">Lines table</option>
                <option value="totals">Totals</option>
                <option value="divider">Divider</option>
                <option value="spacer">Spacer</option>
                <option value="text">Text</option>
              </select>
              <button class="btn success" id="blk_save">Save</button>
            </div>
          </div>
          <div class="bd">
            <div id="blk_editor"></div>
          </div>
        </div>
      </div>
    </div>
  `;

  // Simple tabs to switch which doc type we're editing
  const tabBar = document.createElement("div");
  tabBar.className = "toolbar";
  tabBar.style.marginTop = "8px";
  tabBar.innerHTML = types.map(t => `
    <button class="btn" data-t="${t}">${t}</button>
  `).join("");
  v.querySelector(".bd").prepend(tabBar);

  let activeType = types.includes("INVOICE") ? "INVOICE" : types[0];
  let activeLayout = current[activeType]
    ? (await get("docLayouts", current[activeType]))
    : (allLayouts.find(l => l.type === activeType) || null);

  // Highlight current tab
  function markActiveTab() {
    $$('.toolbar [data-t]').forEach(btn => {
      btn.classList.toggle("primary", btn.dataset.t === activeType);
    });
  }
  markActiveTab();

  $$('.toolbar [data-t]').forEach(btn => btn.onclick = async () => {
    activeType = btn.dataset.t;
    markActiveTab();
    // Refresh active layout for the selected type
    const s2 = await get("settings", "app");
    const cur = s2?.value?.pdf?.layouts || {};
    activeLayout = cur[activeType]
      ? (await get("docLayouts", cur[activeType]))
      : (allLayouts.find(l => l.type === activeType) || null);
    drawBlocks();
  });

  // Persist layout selection per doc type
  types.forEach(t => {
    const sel = $(`#l_sel_${t}`);
    if (!sel) return;
    sel.onchange = async () => {
      const rec = await get("settings", "app");
      const val = rec.value || (rec.value = {});
      val.pdf = val.pdf || {};
      val.pdf.layouts = val.pdf.layouts || {};
      val.pdf.layouts[t] = sel.value;
      await put("settings", { key: "app", value: val });

      if (t === activeType) {
        activeLayout = await get("docLayouts", sel.value);
        drawBlocks();
      }
      toast(`${t} layout selected`, "success");
    };
  });

  function blockFieldsEditor(b) {
    if (b.type === "logo") {
      return `
        <label class="input"><span>Align</span>
          <select data-k="align">
            <option ${b.align === "left" ? "selected" : ""}>left</option>
            <option ${b.align === "center" ? "selected" : ""}>center</option>
            <option ${b.align === "right" || (!b.align || (b.align!=="left" && b.align!=="center")) ? "selected" : ""}>right</option>
          </select>
        </label>
        <label class="input"><span>Size</span><input type="number" data-k="size" value="${b.size || 80}"></label>
      `;
    }
    if (b.type === "company") {
      return `
        <label class="input" style="min-width:340px"><span>Fields (comma)</span>
          <input data-k="fields" value="${(b.fields || []).join(",")}">
        </label>
        <label class="input"><span>Size</span><input type="number" data-k="size" value="${b.size || 10}"></label>
      `;
    }
    if (b.type === "docHeader") {
      return `
        <label class="input"><span>Show type</span><input type="checkbox" data-k="showType" ${b.showType !== false ? "checked" : ""}></label>
        <label class="input"><span>Show number</span><input type="checkbox" data-k="showNo" ${b.showNo !== false ? "checked" : ""}></label>
        <label class="input"><span>Show dates</span><input type="checkbox" data-k="showDates" ${b.showDates !== false ? "checked" : ""}></label>
        <label class="input"><span>Size</span><input type="number" data-k="size" value="${b.size || 14}"></label>
      `;
    }
    if (b.type === "customer") {
      return `
        <label class="input" style="min-width:340px"><span>Fields (comma)</span>
          <input data-k="fields" value="${(b.fields || []).join(",")}">
        </label>
        <label class="input"><span>Size</span><input type="number" data-k="size" value="${b.size || 10}"></label>
      `;
    }
    if (b.type === "lines") {
      return `
        <label class="input" style="min-width:340px"><span>Columns (comma)</span>
          <input data-k="columns" value="${(b.columns || ["item","qty","unitPrice","total"]).join(",")}">
        </label>
        <label class="input"><span>Size</span><input type="number" data-k="size" value="${b.size || 10}"></label>
      `;
    }
    if (b.type === "totals") {
      return `
        <label class="input"><span>Show Sub</span><input type="checkbox" data-k="showSub" ${b.showSub !== false ? "checked" : ""}></label>
        <label class="input"><span>Show VAT</span><input type="checkbox" data-k="showTax" ${b.showTax !== false ? "checked" : ""}></label>
        <label class="input"><span>Show Grand</span><input type="checkbox" data-k="showGrand" ${b.showGrand !== false ? "checked" : ""}></label>
        <label class="input"><span>Size</span><input type="number" data-k="size" value="${b.size || 12}"></label>
      `;
    }
    if (b.type === "divider") return `<div class="sub">No options</div>`;
    if (b.type === "spacer") {
      return `<label class="input"><span>Height (px)</span><input type="number" data-k="px" value="${b.px || 8}"></label>`;
    }
    if (b.type === "text") {
      return `
        <label class="input" style="min-width:380px">
          <span>Text (supports {{company.vatNo}} etc.)</span>
          <input data-k="value" value="${b.value || ""}">
        </label>
        <label class="input"><span>Align</span>
          <select data-k="align">
            <option ${b.align === "left" ? "selected" : ""}>left</option>
            <option ${b.align === "center" ? "selected" : ""}>center</option>
            <option ${b.align === "right" ? "selected" : ""}>right</option>
          </select>
        </label>
        <label class="input"><span>Size</span><input type="number" data-k="size" value="${b.size || 10}"></label>
      `;
    }
    return `<div class="sub">Unknown block</div>`;
  }

  function drawBlocks() {
    const host = $("#blk_editor");
    const blocks = (activeLayout?.blocks || []).slice();

    host.innerHTML = `
      <ol id="blk_list" class="block-list" style="list-style:none;padding:0;margin:0">
        ${blocks.map((b, idx) => `
          <li class="block" draggable="true" data-idx="${idx}" style="border:1px solid #e0e4f0;border-radius:10px;padding:8px;margin:8px 0;display:grid;gap:6px">
            <div class="row" style="justify-content:space-between;align-items:center">
              <b>${b.type}</b>
              <div>
                <button class="btn ghost" data-up="${idx}">↑</button>
                <button class="btn ghost" data-down="${idx}">↓</button>
                <button class="btn warn" data-del="${idx}">Delete</button>
              </div>
            </div>
            <div class="row" style="flex-wrap:wrap;gap:8px">
              ${blockFieldsEditor(b)}
            </div>
          </li>
        `).join("")}
      </ol>
    `;

    // Reorder
    $$("#blk_list [data-up]").forEach(b => b.onclick = () => {
      const i = Number(b.dataset.up);
      if (i > 0) {
        const t = blocks[i - 1];
        blocks[i - 1] = blocks[i];
        blocks[i] = t;
        activeLayout.blocks = blocks;
        drawBlocks();
      }
    });
    $$("#blk_list [data-down]").forEach(b => b.onclick = () => {
      const i = Number(b.dataset.down);
      if (i < blocks.length - 1) {
        const t = blocks[i + 1];
        blocks[i + 1] = blocks[i];
        blocks[i] = t;
        activeLayout.blocks = blocks;
        drawBlocks();
      }
    });
    $$("#blk_list [data-del]").forEach(b => b.onclick = () => {
      const i = Number(b.dataset.del);
      blocks.splice(i, 1);
      activeLayout.blocks = blocks;
      drawBlocks();
    });

    // Field changes
    $$("#blk_list [data-k]").forEach(el => {
      el.oninput = () => {
        const li = el.closest(".block");
        const idx = Number(li.dataset.idx);
        const key = el.dataset.k;
        let val = el.value;
        if (el.type === "number") val = Number(val);
        if (el.type === "checkbox") val = el.checked;

        // special cases: fields/columns comma lists
        if (key === "fields" || key === "columns") {
          val = String(el.value || "")
            .split(",")
            .map(s => s.trim())
            .filter(Boolean);
        }
        activeLayout.blocks[idx][key] = val;
      };
    });

    // Add with dedupe for singleton blocks
    $("#blk_add").onchange = () => {
      const t = $("#blk_add").value;
      if (!t) return;
      const singleton = new Set(["logo", "company", "docHeader", "customer", "lines", "totals"]);
      if (singleton.has(t) && (activeLayout.blocks || []).some(b => b.type === t)) {
        toast(`Only one "${t}" block allowed`, "warn");
        $("#blk_add").value = "";
        return;
      }
      const defaults = {
        logo: { type: "logo", align: "right", size: 80 },
        company: { type: "company", fields: ["tradingName", "address", "email", "vatNo"], size: 10 },
        docHeader: { type: "docHeader", showType: true, showNo: true, showDates: true, size: 14 },
        customer: { type: "customer", fields: ["name", "contact"], size: 10 },
        lines: { type: "lines", columns: ["item","qty","unitPrice","total"], size: 10 },
        totals: { type: "totals", showSub: true, showTax: true, showGrand: true, size: 12 },
        divider: { type: "divider" },
        spacer: { type: "spacer", px: 8 },
        text: { type: "text", value: "Thank you!", size: 10, align: "left" },
      };
      activeLayout.blocks = (activeLayout.blocks || []).concat([defaults[t]]);
      drawBlocks();
      $("#blk_add").value = "";
    };

    $("#blk_save").onclick = async () => {
      activeLayout.updatedAt = nowISO();
      await put("docLayouts", activeLayout);
      toast("Layout saved", "success");
    };
  }

  drawBlocks();

  // Create new layout
  $("#l_new").onclick = async () => {
    const name = prompt("Layout name?");
    const type = (prompt('Type for layout: QUOTE, ORDER, or INVOICE', "INVOICE") || "").toUpperCase();
    if (!name || !type || !types.includes(type)) return;

    const layout = { id: randId(), type, name, blocks: [], updatedAt: nowISO() };
    await add("docLayouts", layout);

    // If none selected for this type, auto-select the new one
    const rec = await get("settings", "app");
    const val = rec.value || (rec.value = {});
    val.pdf = val.pdf || {};
    val.pdf.layouts = val.pdf.layouts || {};
    if (!val.pdf.layouts[type]) {
      val.pdf.layouts[type] = layout.id;
      await put("settings", { key: "app", value: val });
    }

    toast("Layout created", "success");
    renderLayouts();
  };
}
