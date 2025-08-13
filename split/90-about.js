// ============================================================================
// About
// Depends on: 01-db.js, 02-helpers.js

async function renderAbout() {
  const v = $("#view");

  // Gather local data stats
  const stores = [
    "company","warehouses","settings","customers","suppliers",
    "items","docs","lines","payments","movements","docLayouts"
  ];

  const dataByStore = {};
  let totalRecords = 0;
  let totalBytes = 0;

  for (const s of stores) {
    const rows = await all(s);
    dataByStore[s] = rows;
    totalRecords += rows.length;
    try {
      totalBytes += new TextEncoder().encode(JSON.stringify(rows)).length;
    } catch {
      totalBytes += (JSON.stringify(rows) || "").length;
    }
  }

  const kib = Math.round(totalBytes / 102.4) / 10; // 1 KiB ~ 1024B, round to 0.1
  const settingsRec = await get("settings", "app");
  const appVersion = (settingsRec?.value?.appVersion) || (window.APP_VERSION || "dev");

  const rows = stores.map(s => `
    <tr>
      <td>${s}</td>
      <td class="r">${dataByStore[s].length}</td>
    </tr>
  `).join("");

  v.innerHTML = `
    <div class="card">
      <div class="hd">
        <b>About</b>
        <div class="toolbar">
          <button class="btn" id="abt_update">Check for updates</button>
          <button class="btn warn" id="abt_clear">Clear local data</button>
        </div>
      </div>
      <div class="bd">
        <div class="form-grid">
          <div class="input"><span>App</span><div>LiteLedger CRM PWA</div></div>
          <div class="input"><span>Version</span><div>${appVersion}</div></div>
          <div class="input"><span>Build date</span><div>${nowISO().slice(0,10)}</div></div>
          <div class="input"><span>Storage (approx)</span><div>${kib} KiB • ${totalRecords} records</div></div>
        </div>

        <div class="card" style="margin-top:12px">
          <div class="hd"><b>Local Data</b></div>
          <div class="bd">
            <div style="max-height:50vh;overflow:auto">
              <table class="table">
                <thead><tr><th>Store</th><th class="r">Records</th></tr></thead>
                <tbody>${rows}</tbody>
              </table>
            </div>
            <div class="sub" style="margin-top:8px">
              Your data is stored in your browser (IndexedDB). Use Settings → Backup to export an encrypted or plain JSON backup.
            </div>
          </div>
        </div>

        <div class="card" style="margin-top:12px">
          <div class="hd"><b>Troubleshooting</b></div>
          <div class="bd">
            <ul style="margin:0;padding-left:18px">
              <li>If widgets or icons look stale, use “Check for updates”.</li>
              <li>If something is badly broken, export a backup first, then “Clear local data” and restore your backup.</li>
            </ul>
          </div>
        </div>
      </div>
    </div>
  `;

  // Update (Service Worker)
  $("#abt_update").onclick = async () => {
    try {
      if ("serviceWorker" in navigator) {
        const regs = await navigator.serviceWorker.getRegistrations();
        await Promise.all(regs.map(r => r.update()));
        toast("Update check complete. Reload to apply if an update was found.", "success");
      } else {
        toast("Service Worker not supported", "warn");
      }
    } catch (e) {
      console.error(e);
      toast("Update check failed", "warn");
    }
  };

  // Clear local data (danger)
  $("#abt_clear").onclick = async () => {
    const sure = confirm("This will DELETE all local data and unregister the app's service worker. Make a backup first. Continue?");
    if (!sure) return;

    try {
      // Clear IndexedDB stores by deleting each record
      for (const s of stores) {
        const list = await all(s);
        for (const rec of list) {
          try { await del(s, rec.id || rec.key || rec.code); } catch {}
        }
      }

      // Clear caches (if any)
      if (window.caches && caches.keys) {
        const keys = await caches.keys();
        await Promise.all(keys.map(k => caches.delete(k)));
      }

      // Unregister service workers
      if ("serviceWorker" in navigator) {
        const regs = await navigator.serviceWorker.getRegistrations();
        await Promise.all(regs.map(r => r.unregister()));
      }

      toast("Local data cleared. The app will reload.", "success");
      setTimeout(() => location.reload(), 600);
    } catch (e) {
      console.error(e);
      toast("Failed to clear local data", "warn");
    }
  };
}
