// server/lib/sheets.js
//
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

  const header = buildHeaderRow()
  const nameIdx = columnLetterToIndex(ONSHAPE_COLUMNS.name) - 1
  const partNumberIdx = columnLetterToIndex(ONSHAPE_COLUMNS.partNumber) - 1
  const quantityIdx = columnLetterToIndex(ONSHAPE_COLUMNS.quantity) - 1
  const levelIdx = columnLetterToIndex(ONSHAPE_COLUMNS.level) - 1
  const parentIdx = columnLetterToIndex(ONSHAPE_COLUMNS.parent) - 1
  const sourceKeyIdx = columnLetterToIndex(META_COLUMNS.sourceKey) - 1
  const contentHashIdx = columnLetterToIndex(META_COLUMNS.contentHash) - 1
  const vendorIdx = columnLetterToIndex(VENDOR_COLUMNS.vendor) - 1
  const vendorPnIdx = columnLetterToIndex(VENDOR_COLUMNS.vendorPartNumber) - 1
  const urlIdx = columnLetterToIndex(VENDOR_COLUMNS.purchaseUrl) - 1
  const priceIdx = columnLetterToIndex(VENDOR_COLUMNS.price) - 1
  const availabilityIdx = columnLetterToIndex(VENDOR_COLUMNS.availability) - 1
  const listingIdIdx = columnLetterToIndex(META_COLUMNS.listingId) - 1
  const snapshotIdx = columnLetterToIndex(META_COLUMNS.listingSnapshot) - 1

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

  return { sheetName: title, rowsWritten: values.length, groupsCreated: groupRanges.length }
}

/** Diff-syncs rows while only writing mapped Onshape/meta cells. User columns
 * and all unrelated columns remain untouched. Rows without a source key are
 * intentionally ignored as legacy/untracked rows and fresh rows are appended. */
export async function syncHierarchyBom(spreadsheetId, rows, { sheetName } = {}) {
  const sheets = await getSheetsClient()
  const title = await resolveSheetTitle(sheets, spreadsheetId, sheetName)
  const sheetId = await getSheetIdByTitle(sheets, spreadsheetId, title)
  const read = await sheets.spreadsheets.values.get({ spreadsheetId, range: `${title}!A:AA` })
  const values = read.data.values ?? []
  const existing = new Map()
  for (let i = 1; i < values.length; i++) {
    const key = values[i][columnLetterToIndex(META_COLUMNS.sourceKey) - 1]
    if (key) existing.set(key, { rowNumber: i + 1, values: values[i] })
  }
  const updates = []
  const inserts = []
  const freshKeys = new Set(rows.map((r) => r.sourceKey))
  const nameCol = columnLetterToIndex(ONSHAPE_COLUMNS.name) - 1
  const pnCol = columnLetterToIndex(ONSHAPE_COLUMNS.partNumber) - 1
  const qtyCol = columnLetterToIndex(ONSHAPE_COLUMNS.quantity) - 1
  const levelCol = columnLetterToIndex(ONSHAPE_COLUMNS.level) - 1
  const parentCol = columnLetterToIndex(ONSHAPE_COLUMNS.parent) - 1
  const sourceCol = columnLetterToIndex(META_COLUMNS.sourceKey) - 1
  const hashCol = columnLetterToIndex(META_COLUMNS.contentHash) - 1
  const listingIdCol = columnLetterToIndex(META_COLUMNS.listingId) - 1
  const snapshotCol = columnLetterToIndex(META_COLUMNS.listingSnapshot) - 1
  const vendorCol = columnLetterToIndex(VENDOR_COLUMNS.vendor) - 1
  const vendorPnCol = columnLetterToIndex(VENDOR_COLUMNS.vendorPartNumber) - 1
  const urlCol = columnLetterToIndex(VENDOR_COLUMNS.purchaseUrl) - 1
  const priceCol = columnLetterToIndex(VENDOR_COLUMNS.price) - 1
  const availabilityCol = columnLetterToIndex(VENDOR_COLUMNS.availability) - 1
  const cellsFor = (r) => { const v=r.vendorListing; return [[r.isSubassembly ? `${r.partName} (assembly)` : r.partName, r.partNumber, r.quantity, r.level, r.parentLabel ?? '', r.sourceKey, r.contentHash, v?.vendorName ?? '', v?.vendorPartNumber ?? '', v?.purchaseUrl ?? '', v?.latestPrice ?? '', v?.availability ?? '', v?.id ?? '', r.vendorSnapshot ?? '']] }
  for (const row of rows) {
    const found = existing.get(row.sourceKey)
    if (!found) inserts.push(row)
    else if (found.values[hashCol] !== row.contentHash) {
      const parts = cellsFor(row)[0]
      updates.push(...[
        [`${title}!${ONSHAPE_COLUMNS.name}${found.rowNumber}` , [[parts[0]]]],
        [`${title}!${ONSHAPE_COLUMNS.partNumber}${found.rowNumber}`, [[parts[1]]]],
        [`${title}!${ONSHAPE_COLUMNS.quantity}${found.rowNumber}`, [[parts[2]]]],
        [`${title}!${ONSHAPE_COLUMNS.level}${found.rowNumber}`, [[parts[3]]]],
        [`${title}!${ONSHAPE_COLUMNS.parent}${found.rowNumber}`, [[parts[4]]]],
        [`${title}!${META_COLUMNS.sourceKey}${found.rowNumber}`, [[parts[5]]]],
        [`${title}!${META_COLUMNS.contentHash}${found.rowNumber}`, [[parts[6]]]],
      ])
    }
  }
  const deletes = [...existing.values()].filter((r) => !freshKeys.has(r.values[sourceCol]))
  if (updates.length) await sheets.spreadsheets.values.batchUpdate({ spreadsheetId, requestBody: { valueInputOption: 'RAW', data: updates.map(([range, v]) => ({ range, values: v })) } })
  if (inserts.length) {
    await sheets.spreadsheets.values.append({ spreadsheetId, range: `${title}!A:AC`, valueInputOption: 'RAW', insertDataOption: 'INSERT_ROWS', requestBody: { values: inserts.map((r) => { const out = new Array(29).fill(''); const p = cellsFor(r)[0]; [nameCol,pnCol,qtyCol,levelCol,parentCol,sourceCol,hashCol,vendorCol,vendorPnCol,urlCol,priceCol,availabilityCol,listingIdCol,snapshotCol].forEach((idx, i) => { out[idx] = p[i] }); return out }) } })
  }
  if (deletes.length) await sheets.spreadsheets.batchUpdate({ spreadsheetId, requestBody: { requests: deletes.sort((a,b) => b.rowNumber-a.rowNumber).map((r) => ({ deleteDimension: { range: { sheetId, dimension: 'ROWS', startIndex: r.rowNumber - 1, endIndex: r.rowNumber } } })) } })
  return { sheetName: title, rowsUpdated: updates.length / 7, rowsInserted: inserts.length, rowsDeleted: deletes.length, rowsSkipped: rows.length - inserts.length - updates.length / 7 }
}
