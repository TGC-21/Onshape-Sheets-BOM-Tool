// server/lib/sheets.js
// This one is real
// Google Sheets API access via a service account. No OAuth flow — the
// target spreadsheet must be shared with the service account's
// client_email (found in the downloaded JSON key) like any collaborator.
//
// Phase 0 only needs `getSheetsClient` + a trivial read (used by the
// /api/health check to prove the credentials work end-to-end). Write
// helpers (batchUpdate, row grouping, etc.) land in Phase 2+.

import { google } from 'googleapis'
import fs from 'node:fs'
import { buildHeaderRow, columnLetterToIndex, ONSHAPE_COLUMNS, META_COLUMNS, VENDOR_COLUMNS } from './columnMap.js'
import { DEFAULT_COLUMN_CONFIG } from './columnConfig.js'
import { applyBomFormatting } from './formatting.js'

const LEGACY_LAYOUT = { name: 'B', partNumber: 'C', quantity: 'D', level: 'E', parent: 'F', priority: 'G', owner: 'H', vendor: 'I', vendorPartNumber: 'J', purchaseUrl: 'K', price: 'L', availability: 'M', sourceKey: 'Z', contentHash: 'AA', listingId: 'AB', listingSnapshot: 'AC' }
const labelFor = (id, fallback) => DEFAULT_COLUMN_CONFIG.find((c) => c.id === id)?.label || fallback

// sheets.js
async function resolveColumnLayout(sheets, spreadsheetId) {
  try {
    const result = await sheets.spreadsheets.values.get({ spreadsheetId, range: 'Config!A1' })
    const config = JSON.parse(result.data.values?.[0]?.[0] || '')
    if (!Array.isArray(config) || !config.length) return { layout: LEGACY_LAYOUT, labels: null }
    const layout = {}
    const labels = {}
    config.filter((c) => c.enabled !== false).forEach((c, index) => { layout[c.id] = index + 2; labels[c.id] = c.label })
    let next = Math.max(...Object.values(layout), 1) + 1
    for (const id of ['sourceKey', 'contentHash', 'listingId', 'listingSnapshot']) {
      if (!layout[id]) layout[id] = next++
    }
   // Reserve meta columns AFTER whatever the Config tab actually uses,
    // instead of fixed letters (Z/AA/AB/AC) that a wide custom config
    // can grow past and collide with.

    return { layout, labels }
  } catch { return { layout: LEGACY_LAYOUT, labels: null } }
}

function indexFor(layout, id, fallbackLetter) { return layout[id] ?? columnLetterToIndex(fallbackLetter) }
function columnIndexToLetter(index) { let result=''; while(index>0){const remainder=(index-1)%26;result=String.fromCharCode(65+remainder)+result;index=Math.floor((index-1)/26)} return result }

const SCOPES = ['https://www.googleapis.com/auth/spreadsheets']

let cachedClientPromise = null

function loadServiceAccountCredentials() {
  const inlineJson = process.env.GOOGLE_SERVICE_ACCOUNT_JSON
  const keyPath = process.env.GOOGLE_SERVICE_ACCOUNT_KEY_PATH

  if (keyPath) {
    if (!fs.existsSync(keyPath)) {
      throw new Error(
        `GOOGLE_SERVICE_ACCOUNT_KEY_PATH is set to "${keyPath}" but that file doesn't exist. ` +
        `Download the service account's JSON key and point the env var at it.`
      )
    }
    return JSON.parse(fs.readFileSync(keyPath, 'utf8'))
  }

  if (inlineJson) {
    try {
      return JSON.parse(inlineJson)
    } catch {
      throw new Error('GOOGLE_SERVICE_ACCOUNT_JSON is set but is not valid JSON.')
    }
  }

  throw new Error(
    'No Google service account credentials found. Set GOOGLE_SERVICE_ACCOUNT_KEY_PATH ' +
    '(recommended) or GOOGLE_SERVICE_ACCOUNT_JSON in your .env.'
  )
}

/**
 * Returns a memoized, authenticated Sheets API client. Safe to call
 * repeatedly — the underlying auth client handles token refresh itself.
 */
