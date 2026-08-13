// server/lib/onshape.js
//
// Minimal Onshape REST client: Basic Auth from a key pair + 429 retry with
// backoff. This is Phase 0 — just enough to prove auth works and to give
// Phase 1's document/element lookups (and later phases' BOM logic) a
// shared, reusable request function.
//
// Ported from an earlier project's onshape.js. Deliberately stripped down:
// no Supabase, no BOM parsing/category classification/subassembly
// recursion yet (that lands in Phase 2 and Phase 3) — this file is just
// the transport layer.

const ONSHAPE_BASE = 'https://cad.onshape.com/api/v6'

// Cap on concurrent in-flight requests to Onshape when a later phase fans
// out across sibling subassemblies. Defined here so every module that
// eventually needs it agrees on one constant.
export const MAX_ONSHAPE_CONCURRENCY = 5

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

function getCredentials() {
  const accessKey = process.env.ONSHAPE_ACCESS_KEY
  const secretKey = process.env.ONSHAPE_SECRET_KEY
  if (!accessKey || !secretKey) {
    throw new Error('ONSHAPE_ACCESS_KEY and ONSHAPE_SECRET_KEY must be set (check your .env).')
  }
  return Buffer.from(`${accessKey}:${secretKey}`).toString('base64')
}

/**
 * Shared 429 retry/backoff behavior for both GET and POST. Honors
 * Retry-After when Onshape sends one; otherwise backs off exponentially
 * (400ms, 800ms, 1600ms…) with a little random jitter so a burst of
 * parallel requests (relevant once subassembly fan-out lands in Phase 3)
 * doesn't all retry in lockstep. Everything other than 429 (404, 5xx,
 * etc.) is thrown immediately, unchanged.
 */
async function requestWithRetry(url, options, { retries = 3, label = 'request' } = {}) {
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(url, options)
    if (res.ok) return res.json()

    if (res.status === 429 && attempt < retries) {
      const retryAfterHeader = res.headers.get('retry-after')
      const retryAfterMs = retryAfterHeader ? parseFloat(retryAfterHeader) * 1000 : null
      const backoffMs = retryAfterMs ?? (400 * 2 ** attempt + Math.random() * 150)
      console.warn(
        `[onshape] 429 rate limited on ${label} — retrying in ${Math.round(backoffMs)}ms ` +
        `(attempt ${attempt + 1}/${retries})`
      )
      await sleep(backoffMs)
      continue
    }

    const text = await res.text()
    throw new Error(`Onshape API ${res.status}: ${text.slice(0, 400)}`)
  }
}

export async function onshapeGet(path, { retries = 3 } = {}) {
  const credentials = getCredentials()
  return requestWithRetry(
    `${ONSHAPE_BASE}${path}`,
    { headers: { Authorization: `Basic ${credentials}`, Accept: 'application/json' } },
    { retries, label: `GET ${path}` }
  )
}

export async function onshapePost(path, body, { retries = 3 } = {}) {
  const credentials = getCredentials()
  return requestWithRetry(
    `${ONSHAPE_BASE}${path}`,
    {
      method: 'POST',
      headers: {
        Authorization: `Basic ${credentials}`,
        Accept: 'application/json',
        'Content-Type': 'application/json;charset=UTF-8; qs=0.09',
      },
      body: JSON.stringify(body),
    },
    { retries, label: `POST ${path}` }
  )
}

/**
 * Quick connectivity check for Phase 0 — confirms the key pair is valid
 * without depending on any particular document existing. Used by the
 * /api/health route.
 */
export async function checkOnshapeAuth() {
  // /users/session is a cheap authenticated endpoint that just confirms
  // who the key pair resolves to.
  const session = await onshapeGet('/users/session')
  return { userId: session?.id ?? null, name: session?.name ?? null }
}

