// ===========================================================================
// IndexedDB wrapper
const DB_NAME = "liteledger_mvp";
const DB_VER = 3; // bump if you add/change stores or indexes
let _dbp;

function openDB() {
  if (_dbp) return _dbp;
  _dbp = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VER);

    req.onupgradeneeded = () => {
      const db = req.result;

      // --- Core stores ---
      if (!db.objectStoreNames.contains("company")) db.createObjectStore("company", { keyPath: "id" });
      if (!db.objectStoreNames.contains("users")) db.createObjectStore("users", { keyPath: "id" });
      if (!db.objectStoreNames.contains("warehouses")) db.createObjectStore("warehouses", { keyPath: "id" });

      // --- Settings (keyed by "key") ---
      if (!db.objectStoreNames.contains("settings")) db.createObjectStore("settings", { keyPath: "key" });

      // --- Master data ---
      if (!db.objectStoreNames.contains("customers")) {
        const s = db.createObjectStore("customers", { keyPath: "id" });
        s.createIndex("by_code", "code", { unique: true });
      }
      if (!db.objectStoreNames.contains("suppliers")) {
        const s = db.createObjectStore("suppliers", { keyPath: "id" });
        s.createIndex("by_code", "code", { unique: true });
      }
      if (!db.objectStoreNames.contains("items")) {
        const s = db.createObjectStore("items", { keyPath: "id" });
        s.createIndex("by_sku", "sku", { unique: true });
        s.createIndex("by_barcode", "barcode", { unique: false });
      }

      // --- Documents + lines ---
      if (!db.objectStoreNames.contains("docs")) {
        const s = db.createObjectStore("docs", { keyPath: "id" });
        s.createIndex("by_type", "type", { unique: false });
        s.createIndex("by_no", "no", { unique: false });
        s.createIndex("by_customer", "customerId", { unique: false });
        s.createIndex("by_supplier", "supplierId", { unique: false });
      }
      if (!db.objectStoreNames.contains("lines")) {
        const s = db.createObjectStore("lines", { keyPath: "id" });
        s.createIndex("by_doc", "docId", { unique: false });
      }

      // --- Inventory movements ---
      if (!db.objectStoreNames.contains("movements")) {
        const s = db.createObjectStore("movements", { keyPath: "id" });
        s.createIndex("by_item", "itemId", { unique: false });
      }

      // --- Payments ---
      if (!db.objectStoreNames.contains("payments")) {
        const s = db.createObjectStore("payments", { keyPath: "id" });
        s.createIndex("by_customer", "customerId", { unique: false });
      }

      // --- PDF Layouts ---
      if (!db.objectStoreNames.contains("docLayouts")) {
        db.createObjectStore("docLayouts", { keyPath: "id" });
      }

      // --- Misc scratch stores used by UI (drag positions, etc.) ---
      if (!db.objectStoreNames.contains("dragging")) db.createObjectStore("dragging", { keyPath: "id" });
      if (!db.objectStoreNames.contains("primary")) db.createObjectStore("primary", { keyPath: "id" });
    };

    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
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
  const db = await openDB();
  return db.transaction(stores, mode);
}

// --- Basic CRUD helpers (globals) ---

async function get(store, key) {
  const t = await tx([store], "readonly");
  return await new Promise((res, rej) => {
    const r = t.objectStore(store).get(key);
    r.onsuccess = () => res(r.result || null);
    r.onerror = () => rej(r.error);
  });
}

async function put(store, value) {
  const t = await tx([store], "readwrite");
  return await new Promise((res, rej) => {
    const r = t.objectStore(store).put(value);
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
}

async function add(store, value) {
  const t = await tx([store], "readwrite");
  return await new Promise((res, rej) => {
    const r = t.objectStore(store).add(value);
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
}

async function del(store, key) {
  const t = await tx([store], "readwrite");
  return await new Promise((res, rej) => {
    const r = t.objectStore(store).delete(key);
    r.onsuccess = () => res(true);
    r.onerror = () => rej(r.error);
  });
}

async function all(store) {
  const t = await tx([store], "readonly");
  return await new Promise((res, rej) => {
    const r = t.objectStore(store).getAll();
    r.onsuccess = () => res(r.result || []);
    r.onerror = () => rej(r.error);
  });
}

async function whereIndex(store, indexName, key) {
  const t = await tx([store], "readonly");
  return await new Promise((res, rej) => {
    const r = t.objectStore(store).index(indexName).getAll(key);
    r.onsuccess = () => res(r.result || []);
    r.onerror = () => rej(r.error);
  });
}

// (optional) range query helper
async function whereRange(store, indexName, IDBKeyRangeInstance) {
  const t = await tx([store], "readonly");
  return await new Promise((res, rej) => {
    const r = t.objectStore(store).index(indexName).getAll(IDBKeyRangeInstance);
    r.onsuccess = () => res(r.result || []);
    r.onerror = () => rej(r.error);
  });
}

// (optional) clear store
async function clearStore(store) {
  const t = await tx([store], "readwrite");
  return await new Promise((res, rej) => {
    const r = t.objectStore(store).clear();
    r.onsuccess = () => res(true);
    r.onerror = () => rej(r.error);
  });
}