export function getSheetsClient() {
  if (!cachedClientPromise) {
    cachedClientPromise = (async () => {
      const credentials = loadServiceAccountCredentials()
      const auth = new google.auth.GoogleAuth({ credentials, scopes: SCOPES })
      const authClient = await auth.getClient()
      return google.sheets({ version: 'v4', auth: authClient })
    })()
  }
  return cachedClientPromise
}

/**
 * Returns the service account's own email — useful for surfacing in the
 * UI/health check so whoever is setting this up knows exactly which
 * address to share their spreadsheet with.
 */
export function getServiceAccountEmail() {
  const creds = loadServiceAccountCredentials()
  return creds.client_email ?? null
}

/**
 * Minimal round-trip check: fetches a spreadsheet's title. Confirms both
 * that the credentials are valid AND that the spreadsheet has actually
 * been shared with the service account (a 403 here almost always means
 * "forgot to share the sheet").
 */
export async function checkSheetAccess(spreadsheetId) {
  const sheets = await getSheetsClient()
  const res = await sheets.spreadsheets.get({
    spreadsheetId,
    fields: 'properties.title,sheets.properties.title',
  })
  return {
    title: res.data.properties?.title ?? null,
    tabs: (res.data.sheets ?? []).map((s) => s.properties?.title),
  }
}

// ── Phase 2: flat write (wipe + rewrite) ────────────────────────
//
// No diffing yet (that's Phase 4) — every import clears the target tab's
// contents and rewrites the header row + one row per part. This means
// re-running Import in Phase 2 will blow away any values typed into the
// user-owned columns; that's expected and gets fixed once Sync (Phase 4)
// exists. `sheetName` defaults to the first tab if not given.

async function resolveSheetTitle(sheets, spreadsheetId, sheetName) {
  if (sheetName) return sheetName
  const meta = await sheets.spreadsheets.get({
    spreadsheetId,
    fields: 'sheets.properties.title',
  })
  const firstTitle = meta.data.sheets?.[0]?.properties?.title
  if (!firstTitle) throw new Error(`Spreadsheet ${spreadsheetId} has no tabs.`)
  return firstTitle
}

/**
 * Writes a flat list of { partName, partNumber, quantity } rows to the
 * target sheet, wiping whatever was there first. Header row comes from
 * columnMap.buildHeaderRow(). Level/Parent/meta columns are left blank
 * in Phase 2 (no hierarchy or identity-key data yet); user-owned columns
 * are written as blank cells for the user to fill in.
 */
export async function writeFlatBom(spreadsheetId, parts, { sheetName } = {}) {
  const sheets = await getSheetsClient()
  const title = await resolveSheetTitle(sheets, spreadsheetId, sheetName)

  const header = buildHeaderRow()
  const nameIdx = columnLetterToIndex(ONSHAPE_COLUMNS.name) - 1
  const partNumberIdx = columnLetterToIndex(ONSHAPE_COLUMNS.partNumber) - 1
  const quantityIdx = columnLetterToIndex(ONSHAPE_COLUMNS.quantity) - 1

  const rows = parts.map((p) => {
    const row = new Array(header.length).fill('')
    row[nameIdx] = p.partName
    row[partNumberIdx] = p.partNumber
    row[quantityIdx] = p.quantity
    return row
  })

  // Clear the whole tab first so a shrinking BOM doesn't leave stale
  // trailing rows behind (acceptable for Phase 2's wipe-and-rewrite;
  // Phase 4 replaces this with a real diff instead of a clear).
  await sheets.spreadsheets.values.clear({ spreadsheetId, range: title })

  await sheets.spreadsheets.values.update({
    spreadsheetId,
    range: `${title}!A1`,
    valueInputOption: 'RAW',
    requestBody: { values: [header, ...rows] },
  })

  return { sheetName: title, rowsWritten: rows.length }
}

// ── Phase 3: hierarchical write (Level/Parent + row grouping) ──
//
// Same wipe-and-rewrite shape as writeFlatBom (Phase 4 replaces this
// with a real diff), but also writes Level/Parent columns and applies
// native Sheets row grouping so subassemblies collapse/expand in the UI
// — the "recommended approach" from the planning doc's §4.

