# Onshape BOM → Google Sheets Import Tool

> **Status note:** Sections 1–7 below are the original planning doc. Section
> 8 records the architecture decisions made after that planning pass — the
> project is going with a **Node backend + Apps Script frontend**
> (a hybrid of Options A and B from §3), not a standalone web frontend.
> Read §8 for the actual plan being built; earlier sections still hold for
> the Onshape BOM-parsing logic itself, which is unchanged.

## What this is

A standalone tool (unrelated to any existing product) that imports a Bill of
Materials (BOM) from an Onshape assembly into a Google Sheet, keeps it in
sync on re-import, mirrors Onshape's subassembly hierarchy, and lets the
user configure which Onshape BOM columns map to which spreadsheet columns
— plus define their own extra columns (e.g. "Priority", "Owner") that are
never touched by re-imports.

It does **not** need inventory tracking, purchasing, or manufacturing job
logic. It is purely: pull structured data out of Onshape → put it in a
spreadsheet → keep it updated → let humans layer their own data on top.

This document explains the problem, the hardest part (correctly parsing
Onshape's BOM API), and a recommended architecture and build order.

---

## 1. Background: how Onshape's BOM API actually behaves

If you haven't fought with Onshape's BOM endpoint before, this section is
the important one. The naive approach — "call the BOM endpoint, read the
rows" — breaks in several non-obvious ways. This is the accumulated result
of a lot of trial and error against real documents, and it's worth
understanding *why* each workaround exists before writing new code, so the
same mistakes aren't rediscovered from scratch.

### 1.1 The BOM endpoint

```
GET /assemblies/d/{documentId}/{wvmType}/{workspaceOrVersionId}/e/{elementId}/bom
```

Key query parameters:

- `indented=true&multiLevel=false` — this is the combination you want for
  hierarchical import. `indented=true` means each row for a subassembly
  still shows up *as itself* (not exploded into its children inline), and
  crucially, that subassembly row's `itemSource` carries the referenced
  element's own `documentId`/`elementId`/`workspaceId` directly — so you
  don't need a second lookup call to find out what's inside it.
  `multiLevel=false` means Onshape does **not** recursively expand
  subassembly contents for you. You do that yourself, one level at a
  time. This is deliberate: it lets you decide, row by row, whether a
  given subassembly is "yours" (something to recurse into) or someone
  else's/vendor content (something to treat as a leaf part) *before*
  committing to fetch its contents.
- `generateIfAbsent=true` — asks Onshape to generate a BOM if one hasn't
  been materialized for this element yet.
- `bomColumnIds=<id>&bomColumnIds=<id>...` — restricts which columns
  Onshape bothers to serialize. Without this, a BOM response can be very
  large (full material property tables, every dropdown's complete option
  list, appearance/color objects, BOM-tree bookkeeping ids) — almost none
  of which you want. Pass only the header ids you actually need.

`wvmType` matters and is easy to get wrong: it's `'w'` for a workspace,
`'v'` for a version, `'m'` for a microversion. **Mirrored, released, or
otherwise frozen references very commonly resolve to `'v'`, even when the
document you're looking at is otherwise on a workspace.** If you assume
`'w'` for every subassembly reference, you will get spurious 404s on
exactly the mirrored/released subassemblies — which are often the ones
most worth capturing correctly. Always read the actual `wvmType` off each
row's `itemSource`, not off the parent context.

### 1.2 The "never-generated BOM" 404 trap

The single most confusing failure mode: calling the BOM endpoint on an
element that has *never* had its BOM tab opened in the Onshape UI can
return a 404, **even with `generateIfAbsent=true` set**, on the very first
request — especially for elements buried deep in a tree (nested
subassemblies, mirrored branches) that nobody has ever actually clicked
into.

The fix that reliably works:

1. Try the request with the shape/columns you actually want.
2. If it 404s, fire a second, *plain default-shape* request
   (`?generateIfAbsent=true`, no extra params) purely to force generation.
   Discard its response — you don't care what it contains, only that it
   exists now.
3. Poll the original request again with a short increasing backoff (e.g.
   150ms, 300ms, 500ms, 800ms) rather than one flat wait — most
   generations finish fast, and you don't want to always eat a
   worst-case delay.
4. If it's still 404ing after all that, surface a clear error (bad
   document id, wrong wvm type, no access, or genuinely not an Assembly
   tab — Part Studios don't have BOMs).

Skipping this dance means a meaningful fraction of real-world assemblies
(anything with an unopened or freshly-mirrored subassembly) will silently
fail to import.

### 1.3 Onshape's rate limiting

Onshape returns HTTP 429 under load, and if your tool recurses into many
subassemblies — especially in parallel — you *will* hit it. Handle 429
specifically:

- Honor a `Retry-After` header if present.
- Otherwise back off exponentially (e.g. 400ms × 2^attempt, plus a little
  random jitter so a burst of parallel requests doesn't all retry in
  lockstep).
- Cap retries (3 is reasonable) and then surface a real error.
- Cap how many subassembly fetches run *concurrently* in the first place
  (a worker-pool pattern with a small concurrency limit, e.g. 5, works
  well) — don't fire one request per sibling subassembly all at once.

### 1.4 Values don't always come back as plain primitives

Several BOM columns — confirmed for the "Category" column, and worth
treating as a general risk for any column — come back wrapped rather than
as a bare value. You'll see shapes like:

```json
{ "value": 4 }
```
or
```json
[{ "name": "Assembly", "...": "..." }]
```

instead of just `4` or `"Assembly"`. If you don't defensively unwrap
these, you'll silently get `NaN` on quantities or `"[object Object]"` on
text fields. The fix is a small recursive unwrap helper: if it's an
array, take the first element (recurse); if it's an object with a
`value` key, use that; if it's an object with a `name` key, use that;
otherwise return as-is.

### 1.5 Look up columns by header ID, not by header name

Onshape lets a document's BOM *template* rename or localize column
headers (e.g. "Qty (ea)" instead of "Quantity"). If you match columns by
name string, a renamed template will silently break your import — the
column will just come back empty, with no error.

The robust approach: maintain a small table of **known, stable header
ids** for the columns you care about (Name, Part Number, Quantity,
Category are commonly stable across templates), and look values up by
id first. Only fall back to case-insensitive name matching (`"qty"`,
`"quantity"`, `"count"`, etc.) for columns you don't have a known id for
— e.g. any user-configured "extra" column that maps to something outside
your known set.

### 1.6 Telling parts from subassemblies from vendor content

Every BOM row carries a "Category" column whose value resolves to either
`"Onshape part"` or `"Assembly"` (case varies, so lowercase-compare), plus
(for assembly rows only) an owner reference for the *document* that
defines that category. This is what lets you answer three different
questions from one row:

1. **Is this a leaf part or a subassembly?** → Category column.
2. **If it's a subassembly, is it "ours" (something to recurse into) or
   someone else's content (a vendor/COTS assembly bundled as a single
   purchasable unit)?** → Compare the category's owning document id
   against the *root* assembly's document owner id (resolved once per
   import, not per row). If they don't match, treat the row as a leaf
   part rather than recursing into it. This is important: recursing into
   a vendor's internal assembly structure produces a BOM tree nobody
   wants and burns a lot of API calls on data you'll never use.
