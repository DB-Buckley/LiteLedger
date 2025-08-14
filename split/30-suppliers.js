// ============================================================================
// Suppliers (active + archived lists + create/edit modal)
// Depends on: 01-db.js, 02-helpers.js ($, $$, all, get, put, nowISO, randId, round2, currency, toast, goto)
// Routes used: "#/suppliers", "#/suppliers-archived"
// Exposes: window.renderSuppliers, window.renderSuppliersArchived, window.openSupplierForm, window.getActiveSuppliers
// ============================================================================

(() => {
  // ----------------------------- PUBLIC HELPER ------------------------------
  // Use this in Purchases etc. to exclude archived suppliers in dropdowns.
  window.getActiveSuppliers = async () => {
    const list = await all("suppliers");
    return (list || []).filter(s => !s.archived);
  };

  // --------------------------- INTERNAL RENDERER ----------------------------
  async function renderSuppliersImpl(opts = {}) {
    const archived = !!opts.archived;
    const v = $("#view");
    if (!v) return;

    const [suppliersAll, docsAll] = await Promise.all([all("suppliers"), all("docs")]);

    // Aggregate purchase info from PINVs
    const pinvs = (docsAll || []).filter(d => d.type === "PINV");
    const bySupplier = new Map(); // supplierId -> { total90, lastDate }
    const cutoff = new Date(); cutoff.setDate(cutoff.getDate() - 90);

    for (const d of pinvs) {
      const sid = d.supplierId || "unknown";
      const dateStr = d.dates?.issue || d.createdAt || "";
      const dt = new Date(dateStr || "1970-01-01");
      const entry = bySupplier.get(sid) || { total90: 0, lastDate: "" };
      if (dt >= cutoff) entry.total90 += (d.totals?.grandTotal || 0);
      if (!entry.lastDate || dateStr > entry.lastDate) entry.lastDate = dateStr;
      bySupplier.set(sid, entry);
    }

    const suppliers = (suppliersAll || [])
      .filter(s => !!s.archived === archived)
      .sort((a, b) => (a.name || "").localeCompare(b.name || ""));

    const rows = suppliers.map(s => {
      const agg = bySupplier.get(s.id) || { total90: 0, lastDate: "" };
      return `
        <tr data-id="${s.id}">
          <td>${s.code || ""}</td>
          <td>
            ${s.name || ""}
            ${s.archived ? ' <span class="pill" style="margin-left:6px;background:#ddd;color:#333">archived</span>' : ""}
          </td>
          <td>${s.contact?.person || ""}</td>
          <td>${s.contact?.phone || ""}</td>
          <td class="r">${(agg.lastDate || "").slice(0,10)}</td>
          <td class="r">${currency(agg.total90)}</td>
          <td class="r">
            <button class="btn" data-edit="${s.id}">Edit</button>
          </td>
        </tr>`;
    }).join("");

    v.innerHTML = `
      <div class="card">
        <div class="hd">
          <b>${archived ? "Archived Suppliers" : "Suppliers"}</b>
          <div class="toolbar">
            <input id="sup_search" placeholder="Search name / code / contact" style="min-width:280px">
            ${
              archived
                ? `<button class="btn" id="sup_back_active">Active Suppliers</button>`
                : `<button class="btn" id="sup_archived">Archived Suppliers</button>
                   <button class="btn primary" id="sup_new">+ New Supplier</button>`
            }
          </div>
        </div>
        <div class="bd">
          <div style="max-height:60vh;overflow:auto">
            <table class="table">
              <thead>
                <tr><th>Code</th><th>Name</th><th>Contact</th><th>Phone</th><th>Last PINV</th><th>Spend (90d)</th><th></th></tr>
              </thead>
              <tbody id="sup_rows">${rows || '<tr><td colspan="7">No suppliers yet</td></tr>'}</tbody>
            </table>
          </div>
        </div>
      </div>
    `;

    // Search filter
    const filter = () => {
      const q = ($("#sup_search").value || "").toLowerCase();
      $$("#sup_rows tr").forEach(tr => {
        tr.style.display = tr.textContent.toLowerCase().includes(q) ? "" : "none";
      });
    };
    $("#sup_search").oninput = filter;

    // Toolbar nav
    $("#sup_archived")?.addEventListener("click", () => goto("/suppliers-archived"));
    $("#sup_back_active")?.addEventListener("click", () => goto("/suppliers"));

    // New supplier (only on active list)
    $("#sup_new")?.addEventListener("click", () => openSupplierFormImpl());

    // Edit buttons
    $$("#sup_rows [data-edit]").forEach(btn => {
      btn.onclick = () => openSupplierFormImpl(btn.dataset.edit);
    });
  }

  // ------------------------------ MODAL FORM --------------------------------
  async function openSupplierFormImpl(id) {
    const m = $("#modal"), body = $("#modalBody");
    if (!m || !body) return;

    const editing = id ? await get("suppliers", id) : null;
    const s = editing || {
      id: randId(),
      code: "",
      name: "",
      contact: { person: "", phone: "", email: "" },
      termsDays: 30,
      notes: "",
      archived: false,
      createdAt: nowISO(),
    };

    // Are we currently in archived view?
    const inArchivedView = (location.hash || "").includes("/suppliers-archived");

    // Recent purchases for this supplier (last 6)
    const docs = await all("docs");
    const recent = (docs || [])
      .filter(d => d.type === "PINV" && d.supplierId === s.id)
      .sort((a,b) => (b.dates?.issue || b.createdAt || "").localeCompare(a.dates?.issue || a.createdAt || ""))
      .slice(0, 6);

    body.innerHTML = `
      <div class="hd" style="display:flex;justify-content:space-between;align-items:center">
        <h3>${editing ? "Edit" : "New"} Supplier</h3>
        <div class="row">
          ${editing ? `<button class="btn warn" id="sup_archive">${s.archived ? "Unarchive" : "Archive"}</button>` : ""}
          <button class="btn success" id="sup_save">${editing ? "Save" : "Create"}</button>
          <button class="btn" onclick="document.getElementById('modal').close()">Close</button>
        </div>
      </div>
      <div class="bd">
        <div class="form-grid">
          <label class="input"><span>Code</span><input id="s_code" value="${s.code || ""}"></label>
          <label class="input" style="grid-column:span 2"><span>Name</span><input id="s_name" value="${s.name || ""}"></label>
          <label class="input"><span>Contact person</span><input id="s_person" value="${s.contact?.person || ""}"></label>
          <label class="input"><span>Phone</span><input id="s_phone" value="${s.contact?.phone || ""}"></label>
          <label class="input"><span>Email</span><input id="s_email" value="${s.contact?.email || ""}"></label>
          <label class="input"><span>Terms (days)</span><input id="s_terms" type="number" min="0" step="1" value="${s.termsDays ?? 0}"></label>
          <label class="input" style="grid-column:1/-1"><span>Notes</span><input id="s_notes" value="${s.notes || ""}"></label>
        </div>

        ${recent.length ? `
        <div class="card" style="margin-top:12px">
          <div class="hd"><b>Recent purchases</b></div>
          <div class="bd">
            <table class="table small">
              <thead><tr><th>No</th><th>Date</th><th class="r">Total</th></tr></thead>
              <tbody>
                ${recent.map(d => `
                  <tr>
                    <td>${d.no || ""}</td>
                    <td>${(d.dates?.issue || d.createdAt || "").slice(0,10)}</td>
                    <td class="r">${currency(d.totals?.grandTotal || 0)}</td>
                  </tr>`).join("")}
              </tbody>
            </table>
          </div>
        </div>` : ""}
      </div>
    `;
    m.showModal();

    // Bind fields
    $("#s_code").oninput  = () => s.code = $("#s_code").value.trim();
    $("#s_name").oninput  = () => s.name = $("#s_name").value.trim();
    $("#s_person").oninput= () => (s.contact = { ...(s.contact||{}), person: $("#s_person").value.trim() });
    $("#s_phone").oninput = () => (s.contact = { ...(s.contact||{}), phone: $("#s_phone").value.trim() });
    $("#s_email").oninput = () => (s.contact = { ...(s.contact||{}), email: $("#s_email").value.trim() });
    $("#s_terms").oninput = () => s.termsDays = Math.max(0, parseInt($("#s_terms").value || "0", 10));
    $("#s_notes").oninput = () => s.notes = $("#s_notes").value;

    // Archive / Unarchive
    if ($("#sup_archive")) {
      $("#sup_archive").onclick = async () => {
        s.archived = !s.archived;
        await put("suppliers", s);
        toast(s.archived ? "Supplier archived" : "Supplier unarchived");
        m.close();
        // Refresh current list using INTERNAL impl (avoid router recursion)
        if (inArchivedView) {
          renderSuppliersImpl({ archived: true });
        } else {
          renderSuppliersImpl({ archived: false });
        }
      };
    }

    // Save / Create
    $("#sup_save").onclick = async () => {
      if (!s.name) return toast("Name is required", "warn");
      if (!s.code) s.code = (s.name || "").toUpperCase().replace(/[^A-Z0-9]+/g, "").slice(0, 10) || "SUP";

      // unique code safeguard
      const allS = await all("suppliers");
      const dup = (allS || []).find(x => x.code === s.code && x.id !== s.id);
      if (dup) return toast("Code already in use", "warn");

      await put("suppliers", s);
      toast(editing ? "Supplier updated" : "Supplier created", "success");
      m.close();

      if (inArchivedView) {
        renderSuppliersImpl({ archived: true });
      } else {
        renderSuppliersImpl({ archived: false });
      }
    };
  }

  // ----------------------------- PUBLIC EXPORTS ------------------------------
  window.renderSuppliers = () => renderSuppliersImpl({ archived: false });
  window.renderSuppliersArchived = () => renderSuppliersImpl({ archived: true });
  window.openSupplierForm = (id) => openSupplierFormImpl(id);
})();
