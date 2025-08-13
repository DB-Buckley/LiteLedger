// ============================================================================
// Payments & Statements
// Depends on: 01-db.js, 02-helpers.js

// ---------- Helper: compute unpaid invoices summary ----------
async function computeUnpaidInvoices() {
  const [docs, payments, customers] = await Promise.all([all("docs"), all("payments"), all("customers")]);
  const invoices = docs.filter(d => d.type === "INVOICE");

  // Build paid map from allocations
  const paidByInv = new Map(); // invoiceId -> paid
  for (const p of payments) {
    for (const a of (p.allocations || [])) {
      const amt = Number(a.amount) || 0;
      paidByInv.set(a.invoiceId, (paidByInv.get(a.invoiceId) || 0) + amt);
    }
  }

  const custName = (id) => customers.find(c => c.id === id)?.name || "—";

  const rows = [];
  let total = 0;
  for (const inv of invoices) {
    const totalInc = inv.totals?.grandTotal || 0;
    const paid = paidByInv.get(inv.id) || 0;
    const owing = Math.max(0, round2(totalInc - paid));
    if (owing > 0) {
      rows.push({
        id: inv.id,
        no: inv.no || "",
        customerId: inv.customerId || "",
        customerName: custName(inv.customerId),
        due: inv.dates?.due || inv.dates?.issue || "",
        total: round2(totalInc),
        paid: round2(paid),
        owing: round2(owing),
      });
      total += owing;
    }
  }

  // oldest due first
  rows.sort((a, b) => (a.due || "").localeCompare(b.due || ""));
  return { rows, total: round2(total) };
}

// ---------- Page: Payments list + actions ----------
async function renderPayments() {
  const v = $("#view");
  const { rows, total } = await computeUnpaidInvoices();

  v.innerHTML = `
    <div class="card">
      <div class="hd">
        <b>Payments & Statements</b>
        <div class="toolbar">
          <button class="btn primary" id="pay_receive">+ Receive Payment</button>
          <button class="btn" id="stmt_btn">Customer Statement</button>
          <span class="pill">Outstanding: ${currency(total)}</span>
        </div>
      </div>
      <div class="bd">
        <div style="max-height:60vh;overflow:auto">
          <table class="table">
            <thead><tr><th>Invoice</th><th>Customer</th><th>Due</th><th>Total</th><th>Paid</th><th>Owing</th></tr></thead>
            <tbody id="pay_rows">
              ${rows.map(r => `
                <tr>
                  <td>${r.no}</td>
                  <td>${r.customerName}</td>
                  <td>${(r.due || "").slice(0,10)}</td>
                  <td>${currency(r.total)}</td>
                  <td>${currency(r.paid)}</td>
                  <td>${currency(r.owing)}</td>
                </tr>
              `).join("") || `<tr><td colspan="6">No unpaid invoices 🎉</td></tr>`}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  `;

  $("#pay_receive").onclick = () => openReceivePayment();
  $("#stmt_btn").onclick = () => openStatement();
}