async function getSheetIdByTitle(sheets, spreadsheetId, title) {
  const meta = await sheets.spreadsheets.get({
    spreadsheetId,
    fields: 'sheets.properties(sheetId,title)',
  })
  const match = (meta.data.sheets ?? []).find((s) => s.properties?.title === title)
  if (!match) throw new Error(`Could not find tab "${title}" in spreadsheet ${spreadsheetId}.`)
  return match.properties.sheetId
}

/**
 * Given the flat, DFS-ordered `rows` array from buildHierarchyRows
 * (level increases by exactly 1 per nesting step, matching indentation
 * of a tree written out depth-first), computes the contiguous
 * (startIndex, endIndex) ranges — 0-indexed into `rows`, inclusive —
 * that should become one Sheets row group each: every subassembly row's
 * *children* block, not the subassembly row itself (Sheets groups the
 * rows that collapse, not the summary row above them).
 *
 * This is the same "matching nested parentheses by depth" shape as
 * parsing indentation-based structure generally — a stack of open
 * subassemblies, closed as soon as a row at or above that level is hit.
 */
function computeRowGroupRanges(rows) {
  const ranges = []
  const stack = [] // { rowIndex } — level looked up from rows[rowIndex].level

  for (let i = 0; i < rows.length; i++) {
    const level = rows[i].level
    while (stack.length && rows[stack[stack.length - 1].rowIndex].level >= level) {
      const parent = stack.pop()
      const start = parent.rowIndex + 1
      const end = i - 1
      if (end >= start) ranges.push({ start, end })
    }
    if (rows[i].isSubassembly) stack.push({ rowIndex: i })
  }
  while (stack.length) {
    const parent = stack.pop()
    const start = parent.rowIndex + 1
    const end = rows.length - 1
    if (end >= start) ranges.push({ start, end })
  }
  return ranges
}

/**
 * Writes hierarchical rows (from buildHierarchyRows) to the target
 * sheet: wipes the tab, writes header + Name/Part Number/Quantity/
 * Level/Parent columns, then applies row grouping so each
 * subassembly's children collapse together.
 *
 * Known Phase 3 limitation: because this still wipes-and-rewrites (no
 * diff yet), any row groups left over from a *previous* import aren't
 * explicitly torn down first — Sheets generally handles this fine since
 * clearing values doesn't remove grouping metadata tied to row indices,
 * and re-adding groups over the same ranges is a no-op/harmless, but a
 * BOM that changes shape between imports (fewer/more nested levels)
 * could leave a stale group boundary until Phase 4's diff-based rewrite
 * replaces this wipe-and-rewrite approach entirely.
 */
