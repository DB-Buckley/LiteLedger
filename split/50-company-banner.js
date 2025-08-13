// ===========================================================================
// Company banner
async function renderCompanyHeader() {
    const co = await get("company", "company");
    if (!co) return;
    const nameEl = $("#companyName"),
        subEl = $("#companyContact"),
        img = $("#companyLogo");
    if (nameEl) nameEl.textContent = co.tradingName || "Company";
    if (subEl) {
        const contact = [co.email, co.phone].filter(Boolean).join(" • ");
        subEl.textContent = contact;
    }
    if (img) {
        if (co.logoDataUrl) {
            img.src = co.logoDataUrl;
            img.style.visibility = "visible";
        } else {
            img.src = "";
            img.style.visibility = "hidden";
        }
    }
}