// ---------- Modal: Receive Payment & allocations ----------
async function openReceivePayment() {
  const m = $("#modal"), body = $("#modalBody");
  const [customers, pays, docs] = await Promise.all([all("customers"), all("payments"), all("docs")]);

  const invoicesByCustomer = (custId) => {
    return docs
      .filter(d => d.type === "INVOICE" && d.customerId === custId)
      .map(i => {
        const paid = pays
          .flatMap(p => p.allocations || [])
          .filter(a => a.invoiceId === i.id)
          .reduce((s, a) => s + (Number(a.amount) || 0), 0);
        const total = i.totals?.grandTotal || 0;
        const owing = Math.max(0, round2(total - paid));
        return { id: i.id, no: i.no, due: i.dates?.due, total, paid, owing };
      })
      .filter(r => r.owing > 0)
      .sort((a, b) => (a.due || "").localeCompare(b.due || ""));
  };

  let allocations = []; // {invoiceId, amount}

  function draw(custId = customers[0]?.id) {
    const invs = invoicesByCustomer(custId);
    const rows = invs.map(r => `
      <tr data-id="${r.id}">
        <td>${r.no}</td>
        <td>${(r.due || "").slice(0,10)}</td>
        <td>${currency(r.total)}</td>
        <td>${currency(r.paid)}</td>
        <td>${currency(r.owing)}</td>
        <td><input type="number" min="0" step="0.01" value="${allocations.find(a => a.invoiceId === r.id)?.amount || 0}" data-alloc="${r.id}"></td>
      </tr>
    `).join("");

    body.innerHTML = `
      <div class="hd" style="display:flex;justify-content:space-between;align-items:center">
        <h3>Receive Payment</h3>
        <div class="row">
          <button class="btn success" id="pay_save">Save</button>
          <button class="btn" onclick="document.getElementById('modal').close()">Close</button>
        </div>
      </div>
      <div class="bd">
        <div class="form-grid">
          <label class="input"><span>Customer</span>
            <select id="pay_cust">
              ${customers.map(c => `<option value="${c.id}" ${c.id === custId ? "selected" : ""}>${c.name}</option>`).join("")}
            </select>
          </label>
          <label class="input"><span>Date</span><input id="pay_date" type="date" value="${nowISO().slice(0,10)}"></label>
          <label class="input"><span>Reference</span><input id="pay_ref" placeholder="EFT / Cash / Ref #"></label>
          <label class="input"><span>Amount</span><input id="pay_amount" type="number" min="0" step="0.01" value="0"></label>
        </div>

        <div class="toolbar" style="margin-top:10px">
          <button class="btn" id="pay_auto">Auto-allocate oldest first</button>
        </div>

        <div style="max-height:320px;overflow:auto">
          <table class="table">
            <thead><tr><th>Invoice</th><th>Due</th><th>Total</th><th>Paid</th><th>Owing</th><th>Allocate</th></tr></thead>
            <tbody id="alloc_rows">
              ${rows || `<tr><td colspan="6">No unpaid invoices</td></tr>`}
            </tbody>
          </table>
        </div>

        <div class="row" style="justify-content:flex-end;gap:18px;margin-top:10px">
          <div><div class="sub">Allocated</div><div id="alloc_sum" class="r">R 0.00</div></div>
        </div>
      </div>
    `;
    m.showModal();

    const recalc = () => {
      const sum = allocations.reduce((s, a) => s + (Number(a.amount) || 0), 0);
      $("#alloc_sum").textContent = currency(sum);
    };

    $("#pay_cust").onchange = () => {
      allocations = [];
      draw($("#pay_cust").value);
    };

    $$("#alloc_rows [data-alloc]").forEach(inp => {
      inp.oninput = () => {
        const id = inp.dataset.alloc;
        const amt = Number(inp.value) || 0;
        const idx = allocations.findIndex(a => a.invoiceId === id);
        if (idx >= 0) allocations[idx].amount = amt;
        else allocations.push({ invoiceId: id, amount: amt });
        recalc();
      };
    });

    $("#pay_auto").onclick = () => {
      const totalAmt = Number($("#pay_amount").value) || 0;
      let remain = totalAmt;
      allocations = [];
      $$("#alloc_rows tr").forEach(tr => {
        const id = tr.dataset.id;
        const owing = Number(tr.children[4].textContent.replace(/[^\d.-]/g, "")) || 0;
        const alloc = Math.max(0, Math.min(owing, remain));
        const cell = tr.querySelector("[data-alloc]");
        if (cell) cell.value = alloc.toFixed(2);
        if (alloc > 0) allocations.push({ invoiceId: id, amount: alloc });
        remain -= alloc;
      });
      recalc();
    };

    $("#pay_save").onclick = async () => {
      const pay = {
        id: randId(),
        customerId: $("#pay_cust").value,
        date: $("#pay_date").value,
        ref: $("#pay_ref").value.trim(),
        amount: Number($("#pay_amount").value) || allocations.reduce((s, a) => s + (Number(a.amount) || 0), 0),
        allocations: allocations.filter(a => (Number(a.amount) || 0) > 0),
        createdAt: nowISO(),
      };
      if (!pay.customerId) return toast("Select a customer", "warn");
      if (!pay.amount || pay.amount <= 0) return toast("Enter an amount", "warn");
      await add("payments", pay);
      toast("Payment saved", "success");
      m.close();
      renderPayments();
    };

    recalc();
  }

  draw();
}

