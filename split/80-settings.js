// ============================================================================
// Settings
// Depends on: 01-db.js, 02-helpers.js, 03-bootstrap.js
// ============================================================================

async function renderSettings() {
  const v = $("#view");
  const sRec = await get("settings", "app");
  const settings = sRec?.value || {};

  const num = (n) => (n === undefined || n === null) ? "" : n;

  v.innerHTML = `
    <div class="card">
      <div class="hd">
        <b>Settings</b>
        <div class="toolbar">
          <button class="btn" id="install_btn">Install app</button>
          <button class="btn success" id="save_btn">Save</button>
        </div>
      </div>
      <div class="bd">
        <div class="form-grid">
          <label class="input"><span>Currency</span>
            <input id="set_currency" value="${settings.currency || "ZAR"}" placeholder="ZAR">
          </label>
          <label class="input"><span>VAT rate %</span>
            <input id="set_vat" type="number" min="0" step="0.01" value="${num(settings.vatRate ?? 15)}">
          </label>
          <label class="input"><span>Totals default inclusive</span>
            <input id="set_inclusive" type="checkbox" ${settings.taxInclusiveDefault !== false ? "checked" : ""}>
          </label>

          <label class="input"><span>SARS wording on invoice</span>
            <input id="set_sars" type="checkbox" ${settings?.pdf?.sarsWording !== false ? "checked" : ""}>
          </label>
        </div>

        <div class="card" style="margin-top:14px">
          <div class="hd"><b>Document numbering</b></div>
          <div class="bd">
            <div class="form-grid">
              ${["QTE","SO","INV","PINV"].map(k => `
                <label class="input"><span>${k} prefix</span>
                  <input data-num="${k}.prefix" value="${settings?.numbering?.[k]?.prefix || k}">
                </label>
                <label class="input"><span>${k} next</span>
                  <input data-num="${k}.next" type="number" min="1" step="1" value="${num(settings?.numbering?.[k]?.next || 1)}">
                </label>
                <label class="input"><span>${k} pad</span>
                  <input data-num="${k}.pad" type="number" min="1" step="1" value="${num(settings?.numbering?.[k]?.pad || 4)}">
                </label>
              `).join("")}
            </div>
          </div>
        </div>

        <div class="card" style="margin-top:14px">
          <div class="hd"><b>Company</b></div>
          <div class="bd">
            <div class="form-grid">
              <label class="input" style="grid-column:span 2"><span>Trading name</span><input id="co_name"></label>
              <label class="input"><span>VAT number</span><input id="co_vat"></label>
              <label class="input"><span>Email</span><input id="co_email"></label>
              <label class="input"><span>Phone</span><input id="co_phone"></label>
              <label class="input" style="grid-column:1/-1"><span>Address</span><input id="co_addr"></label>
            </div>
          </div>
        </div>

        <div class="card" style="margin-top:14px">
          <div class="hd"><b>Backup & Restore</b></div>
          <div class="bd">
            <div class="form-grid">
              <label class="input" style="grid-column:1/-1"><span>Password (optional, for encryption)</span>
                <input id="bk_password" type="password" placeholder="Leave blank for unencrypted">
              </label>
              <div class="row" style="gap:8px">
                <button class="btn" id="bk_export">Download backup</button>
                <label class="btn">
                  Restore from file
                  <input id="bk_file" type="file" accept=".json,application/json" style="display:none">
                </label>
              </div>
              <div class="sub">Backup includes: company, warehouses, settings, customers, suppliers, items, docs, lines, payments, movements, docLayouts.</div>
            </div>
          </div>
        </div>
      </div>
    </div>
  `;

  // Load company fields
  const co = await get("company", "company");
  if ($("#co_name")) {
    $("#co_name").value = co?.tradingName || "";
    $("#co_vat").value  = co?.vatNo || "";
    $("#co_email").value= co?.email || "";
    $("#co_phone").value= co?.phone || "";
    $("#co_addr").value = co?.address || "";
  }

  // Attach the Save handler
  if (typeof wireSettingsSave === "function") wireSettingsSave();

  // Install button (PWA)
  const installBtn = $("#install_btn");
  if (installBtn) {
    const hasPrompt = !!window.__deferredInstallPrompt;
    installBtn.disabled = !hasPrompt;
    installBtn.title = hasPrompt ? "" : "Install prompt not available (maybe already installed)";
    installBtn.onclick = async () => {
      if (!window.__deferredInstallPrompt) return toast("Install prompt not available", "warn");
      const e = window.__deferredInstallPrompt;
      window.__deferredInstallPrompt = null;
      installBtn.disabled = true;
      try { await e.prompt(); await e.userChoice; toast("Install flow completed", "success"); }
      catch { toast("Install dismissed", "warn"); }
    };
  }

  // Backup/restore
  $("#bk_export").onclick = async () => {
    try {
      const pass = $("#bk_password").value || "";
      const backup = await exportAllData(pass);
      const blob = new Blob([backup], { type: "application/json" });
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = `liteledger-backup-${nowISO().slice(0,10)}.json`;
      a.click();
    } catch (err) {
      console.error(err);
      toast("Backup failed", "warn");
    }
  };

  $("#bk_file").onchange = async () => {
    const f = $("#bk_file").files?.[0];
    if (!f) return;
    try {
      const text = await f.text();
      const pass = $("#bk_password").value || "";
      await importAllData(text, pass);
      toast("Restore complete", "success");
      renderSettings();
    } catch (err) {
      console.error(err);
      toast("Restore failed (wrong password or invalid file)", "warn");
    } finally {
      $("#bk_file").value = "";
    }
  };
}

