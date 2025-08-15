// ===========================================================================
// IndexedDB wrapper
// ===========================================================================

const DB_NAME = "liteledger_mvp";
// Bump this whenever you add/change stores or indexes:
const DB_VER = 6;

let _dbp;

function openDB() {
  if (_dbp) return _dbp;

  _dbp = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VER);

    req.onupgradeneeded = (e) => {
      const db = req.result;
      const upTx = e.target.transaction; // VersionChange transaction

      const hasStore = (name) => db.objectStoreNames.contains(name);
      const getStore = (name, opts) =>
        hasStore(name) ? upTx.objectStore(name) : db.createObjectStore(name, opts);

      const ensureIndex = (store, idxName, keyPath, options = {}) => {
        if (!store.indexNames.contains(idxName)) store.createIndex(idxName, keyPath, options);
      };

      // --- Core stores ---
      ensureIndex(getStore("company",    { keyPath: "id" }), "by_id", "id", { unique: true });
      ensureIndex(getStore("users",      { keyPath: "id" }), "by_id", "id", { unique: true });
      ensureIndex(getStore("warehouses", { keyPath: "id" }), "by_id", "id", { unique: true });

      // --- Settings (keyed by "key") ---
      getStore("settings", { keyPath: "key" }); // typically {key:"app"}

      // --- Master data ---
      {
        const s = getStore("customers", { keyPath: "id" });
        ensureIndex(s, "by_code", "code", { unique: true });
      }
      {
        const s = getStore("suppliers", { keyPath: "id" });
        ensureIndex(s, "by_code", "code", { unique: true });
      }
      {
        const s = getStore("items", { keyPath: "id" });
        ensureIndex(s, "by_sku", "sku", { unique: true });
        ensureIndex(s, "by_barcode", "barcode", { unique: false });
      }

      // --- Documents + lines ---
      {
        const s = getStore("docs", { keyPath: "id" });
        ensureIndex(s, "by_type", "type");
        ensureIndex(s, "by_no", "no");
        ensureIndex(s, "by_customer", "customerId");
        ensureIndex(s, "by_supplier", "supplierId");
      }
      {
        const s = getStore("lines", { keyPath: "id" });
        ensureIndex(s, "by_doc", "docId");
      }

      // --- Inventory movements (source of truth for on-hand) ---
      {
        const s = getStore("movements", { keyPath: "id" });
        ensureIndex(s, "by_item", "itemId");
        ensureIndex(s, "by_doc", "relatedDocId");
      }

      // --- Customer payments (receipts) ---
      {
        const s = getStore("payments", { keyPath: "id" });
        ensureIndex(s, "by_customer", "customerId");
        ensureIndex(s, "by_date", "date");
      }

      // --- Supplier payments (AP) ---
      {
        const s = getStore("supplierPayments", { keyPath: "id" });
        ensureIndex(s, "by_supplier", "supplierId");
        ensureIndex(s, "by_date", "date");
      }

      // --- PDF Layouts ---
      getStore("docLayouts", { keyPath: "id" });

      // --- Adjustments (manual stock corrections / audits) ---
      // { id, itemId, warehouseId, qtyDelta, reason, note, userId, relatedDocId, timestamp }
      {
        const s = getStore("adjustments", { keyPath: "id" });
        ensureIndex(s, "by_item", "itemId");
        ensureIndex(s, "by_warehouse", "warehouseId");
        ensureIndex(s, "by_date", "timestamp");
        ensureIndex(s, "by_doc", "relatedDocId");
        ensureIndex(s, "by_user", "userId");
      }

      // --- Misc scratch stores used by UI (drag positions, etc.) ---
      getStore("dragging", { keyPath: "id" });
      getStore("primary",  { keyPath: "id" });
    };

    req.onsuccess = () => resolve(req.result);
    req.onerror   = () => reject(req.error);
    req.onblocked = () => console.warn("IndexedDB upgrade blocked. Close other tabs.");
  });

  // close on versionchange from another tab
  _dbp.then((db) => {
    db.onversionchange = () => {
      try { db.close(); } catch {}
      console.warn("DB version change detected; closing this connection.");
    };
  });

  return _dbp;
}

async function tx(stores, mode = "readonly") {
  const wanted = Array.isArray(stores) ? stores : [stores];
  let db = await openDB();

  // If any requested store is missing (old connection cached), reopen to apply upgrade.
  for (const s of wanted) {
    if (!db.objectStoreNames.contains(s)) {
      console.warn(`[DB] Missing store "${s}". Reopening DB to apply upgrade…`);
      try { db.close?.(); } catch {}
      _dbp = null;              // drop cached connection
      db = await openDB();      // re-open (will run onupgradeneeded if DB_VER bumped)
      break;
    }
  }

  // Try to open the transaction; if NotFoundError, reopen once and retry.
  try {
    return db.transaction(wanted, mode);
  } catch (err) {
    if (err && String(err.name || err).includes("NotFoundError")) {
      console.warn("[DB] Transaction failed due to missing store(s); reopening and retrying once…");
      try { db.close?.(); } catch {}
      _dbp = null;
      db = await openDB();
      return db.transaction(wanted, mode);
    }
    throw err;
  }
}

// --- Basic CRUD helpers (globals) ---

async function get(store, key) {
  const t = await tx([store], "readonly");
  return await new Promise((res, rej) => {
    const r = t.objectStore(store).get(key);
    r.onsuccess = () => res(r.result || null);
    r.onerror   = () => rej(r.error);
  });
}

async function put(store, value) {
  const t = await tx([store], "readwrite");
  return await new Promise((res, rej) => {
    const r = t.objectStore(store).put(value);
    r.onsuccess = () => res(r.result);
    r.onerror   = () => rej(r.error);
  });
}

async function add(store, value) {
  const t = await tx([store], "readwrite");
  return await new Promise((res, rej) => {
    const r = t.objectStore(store).add(value);
    r.onsuccess = () => res(r.result);
    r.onerror   = () => rej(r.error);
  });
}

async function del(store, key) {
  const t = await tx([store], "readwrite");
  return await new Promise((res, rej) => {
    const r = t.objectStore(store).delete(key);
    r.onsuccess = () => res(true);
    r.onerror   = () => rej(r.error);
  });
}

async function all(store) {
  const t = await tx([store], "readonly");
  return await new Promise((res, rej) => {
    const r = t.objectStore(store).getAll();
    r.onsuccess = () => res(r.result || []);
    r.onerror   = () => rej(r.error);
  });
}

async function whereIndex(store, indexName, key) {
  const t = await tx([store], "readonly");
  return await new Promise((res, rej) => {
    const r = t.objectStore(store).index(indexName).getAll(key);
    r.onsuccess = () => res(r.result || []);
    r.onerror   = () => rej(r.error);
  });
}

// (optional) range query helper
async function whereRange(store, indexName, IDBKeyRangeInstance) {
  const t = await tx([store], "readonly");
  return await new Promise((res, rej) => {
    const r = t.objectStore(store).index(indexName).getAll(IDBKeyRangeInstance);
    r.onsuccess = () => res(r.result || []);
    r.onerror   = () => rej(r.error);
  });
}

// (optional) clear store
async function clearStore(store) {
  const t = await tx([store], "readwrite");
  return await new Promise((res, rej) => {
    const r = t.objectStore(store).clear();
    r.onsuccess = () => res(true);
    r.onerror   = () => rej(r.error);
  });
}