export async function getOnshapeAccountScope() {
  const session = await onshapeGet('/users/session')
  const rawOrganizations = session?.organizations ?? session?.companies ?? session?.memberships ?? []
  const organizations = (Array.isArray(rawOrganizations) ? rawOrganizations : [rawOrganizations])
    .filter(Boolean).map((org) => ({ id: org.id, name: org.name, type: org.type || org.kind || 'organization' })).filter((org) => org.id)
  return { user: { id: session?.id ?? null, name: session?.name ?? null }, organizations }
}

// ── Phase 2: flat BOM fetching + parsing ────────────────────────
//
// Direct parts only for now — no subassembly recursion (that's Phase 3).
// This section ports fetchBomWithFallback / resolveRow / unwrapBomValue
// from the earlier project's onshape.js essentially unchanged, since
// that logic already solves the hard, non-obvious problems documented in
// the planning doc's §1 (never-generated-BOM 404s, wrapped values,
// header-id-first lookups).

// Standard BOM column (header) ids. These map to Onshape's built-in part
// properties and have been observed stable across documents/templates.
// Passed via `bomColumnIds` so Onshape only serializes what we need
// instead of full material tables, enum option lists, appearance, etc.
const CATEGORY_HEADER_ID = '57f3fb8efa3416c06701d625'
const QUANTITY_HEADER_ID = '5ace84d3c046ad611c65a0dd' // NOT '...c65a0ba', that id is "Item"
const NAME_HEADER_ID = '57f3fb8efa3416c06701d60d'
const PART_NUMBER_HEADER_ID = '57f3fb8efa3416c06701d60f'

const STANDARD_BOM_COLUMN_IDS = [
  NAME_HEADER_ID,
  PART_NUMBER_HEADER_ID,
  QUANTITY_HEADER_ID,
  CATEGORY_HEADER_ID,
]

/**
 * Several BOM columns (confirmed for Category; treated as a general risk
 * for any column) come back as an object or single-element array
 * wrapping the real value rather than a bare primitive — e.g.
 * { value: 4 } or [{ name: 'Assembly', ... }] instead of just `4`.
 * Unwrap defensively before anything tries to parseInt/String a column
 * value, so a wrapped response degrades gracefully instead of silently
 * producing NaN / "[object Object]".
 */
function unwrapBomValue(val) {
  if (val === null || val === undefined) return val
  if (Array.isArray(val)) return val.length ? unwrapBomValue(val[0]) : null
  if (typeof val === 'object') {
    if ('value' in val) return val.value
    if ('name' in val) return val.name
  }
  return val
}

/**
 * Fetches a BOM at `path`, with a fallback for elements that have never
 * had ANY BOM materialized: `generateIfAbsent=true` is supposed to
 * generate one synchronously, but in practice it can 404 on the very
 * first request for a shape (indented/multiLevel combo) an element has
 * never been asked for — especially elements buried deep in a tree that
 * nobody has ever opened the BOM tab for in the Onshape UI. Forcing the
 * plain/default BOM shape first reliably triggers generation; once
 * generated, the originally-requested shape works.
 */
async function fetchBomWithFallback(documentId, wvmType, workspaceId, elementId, queryString, bomColumnIds) {
  const base = `/assemblies/d/${documentId}/${wvmType}/${workspaceId}/e/${elementId}/bom`
  const fullQuery = bomColumnIds?.length
    ? `${queryString}&${bomColumnIds.map((id) => `bomColumnIds=${id}`).join('&')}`
    : queryString
  const path = `${base}?${fullQuery}`

  try {
    return await onshapeGet(path)
  } catch (e) {
    if (!/Onshape API 404/.test(e.message)) throw e
  }

  console.warn(`[onshape] BOM 404 for element ${elementId} — forcing default BOM generation, then retrying…`)
  try {
    // Intentionally no bomColumnIds — this call exists purely to trigger
    // generation, its response is discarded either way.
    await onshapeGet(`${base}?generateIfAbsent=true`)
  } catch {
    // If even the plain default BOM 404s, this element has no BOM to
    // give — fall through to the final error below.
  }

  // Poll with increasing delays instead of one flat wait — most
  // generations finish well under the worst case.
  const pollDelaysMs = [150, 300, 500, 800]
  let lastErr
  for (const delay of pollDelaysMs) {
    await sleep(delay)
    try {
      return await onshapeGet(path)
    } catch (e2) {
      lastErr = e2
      if (!/Onshape API 404/.test(e2.message)) throw e2
    }
  }

  throw new Error(
    `Could not load the BOM for element ${elementId} (document ${documentId}, ${wvmType} ${workspaceId}). ` +
    `Onshape returned 404 even after forcing BOM generation — check that this element is an Assembly ` +
    `(not a Part Studio/other tab), that the ${wvmType === 'v' ? 'version' : wvmType === 'm' ? 'microversion' : 'workspace'} id is current, and that you have access to it.` +
    (lastErr ? ` (last error: ${lastErr.message})` : '')
  )
}