export async function writeHierarchyBom(spreadsheetId, rows, { sheetName } = {}) {
  const sheets = await getSheetsClient()
  const title = await resolveSheetTitle(sheets, spreadsheetId, sheetName)
  const sheetId = await getSheetIdByTitle(sheets, spreadsheetId, title)
  const { layout, labels } = await resolveColumnLayout(sheets, spreadsheetId)
  const nameIdx = indexFor(layout, 'name', ONSHAPE_COLUMNS.name) - 1
  const partNumberIdx = indexFor(layout, 'partNumber', ONSHAPE_COLUMNS.partNumber) - 1
  const quantityIdx = indexFor(layout, 'quantity', ONSHAPE_COLUMNS.quantity) - 1
  const levelIdx = indexFor(layout, 'level', ONSHAPE_COLUMNS.level) - 1
  const parentIdx = indexFor(layout, 'parent', ONSHAPE_COLUMNS.parent) - 1
  const sourceKeyIdx = indexFor(layout, 'sourceKey', META_COLUMNS.sourceKey) - 1
  const contentHashIdx = indexFor(layout, 'contentHash', META_COLUMNS.contentHash) - 1
  const vendorIdx = indexFor(layout, 'vendor', VENDOR_COLUMNS.vendor) - 1
  const vendorPnIdx = indexFor(layout, 'vendorPartNumber', VENDOR_COLUMNS.vendorPartNumber) - 1
  const urlIdx = indexFor(layout, 'purchaseUrl', VENDOR_COLUMNS.purchaseUrl) - 1
  const priceIdx = indexFor(layout, 'price', VENDOR_COLUMNS.price) - 1
  const availabilityIdx = indexFor(layout, 'availability', VENDOR_COLUMNS.availability) - 1
  const listingIdIdx = indexFor(layout, 'listingId', META_COLUMNS.listingId) - 1
  const snapshotIdx = indexFor(layout, 'listingSnapshot', META_COLUMNS.listingSnapshot) - 1
  const header = new Array(Math.max(...Object.values(layout), columnLetterToIndex(META_COLUMNS.listingSnapshot))).fill('')
  const metaLabels = { sourceKey: 'Source Key (hidden — do not edit)', contentHash: 'Content Hash (hidden — do not edit)', listingId: 'Listing Id (hidden — do not edit)', listingSnapshot: 'Listing Snapshot (hidden — do not edit)', vendor: 'Vendor', vendorPartNumber: 'Vendor Part Number', purchaseUrl: 'Purchase URL', price: 'Price', availability: 'Availability', name: 'Name', partNumber: 'Part Number', quantity: 'Quantity', level: 'Level', parent: 'Parent' }
  const effectiveLabels = labels ? { ...metaLabels, ...labels } : metaLabels
  Object.entries(effectiveLabels).forEach(([id, label]) => { const index = indexFor(layout, id, LEGACY_LAYOUT[id]) - 1; if (index >= 0 && index < header.length) header[index] = label })
  
  const values = rows.map((r) => {
    const row = new Array(header.length).fill('')
    row[nameIdx] = r.isSubassembly ? `${r.partName} (assembly)` : r.partName
    row[partNumberIdx] = r.partNumber
    row[quantityIdx] = r.quantity
    row[levelIdx] = r.level
    row[parentIdx] = r.parentLabel ?? ''
    row[sourceKeyIdx] = r.sourceKey ?? ''
    row[contentHashIdx] = r.contentHash ?? ''
    const v = r.vendorListing
    if (v) { row[vendorIdx] = v.vendorName; row[vendorPnIdx] = v.vendorPartNumber; row[urlIdx] = v.purchaseUrl ?? ''; row[priceIdx] = v.latestPrice ?? ''; row[availabilityIdx] = v.active === false ? 'Unavailable' : (v.availability ?? ''); row[listingIdIdx] = v.id; row[snapshotIdx] = r.vendorSnapshot }
    return row
  })

  await sheets.spreadsheets.values.clear({ spreadsheetId, range: title })
  await sheets.spreadsheets.values.update({
    spreadsheetId,
    range: `${title}!A1`,
    valueInputOption: 'RAW',
    requestBody: { values: [header, ...values] },
  })

  const groupRanges = computeRowGroupRanges(rows)
  if (groupRanges.length) {
    // +1: skip past the header row (row 1). Sheets GridRange indices are
    // 0-indexed with an exclusive end, so a data-array range [start,end]
    // (inclusive, 0-indexed into `rows`) becomes
    // startIndex = start + 1, endIndex = end + 2.
    const requests = groupRanges.map(({ start, end }) => ({
      addDimensionGroup: {
        range: { sheetId, dimension: 'ROWS', startIndex: start + 1, endIndex: end + 2 },
      },
    }))
    await sheets.spreadsheets.batchUpdate({ spreadsheetId, requestBody: { requests } })
  }

  await applyBomFormatting(sheets, spreadsheetId, sheetId, {
    numColumns: header.length,
    numRows: values.length + 1,
    hiddenColumnIndexes: [sourceKeyIdx, contentHashIdx, listingIdIdx, snapshotIdx].filter((i) => i >= 0),
    quantityColIndex: quantityIdx >= 0 ? quantityIdx : null,
    priceColIndex: priceIdx >= 0 ? priceIdx : null,
  })

  return { sheetName: title, rowsWritten: values.length, groupsCreated: groupRanges.length }
}

/**
 * Reapplies the standard BOM formatting to whatever is currently in the
 * sheet, without touching any values. Used by the "Format sheet" menu
 * command — e.g. after reordering columns in the config panel, or if a
 * user has manually undone some formatting and wants it back.
 */