// ---------- Modal: Customer Statement (range + CSV) ----------
async function openStatement() {
  const m = $("#modal"), body = $("#modalBody");
  const [customers, docs, payments] = await Promise.all([all("customers"), all("docs"), all("payments")]);

  function draw(customerId = customers[0]?.id, from = "", to = "") {
    const invs = docs.filter(d => d.type === "INVOICE" && d.customerId === customerId);
    const pays = payments.filter(p => p.customerId === customerId);

    const tx = [];
    for (const i of invs) {
      tx.push({
        date: (i.dates?.issue || "").slice(0, 10),
        desc: `Invoice ${i.no || ""}`,
        debit: i.totals?.grandTotal || 0,
        credit: 0,
      });
    }
    for (const p of pays) {
      tx.push({
        date: (p.date || "").slice(0, 10),
        desc: `Payment ${p.ref || p.id.slice(-6)}`,
        debit: 0,
        credit: p.amount || 0,
      });
    }
    tx.sort((a, b) => (a.date || "").localeCompare(b.date || ""));

    const fromD = from ? new Date(from) : null;
    const toD = to ? new Date(to) : null;
    const filtered = tx.filter(t => {
      const d = new Date(t.date || "1970-01-01");
      if (fromD && d < fromD) return false;
      if (toD && d > toD) return false;
      return true;
    });

    let bal = 0;
    const rows = filtered.map(t => {
      bal = round2(bal + (t.debit || 0) - (t.credit || 0));
      return `
        <tr>
          <td>${t.date}</td>
          <td>${t.desc}</td>
          <td class="r">${t.debit ? currency(t.debit) : ""}</td>
          <td class="r">${t.credit ? currency(t.credit) : ""}</td>
          <td class="r">${currency(bal)}</td>
        </tr>
      `;
    }).join("");

    body.innerHTML = `
      <div class="hd" style="display:flex;justify-content:space-between;align-items:center">
        <h3>Customer Statement</h3>
        <div class="row">
          <button class="btn" id="stmt_csv">Download CSV</button>
          <button class="btn" onclick="document.getElementById('modal').close()">Close</button>
        </div>
      </div>
      <div class="bd">
        <div class="form-grid">
          <label class="input"><span>Customer</span>
            <select id="stmt_cust">
              ${customers.map(c => `<option value="${c.id}" ${c.id === customerId ? "selected" : ""}>${c.name}</option>`).join("")}
            </select>
          </label>
          <label class="input"><span>From</span><input id="stmt_from" type="date" value="${from}"></label>
          <label class="input"><span>To</span><input id="stmt_to" type="date" value="${to}"></label>
        </div>
        <div style="max-height:360px;overflow:auto;margin-top:10px">
          <table class="table">
            <thead><tr><th>Date</th><th>Description</th><th>Debit</th><th>Credit</th><th>Balance</th></tr></thead>
            <tbody>${rows || `<tr><td colspan="5">No transactions in range</td></tr>`}</tbody>
          </table>
        </div>
      </div>
    `;

    $("#stmt_cust").onchange = () => draw($("#stmt_cust").value, $("#stmt_from").value, $("#stmt_to").value);
    $("#stmt_from").onchange = () => draw($("#stmt_cust").value, $("#stmt_from").value, $("#stmt_to").value);
    $("#stmt_to").onchange = () => draw($("#stmt_cust").value, $("#stmt_from").value, $("#stmt_to").value);

    $("#stmt_csv").onclick = () => {
      const csv = ["Date,Description,Debit,Credit,Balance"]
        .concat(
          Array.from(body.querySelectorAll("tbody tr")).map(tr => {
            const tds = tr.querySelectorAll("td");
            return Array.from(tds).map(td =>
              `"${td.textContent.trim().replace(/"/g, '""')}"`
            ).join(",");
          })
        )
        .join("\n");
      const blob = new Blob([csv], { type: "text/csv" });
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      const custName = $("#stmt_cust").selectedOptions[0]?.textContent || "customer";
      a.download = `statement-${custName.replace(/\s+/g, "_")}.csv`;
      a.click();
    };
  }

  draw();
  m.showModal();
}
