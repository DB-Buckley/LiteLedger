// ============================================================================
// Bootstrap / First-run seeding + migrations
// Depends on: 01-db.js, 02-helpers.js (for nowISO, randId, etc.)
// ============================================================================

// Helper: default PDF blocks (used if no global defaultLayoutBlocks() is present)
function __fallbackLayoutBlocks() {
  return [
    { type: "logo", align: "right", size: 80 },
    { type: "company", fields: ["tradingName", "address", "email", "vatNo"], size: 10 },
    { type: "docHeader", showType: true, showNo: true, showDates: true, size: 14 },
    { type: "divider" },
    { type: "customer", fields: ["name", "contact"], size: 10 },
    { type: "spacer", px: 8 },
    { type: "lines", columns: ["item", "qty", "unitPrice", "total"], size: 10 },
    { type: "totals", showSub: true, showTax: true, showGrand: true, size: 12 },
    { type: "text", value: "Thank you for your business.", align: "left", size: 10 },
  ];
}

// Shim: ensureDashboardDefaults (define only if missing)
// Works on the FULL settings.value object and mutates it in place.
(function () {
  if (typeof window.ensureDashboardDefaults === "function") return;
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

    const sizes = (d.sizes = d.sizes || {});
    const sizeDef = {
      salesTrend:   { w: 3, h: 1 },
      unpaid:       { w: 1, h: 1 },
      lowStock:     { w: 1, h: 1 },
      conversion:   { w: 1, h: 1 },
      topCustomers: { w: 2, h: 2 },
      topItems:     { w: 2, h: 2 },
    };
    for (const [k, sz] of Object.entries(sizeDef)) if (!sizes[k]) sizes[k] = sz;
  };
})();