3. **If it's an unrecognized/missing category value**, fail safe by
   treating the row as a plain part rather than crashing or silently
   dropping it. Real-world documents occasionally have rows that don't
   fit the expected shape; a defensive default beats an exception three
   levels deep in a recursive import.

### 1.7 Recursion shape

Putting 1.1–1.6 together, the traversal for one assembly element looks
like:

```
fetch indented BOM for (documentId, wvmType, workspaceId, elementId)
for each row:
    resolve name/part-number/quantity (unwrapping values, header-id first)
    if row has no usable name → skip
    classify via Category column:
        "part"      → add to this level's direct parts
        "assembly":
            if owning document == root document → genuine subassembly:
                record it, recurse into it (own fetch, one level deeper)
            else → vendor/COTS assembly → treat as a leaf part
        unrecognized → fail-safe, treat as a leaf part
```

Two practical additions worth building in from day one:

- **A max recursion depth** (e.g. 5 levels). Real trees rarely go deeper,
  and it protects against a pathological/cyclic reference structure.
  Past the depth cap, treat everything as flat parts rather than
  recursing further.
- **A dedupe cache keyed by `(documentId, wvmType, workspaceId,
  elementId)`.** The same subassembly is very often instanced more than
  once (two identical gearboxes, a mirrored left/right arm). Cache the
  *in-flight promise*, not just the eventual result, so that if two
  sibling rows reference the same subassembly and get processed
  concurrently, the second one awaits the first's fetch instead of
  firing a duplicate request. This alone can cut API calls dramatically
  on trees with repeated substructure.