export async function formatBomSheet(spreadsheetId, { sheetName } = {}) {
  const sheets = await getSheetsClient()
  const title = await resolveSheetTitle(sheets, spreadsheetId, sheetName)
  const sheetId = await getSheetIdByTitle(sheets, spreadsheetId, title)
  const { layout, labels } = await resolveColumnLayout(sheets, spreadsheetId)
  const maxColumn = Math.max(...Object.values(layout), columnLetterToIndex(META_COLUMNS.listingSnapshot))

  const read = await sheets.spreadsheets.values.get({ spreadsheetId, range: `${title}!A:${columnIndexToLetter(maxColumn)}` })
  const numRows = Math.max(read.data.values?.length ?? 1, 1)

  const sourceKeyIdx = indexFor(layout, 'sourceKey', META_COLUMNS.sourceKey) - 1
  const contentHashIdx = indexFor(layout, 'contentHash', META_COLUMNS.contentHash) - 1
  const listingIdIdx = indexFor(layout, 'listingId', META_COLUMNS.listingId) - 1
  const snapshotIdx = indexFor(layout, 'listingSnapshot', META_COLUMNS.listingSnapshot) - 1
  const quantityIdx = indexFor(layout, 'quantity', ONSHAPE_COLUMNS.quantity) - 1
  const priceIdx = indexFor(layout, 'price', VENDOR_COLUMNS.price) - 1

  await applyBomFormatting(sheets, spreadsheetId, sheetId, {
    numColumns: maxColumn,
    numRows,
    hiddenColumnIndexes: [sourceKeyIdx, contentHashIdx, listingIdIdx, snapshotIdx].filter((i) => i >= 0),
    quantityColIndex: quantityIdx >= 0 ? quantityIdx : null,
    priceColIndex: priceIdx >= 0 ? priceIdx : null,
  })

  return { sheetName: title }
}

/** Diff-syncs rows while only writing mapped Onshape/meta cells. User columns
 * and all unrelated columns remain untouched. Rows without a source key are
 * intentionally ignored as legacy/untracked rows and fresh rows are appended. */