/**
 * Flat, non-indented BOM fetch. Phase 2 only ever calls this — no
 * subassembly recursion or indented/category classification yet, so a
 * subassembly row is just serialized like any other row and, for now,
 * treated the same as a part (Phase 3 adds the classify-and-recurse
 * logic from the planning doc's §1.6–1.7).
 */
export async function fetchFlatBom(documentId, workspaceId, elementId, wvmType = 'w', bomColumnIds = STANDARD_BOM_COLUMN_IDS) {
  return fetchBomWithFallback(
    documentId, wvmType, workspaceId, elementId,
    'indented=false&multiLevel=false&generateIfAbsent=true',
    bomColumnIds
  )
}

/**
 * Resolves one BOM row into { partName, partNumber, quantity }. Prefers
 * looking up well-known columns by header id — immune to a document's
 * BOM template renaming/localizing a column (e.g. "Qty (ea)" instead of
 * "Quantity"), which name-only matching would silently miss. Falls back
 * to case-insensitive name matching only when the id isn't present in
 * this row at all.
 */
export function resolveRow(row, headerById) {
  const vals = row.headerIdToValue ?? {}
  const byName = {}
  Object.entries(vals).forEach(([hid, v]) => {
    const name = headerById[hid]
    if (name) byName[name] = v
  })

  const rawQuantity = vals[QUANTITY_HEADER_ID] ?? byName['quantity'] ?? byName['qty'] ?? byName['count']
  const rawPartName = vals[NAME_HEADER_ID] ?? byName['name'] ?? byName['part name'] ?? byName['description']
  const rawPartNumber = vals[PART_NUMBER_HEADER_ID] ?? byName['part number'] ?? byName['part #'] ?? byName['pn']

  const unwrappedQuantity = unwrapBomValue(rawQuantity)
  const parsedQuantity = parseInt(unwrappedQuantity, 10)

  const partName = unwrapBomValue(rawPartName) ? String(unwrapBomValue(rawPartName)) : 'Unknown part'
  const partNumber = unwrapBomValue(rawPartNumber) ? String(unwrapBomValue(rawPartNumber)) : ''
  const quantity = Number.isFinite(parsedQuantity) && parsedQuantity > 0 ? parsedQuantity : 1

  if (!Number.isFinite(parsedQuantity)) {
    console.warn(`[onshape] Could not resolve a quantity for row "${partName}" — raw value:`, rawQuantity, '— defaulting to 1.')
  }

  return { partName, partNumber, quantity }
}

/**
 * Parses a flat BOM response into a simple row list. Rows that resolve
 * to no usable name are dropped (defensive — a row with literally no
 * name isn't useful to write to a sheet).
 */
export function parseFlatBomRows(bomData) {
  const headers = bomData.headers ?? []
  const headerById = {}
  headers.forEach((h) => { headerById[h.id] = h.name?.toLowerCase() })

  const parts = (bomData.rows ?? [])
    .map((row) => resolveRow(row, headerById))
    .filter((p) => p.partName && p.partName !== 'Unknown part')

  return { headers, parts }
}

