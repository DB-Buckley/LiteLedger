// ============================================================================
// Customers (active + archived lists + create/edit modal)
// Depends on: 01-db.js, 02-helpers.js ($, $$, all, get, put, del, nowISO, randId, round2, currency, toast, goto)
// Routes used: "#/customers", "#/customers-archived"
// Exposes: window.renderCustomers, window.renderCustomersArchived, window.openCustomerForm
// ============================================================================

(() => {
  // --------------------------- INTERNAL RENDERER ----------------------------
  async function renderCustomersImpl(opts = {}) {
    const archived = !!opts.archived;
    const v = $("#view");
    if (!v) return;

    // Load data for quick stats (owing per customer)
    const [customersAll, docsAll, paymentsAll] = await Promise.all([
      all("customers"),
      all("docs"),
      all("payments"),
    ]);

    const customers = (customersAll || []).filter(c => !!c.archived === archived);

    // Open balances from invoices minus allocations
    const invoices = (docsAll || []).filter(d => d.type === "INVOICE");
    const paidByInv = new Map();
    for (const p of (paymentsAll || [])) {
      for (const a of (p.allocations || [])) {
        paidByInv.set(a.invoiceId, (paidByInv.get(a.invoiceId) || 0) + (Number(a.amount) || 0));
      }
    }
    const owingByCustomer = new Map();
    for (const inv of invoices) {
      const total = inv.totals?.grandTotal || 0;
      const paid  = paidByInv.get(inv.id) || 0;
      const owing = Math.max(0, round2(total - paid));
      if (owing > 0) {
        const k = inv.customerId || "unknown";
        owingByCustomer.set(k, (owingByCustomer.get(k) || 0) + owing);
      }
    }

    // Rows
    const rowsHtml =
      (customers
        .sort((a, b) => (a.name || "").localeCompare(b.name || ""))
        .map(c => `
          <tr data-id="${c.id}">
            <td>${c.code || ""}</td>
            <td>
              ${c.name || ""}
              ${c.archived ? ' <span class="pill" style="margin-left:6px;background:#ddd;color:#333">archived</span>' : ""}
            </td>
            <td>${c.contact?.person || ""}</td>
            <td>${c.contact?.phone || ""}</td>
            <td class="r">${currency(owingByCustomer.get(c.id) || 0)}</td>
            <td class="r">${c.termsDays ?? 0}d</td>
            <td class="r">
              <button class="btn" data-edit="${c.id}">Edit</button>
            </td>
          </tr>
        `).join("")) || '<tr><td colspan="7">No customers yet</td></tr>';

    v.innerHTML = `
      <div class="card">
        <div class="hd">
          <b>${archived ? "Archived Customers" : "Customers"}</b>
          <div class="toolbar">
            <input id="cust_search" placeholder="Search name / code / contact" style="min-width:280px">
            ${
              archived
                ? `<button class="btn" id="cust_back_active">Active Customers</button>`
                : `<button class="btn" id="cust_archived">Archived Customers</button>
                   <button class="btn primary" id="cust_new">+ New Customer</button>`
            }
          </div>
        </div>
        <div class="bd">
          <div style="max-height:60vh;overflow:auto">
            <table class="table">
              <thead>
                <tr><th>Code</th><th>Name</th><th>Contact</th><th>Phone</th><th>Owing</th><th>Terms</th><th></th></tr>
              </thead>
              <tbody id="cust_rows">${rowsHtml}</tbody>
            </table>
          </div>
        </div>
      </div>
    `;

    // Search filter
    const filter = () => {
      const q = ($("#cust_search").value || "").toLowerCase();
      $$("#cust_rows tr").forEach(tr => {
        tr.style.display = tr.textContent.toLowerCase().includes(q) ? "" : "none";
      });
    };
    $("#cust_search").oninput = filter;

    // Toolbar nav
    $("#cust_archived")?.addEventListener("click", () => goto("/customers-archived"));
    $("#cust_back_active")?.addEventListener("click", () => goto("/customers"));

    // New customer (only on active list)
    $("#cust_new")?.addEventListener("click", () => openCustomerFormImpl());

    // Edit buttons
    $$("#cust_rows [data-edit]").forEach(btn => {
      btn.onclick = () => openCustomerFormImpl(btn.dataset.edit);
    });
  }

  // ------------------------------ MODAL FORM --------------------------------
  async function openCustomerFormImpl(id) {
    const m = $("#modal"), body = $("#modalBody");
    if (!m || !body) return;

    const editing = id ? await get("customers", id) : null;
    const c = editing || {
      id: randId(),
      code: "",
      name: "",
      contact: { person: "", phone: "", email: "" },
      termsDays: 30,
      creditLimit: 0,
      taxExempt: false,
      openingBalance: 0,
      archived: false,
      createdAt: nowISO(),
    };

    const inArchivedView = (location.hash || "").includes("/customers-archived");

    // Quick activity (last 6 docs)
    const docsAll = await all("docs");
    const recent = (docsAll || [])
      .filter(d => d.customerId === c.id)
      .sort((a,b) => (b.dates?.issue || b.createdAt || "").localeCompare(a.dates?.issue || a.createdAt || ""))
      .slice(0, 6);

    body.innerHTML = `
      <div class="hd" style="display:flex;justify-content:space-between;align-items:center">
        <h3>${editing ? "Edit" : "New"} Customer</h3>
        <div class="row">
          ${editing ? `<button class="btn warn" id="cust_archive">${c.archived ? "Unarchive" : "Archive"}</button>` : ""}
          <button class="btn success" id="cust_save">${editing ? "Save" : "Create"}</button>
          <button class="btn" onclick="document.getElementById('modal').close()">Close</button>
        </div>
      </div>
      <div class="bd">
        <div class="form-grid">
          <label class="input"><span>Code</span><input id="c_code" value="${c.code || ""}"></label>
          <label class="input" style="grid-column:span 2"><span>Name</span><input id="c_name" value="${c.name || ""}"></label>
          <label class="input"><span>Contact person</span><input id="c_person" value="${c.contact?.person || ""}"></label>
          <label class="input"><span>Phone</span><input id="c_phone" value="${c.contact?.phone || ""}"></label>
          <label class="input"><span>Email</span><input id="c_email" value="${c.contact?.email || ""}"></label>
          <label class="input"><span>Terms (days)</span><input id="c_terms" type="number" min="0" step="1" value="${c.termsDays ?? 0}"></label>
          <label class="input"><span>Credit limit</span><input id="c_limit" type="number" min="0" step="0.01" value="${c.creditLimit ?? 0}"></label>
          <label class="input"><span>Tax exempt</span><input id="c_tax" type="checkbox" ${c.taxExempt ? "checked" : ""}></label>
          <label class="input" style="grid-column:1/-1"><span>Opening balance</span><input id="c_open" type="number" step="0.01" value="${c.openingBalance ?? 0}"></label>
        </div>

        ${recent.length ? `
        <div class="card" style="margin-top:12px">
          <div class="hd"><b>Recent activity</b></div>
          <div class="bd">
            <table class="table small">
              <thead><tr><th>Type</th><th>No</th><th>Date</th><th class="r">Total</th></tr></thead>
              <tbody>
                ${recent.map(d => `
                  <tr>
                    <td>${d.type}</td>
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
    $("#c_code").oninput   = () => c.code = $("#c_code").value.trim();
    $("#c_name").oninput   = () => c.name = $("#c_name").value.trim();
    $("#c_person").oninput = () => (c.contact = { ...(c.contact||{}), person: $("#c_person").value.trim() });
    $("#c_phone").oninput  = () => (c.contact = { ...(c.contact||{}), phone: $("#c_phone").value.trim() });
    $("#c_email").oninput  = () => (c.contact = { ...(c.contact||{}), email: $("#c_email").value.trim() });
    $("#c_terms").oninput  = () => c.termsDays = Math.max(0, parseInt($("#c_terms").value || "0", 10));
    $("#c_limit").oninput  = () => c.creditLimit = round2($("#c_limit").value || 0);
    $("#c_tax").onchange   = () => c.taxExempt = $("#c_tax").checked;
    $("#c_open").oninput   = () => c.openingBalance = round2($("#c_open").value || 0);

    // Archive / Unarchive
    if ($("#cust_archive")) {
      $("#cust_archive").onclick = async () => {
        c.archived = !c.archived;
        await put("customers", c);
        toast(c.archived ? "Customer archived" : "Customer unarchived");
        m.close();
        // Refresh the list the user is currently on (call INTERNAL impl to avoid router recursion)
        if (inArchivedView) {
          renderCustomersImpl({ archived: true });
        } else {
          renderCustomersImpl({ archived: false });
        }
      };
    }

    // Save / Create
    $("#cust_save").onclick = async () => {
      if (!c.name) return toast("Name is required", "warn");
      if (!c.code)
        c.code = (c.name || "").toUpperCase().replace(/[^A-Z0-9]+/g, "").slice(0, 10) || "CUST";

      // Unique code safeguard
      const allC = await all("customers");
      const dup = (allC || []).find(x => x.code === c.code && x.id !== c.id);
      if (dup) return toast("Code already in use", "warn");

      await put("customers", c);
      toast(editing ? "Customer updated" : "Customer created", "success");
      m.close();

      if (inArchivedView) {
        renderCustomersImpl({ archived: true });
      } else {
        renderCustomersImpl({ archived: false });
      }
    };
  }

  // ----------------------------- PUBLIC EXPORTS ------------------------------
  window.renderCustomers = () => renderCustomersImpl({ archived: false });
  window.renderCustomersArchived = () => renderCustomersImpl({ archived: true });
  window.openCustomerForm = (id) => openCustomerFormImpl(id);
})();
