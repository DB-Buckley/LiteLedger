# Split output for app.js

Suggested load order: by filename ascending.

## Files

- `00-core-and-utils.js` — section: **core**
- `01-db.js` — section: **IndexedDB wrapper**
- `02-helpers-2.js` — section: **CSV helper**
- `02-helpers.js` — section: **Numbering & tax helpers**
- `10-dashboard.js` — section: **Dashboard (widgets + drag/resize)**
- `20-customers.js` — section: **Customers**
- `30-suppliers-2.js` — section: **Purchases (Supplier Invoices - Weighted Average Cost)**
- `30-suppliers.js` — section: **Suppliers**
- `40-items-2.js` — section: **Items**
- `40-items.js` — section: **Reusable Item Finder**
- `50-backup-with-optional-aes-gcm-encryption.js` — section: **Backup (with optional AES-GCM encryption)**
- `50-company-banner.js` — section: **Company banner**
- `50-integrity-guards.js` — section: **Integrity guards**
- `50-inventory-avg-movements.js` — section: **Inventory (AVG) + movements**
- `50-pdf-building-pdf-lib-preferred-lightweight-fallback.js` — section: **PDF building (pdf-lib preferred, lightweight fallback)**
- `50-sales-documents-quotes-orders-invoices.js` — section: **Sales Documents (Quotes / Orders / Invoices)**
- `50-section-19.js` — section: **section_19**
- `50-section-21.js` — section: **section_21**
- `50-section-23.js` — section: **section_23**
- `50-section-25.js` — section: **section_25**
- `50-section-27.js` — section: **section_27**
- `50-section-29.js` — section: **section_29**
- `50-section-31.js` — section: **section_31**
- `50-utilities.js` — section: **Utilities**
- `60-layouts.js` — section: **Layouts Editor UI (no duplicate blocks)**
- `70-payments.js` — section: **Payments & Statements**
- `80-settings-2.js` — section: **Settings (company, app, backup with optional encryption, install prompt)**
- `80-settings.js` — section: **Settings bootstrap (defaults)**
- `90-about.js` — section: **About**
- `95-router.js` — section: **Router**
- `98-pwa.js` — section: **PWA registration**
- `99-init.js` — section: **init()**

## Script tags (classic)
```html
<!-- Add these to index.html in this order: -->
<script src="split/00-core-and-utils.js"></script>
<script src="split/01-db.js"></script>
<script src="split/02-helpers-2.js"></script>
<script src="split/02-helpers.js"></script>
<script src="split/10-dashboard.js"></script>
<script src="split/20-customers.js"></script>
<script src="split/30-suppliers-2.js"></script>
<script src="split/30-suppliers.js"></script>
<script src="split/40-items-2.js"></script>
<script src="split/40-items.js"></script>
<script src="split/50-backup-with-optional-aes-gcm-encryption.js"></script>
<script src="split/50-company-banner.js"></script>
<script src="split/50-integrity-guards.js"></script>
<script src="split/50-inventory-avg-movements.js"></script>
<script src="split/50-pdf-building-pdf-lib-preferred-lightweight-fallback.js"></script>
<script src="split/50-sales-documents-quotes-orders-invoices.js"></script>
<script src="split/50-section-19.js"></script>
<script src="split/50-section-21.js"></script>
<script src="split/50-section-23.js"></script>
<script src="split/50-section-25.js"></script>
<script src="split/50-section-27.js"></script>
<script src="split/50-section-29.js"></script>
<script src="split/50-section-31.js"></script>
<script src="split/50-utilities.js"></script>
<script src="split/60-layouts.js"></script>
<script src="split/70-payments.js"></script>
<script src="split/80-settings-2.js"></script>
<script src="split/80-settings.js"></script>
<script src="split/90-about.js"></script>
<script src="split/95-router.js"></script>
<script src="split/98-pwa.js"></script>
<script src="split/99-init.js"></script>
```

## Notes
- This keeps your current global API intact (no imports needed).
- If you want ES modules later, we can convert these to `export`/`import` cleanly.