// ── Phase 3: subassembly recursion + hierarchy ──────────────────
//
// Builds on Phase 2's flat parsing. Adds: telling parts from
// subassemblies from vendor/COTS content (planning doc §1.6), the
// indented BOM fetch that avoids a second lookup call per subassembly
// (§1.1), a dedupe cache for repeated subassembly instances (§1.7), and
// a max recursion depth as a guard against pathological/cyclic trees.

// How many generations of subassemblies to recurse into as real nested
// rows before flattening the rest into direct parts. Matches the
// planning doc's recommendation (§1.7) — real trees rarely go deeper,
// and it protects against a pathological/cyclic reference structure.
export const MAX_CHILD_DEPTH = 5

/**
 * Indented, non-multi-level BOM fetch. `indented=true` means a
 * subassembly row still shows up as itself (not exploded into its
 * children inline) — and crucially its `itemSource` carries the
 * referenced element's own documentId/elementId/workspaceId directly, so
 * no second lookup call is needed to find out what's inside it.
 * `multiLevel=false` means Onshape does not recurse into subassembly
 * contents for us — that's done manually below, one level at a time, so
 * each row can be classified (ours vs. vendor/COTS) before deciding
 * whether to descend into it at all.
 */
async function fetchIndentedBom(documentId, workspaceId, elementId, wvmType, bomColumnIds) {
  return fetchBomWithFallback(
    documentId, wvmType, workspaceId, elementId,
    'indented=true&multiLevel=false&generateIfAbsent=true',
    bomColumnIds
  )
}

/**
 * Every BOM row carries a "Category" column whose value resolves to
 * either "Onshape part" or "Assembly" (case varies — lowercase-compare),
 * plus (for assembly rows) an owner reference for the document that
 * defines that category. Returns null if the row has no usable category
 * value at all, so the caller can fail-safe rather than crash.
 */
function getCategoryInfo(row) {
  const val = row.headerIdToValue?.[CATEGORY_HEADER_ID]
  if (!val) return null
  const obj = Array.isArray(val) ? val[0] : val
  if (!obj || !obj.name) return null

  const rowDocumentId = row.itemSource?.documentId ?? null
  return { name: String(obj.name).toLowerCase(), documentId: rowDocumentId }
}

// Cache document -> ownerId lookups so a deep BOM tree doesn't repeat
// the same /documents/{id} call for every row that references it.
const documentOwnerCache = new Map()

/**
 * Resolves a document's owning-team/owning-user id, used to tell "our"
 * subassemblies (worth recursing into) from vendor/COTS assemblies
 * (bundled purchasable units, treated as a leaf part instead).
 */
export async function fetchDocumentOwnerId(documentId) {
  if (documentOwnerCache.has(documentId)) return documentOwnerCache.get(documentId)
  const promise = onshapeGet(`/documents/${documentId}`)
    .then((doc) => doc?.owner?.id ?? null)
    .catch((e) => {
      console.warn(`[onshape] could not resolve owner for document ${documentId}:`, e.message)
      return null
    })
  documentOwnerCache.set(documentId, promise)
  return promise
}

function elementCacheKey(documentId, wvmType, workspaceId, elementId) {
  return `${documentId}::${wvmType}::${workspaceId}::${elementId}`
}

/**
 * Resolves one assembly level's BOM into { directParts, subassemblies },
 * classifying each row per the planning doc's §1.6:
 *   1. Category column says part or assembly.
 *   2. If assembly: compare the category's owning document id against
 *      the *root* assembly's document owner id (passed down, resolved
 *      once per import). Mismatch → vendor/COTS assembly, treated as a
 *      leaf part rather than recursed into.
 *   3. Unrecognized/missing category → fail safe as a plain part rather
 *      than crashing or silently dropping the row.
 *
 * Caches by (documentId, wvmType, workspaceId, elementId) so a
 * subassembly instanced more than once (two identical gearboxes, a
 * mirrored left/right arm) is only fetched once per import — the
 * in-flight *promise* is cached, not just the eventual result, so two
 * sibling rows referencing the same subassembly and resolved
 * concurrently would await the same fetch rather than duplicating it.
 */