export async function syncHierarchyBom(spreadsheetId, rows, { sheetName } = {}) {
  const sheets = await getSheetsClient()
  const title = await resolveSheetTitle(sheets, spreadsheetId, sheetName)
  const sheetId = await getSheetIdByTitle(sheets, spreadsheetId, title)
  const layout = await resolveColumnLayout(sheets, spreadsheetId)
  const maxColumn = Math.max(...Object.values(layout), columnLetterToIndex(META_COLUMNS.listingSnapshot))
  const read = await sheets.spreadsheets.values.get({ spreadsheetId, range: `${title}!A:${columnIndexToLetter(maxColumn)}` })
  const values = read.data.values ?? []
  const existing = new Map()
  for (let i = 1; i < values.length; i++) {
    const key = values[i][indexFor(layout, 'sourceKey', META_COLUMNS.sourceKey) - 1]
    if (key) existing.set(key, { rowNumber: i + 1, values: values[i] })
  }
  const updates = []
  const inserts = []
  const freshKeys = new Set(rows.map((r) => r.sourceKey))
  const nameCol = indexFor(layout, 'name', ONSHAPE_COLUMNS.name) - 1
  const pnCol = indexFor(layout, 'partNumber', ONSHAPE_COLUMNS.partNumber) - 1
  const qtyCol = indexFor(layout, 'quantity', ONSHAPE_COLUMNS.quantity) - 1
  const levelCol = indexFor(layout, 'level', ONSHAPE_COLUMNS.level) - 1
  const parentCol = indexFor(layout, 'parent', ONSHAPE_COLUMNS.parent) - 1
  const sourceCol = indexFor(layout, 'sourceKey', META_COLUMNS.sourceKey) - 1
  const hashCol = indexFor(layout, 'contentHash', META_COLUMNS.contentHash) - 1
  const listingIdCol = indexFor(layout, 'listingId', META_COLUMNS.listingId) - 1
  const snapshotCol = indexFor(layout, 'listingSnapshot', META_COLUMNS.listingSnapshot) - 1
  const vendorCol = indexFor(layout, 'vendor', VENDOR_COLUMNS.vendor) - 1
  const vendorPnCol = indexFor(layout, 'vendorPartNumber', VENDOR_COLUMNS.vendorPartNumber) - 1
  const urlCol = indexFor(layout, 'purchaseUrl', VENDOR_COLUMNS.purchaseUrl) - 1
  const priceCol = indexFor(layout, 'price', VENDOR_COLUMNS.price) - 1
  const availabilityCol = indexFor(layout, 'availability', VENDOR_COLUMNS.availability) - 1
  const cellsFor = (r) => { const v=r.vendorListing; return [[r.isSubassembly ? `${r.partName} (assembly)` : r.partName, r.partNumber, r.quantity, r.level, r.parentLabel ?? '', r.sourceKey, r.contentHash, v?.vendorName ?? '', v?.vendorPartNumber ?? '', v?.purchaseUrl ?? '', v?.latestPrice ?? '', v?.availability ?? '', v?.id ?? '', r.vendorSnapshot ?? '']] }
  for (const row of rows) {
    const found = existing.get(row.sourceKey)
    if (!found) inserts.push(row)
    else if (found.values[hashCol] !== row.contentHash) {
      const parts = cellsFor(row)[0]
      updates.push(...[
        [`${title}!${columnIndexToLetter(nameCol + 1)}${found.rowNumber}` , [[parts[0]]]],
        [`${title}!${columnIndexToLetter(pnCol + 1)}${found.rowNumber}`, [[parts[1]]]],
        [`${title}!${columnIndexToLetter(qtyCol + 1)}${found.rowNumber}`, [[parts[2]]]],
        [`${title}!${columnIndexToLetter(levelCol + 1)}${found.rowNumber}`, [[parts[3]]]],
        [`${title}!${columnIndexToLetter(parentCol + 1)}${found.rowNumber}`, [[parts[4]]]],
        [`${title}!${columnIndexToLetter(sourceCol + 1)}${found.rowNumber}`, [[parts[5]]]],
        [`${title}!${columnIndexToLetter(hashCol + 1)}${found.rowNumber}`, [[parts[6]]]],
      ])
    }
  }
  const deletes = [...existing.values()].filter((r) => !freshKeys.has(r.values[sourceCol]))
  if (updates.length) await sheets.spreadsheets.values.batchUpdate({ spreadsheetId, requestBody: { valueInputOption: 'RAW', data: updates.map(([range, v]) => ({ range, values: v })) } })
  if (inserts.length) {
    await sheets.spreadsheets.values.append({ spreadsheetId, range: `${title}!A:${columnIndexToLetter(maxColumn)}`, valueInputOption: 'RAW', insertDataOption: 'INSERT_ROWS', requestBody: { values: inserts.map((r) => { const out = new Array(maxColumn).fill(''); const p = cellsFor(r)[0]; [nameCol,pnCol,qtyCol,levelCol,parentCol,sourceCol,hashCol,vendorCol,vendorPnCol,urlCol,priceCol,availabilityCol,listingIdCol,snapshotCol].forEach((idx, i) => { out[idx] = p[i] }); return out }) } })
  }
  if (deletes.length) await sheets.spreadsheets.batchUpdate({ spreadsheetId, requestBody: { requests: deletes.sort((a,b) => b.rowNumber-a.rowNumber).map((r) => ({ deleteDimension: { range: { sheetId, dimension: 'ROWS', startIndex: r.rowNumber - 1, endIndex: r.rowNumber } } })) } })

  const finalRowCount = existing.size + inserts.length - deletes.length + 1 // +1 for header
  await applyBomFormatting(sheets, spreadsheetId, sheetId, {
    numColumns: maxColumn,
    numRows: finalRowCount,
    hiddenColumnIndexes: [sourceCol, hashCol, listingIdCol, snapshotCol].filter((i) => i >= 0),
    quantityColIndex: qtyCol >= 0 ? qtyCol : null,
    priceColIndex: priceCol >= 0 ? priceCol : null,
  })

  return { sheetName: title, rowsUpdated: updates.length / 7, rowsInserted: inserts.length, rowsDeleted: deletes.length, rowsSkipped: rows.length - inserts.length - updates.length / 7 }
}
