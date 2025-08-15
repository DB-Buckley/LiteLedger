// ============================================================================
// Helpers & Utilities (globals, idempotent)
// This file safely defines globals only if they aren't already defined.
// ============================================================================

(function () {
  // ----------------------------- DOM helpers --------------------------------
  if (typeof window.$ !== "function") {
    window.$ = (sel, root = document) => root.querySelector(sel);
  }
  if (typeof window.$$ !== "function") {
    window.$$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));
  }

  // ----------------------------- Time / IDs ---------------------------------
  if (typeof window.nowISO !== "function") {
    window.nowISO = () => new Date().toISOString();
  }
  if (typeof window.randId !== "function") {
    window.randId = () => {
      try {
        const a = crypto.getRandomValues(new Uint8Array(16));
        return Array.from(a, (x) => x.toString(16).padStart(2, "0")).join("");
      } catch {
        return Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2);
      }
    };
  }

  // ---------------------------- Math / money --------------------------------
  if (typeof window.round2 !== "function") {
    window.round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
  }

  // Currency formatter (memoizes currency from settings when available)
  if (typeof window.currency !== "function") {
    let __CURRENCY = "ZAR";
    (async () => {
      try {
        const s = await get("settings", "app");
        __CURRENCY = (s?.value?.currency) || "ZAR";
      } catch {}
    })();
    window.currency = (n) => {
      try {
        return new Intl.NumberFormat("en-ZA", { style: "currency", currency: __CURRENCY })
          .format(Number(n) || 0);
      } catch {
        return `R ${(Number(n) || 0).toFixed(2)}`;
      }
    };
  }

  // --------------------------- Numbering (docs) -----------------------------
  if (typeof window.nextDocNo !== "function") {
    window.nextDocNo = async (type) => {
      const s = await get("settings", "app");
      const v = s.value || (s.value = {});
      const map = { QUOTE: "QTE", ORDER: "SO", INVOICE: "INV", PINV: "PINV", QTE: "QTE", SO: "SO", INV: "INV" };
      const key = map[(type || "").toUpperCase()] || String(type || "").toUpperCase();
      v.numbering = v.numbering || {};
      const cfg = v.numbering[key] || (v.numbering[key] = { prefix: key, next: 1, pad: 4 });
      const n = cfg.next || 1;
      cfg.next = n + 1;
      await put("settings", { key: "app", value: v });
      return `${cfg.prefix}${String(n).padStart(cfg.pad || 4, "0")}`;
    };
  }

  // ----------------------------- Totals & VAT -------------------------------
  if (typeof window.calcLineTotals !== "function") {
    window.calcLineTotals = ({ qty = 0, unitPrice = 0, discountPct = 0, taxRate = 0 }) => {
      const ex = (Number(qty) || 0) * (Number(unitPrice) || 0);
      const disc = ex * ((Number(discountPct) || 0) / 100);
      const taxable = Math.max(0, ex - disc);
      const tax = taxable * ((Number(taxRate) || 0) / 100);
      const inc = taxable + tax;
      return { exTax: round2(taxable), tax: round2(tax), incTax: round2(inc) };
    };
  }

  if (typeof window.sumDoc !== "function") {
    window.sumDoc = (lines) => {
      let sub = 0, tax = 0, tot = 0;
      for (const ln of lines || []) {
        const t = calcLineTotals(ln);
        sub += t.exTax; tax += t.tax; tot += t.incTax;
      }
      return { subTotal: round2(sub), tax: round2(tax), grandTotal: round2(tot) };
    };
  }

  // --------------------------- Inventory helpers ----------------------------
  // Robust balance calculator: sums all qtyDelta for an item (optionally by warehouse).
  // Falls back to full scan if the "by_item" index isn't available.
  if (typeof window.balanceQty !== "function") {
    window.balanceQty = async (itemId, opts = {}) => {
      const { warehouseId = null } = opts || {};
      let movs = [];
      try {
        movs = await whereIndex("movements", "by_item", itemId);
      } catch {
        movs = await all("movements");
        movs = (movs || []).filter(m => m.itemId === itemId);
      }
      let sum = 0;
      for (const m of (movs || [])) {
        if (warehouseId && m.warehouseId !== warehouseId) continue;
        sum += Number(m.qtyDelta) || 0; // type-agnostic: PURCHASE+, SALE-, ADJUST±, etc.
      }
      return sum;
    };
  }

  if (typeof window.recordStockAdjustment !== "function") {
  window.recordStockAdjustment = async function recordStockAdjustment({
    itemId, warehouseId = "WH1", qtyDelta = 0, reason = "", note = "", userId = null, relatedDocId = null
  }) {
    const ts = nowISO();
    const adj = { id: randId(), itemId, warehouseId, qtyDelta: Number(qtyDelta) || 0,
                  reason, note, userId, relatedDocId, timestamp: ts };
    await add("adjustments", adj);

    // Mirror into movements so on-hand updates via balanceQty()
    await add("movements", {
      id: randId(),
      itemId,
      warehouseId,
      type: "ADJUST",
      qtyDelta: Number(qtyDelta) || 0,
      costImpact: 0,
      relatedDocId: relatedDocId || adj.id,
      timestamp: ts,
      note: reason ? `Adjust: ${reason}` : "Adjust",
    });

    return adj.id;
  };
}

  // -------------------------------- Toasts ----------------------------------
  if (typeof window.toast !== "function") {
    (function () {
      let host;
      window.toast = function toast(msg, kind = "info") {
        if (!host) {
          host = document.createElement("div");
          host.id = "toasts";
          host.style.cssText = "position:fixed;right:16px;bottom:16px;display:grid;gap:8px;z-index:9999";
          document.body.appendChild(host);
        }
        const el = document.createElement("div");
        el.className = "toast";
        el.textContent = msg;
        el.style.cssText = "background:#0f172a;color:#fff;padding:10px 12px;border-radius:10px;box-shadow:0 6px 20px rgba(0,0,0,.15)";
        if (kind === "warn") el.style.background = "#c2410c";
        if (kind === "success") el.style.background = "#166534";
        host.appendChild(el);
        setTimeout(() => { el.style.opacity = "0"; el.style.transition = "opacity .3s"; }, 2400);
        setTimeout(() => el.remove(), 2800);
      };
    })();
  }

  // ------------------------------- Item finder ------------------------------
  // Legacy finder used by older flows. New flows embed their own picker in the modal.
  if (typeof window.openItemFinder !== "function") {
    window.openItemFinder = async ({ onPick }) => {
      const items = await all("items");
      const m = $("#modal"), body = $("#modalBody");
      body.innerHTML = `
        <div class="hd" style="display:flex;justify-content:space-between;align-items:center">
          <h3>Select Item</h3>
          <div class="row">
            <button class="btn" onclick="document.getElementById('modal').close()">Close</button>
          </div>
        </div>
        <div class="bd">
          <div class="toolbar"><input id="it_find" placeholder="Search name / sku / barcode" style="min-width:300px"></div>
          <div style="max-height:360px;overflow:auto">
            <table class="table">
              <thead><tr><th>SKU</th><th>Name</th><th>Price</th><th></th></tr></thead>
              <tbody id="it_rows">
                ${items.map(i => `
                  <tr data-id="${i.id}">
                    <td>${i.sku || i.code || ""}</td>
                    <td>${i.name || ""}</td>
                    <td>${currency(i.sellPrice || i.costAvg || 0)}</td>
                    <td><button class="btn" data-pick="${i.id}">Choose</button></td>
                  </tr>`).join("")}
              </tbody>
            </table>
          </div>
        </div>`;
      m.showModal();

      const filter = () => {
        const q = ($("#it_find").value || "").toLowerCase();
        $$("#it_rows tr").forEach(tr => {
          tr.style.display = tr.textContent.toLowerCase().includes(q) ? "" : "none";
        });
      };
      $("#it_find").oninput = filter;

      $$("#it_rows [data-pick]").forEach(btn => {
        btn.onclick = () => {
          const it = items.find(x => x.id === btn.dataset.pick);
          if (it && typeof onPick === "function") onPick(it);
          m.close();
        };
      });
    };
  }

  // ------------------------ Dashboard defaults helper -----------------------
  // Works on the FULL settings.value object (creates/repairs value.dashboard).
  if (typeof window.ensureDashboardDefaults !== "function") {
    window.ensureDashboardDefaults = (settingsValue) => {
      if (!settingsValue || typeof settingsValue !== "object") return;
      const d = (settingsValue.dashboard = settingsValue.dashboard || {});
      d.grid = d.grid || { cols: 12, rowHeight: 90 };
      d.sizes = d.sizes || {};
      d.widgets = d.widgets || {};

      const def = (id, x, y, w, h) => ({ id, x, y, w, h, enabled: true });
      d.widgets.salesTrend   = d.widgets.salesTrend   || def("salesTrend",   0, 0, 6, 4);
      d.widgets.unpaid       = d.widgets.unpaid       || def("unpaid",       6, 0, 6, 3);
      d.widgets.lowStock     = d.widgets.lowStock     || def("lowStock",     0, 4, 6, 3);
      d.widgets.conversion   = d.widgets.conversion   || def("conversion",   6, 3, 6, 3);
      d.widgets.topCustomers = d.widgets.topCustomers || def("topCustomers", 0, 7, 6, 4);
      d.widgets.topItems     = d.widgets.topItems     || def("topItems",     6, 6, 6, 4);

      // Back-compat: provide simple sizes map used by resize code
      const sizes = (d.sizes = d.sizes || {});
      const sizeDef = {
        salesTrend:   { w: 3, h: 1 },
        unpaid:       { w: 1, h: 1 },
        lowStock:     { w: 1, h: 1 },
        conversion:   { w: 1, h: 1 },
        topCustomers: { w: 2, h: 2 },
        topItems:     { w: 2, h: 2 },
      };
      for (const [k, sz] of Object.entries(sizeDef)) {
        if (!sizes[k]) sizes[k] = sz;
      }
    };
  }

  // ----------------------------- PDF generator ------------------------------
  // Fallback PDF builder if your HTML->PDF module (60-pdf.js) isn't loaded.
  if (typeof window.buildInvoicePDF_lib !== "function") {
    window.buildInvoicePDF_lib = async function buildInvoicePDF_lib({ doc, lines = [], company, customer, settings }) {
      const { PDFDocument, StandardFonts, rgb } = (window.PDFLib || {});
      if (!PDFDocument) {
        console.warn("pdf-lib not loaded; returning empty blob");
        return new Blob(["PDF generation unavailable"], { type: "application/pdf" });
      }

      const A4 = [595.28, 841.89]; // A4 portrait (pt)
      const pdf = await PDFDocument.create();
      const font = await pdf.embedFont(StandardFonts.Helvetica);
      const fontB = await pdf.embedFont(StandardFonts.HelveticaBold);

      let page, width, y;

      const drawHR = () => {
        page.drawRectangle({ x: 40, y, width: width - 80, height: 1, color: rgb(0.8, 0.8, 0.9) });
        y -= 16;
      };

      const drawText = (t, x, size = 12, bold = false) => {
        page.drawText(String(t ?? ""), { x, y, size, font: bold ? fontB : font, color: rgb(0, 0, 0) });
        y -= size + 6;
      };

      const drawTableHeader = () => {
        y -= 6;
        page.drawText("Item",  { x: cols[0], y, size: 11, font: fontB });
        page.drawText("Qty",   { x: cols[1], y, size: 11, font: fontB });
        page.drawText("Unit",  { x: cols[2], y, size: 11, font: fontB });
        page.drawText("VAT",   { x: cols[3], y, size: 11, font: fontB });
        page.drawText("Total", { x: cols[4], y, size: 11, font: fontB });
        y -= 14;
      };

      const newPage = (withHeader = false) => {
        page = pdf.addPage(A4);
        width = page.getSize().width;
        y = 800;
        if (withHeader) drawTableHeader();
      };

      // Start first page
      newPage(false);

      // Header
      drawText(company?.tradingName || "Company", 40, 16, true);
      drawText(company?.address || "", 40, 10);
      drawText((company?.email || "") + (company?.vatNo ? `  VAT: ${company.vatNo}` : ""), 40, 10);

      drawText((doc?.type || "DOC") + " " + (doc?.no || ""), width - 200, 16, true);
      drawText("Issue: " + (doc?.dates?.issue || "").slice(0, 10), width - 200, 10);

      y -= 8;
      drawHR();

      // Customer / Supplier
      if (customer?.name) drawText("To: " + customer.name, 40, 12, true);
      if (customer?.contact?.person) drawText("Attn: " + customer.contact.person, 40, 10);

      // Table
      const cols = [40, 300, 370, 430, 500]; // item, qty, unit, tax, total
      drawTableHeader();

      // Lines
      let sub = 0, tax = 0, tot = 0;
      const vatRateDefault = settings?.vatRate ?? 15;

      for (const l of lines) {
        if (y < 120) newPage(true); // leave space for totals/footer

        const t = calcLineTotals({
          qty: l.qty,
          unitPrice: l.unitPrice ?? l.unitCost ?? 0,
          discountPct: l.discountPct ?? 0,
          taxRate: l.taxRate ?? vatRateDefault,
        });

        sub += t.exTax; tax += t.tax; tot += t.incTax;

        page.drawText(l.itemName || l.name || "", { x: cols[0], y, size: 10, font });
        page.drawText(String(l.qty || 0),         { x: cols[1], y, size: 10, font });
        page.drawText(currency(l.unitPrice ?? l.unitCost ?? 0), { x: cols[2], y, size: 10, font });
        page.drawText(`${round2(l.taxRate ?? vatRateDefault)}%`, { x: cols[3], y, size: 10, font });
        page.drawText(currency(t.incTax),         { x: cols[4], y, size: 10, font });
        y -= 14;
      }

      // Totals
      if (y < 100) newPage(false);
      y -= 8;
      drawHR();

      const drawKV = (k, v) => {
        page.drawText(k, { x: 360, y, size: 11, font: fontB });
        page.drawText(v, { x: 460, y, size: 11, font });
        y -= 14;
      };
      drawKV("Sub Total",  currency(sub));
      drawKV("VAT",        currency(tax));
      drawKV("Grand Total",currency(tot));

      const bytes = await pdf.save();
      return new Blob([bytes], { type: "application/pdf" });
    };
  }
})();
