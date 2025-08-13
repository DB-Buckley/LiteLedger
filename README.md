# LiteLedger CRM — Netlify-ready PWA (MVP)

Run locally:
- `python -m http.server 5500` → open http://localhost:5500/
- Or use VS Code Live Server / `npx http-server -p 5500 .`

Deploy to Netlify: drag-drop this folder.

Notes
- PDFs use **pdf-lib** via CDN; if offline, there’s a small built-in fallback.
- PWA install/offline works on HTTPS/localhost.
- Default VAT 15%. Documents default to **tax inclusive** for totals (unit prices are excluding).
- CSV samples are under `sample_csv/`.