async function ensureBootstrap() {
  // --- Company ---
  if (!(await all("company")).length) {
    await add("company", {
      id: "company",
      tradingName: "Demo Company (Edit in Settings)",
      email: "info@example.com",
      phone: "",
      vatNo: "",
      address: "",
      logoDataUrl: "",
    });
  }

  // --- Warehouses ---
  if (!(await all("warehouses")).length) {
    await add("warehouses", { id: "WH1", code: "MAIN", name: "Main Warehouse" });
  }

  // --- Settings: create if missing, then normalize/migrate
  let set = await get("settings", "app");
  if (!set) {
    const seed = {
      vatRate: 15,
      currency: "ZAR",
      taxInclusiveDefault: true,
      numbering: {
        QTE:  { prefix: "QTE",  next: 1, pad: 4 },
        SO:   { prefix: "SO",   next: 1, pad: 4 },
        INV:  { prefix: "INV",  next: 1, pad: 4 },
        PINV: { prefix: "PINV", next: 1, pad: 4 },
      },
      pdf: { sarsWording: true, layouts: {} },
      // dashboard will be created by ensureDashboardDefaults below
    };
    // If a global `defaults` object exists, shallow-merge it in (last write wins)
    if (typeof window.defaults === "object" && window.defaults) {
      Object.assign(seed, window.defaults);
      seed.pdf = Object.assign({ sarsWording: true, layouts: {} }, window.defaults.pdf || {});
      seed.numbering = Object.assign({
        QTE: { prefix: "QTE", next: 1, pad: 4 },
        SO:  { prefix: "SO",  next: 1, pad: 4 },
        INV: { prefix: "INV", next: 1, pad: 4 },
        PINV:{ prefix: "PINV",next: 1, pad: 4 },
      }, window.defaults.numbering || {});
    }
    await add("settings", { key: "app", value: seed });
    set = await get("settings", "app");
  }

  const v = set.value || (set.value = {});

  // Core defaults/migrations
  v.vatRate = typeof v.vatRate === "number" ? v.vatRate : 15;
  v.currency = v.currency || "ZAR";
  v.taxInclusiveDefault = v.taxInclusiveDefault !== undefined ? v.taxInclusiveDefault : true;

  // Numbering (ensure all present)
  v.numbering = v.numbering || {};
  const ensureNum = (k, prefix) => {
    v.numbering[k] = v.numbering[k] || { prefix, next: 1, pad: 4 };
    v.numbering[k].prefix = v.numbering[k].prefix || prefix;
    if (typeof v.numbering[k].next !== "number") v.numbering[k].next = 1;
    if (typeof v.numbering[k].pad !== "number") v.numbering[k].pad = 4;
  };
  ensureNum("QTE", "QTE");
  ensureNum("SO", "SO");
  ensureNum("INV", "INV");
  ensureNum("PINV", "PINV");

  // PDF / Layouts
  v.pdf = v.pdf || {};
  v.pdf.sarsWording = v.pdf.sarsWording !== undefined ? v.pdf.sarsWording : true;
  v.pdf.layouts = v.pdf.layouts || {};

  // Dashboard: ensure structure on full settings.value (not on v.dashboard)
  ensureDashboardDefaults(v);

  // Ensure a layout exists per type and is linked in settings
  const buildBlocks = () =>
    (typeof defaultLayoutBlocks === "function" ? defaultLayoutBlocks() : __fallbackLayoutBlocks());

  let layouts = await all("docLayouts");
  layouts = Array.isArray(layouts) ? layouts : [];

  const ensureLayout = async (type, niceName) => {
    let id = v.pdf.layouts[type];
    let layoutDoc = id ? layouts.find((l) => l.id === id) : null;
    if (!layoutDoc) layoutDoc = layouts.find((l) => l.type === type) || null;
    if (!layoutDoc) {
      layoutDoc = {
        id: randId(),
        type,
        name: niceName,
        blocks: buildBlocks(),
        updatedAt: nowISO(),
      };
      await add("docLayouts", layoutDoc);
      layouts.push(layoutDoc);
    }
    v.pdf.layouts[type] = layoutDoc.id;
  };

  await ensureLayout("QUOTE",   "Default Quote");
  await ensureLayout("ORDER",   "Default Order");
  await ensureLayout("INVOICE", "Default Invoice");
  await ensureLayout("PINV",    "Default Supplier Invoice"); // NEW: purchases PDF layout

  await put("settings", { key: "app", value: v });

  // --- Demo master data (only if empty) ---
  if (!(await all("customers")).length) {
    await add("customers", {
      id: randId(),
      code: "CUST001",
      name: "Acme Retailers",
      contact: { person: "Lindiwe", phone: "082 000 0000", email: "lindiwe@acme.co.za" },
      termsDays: 30,
      creditLimit: 50000,
      taxExempt: false,
      openingBalance: 0,
      archived: false,
      createdAt: nowISO(),
    });
  }

  if (!(await all("suppliers")).length) {
    await add("suppliers", {
      id: randId(),
      code: "SUP001",
      name: "Global Tools (Pty) Ltd",
      contact: { person: "Pieter", phone: "021 555 1234", email: "orders@globaltools.co.za" },
      termsDays: 30,
      notes: "",
      archived: false,
      createdAt: nowISO(),
    });
  }

  if (!(await all("items")).length) {
    await add("items", {
      id: randId(),
      sku: "STIHL-MS250",
      barcode: "6000000000012",
      name: "STIHL MS 250 Chainsaw",
      description: "45.4cc 2.3kW",
      category: "Chainsaws",
      unit: "ea",
      costAvg: 2800,
      costMethod: "AVG",
      sellPrice: 3999,
      vatApplies: true,
      reOrderLevel: 2,
      openingQty: 10,
      warehouseId: "WH1",
      nonStock: false,
      createdAt: nowISO(),
    });
    await add("items", {
      id: randId(),
      sku: "OIL-2T-1L",
      barcode: "6000000000556",
      name: "2T Oil 1L",
      description: "High-performance 2-stroke oil",
      category: "Oils",
      unit: "l",
      costAvg: 70,
      costMethod: "AVG",
      sellPrice: 120,
      vatApplies: true,
      reOrderLevel: 8,
      openingQty: 50,
      warehouseId: "WH1",
      nonStock: false,
      createdAt: nowISO(),
    });
  }
}

// Expose for startup
window.ensureBootstrap = ensureBootstrap;

// -------------------------- PWA Install Prompt ------------------------------
window.deferredInstallEvent = null;

window.addEventListener("beforeinstallprompt", (e) => {
  e.preventDefault(); // prevent auto prompt
  window.deferredInstallEvent = e; // stash it for later
  // Optional: make the "Install" button visible here
});

window.addEventListener("appinstalled", () => {
  window.deferredInstallEvent = null; // clean up after install
});

// Click handler for an install button with id="install_btn"
document.addEventListener("click", async (e) => {
  const t = e.target;
  if (t && t.id === "install_btn") {
    const ev = window.deferredInstallEvent;
    if (!ev) return;
    ev.prompt();
    await ev.userChoice;
    window.deferredInstallEvent = null;
  }
});
