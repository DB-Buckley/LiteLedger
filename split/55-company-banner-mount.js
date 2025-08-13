// ============================================================================
// Company Banner mount wrapper
// Depends on: 50-company-banner.js (which defines renderCompanyHeader)

(function () {
  async function mountCompanyBanner() {
    if (typeof renderCompanyHeader !== "function") {
      console.warn("renderCompanyHeader() not found (50-company-banner.js missing?)");
      return;
    }
    // Find or create a host
    let host = document.getElementById("companyBanner");
    if (!host) {
      const header = document.querySelector("header") || document.body;
      host = document.createElement("div");
      host.id = "companyBanner";
      host.style.cssText = "margin:8px 0";
      header.prepend(host);
    }
    try {
      await renderCompanyHeader(host);
    } catch (e) {
      console.error("renderCompanyHeader failed:", e);
    }
  }

  window.mountCompanyBanner = mountCompanyBanner;
})();
