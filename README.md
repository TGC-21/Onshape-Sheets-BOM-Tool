# onshape-bom-sheets — backend

Phases 0–3 implemented: server skeleton, Onshape auth (429 retry/
backoff), Google Sheets service-account auth, the document/assembly
picker, and a hierarchical BOM import with subassembly recursion and
Sheets row grouping.

## Setup

```bash
npm install
cp .env.example .env
# fill in .env:
#   - ONSHAPE_ACCESS_KEY / ONSHAPE_SECRET_KEY  (https://dev.onshape.com/keys)
#   - GOOGLE_SERVICE_ACCOUNT_KEY_PATH pointing at a downloaded service
#     account JSON key (share your target Sheet with its client_email)
npm start
```

The Apps Script frontend lives in `apps-script/`. Copy `Code.gs` and
`sidebar.html` into the container-bound Apps Script project for each target
spreadsheet, then set `BACKEND_URL` once in `Code.gs` before deployment.

The fixed V1 layout reserves `G` for user-owned Priority and `H` for
user-owned Owner. Sync never overwrites those columns; helper metadata is
stored in hidden columns `Z` and `AA`.

## Routes

- `GET /api/health` — confirms Onshape key pair + Google service account
  creds are both valid. Pass `?spreadsheetId=<id>` to also confirm a
  specific Sheet has been shared with the service account.
- `GET /api/onshape/documents?q=...&limit=...` — search Onshape documents.
- `GET /api/onshape/elements?documentId=...&workspaceId=...` — list
  assembly elements within a document's default workspace.
- `POST /api/import` — full hierarchical BOM import (destructive wipe/rewrite).
  ```json
  {
    "documentId": "...",
    "workspaceId": "...",
    "elementId": "...",
    "spreadsheetId": "...",
    "sheetName": "Sheet1"
  }
  ```
  `sheetName` is optional and defaults to the spreadsheet's first tab.

  Walks the full subassembly tree (up to `MAX_CHILD_DEPTH = 5` levels
  deep, matching the planning doc's §1.7), classifying each assembly row
  as "ours" (recurse into it) vs. vendor/COTS (treat as a leaf part) by
  comparing the BOM row's Category-owning document id against the
  currently-walked document. A subassembly instanced more than once
  (e.g. two identical gearboxes, a mirrored left/right arm) is only
  fetched from Onshape once, via an in-flight-promise dedupe cache, even
  though it still produces separate rows per instance.

  Writes `Name` / `Part Number` / `Quantity` / `Level` / `Parent`
  columns, then applies native Sheets row grouping (one collapsible
  group per subassembly's children) so the hierarchy can be folded in
  the Sheets UI without any custom scripting.

  `Level`/`Parent` currently use synthetic, per-import row ids — not yet
  the persistent cross-import identity key from the planning doc's §6/§8.4
  (that lands in Phase 4). Every call **wipes the target tab and rewrites
  everything**, including blowing away the Priority/Owner columns and,
  in edge cases where the tree's shape changes between imports, possibly
  leaving a stale row-group boundary. Both are expected Phase 3
  limitations that Phase 4's diff-based sync replaces this wipe-and-
  rewrite approach to fix.

 - `POST /api/sync` — diff the registered assembly into the target tab while
   preserving user-owned columns. Body: `{ "spreadsheetId": "...", "sheetName": "Sheet1" }`.
   Run `/api/import` once first; unchanged rows are skipped, changed rows are
   updated, new rows appended, and missing tracked rows deleted.

## Future work

- Config tab for column mapping.
- Scheduled sync.
- PostgreSQL-backed COTS vendor catalog. Set `DATABASE_URL` and use
  `Onshape BOM → Manage vendor listings` to maintain grouped parts and
  vendor options.
- PostgreSQL-backed vendor catalog with a `Manage vendor listings` view in
  the Apps Script sidebar. The catalog will support grouped Onshape parts,
  vendor options, cross-references, default options, CSV additive/upsert
  import, and preserved unavailable listing snapshots.

See onshape-bom-to-sheets-tool.md §8.7 for the full roadmap.