export async function resolveBomWithSubassemblies(
  documentId, workspaceId, elementId, wvmType = 'w', rootOwnerId = null,
  bomColumnIds = STANDARD_BOM_COLUMN_IDS,
  resolveCache = new Map()
) {
  const cacheKey = elementCacheKey(documentId, wvmType, workspaceId, elementId)
  if (resolveCache.has(cacheKey)) {
    return resolveCache.get(cacheKey)
  }
  const promise = resolveBomWithSubassembliesUncached(
    documentId, workspaceId, elementId, wvmType, rootOwnerId, bomColumnIds, resolveCache
  )
  resolveCache.set(cacheKey, promise)
  return promise
}

async function resolveBomWithSubassembliesUncached(documentId, workspaceId, elementId, wvmType, rootOwnerId, bomColumnIds, resolveCache) {
  // rootOwnerId is threaded through (unused directly here) so a future
  // refinement — e.g. comparing document *owner* id instead of document
  // id for cross-document vendor detection — doesn't require touching
  // every call site again.
  const bomData = await fetchIndentedBom(documentId, workspaceId, elementId, wvmType, bomColumnIds)
  const headers = bomData.headers ?? []
  const headerById = {}
  headers.forEach((h) => { headerById[h.id] = h.name?.toLowerCase() })

  const allRows = bomData.rows ?? []
  const directParts = []
  const subassemblies = []

  for (const row of allRows) {
    const parsed = resolveRow(row, headerById)
    if (parsed.partName === 'Unknown part') continue

    const category = getCategoryInfo(row)

    if (!category) {
      console.warn(`[onshape] Row "${parsed.partName}" has no Category value; treating as part.`)
      directParts.push({ ...parsed, ref: { ...row.itemSource, documentId: row.itemSource?.documentId || documentId, wvmType: row.itemSource?.wvmType || 'w', wvmId: row.itemSource?.wvmId || workspaceId, elementId: row.itemSource?.elementId || elementId } })
      continue
    }

    const isPart = category.name.includes('part')
    const isAssembly = !isPart && category.name.includes('assembly')

    if (isPart) {
      directParts.push({ ...parsed, ref: { ...row.itemSource, documentId: row.itemSource?.documentId || documentId, wvmType: row.itemSource?.wvmType || 'w', wvmId: row.itemSource?.wvmId || workspaceId, elementId: row.itemSource?.elementId || elementId } })
      continue
    }

    if (!isAssembly) {
      console.warn(`[onshape] Row "${parsed.partName}" has unrecognized category "${category.name}"; treating as part.`)
      directParts.push({ ...parsed, ref: { ...row.itemSource, documentId: row.itemSource?.documentId || documentId, wvmType: row.itemSource?.wvmType || 'w', wvmId: row.itemSource?.wvmId || workspaceId, elementId: row.itemSource?.elementId || elementId } })
      continue
    }

    // "Ours" means the subassembly's Category definition is owned by
    // the same document currently being walked — i.e. it's part of this
    // team's own document tree, not a vendor/COTS assembly bundled in
    // from elsewhere. Recursing into vendor content would produce a BOM
    // tree nobody wants and burn API calls on data that's never used.
    const isOurs = documentId !== null && category.documentId !== null && category.documentId === documentId

    if (!isOurs) {
      directParts.push({ ...parsed, ref: { ...row.itemSource, documentId: row.itemSource?.documentId || documentId, wvmType: row.itemSource?.wvmType || 'w', wvmId: row.itemSource?.wvmId || workspaceId, elementId: row.itemSource?.elementId || elementId } })
      continue
    }

    const src = row.itemSource || {}
    const resolvedElementId = src.elementId
    const resolvedDocumentId = src.documentId || documentId
    const resolvedWorkspaceId = src.wvmId || workspaceId
    // 'w' (workspace), 'v' (version), or 'm' (microversion). Mirrored,
    // released, or otherwise frozen references commonly come back as
    // 'v' — read the actual wvmType off the row, never assume 'w'.
    const resolvedWvmType = src.wvmType || 'w'

    if (!resolvedElementId) {
      console.warn(`[onshape] Assembly row "${parsed.partName}" has no itemSource.elementId; treating as part.`)
      directParts.push({ ...parsed, ref: { ...row.itemSource, documentId: row.itemSource?.documentId || documentId, wvmType: row.itemSource?.wvmType || 'w', wvmId: row.itemSource?.wvmId || workspaceId, elementId: row.itemSource?.elementId || elementId } })
      continue
    }

    subassemblies.push({
      ...parsed,
      ref: { ...src, documentId: resolvedDocumentId, wvmType: resolvedWvmType, wvmId: resolvedWorkspaceId, elementId: resolvedElementId },
      resolvedElementId,
      resolvedDocumentId,
      resolvedWorkspaceId,
      resolvedWvmType,
    })
  }

  return { headers, directParts, subassemblies }
}