// ------------------------------- Save logic (null-safe) ---------------------
(function () {
  function getVal(id, def = "") {
    const el = document.getElementById(id);
    return el ? el.value : def;
  }
  function getNum(id, def = 0) {
    const el = document.getElementById(id);
    const n = el ? Number(el.value) : def;
    return Number.isFinite(n) ? n : def;
  }
  function getChk(id) {
    const el = document.getElementById(id);
    return el ? !!el.checked : false;
  }

  async function onSaveSettings() {
    const rec = await get("settings", "app");
    if (!rec) return toast("Settings record missing", "warn");
    const v = rec.value || (rec.value = {});

    // Core
    v.currency = (getVal("set_currency", "ZAR").trim() || "ZAR");
    v.vatRate = getNum("set_vat", 15);
    v.taxInclusiveDefault = getChk("set_inclusive");

    // PDF/SARS wording
    v.pdf = v.pdf || {};
    v.pdf.sarsWording = getChk("set_sars");

    // Numbering
    v.numbering = v.numbering || {};
    const setNum = (path, value) => {
      const [key, prop] = path.split(".");
      v.numbering[key] = v.numbering[key] || {};
      if (prop === "prefix") v.numbering[key][prop] = String(value || "");
      if (prop === "pad")    v.numbering[key][prop] = Math.max(1, Math.round(Number(value || 4)));
      if (prop === "next")   v.numbering[key][prop] = Math.max(1, Math.round(Number(value || 1)));
    };
    document.querySelectorAll("#view [data-num]").forEach((el) => setNum(el.dataset.num, el.value));

    await put("settings", { key: "app", value: v });

    // Company (only if controls exist)
    let company = await get("company", "company");
    if (!company) company = { id: "company" };
    if (document.getElementById("co_name")) {
      company.tradingName = getVal("co_name", company.tradingName || "");
      company.vatNo       = getVal("co_vat",  company.vatNo || "");
      company.email       = getVal("co_email",company.email || "");
      company.phone       = getVal("co_phone",company.phone || "");
      company.address     = getVal("co_addr", company.address || "");
      await put("company", company);
    }

    if (typeof window.mountCompanyBanner === "function") {
      try { await window.mountCompanyBanner(); } catch {}
    }

    toast("Settings saved", "success");
  }

  window.wireSettingsSave = function wireSettingsSave() {
    const btn = document.getElementById("save_btn");
    if (btn) btn.onclick = onSaveSettings;
  };
})();

// ------------------------------- Backup Logic -------------------------------
async function exportAllData(password = "") {
  const stores = [
    "company","warehouses","settings","customers","suppliers",
    "items","docs","lines","payments","movements","docLayouts"
  ];
  const payload = { version: 1, exportedAt: nowISO(), stores: {} };
  for (const s of stores) payload.stores[s] = await all(s);

  const json = JSON.stringify(payload);
  if (!password) return json;

  if (!(window.crypto && window.crypto.subtle)) {
    toast("WebCrypto not available, exporting unencrypted", "warn");
    return json;
  }
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await deriveKey(password, salt);
  const enc = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, new TextEncoder().encode(json));
  const out = { enc: "AES-GCM", salt: b64enc(salt), iv: b64enc(iv), data: b64enc(new Uint8Array(enc)) };
  return JSON.stringify(out);
}

async function importAllData(text, password = "") {
  let obj;
  try { obj = JSON.parse(text); } catch { throw new Error("Invalid JSON"); }

  if (obj && obj.enc === "AES-GCM") {
    if (!password) throw new Error("Password required for encrypted backup");
    const salt = b64dec(obj.salt);
    const iv = b64dec(obj.iv);
    const key = await deriveKey(password, salt);
    const buf = b64dec(obj.data);
    const dec = await crypto.subtle.decrypt({ name: "AES-GCM", iv }, key, buf);
    obj = JSON.parse(new TextDecoder().decode(dec));
  }

  if (!obj || !obj.stores) throw new Error("Invalid backup payload");
  if (!confirm("Restore will overwrite existing data. Continue?")) return;

  const stores = Object.keys(obj.stores);
  for (const s of stores) {
    const cur = await all(s);
    for (const rec of cur) { try { await del(s, rec.id || rec.key || rec.code); } catch {} }
    const list = obj.stores[s] || [];
    for (const rec of list) { await put(s, rec); }
  }
}

// ------------------------------ Crypto helpers ------------------------------
async function deriveKey(password, salt) {
  const enc = new TextEncoder().encode(password);
  const base = await crypto.subtle.importKey("raw", enc, "PBKDF2", false, ["deriveKey"]);
  return await crypto.subtle.deriveKey(
    { name: "PBKDF2", salt, iterations: 100000, hash: "SHA-256" },
    base,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt","decrypt"]
  );
}

function b64enc(bytes) {
  let s = "";
  const b = (bytes instanceof Uint8Array) ? bytes : new Uint8Array(bytes);
  for (let i = 0; i < b.length; i++) s += String.fromCharCode(b[i]);
  return btoa(s);
}
function b64dec(b64) {
  const s = atob(b64 || "");
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}
