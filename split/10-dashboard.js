// ============================================================================
// Dashboard
// Depends on: 01-db.js, 02-helpers.js, 03-bootstrap.js
// Notes:
// - No top-level await
// - Exposes window.renderDashboard for 95-router.js to use
// - Ensures dashboard defaults inside renderDashboard (safe to call anytime)

(() => {
  // ------------------------------ Public API --------------------------------
  async function renderDashboard() {
    const v = $("#view");
    if (!v) return;

    // Ensure settings + dashboard defaults exist (supports both "return" or "mutate" styles)
    const sRec = await get("settings", "app");
    const settings = sRec?.value || {};

    let dash = ensureDashboardDefaults(settings.dashboard);
    if (!dash) {
      // If helper mutates the full settings object instead of returning the dashboard
      ensureDashboardDefaults(settings);
      dash = settings.dashboard;
    }
    settings.dashboard = dash || { sizes: {} };

    await put("settings", { key: "app", value: settings });

    // Data needed by widgets (defensive: all() returns [] if empty)
    const [docs, lines, items, payments, customers] = await Promise.all([
      all("docs"),
      all("lines"),
      all("items"),
      all("payments"),
      all("customers"),
    ]);

    const invoices = (docs || []).filter(d => d.type === "INVOICE");
    const quotes   = (docs || []).filter(d => d.type === "QUOTE");

    v.innerHTML = `
      <div class="card">
        <div class="hd">
          <b>Dashboard</b>
          <div class="toolbar">
            <button class="btn" id="dash_reset">Reset layout</button>
          </div>
        </div>
        <div class="bd">
          <div id="widgets" class="widgets" style="
            display:grid; gap:12px;
            grid-template-columns: repeat(3, minmax(0,1fr));
            grid-auto-rows: 120px;">
            
            ${widgetCard("salesTrend", "Sales Trend (12 mo)", `
              <div id="w_salesTrend" class="spark"></div>
            `)}

            ${widgetCard("unpaid", "Unpaid Invoices", `
              <div id="w_unpaid_total" class="big"></div>
              <div id="w_unpaid_count" class="muted"></div>
            `)}

            ${widgetCard("lowStock", "Low Stock", `
              <div style="max-height:150px;overflow:auto">
                <table class="table small">
                  <thead><tr><th>SKU</th><th>Item</th><th class="r">On Hand</th></tr></thead>
                  <tbody id="w_low_rows"><tr><td colspan="3">Loading…</td></tr></tbody>
                </table>
              </div>
            `)}

            ${widgetCard("conversion", "Quote → Invoice", `
              <div id="w_conv_rate" class="big"></div>
              <div id="w_conv_note" class="muted"></div>
            `)}

            ${widgetCard("topCustomers", "Top Customers (90d)", `
              <div style="max-height:150px;overflow:auto">
                <table class="table small">
                  <thead><tr><th>Customer</th><th class="r">Sales</th></tr></thead>
                  <tbody id="w_topcust_rows"><tr><td colspan="2">Loading…</td></tr></tbody>
                </table>
              </div>
            `)}

            ${widgetCard("topItems", "Top Items (90d)", `
              <div style="max-height:150px;overflow:auto">
                <table class="table small">
                  <thead><tr><th>Item</th><th class="r">Sales</th></tr></thead>
                  <tbody id="w_topitem_rows"><tr><td colspan="2">Loading…</td></tr></tbody>
                </table>
              </div>
            `)}
          </div>
        </div>
      </div>
    `;

    // Apply initial sizes from settings (guarded)
    applyWidgetSizes((settings.dashboard && settings.dashboard.sizes) || {});

    // Wire reset (guarantee a valid default object even if helper returns nothing)
    $("#dash_reset").onclick = async () => {
      const rec = await get("settings", "app");
      const maybeDefault = ensureDashboardDefaults(null);
      rec.value.dashboard = maybeDefault || { sizes: {} };
      await put("settings", { key: "app", value: rec.value });
      renderDashboard();
    };

    // Populate widgets
    await Promise.all([
      drawSalesTrend(invoices),
      drawUnpaid(invoices, payments, customers),
      drawLowStock(items),
      drawConversion(quotes, invoices),
      drawTopCustomers(invoices, lines, customers),
      drawTopItems(invoices, lines),
    ]);

    // Enable resizing (safe)
    enableWidgetResize();
  }

  // ------------------------------ UI helpers --------------------------------
  function widgetCard(id, title, innerHtml) {
    return `
      <div class="widget card" data-wid="${id}" style="min-height:120px">
        <div class="hd" style="position:relative">
          <b>${title}</b>
        </div>
        <div class="bd">
          ${innerHtml}
        </div>
      </div>
    `;
  }

  function applyWidgetSizes(sizes = {}) {
    const container = $("#widgets");
    if (!container) return;
    const isNarrow = window.matchMedia("(max-width:800px)").matches;
    const colCount = isNarrow ? 1 : 3;

    container.querySelectorAll(".widget").forEach((w) => {
      const key = w.dataset.wid;
      const sz = sizes[key] || { w: 1, h: 1 };
      const wUnits = Math.max(1, Math.min(colCount, Number(sz.w) || 1));
      const hUnits = Math.max(1, Math.min(6, Number(sz.h) || 1));
      w.style.gridColumn = `span ${wUnits}`;
      w.style.gridRow = `span ${hUnits}`;
      if (!w.querySelector(".resize")) {
        const r = document.createElement("div");
        r.className = "resize";
        r.textContent = "⇲";
        r.style.cssText = "position:absolute;right:8px;bottom:6px;cursor:nwse-resize;opacity:.6";
        w.style.position = "relative";
        w.appendChild(r);
      }
    });
  }

  // --- Resizing (snap to grid), safe writes to settings.dashboard.sizes
  function enableWidgetResize() {
    const container = document.getElementById("widgets");
    if (!container) return;

    const isNarrow = window.matchMedia("(max-width:800px)").matches;
    const colCount = isNarrow ? 1 : 3;
    const cs = getComputedStyle(container);
    const unitH = parseFloat(cs.gridAutoRows) || 120;

    let resizing = null, startX = 0, startY = 0, startW = 1, startH = 1;

    container.addEventListener("pointerdown", (e) => {
      const hit = e.target.closest(".resize");
      if (!hit) return;
      const card = hit.closest(".widget");

      const style = getComputedStyle(card);
      const spanParse = (endProp, startProp) => {
        const end = style[endProp];
        const m = /span\s+(\d+)/.exec(end);
        if (m) return Math.max(1, parseInt(m[1], 10));
        const start = parseInt(style[startProp], 10);
        const endNum = parseInt(end, 10);
        const span = isFinite(start) && isFinite(endNum) ? Math.max(1, endNum - start) : 1;
        return span;
      };
      const curW = spanParse("gridColumnEnd", "gridColumnStart");
      const curH = spanParse("gridRowEnd", "gridRowStart");

      resizing = { card, key: card.dataset.wid };
      startX = e.clientX;
      startY = e.clientY;
      startW = curW;
      startH = curH;
      card.setPointerCapture(e.pointerId);
    });

    container.addEventListener("pointermove", (e) => {
      if (!resizing) return;
      const dx = e.clientX - startX;
      const dy = e.clientY - startY;
      const w = Math.max(1, Math.min(colCount, Math.round(startW + dx / (container.clientWidth / colCount))));
      const h = Math.max(1, Math.min(6, Math.round(startH + dy / unitH)));
      resizing.card.style.gridColumn = `span ${w}`;
      resizing.card.style.gridRow = `span ${h}`;
    });

    container.addEventListener("pointerup", async () => {
      if (!resizing) return;
      const style = getComputedStyle(resizing.card);
      const spanParse = (endProp, startProp) => {
        const end = style[endProp];
        const m = /span\s+(\d+)/.exec(end);
        if (m) return Math.max(1, parseInt(m[1], 10));
        const start = parseInt(style[startProp], 10);
        const endNum = parseInt(end, 10);
        const span = isFinite(start) && isFinite(endNum) ? Math.max(1, endNum - start) : 1;
        return span;
      };

      const isNarrow2 = window.matchMedia("(max-width:800px)").matches;
      const colCount2 = isNarrow2 ? 1 : 3;

      const wUnits = Math.max(1, Math.min(colCount2, spanParse("gridColumnEnd", "gridColumnStart")));
      const hUnits = Math.max(1, Math.min(6, spanParse("gridRowEnd", "gridRowStart")));

      const s2 = await get("settings", "app");
      const v2 = s2.value || (s2.value = {});

      // Robust defaulting again in case helper returns nothing
      let dash2 = ensureDashboardDefaults(v2.dashboard);
      if (!dash2) {
        ensureDashboardDefaults(v2);
        dash2 = v2.dashboard;
      }
      v2.dashboard = dash2 || { sizes: {} };

      v2.dashboard.sizes[resizing.key] = { w: wUnits, h: hUnits };
      await put("settings", { key: "app", value: v2 });

      resizing = null;
    });
  }

  // ========================== Widget draw functions ===========================
  async function drawSalesTrend(invoices) {
    // last 12 months, inclusive of current month
    const buckets = new Map(); // "YYYY-MM" -> total
    const now = new Date();
    for (let i = 11; i >= 0; i--) {
      const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
      const key = `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,"0")}`;
      buckets.set(key, 0);
    }
    for (const inv of invoices) {
      const dt = new Date(inv.dates?.issue || inv.createdAt || nowISO());
      const key = `${dt.getFullYear()}-${String(dt.getMonth()+1).padStart(2,"0")}`;
      if (buckets.has(key)) {
        buckets.set(key, (buckets.get(key) || 0) + (inv.totals?.grandTotal || 0));
      }
    }
    const data = Array.from(buckets.values());
    const max = Math.max(1, ...data);
    const bars = data.map(v => {
      const h = Math.round((v / max) * 80) + 8; // min height 8
      return `<div style="height:${h}px;flex:1"></div>`;
    }).join("");
    const el = $("#w_salesTrend");
    if (el) {
      el.innerHTML = `<div style="display:flex;gap:4px;align-items:flex-end;height:96px">${bars}</div>`;
    }
  }

  async function drawUnpaid(invoices, payments, customers) {
    // compute paid per invoice via allocations
    const paidByInv = new Map(); // id -> paid
    for (const p of (payments || [])) {
      for (const a of (p.allocations || [])) {
        paidByInv.set(a.invoiceId, (paidByInv.get(a.invoiceId) || 0) + (Number(a.amount) || 0));
      }
    }
    let totalOwing = 0, count = 0;
    for (const inv of (invoices || [])) {
      const total = inv.totals?.grandTotal || 0;
      const paid = paidByInv.get(inv.id) || 0;
      const owing = Math.max(0, round2(total - paid));
      if (owing > 0) { totalOwing += owing; count++; }
    }
    const totEl = $("#w_unpaid_total");
    const cntEl = $("#w_unpaid_count");
    if (totEl) totEl.textContent = currency(totalOwing);
    if (cntEl) cntEl.textContent = `${count} open invoice${count === 1 ? "" : "s"}`;
  }

  async function drawLowStock(items) {
    const rows = [];
    for (const it of (items || [])) {
      if (it.nonStock) continue;
      const bal = await balanceQty(it.id);
      const onHand = (Number(it.openingQty) || 0) + bal;
      if (typeof it.reOrderLevel === "number" && onHand <= it.reOrderLevel) {
        rows.push(`<tr>
          <td>${it.sku || ""}</td>
          <td>${it.name || ""}</td>
          <td class="r">${onHand}</td>
        </tr>`);
      }
    }
    const tbl = $("#w_low_rows");
    if (tbl) tbl.innerHTML = rows.length ? rows.join("") : `<tr><td colspan="3">All good ✔</td></tr>`;
  }

  async function drawConversion(quotes, invoices) {
    // 90-day window
    const cutoff = new Date(); cutoff.setDate(cutoff.getDate() - 90);
    const inRange = (d) => new Date(d || "1970-01-01") >= cutoff;

    const qCount = (quotes || []).filter(q => inRange(q.dates?.issue || q.createdAt)).length;
    const iCount = (invoices || []).filter(i => inRange(i.dates?.issue || i.createdAt)).length;
    const rate = qCount ? Math.round((iCount / qCount) * 100) : 0;

    const rEl = $("#w_conv_rate");
    const nEl = $("#w_conv_note");
    if (rEl) rEl.textContent = `${rate}%`;
    if (nEl) nEl.textContent = `${iCount} invoices from ${qCount} quotes (90d)`;
  }

  async function drawTopCustomers(invoices, lines, customers) {
    // sum by customer over last 90 days
    const cutoff = new Date(); cutoff.setDate(cutoff.getDate() - 90);
    const inRange = (d) => new Date(d || "1970-01-01") >= cutoff;

    const invMap = new Map((invoices || [])
      .filter(i => inRange(i.dates?.issue || i.createdAt))
      .map(i => [i.id, i]));
    const byCust = new Map(); // custId -> total
    for (const l of (lines || [])) {
      const d = invMap.get(l.docId);
      if (!d) continue;
      const t = calcLineTotals({
        qty: l.qty, unitPrice: l.unitPrice ?? l.unitCost ?? 0,
        discountPct: l.discountPct ?? 0, taxRate: d.taxRate ?? 15
      }).incTax;
      const key = d.customerId || "unknown";
      byCust.set(key, (byCust.get(key) || 0) + t);
    }
    const top = Array.from(byCust.entries()).sort((a,b)=>b[1]-a[1]).slice(0,5);
    const rows = top.map(([cid, total]) => {
      const name = (customers || []).find(c => c.id === cid)?.name || "—";
      return `<tr><td>${name}</td><td class="r">${currency(total)}</td></tr>`;
    });
    const el = $("#w_topcust_rows");
    if (el) el.innerHTML = rows.length ? rows.join("") : `<tr><td colspan="2">No sales</td></tr>`;
  }

  async function drawTopItems(invoices, lines) {
    const cutoff = new Date(); cutoff.setDate(cutoff.getDate() - 90);
    const inRange = (d) => new Date(d || "1970-01-01") >= cutoff;

    const invMap = new Map((invoices || [])
      .filter(i => inRange(i.dates?.issue || i.createdAt))
      .map(i => [i.id, i]));
    const byItem = new Map(); // itemName -> total
    for (const l of (lines || [])) {
      const d = invMap.get(l.docId);
      if (!d) continue;
      const t = calcLineTotals({
        qty: l.qty, unitPrice: l.unitPrice ?? l.unitCost ?? 0,
        discountPct: l.discountPct ?? 0, taxRate: d.taxRate ?? 15
      }).incTax;
      const key = l.itemName || l.name || l.itemId || "—";
      byItem.set(key, (byItem.get(key) || 0) + t);
    }
    const top = Array.from(byItem.entries()).sort((a,b)=>b[1]-a[1]).slice(0,5);
    const rows = top.map(([name, total]) => `<tr><td>${name}</td><td class="r">${currency(total)}</td></tr>`);
    const el = $("#w_topitem_rows");
    if (el) el.innerHTML = rows.length ? rows.join("") : `<tr><td colspan="2">No sales</td></tr>`;
  }

  // Expose for router
  window.renderDashboard = renderDashboard;
})();