/**
 * Walks an assembly's full subassembly tree and flattens it into an
 * ordered list of rows suitable for a spreadsheet write, each carrying
 * `level` (depth) and `parentRowId` (a synthetic id scoped to this one
 * build — NOT the persistent identity key Phase 4 introduces for
 * cross-import diffing; this is purely for rendering hierarchy/grouping
 * in a single write).
 *
 * Traversal is sequential (not fan-out/parallel across siblings) for
 * Phase 3 — simpler and still correct, since the dedupe cache means a
 * repeated subassembly is still only fetched once. Parallelizing
 * sibling fetches (planning doc §1.3/§1.7) is a straightforward addition
 * later if large/wide trees turn out slow in practice, but isn't needed
 * for correctness.
 *
 * Past MAX_CHILD_DEPTH, remaining levels are fetched flat (fetchFlatBom)
 * and every row treated as a plain part rather than recursed into
 * further — a guard against pathological/cyclic reference structures.
 */
export async function buildHierarchyRows(documentId, workspaceId, elementId, wvmType = 'w') {
  const rootOwnerId = await fetchDocumentOwnerId(documentId)
  const resolveCache = new Map()
  let rowCounter = 0
  const rows = []

  async function walk(docId, wsId, elId, wvm, level, parentRowId) {
    if (level > MAX_CHILD_DEPTH) {
      const bomData = await fetchFlatBom(docId, wsId, elId, wvm)
      const { parts } = parseFlatBomRows(bomData)
      for (const p of parts) {
        rows.push({ ...p, level, parentRowId, rowId: `r${rowCounter++}`, isSubassembly: false,
          ref: p.ref ?? { documentId: docId, wvmType: wvm, wvmId: wsId, elementId: elId } })
      }
      return
    }

    const { directParts, subassemblies } = await resolveBomWithSubassemblies(
      docId, wsId, elId, wvm, rootOwnerId, STANDARD_BOM_COLUMN_IDS, resolveCache
    )

    for (const p of directParts) {
      rows.push({ ...p, level, parentRowId, rowId: `r${rowCounter++}`, isSubassembly: false,
        ref: p.ref ?? { documentId: docId, wvmType: wvm, wvmId: wsId, elementId: elId } })
    }

    for (const s of subassemblies) {
      const rowId = `r${rowCounter++}`
      rows.push({
        partName: s.partName, partNumber: s.partNumber, quantity: s.quantity,
        level, parentRowId, rowId, isSubassembly: true,
        ref: s.ref,
      })
      await walk(s.resolvedDocumentId, s.resolvedWorkspaceId, s.resolvedElementId, s.resolvedWvmType, level + 1, rowId)
    }
  }

  await walk(documentId, workspaceId, elementId, wvmType, 0, null)
  return rows
}