None of this logic is exotic once written down, but every rule above was
discovered by hitting a real, confusing failure against a real document —
worth treating as a checklist rather than re-deriving by trial and error a
second time.

---

## 2. What the tool needs to do

1. **Authenticate to Onshape.** Simplest approach: a single Onshape API
   key pair (Access Key + Secret Key, from https://dev.onshape.com/keys),
   sent as HTTP Basic Auth, held server-side only. No OAuth app, no
   Onshape App Store listing, no Custom Tab dependency. Limitation: this
   is one shared identity, so the tool sees whatever documents that one
   Onshape account can see — fine for one team, not appropriate if
   different users should see different private documents.

2. **Let the user pick a document, then an assembly element within it.**
   Two simple lookups:
   - Search/list documents (`GET /documents?q=...`).
   - List elements in a document/workspace, filtered to `elementType ===
     'ASSEMBLY'` (`GET /documents/d/{id}/w/{id}/elements`).

3. **Import the BOM into a Google Sheet**, respecting:
   - A **user-configurable column mapping** (which Onshape BOM column
     goes in which spreadsheet column).
   - **User-owned extra columns** (Priority, Owner, whatever) that the
     tool creates once and never overwrites again.
   - **Hierarchy**, so subassemblies are visually and structurally
     distinguishable from a flat part list.

4. **Re-import (sync) without destroying user data.** Re-running the
   import against the same assembly should update Onshape-sourced values
   (name changed, quantity changed, a part was added/removed) while
   leaving every user-owned column's values exactly as they were for
   rows that still exist.

5. **Explicitly out of scope:** inventory tracking, purchasing/ordering
   workflows, fabrication/manufacturing job tracking, linking rows to any
   external "is this in stock" system. This tool only moves structured
   BOM data into a place your team can annotate it.

---

## 3. Hosting options

### Option A — Google Apps Script

Runs entirely inside the Google ecosystem, bound to the spreadsheet (or
a standalone script deployed as a Sheets add-on).

**Pros**
- No separate server to host or pay for.
- Already has first-class access to the target Sheet — no separate
  Google auth flow needed for the *Sheets* side.
- A simple custom menu (`onOpen()` → "Import BOM…", "Re-import",
  "Configure columns…") is a perfectly good UI for a small team tool.
- `UrlFetchApp` can call the Onshape REST API directly with Basic Auth,
  the same way any server-side client would.

**Cons**
- 6-minute execution time limit per run. Fine for most BOMs; could bite
  on very deep/wide trees with many subassemblies, since each one is a
  separate HTTP round trip.
- Secrets (the Onshape key pair) live in `PropertiesService` — workable
  for a small trusted team, not a great story if this ever needs to be
  distributed more broadly.
- Rate-limit backoff and retry logic is more awkward to write cleanly in
  Apps Script's synchronous execution model than in a normal async
  server, though not impossible.

**Best fit if:** this is for you and a handful of teammates, and you'd
rather ship something working this week than stand up infrastructure.

### Option B — Small backend (Node) + Google Sheets API + minimal frontend

A standalone server that talks to both Onshape and the Google Sheets
API, with no execution time ceiling and a testable, normal async
codebase.

**Pros**
- No time limit — safe for large/deep assemblies.
- Real error handling, real retry logic, real tests.
- Google auth via a service account (with domain-wide delegation) or
  OAuth if different users need to work with different sheets they
  personally own.
- Doesn't need a database — the spreadsheet itself is the data store.

**Cons**
- More setup: hosting, credentials, a minimal frontend for the
  document/assembly picker and column-mapping configuration.

**Best fit if:** you want this to be a real, reusable tool that multiple
people configure differently, or you expect assemblies large/deep enough
to worry about Apps Script's time limit.

**Recommendation:** start with Option A if you want something working
fast and the team is small; move to Option B only if you hit the
execution-time ceiling or need per-user document access.

---

## 4. Representing hierarchy in a spreadsheet

Three reasonable approaches, in order of recommendation:

1. **Flat sheet + `Level` (depth) column + `Parent` (identity key of the
   parent row) column, with Sheets' native row grouping/outline feature
   used for visual collapsing.** This is the recommended approach: it's
   both machine-diffable (a reimport can walk parent→child relationships
   programmatically) and human-friendly (collapsible groups in the
   actual Sheets UI, no custom scripting needed for the fold/unfold
   interaction).

2. **Separate tabs per subassembly**, mirroring Onshape's own tree more
   literally. Feels intuitive at first glance but multiplies your
   write/reimport complexity per tab and makes "search across the whole
   BOM" harder for the user.

3. **Flat, unindented list with no structure markers.** Simplest to
   write, but throws away the one piece of information you specifically
   said you wanted to preserve (the subassembly structure). Not
   recommended given your stated goal.

Go with #1 unless a concrete reason surfaces to do otherwise.

---

## 5. Column mapping & user-owned columns

Keep a small, explicit configuration — a "Config" tab in the sheet
itself is a reasonable place, since it travels with the sheet and is
visible/editable by the user without touching code:

```
Onshape source column   → Target sheet column
"Part Number"           → B
"Name"                  → C
"Quantity"               → D
```

Plus a separate, explicit list of **user-only columns** (e.g. "Priority"
in column E, "Owner" in column F) that the import step creates once (if
missing) and **never writes to again** on subsequent re-imports.

This split — "columns the tool owns and refreshes" vs. "columns the user
owns and the tool never touches" — is the single most important design
decision here, because it's what makes re-import safe. Get the row
identity matching right (next section) and this becomes straightforward:
for any row that still exists, only overwrite the mapped Onshape-sourced
cells; leave every other cell alone.

---

## 6. Re-import: matching rows across two imports without losing user data

A naive re-import (wipe everything, re-write from scratch) would destroy
every Priority/Owner value the user entered. The fix is to give every row
a **stable identity key** that survives across two independent imports of
the same assembly, then diff against it.

**The key insight:** nothing about a BOM row's position or its visible
part number is a safe identity — a part number can be blank, edited, or
duplicated by a user, and Onshape doesn't give you a stable row ID. What
*is* stable is a composite of:

```
documentId :: wvmType :: workspaceOrVersionId :: elementId :: partIdentity :: fullConfiguration
```

`partIdentity` (not `partId`) is the right field to use — it's the
stronger differentiator for identifying a specific part instance within
a Part Studio; `partId` alone is not guaranteed unique enough for this
purpose. This composite is also, not coincidentally, close to what
Onshape itself uses to decide when two rows are "the same part" for its
own repeated-instance quantity rollup — so if two rows share this key,
Onshape already considers them the same part, which is exactly the
notion of identity a re-import diff needs.

Store this composite key in a **hidden column** on each row (or a
hidden helper tab mapping row → key, if you'd rather keep the visible
sheet completely clean). On re-import:

1. Fetch the current BOM tree fresh, computing each row's identity key.
2. For every **existing** sheet row whose key still appears in the fresh
   fetch → update only the mapped Onshape-sourced columns; leave every
   user-owned column untouched.
3. For every fresh-fetch row whose key has **no match** in the sheet →
   insert it as a new row (with user-owned columns left blank for the
   user to fill in).
4. For every existing sheet row whose key **no longer appears** in the
   fresh fetch → the part has left the BOM. Don't silently delete it —
   either mark it (e.g. a "Removed" flag/strikethrough) or move it to an
   "Archive" section/tab, so a re-import can't quietly erase a row a
   user has annotated. Deleting should be an explicit, separate action if
   you want it at all.

This is a smaller version of the same "carry promises forward across a
rebuild" problem that shows up in any tool that treats an external
system as the source of truth for structure but lets local users
annotate on top — the shape of the solution (identity key + three-way
diff: update / insert / orphan) generalizes well beyond this specific
case.

---

## 7. Suggested build order

1. **Auth + picker.** Prove you can authenticate to Onshape and list
   documents → assembly elements. No BOM logic yet.
2. **One-shot flat import.** Direct parts only (no subassembly
   recursion), fixed hardcoded columns, no re-import. This alone
   exercises the hardest part — correct BOM parsing (unwrapping values,
   header-id lookups, the never-generated-BOM retry dance) — without
   also debugging hierarchy or diffing at the same time.
3. **Add subassembly recursion** (the classification + recurse-vs-flatten
   logic from §1.6–1.7) and the `Level`/`Parent` hierarchy columns.
4. **Make column mapping configurable** — replace the hardcoded
   columns from step 2 with a lookup against the user's Config tab.
5. **Add re-import** with the identity-key diff from §6.
6. **Polish**: Sheets row grouping for collapse/expand, a proper
   settings UI if you went with Option B, scheduled/triggered re-import
   (e.g. a daily trigger in Apps Script, or a cron-triggered endpoint in
   a Node backend).

Each step is independently useful and testable before moving to the
next — don't try to build hierarchy, configurability, and re-import all
at once, since the BOM-parsing edge cases in §1 are exactly the kind of
thing that's much easier to debug in isolation (step 2) than tangled up
with three other moving pieces.

> **Superseded by §8.** The build order below is still the right shape for
> the *BOM logic itself*, but the concrete phases in §8.6 are the ones
> actually being followed — they fold in the hosting/frontend decisions
> from §8.1–§8.5.

---

## 8. Final architecture decisions

This section captures what was actually decided after the initial planning
pass, superseding the open questions in §3–§5.

### 8.1 Hosting: Node backend, not Apps Script alone

The project already has a Node application deployed on an Oracle VM, so
**Option B (small backend)** is used for all real logic — Onshape BOM
resolution, retries/backoff, category classification, row diffing, and
Google Sheets writes. No database: the spreadsheet itself remains the
data store, plus one small local JSON file on the VM (see §8.4).

Auth to Google Sheets is via a **service account** (not OAuth). The
target spreadsheet is shared with the service account's email like a
normal collaborator. This is the simplest option given the tool doesn't
need per-user document access at this stage; OAuth can be added later if
that changes. Credentials (Onshape access/secret key pair, Google service
account JSON) live in a `.env` file read by the Node process — no secrets
manager for now.

### 8.2 Frontend: Apps Script *is* the frontend, not a separate site

Key decision: rather than a standalone web page the user has to visit
separately from the spreadsheet, **a container-bound Apps Script project
attached to the Sheet becomes the entire UI**. This avoids Onshape's own
embedding option (Custom Tabs), which would require registering an OAuth
app through the Onshape Developer Portal/App Store — a much heavier
integration than the current API-key Basic Auth setup, and not worth it
just to host an "Import" button.

Concretely:

- A small `Code.gs` adds a custom menu to the Sheet's own menu bar:
  `Onshape BOM → Import…` and `Sync now`.
- `Import…` opens an `HtmlService` sidebar/dialog docked
  inside the Sheet. That dialog's JS calls back into Apps Script
  (`google.script.run`), which proxies to the Node backend's
  `documents`/`elements` lookup endpoints — so picking a document and
  assembly happens without ever leaving the spreadsheet tab.
- `Sync now` is a single menu click once an assembly has been linked to
  the sheet — no re-picking required.
- Apps Script talks to the Node backend over HTTPS via `UrlFetchApp.fetch(...)`,
  POSTing to `/api/import` or `/api/sync` and showing a toast/alert with
  the result.

This means Apps Script owns zero BOM-parsing logic — it's purely a thin
UI shell over the backend's REST endpoints. All the hard problems in §1
stay entirely in Node.

**Trade-off accepted:** the Sheet becomes bound to its attached Apps
Script project (deployed via the Apps Script editor on that specific
Sheet, or via a template Sheet copied per new BOM). This is normal for
this kind of tool and is the same shape §3's Option A originally
envisioned for the UI — the difference is the backend underneath it is
Option B (Node), not Apps Script itself.

### 8.3 Hierarchy & row grouping

As recommended in §4: flat sheet, `Level` (depth) + `Parent` (identity
key of parent row) columns, with native Sheets row grouping/outline
applied programmatically after each write so subassemblies collapse/expand
without any custom scripting on the user's part.

### 8.4 Re-import / sync: identity key + content hash

Reuses the composite identity key already implemented as `buildSourceKey()`
in the existing `onshape.js` (documentId :: wvmType :: workspaceOrVersionId
:: elementId :: partIdentity :: fullConfiguration), unchanged in spirit
from §6. Two refinements over the original plan:

- **Content hash added.** Each row also gets a hash of its Onshape-owned
  field values (Name, Part Number, Quantity, Category-derived Level).
  On sync: same key + same hash → **skip**, no write at all (avoids
  needlessly rewriting parts that haven't changed since the last import).
  Same key + different hash → **update** only the Onshape-owned cells.
- **Deletions are hard deletes, not archived.** Per §6's original design,
  a row whose key disappears from the fresh BOM fetch was to be flagged
  or archived. That's been simplified: if a part is no longer present in
  the current Onshape BOM, its row is **deleted outright** from the
  sheet. No audit trail/Archive tab for V1.

Both `sourceKey` and `contentHash` are stored in hidden helper columns
per row (not a separate helper tab), matching §6's original hidden-column
approach.

The backend also persists a tiny mapping of `sheetId → {documentId,
workspaceId, elementId}` in a local JSON file (`server/data/registry.json`)
so that `Sync now` doesn't require re-sending Onshape ids from Apps Script
on every call — only `Import` (first-time linking) needs the full
picker flow.

### 8.5 Column mapping: hardcoded both sides for V1

No Config tab in V1 (deferred, still planned per §5/§7 step 4). Instead,
both the Onshape-owned and user-owned column sets are hardcoded explicitly
in one config module, so a Config-tab reader can later replace this object
with no other refactor:

```js
// server/lib/columnMap.js
export const ONSHAPE_COLUMNS = {
  name:       'B',
  partNumber: 'C',
  quantity:   'D',
  level:      'E',
  parent:     'F',
};
export const USER_COLUMNS = {
  priority: 'G',
  owner:    'H',
};
// hidden helper columns
export const META_COLUMNS = {
  sourceKey:   'Z',
  contentHash: 'AA',
};
```

Only `ONSHAPE_COLUMNS` cells are ever overwritten on sync. `USER_COLUMNS`
cells are created blank on insert and never touched again. Any column not
listed in either map is left alone by the tool (relevant if a user adds
their own ad hoc column outside the hardcoded `USER_COLUMNS` set — it's
implicitly safe since the tool only writes to cells it explicitly knows
about).

### 8.6 File structure

```
onshape-bom-sheets/
├── .env                        # ONSHAPE_ACCESS_KEY, ONSHAPE_SECRET_KEY,
│                                # GOOGLE_SERVICE_ACCOUNT_JSON (or path), PORT
├── server/
│   ├── index.js                # Express/Hono app entry
│   ├── routes/
│   │   ├── onshape-lookup.js   # documents / elements (trimmed from prior project)
│   │   ├── import.js           # POST /api/import
│   │   └── sync.js             # POST /api/sync
│   ├── lib/
│   │   ├── onshape.js          # trimmed version of prior onshape.js —
│   │   │                       #  drop fetchAssemblyPartTree/Supabase,
│   │   │                       #  keep fetch/retry/dedupe/category logic
│   │   ├── sheets.js           # Google Sheets API client + write/read helpers
│   │   ├── columnMap.js        # hardcoded Onshape-owned + user-owned columns (§8.5)
│   │   ├── rowIdentity.js      # buildSourceKey() + contentHash()
│   │   └── registry.js         # JSON-file-backed sheetId → assembly ref store
│   └── data/
│       └── registry.json       # gitignored
└── apps-script/
    ├── Code.gs                 # custom menu, calls backend via UrlFetchApp
    └── sidebar.html            # document/assembly picker UI (HtmlService)
```

### 8.7 Implementation roadmap

Phased so the hardest, most failure-prone logic (Onshape BOM parsing) is
proven in isolation before layering hierarchy, sync, and UI on top —
consistent with the reasoning in §7, adapted to the Node + Apps Script
split.

**Phase 0 — Backend skeleton & auth**
- Stand up the Node app on the Oracle VM (or locally first), `.env` for
  Onshape key pair.
- Port `onshape.js`'s `onshapeGet`/`onshapePost` (retry/backoff intact),
  stripped of Supabase-specific exports.
- Set up the Google service account, confirm it can read/write a test
  Sheet via the Sheets API (no Onshape involved yet).

**Phase 1 — Document/assembly lookup**
- Port `onshape-lookup.js`'s `documents` and `elements` handlers.
- No BOM logic yet — just prove documents can be searched and assembly
  elements listed, hit directly (curl/Postman) or from a placeholder
  route.

**Phase 2 — One-shot flat BOM import**
- Port `resolveRow`, `unwrapBomValue`, `fetchBomWithFallback` (the
  never-generated-BOM 404 retry dance), header-id-first column lookup.
- Direct parts only, no subassembly recursion yet, fixed hardcoded
  columns, writes straight to a Sheet with no diffing (every import
  wipes and rewrites). This is where the BOM-parsing edge cases from §1
  get debugged in isolation, per §7's reasoning.

**Phase 3 — Subassembly recursion & hierarchy**
- Port `resolveBomWithSubassemblies` (category classification,
  ours-vs-vendor detection, dedupe cache, max depth).
- Add `Level`/`Parent` columns to the sheet writer.
- Apply Sheets row grouping/outline after write (§8.3).

**Phase 4 — Sync (identity key + content hash diff)**
- Implement `buildSourceKey()` + `contentHash()` in `rowIdentity.js`.
- Implement the update/insert/delete diff against existing hidden
  `sourceKey`/`contentHash` columns (§8.4), including the "skip
  unchanged rows" optimization.
- Add `registry.json` so a sync call only needs `sheetId`.

**Phase 5 — Apps Script integration**
- `Code.gs`: custom menu (`Import…`, `Sync now`).
- `sidebar.html`: document/assembly picker calling the backend's lookup
  endpoints via `google.script.run` → Apps Script → `UrlFetchApp`.
- Wire `Import…` to `POST /api/import`, `Sync now` to `POST /api/sync`;
  surface success/error via toast or alert.

**Phase 6 — Polish**
- User-owned columns (`USER_COLUMNS`) finalized and documented for
  end users.
- Config tab for column mapping (originally §5/§7 step 4) — replaces the
  hardcoded `columnMap.js` values, deferred from V1 as agreed.
- Optional: scheduled sync (cron-triggered endpoint on the VM, or an
  Apps Script time-driven trigger calling `Sync now` automatically).
- Error surfacing polish in the sidebar (e.g. distinguishing "no access",
  "not an Assembly tab", "BOM has no rows").

Phase 6 deployment decision: the Apps Script backend URL is a deployment
constant (`BACKEND_URL` in `apps-script/Code.gs`), not an end-user setting or
Script Property. This avoids asking spreadsheet users to configure backend
infrastructure. The constant is set once per deployed/template script.

---

## 9. Future scope: purchasable COTS parts

The tool may later cross-reference imported COTS/vendor parts against
purchasable products. The engineering part and the vendor listing should be
separate concepts:

- A **part** represents what the BOM requires, such as `FR8ZZ`.
- A **vendor listing** represents one way to purchase or fulfill that part,
  including vendor, vendor part number, purchase URL, price, currency,
  availability, and preferred-listing status.

This separation is important because an Onshape `part_number` may identify a
vendor-specific part, or may be vendor-agnostic and accept equivalent products
from multiple vendors. The data model should also distinguish:

- `vendor_agnostic`: the design intentionally allows equivalent vendors.
- `vendor_unknown`: the design may be vendor-specific, but the vendor has not
  yet been identified.

### 9.1 Planned storage architecture

The canonical vendor catalog should eventually live in a SQL database hosted
alongside the Node backend on the Oracle VM, preferably PostgreSQL. Google
Sheets should remain the BOM workspace and display selected purchasing data,
not the authoritative vendor catalog. Local JSON files should be limited to
configuration, caches, or development seed data.

A minimal future schema could be:

```text
parts
  id
  normalized_part_number
  original_part_number
  description
  vendor_agnostic
  vendor_unknown
  created_at
  updated_at

vendor_listings
  id
  part_id
  vendor_name
  vendor_part_number
  purchase_url
  price
  currency
  availability
  last_checked_at
  is_preferred
```

Part-number normalization should support reliable lookup while preserving the
original Onshape value for traceability. It must not remove punctuation or
formatting that carries meaning for vendor-specific numbers.

### 9.2 Planned BOM integration

When this feature is eventually implemented, the backend can identify COTS
rows, normalize their part numbers, query the SQL catalog, and expose zero,
one, or multiple matching listings. The Sheet may show fields such as
preferred vendor, vendor part number, purchase URL, and price. Any manually
selected listing or override must be treated as user-owned data and preserved
by sync.

Inventory, purchasing workflows, and stock tracking remain out of scope until
explicitly added as a later phase.

### 9.5 Initial implementation scope

The first implementation uses PostgreSQL on the Oracle VM, configured through
`DATABASE_URL`. The backend initializes the catalog tables on first catalog
request and exposes catalog read, single-part upsert, and additive JSON/CSV
upsert endpoints. The Apps Script menu provides **Manage vendor listings** and
opens a grouped catalog view with a simple add/update form.

When importing, a matching active default listing is projected into vendor
columns for the row. Unmatched rows remain ordinary BOM rows with blank vendor
fields. Existing sync rows preserve their vendor snapshot; catalog changes do
not silently replace a listing already selected for an existing BOM row.

The current management UI is an initial operational version. Inline editing,
listing selection dropdowns, unavailable-listing display, and polished CSV
file upload remain follow-up improvements within this scope.

### 9.3 Vendor catalog user experience

Vendor listings should be manageable from the existing `Onshape BOM Import`
sidebar through a **Manage vendor listings** action. This opens an editable,
spreadsheet-like management view backed by the PostgreSQL catalog. Users should
not need direct database access or a separate administration application.

The UI should present grouped sections by Onshape Part Number rather than a
flat technical table. Each section can show the part description, any known
cross-references, and its vendor options. Existing options are editable
inline, while a separate Add Vendor Option form can make new entries easier to
create. CSV import/export should be supported later; imports are additive
upserts and never destructive by default.

User-facing labels should favor plain language:

```text
Onshape Part Number
Description
Cross-reference / Alternate Part Number
Vendor Options
  Vendor
  Vendor Part Number
  Purchase URL
  Latest Price
  Currency (defaults to USD)
  Default Option
```

The database may retain technical fields such as `is_preferred`, but the UI
should present this as a visually clear **Default Option** state. There should
be one default option per catalog part, while users can still select another
available option for a specific BOM row.

Cross-reference type should remain an implementation detail. The preferred
behavior is to infer it automatically from the entered value where practical,
without exposing a confusing type selector. If automatic classification is
ambiguous or unreliable, the system should treat the value as a cross-reference
to a vendor listing rather than forcing the user to understand internal
distinctions such as manufacturer part number versus vendor catalog number.

### 9.4 Listing selection and historical snapshots

Newly imported BOM rows should use the catalog's current Default Option when a
match exists. Existing BOM rows should retain their currently selected option
when the global default changes; this prevents a part already quoted, ordered,
or placed in a cart from silently changing vendors.

The selected vendor information and price should be stored as a snapshot on the
BOM row. Users can change the selected option through a simple dropdown or
cell, without needing to see or understand a field named "override". Clearing
the selection may restore the current default as an explicit user action.

If a selected catalog option is later deleted or deactivated, existing BOM
rows should preserve their snapshot values and be marked **Unavailable**. They
should not be silently cleared or reassigned.

## 10. Future scope: multiple Sheets and subassembly tabs

The Apps Script project is container-bound: it belongs to one Google
Spreadsheet document. A separate spreadsheet therefore needs its own copy of
the Apps Script project, either by copying a template spreadsheet or repeating
the setup manually. The Node backend itself is shared, and each spreadsheet/tab
is independently registered through the backend registry.

This is acceptable for the expected usage model, where a major assembly has a
primary spreadsheet. A future deployment workflow could provide a template or
an installable Apps Script project to reduce repetition across spreadsheets.

The current import writes one selected assembly into one target tab. A future
multi-tab import could let the user choose which large subassemblies become
separate tabs, while preserving the parent/child relationship through stable
source keys and registry entries. That feature should define:

- whether each subassembly tab is a full independent sync target;
- how parent rows link to the referenced tab;
- whether shared subassemblies are imported once or duplicated per parent;
- how tab renames and deleted tabs affect the registry; and
- whether the parent BOM displays a summary row, a link, or both.
