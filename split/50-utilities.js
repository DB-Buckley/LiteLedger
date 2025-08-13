// ===========================================================================
// Utilities
const pad = (num, width = 4) => String(num).padStart(width, "0");
const nowISO = () => new Date().toISOString();
const randId = () =>
    (Date.now().toString(36) + Math.random().toString(36).slice(2, 8)).toUpperCase();
function toast(msg, ms = 2400) {
    const t = $("#toast");
    if (!t) return alert(msg);
    t.textContent = msg;
    t.hidden = false;
    setTimeout(() => (t.hidden = true), ms);
}
const isSecure = location.protocol === "https:" || location.hostname === "localhost";
