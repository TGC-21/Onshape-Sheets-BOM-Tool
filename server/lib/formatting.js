// server/lib/formatting.js
//
// Cosmetic formatting for the BOM tab, applied via the Sheets API's
// batchUpdate (spreadsheets.batchUpdate), not values.update. This is
// intentionally separate from the value-writing functions in sheets.js:
// formatting requests are idempotent-ish (safe to reapply) but touch
// sheet *properties* (bandedRanges, dimension visibility, cell format),
// not cell contents, so keeping them in one place makes it obvious this
// never risks clobbering a value.
//
// NOTE on scope: Sheets' native data-validation dropdown chips (used for
// the "dropdown" user-column type) are rendered by Sheets' own UI chrome
// — there is no API property that changes their corner radius, font, or
// chip styling. Nothing here (or anywhere) can change that; it's a
// Sheets platform limitation, not a gap in this tool.

const HEADER_BG = { red: 0.42, green: 0.07, blue: 0.11 } // dark red, ~#6b121c
const HEADER_FG = { red: 1, green: 1, blue: 1 }
const BAND_FIRST = { red: 1, green: 1, blue: 1 } // white
const BAND_SECOND = { red: 0.98, green: 0.91, blue: 0.92 } // light red tint, ~#fae8ea
const GRID_BORDER = { red: 0.85, green: 0.85, blue: 0.85 }

/**
 * Returns the batchUpdate requests that give the BOM tab a consistent,
 * readable look: bold white-on-dark-red header, frozen header row,
 * light red/white row banding, a light grid border, sensible number
 * formats for Quantity/Price, auto-sized columns, and the hidden meta
 * columns (Source Key / Content Hash / Listing Id / Listing Snapshot)
 * actually hidden instead of just labeled "(hidden — do not edit)".
 *
 * `sheetId` — numeric grid id (not the tab title) for the target tab.
 * `numColumns` — width of the header row (from buildHeaderRow()/layout).
 * `numRows` — total rows including the header (1 + data row count).
 * `hiddenColumnIndexes` — 0-indexed column positions to hide.
 * `quantityColIndex` / `priceColIndex` — 0-indexed, or null to skip.
 * `existingBandedRangeIds` — banded range ids already on this sheet, so
 *   they can be deleted first (otherwise re-running import/sync keeps
 *   stacking new banded ranges on top of the old ones).
 */
export function buildFormattingRequests({
  sheetId,
  numColumns,
  numRows,
  hiddenColumnIndexes = [],
  quantityColIndex = null,
  priceColIndex = null,
  existingBandedRangeIds = [],
  columnWidths = [],
  trimRowsTo = null
}) {
  const requests = []

  // Remove any banded ranges from a previous formatting pass before
  // adding a fresh one sized to the current row count.
  for (const bandedRangeId of existingBandedRangeIds) {
    requests.push({ deleteBanding: { bandedRangeId } })
  }

  if (trimRowsTo != null) {
    requests.push({
      updateSheetProperties: {
        properties: { sheetId, gridProperties: { rowCount: Math.max(trimRowsTo, 1) } },
        fields: 'gridProperties.rowCount',
      },
    })
  }

  // Freeze the header row.
  requests.push({
    updateSheetProperties: {
      properties: { sheetId, gridProperties: { frozenRowCount: 1 } },
      fields: 'gridProperties.frozenRowCount',
    },
  })

  // Header row style: bold white text on dark red, centered, slightly
  // taller row so it doesn't feel cramped.
  requests.push({
    repeatCell: {
      range: { sheetId, startRowIndex: 0, endRowIndex: 1, startColumnIndex: 0, endColumnIndex: numColumns },
      cell: {
        userEnteredFormat: {
          backgroundColor: HEADER_BG,
          textFormat: { foregroundColor: HEADER_FG, bold: true, fontSize: 10 },
          horizontalAlignment: 'CENTER',
          verticalAlignment: 'MIDDLE',
          wrapStrategy: 'CLIP',
        },
      },
      fields: 'userEnteredFormat(backgroundColor,textFormat,horizontalAlignment,verticalAlignment,wrapStrategy)',
    },
  })
  requests.push({
    updateDimensionProperties: {
      range: { sheetId, dimension: 'ROWS', startIndex: 0, endIndex: 1 },
      properties: { pixelSize: 30 },
      fields: 'pixelSize',
    },
  })

  // Data rows: clip long text instead of overflowing into neighboring
  // cells, middle-align vertically.
  if (numRows > 1) {
    requests.push({
      repeatCell: {
        range: { sheetId, startRowIndex: 1, endRowIndex: numRows, startColumnIndex: 0, endColumnIndex: numColumns },
        cell: { userEnteredFormat: { wrapStrategy: 'CLIP', verticalAlignment: 'MIDDLE' } },
        fields: 'userEnteredFormat(wrapStrategy,verticalAlignment)',
      },
    })

    // Light red/white banding across the data rows.
    requests.push({
      addBanding: {
        bandedRange: {
          range: { sheetId, startRowIndex: 1, endRowIndex: numRows, startColumnIndex: 0, endColumnIndex: numColumns },
          rowProperties: { firstBandColor: BAND_FIRST, secondBandColor: BAND_SECOND },
        },
      },
    })

    // Thin light-gray grid border around the whole table.
    requests.push({
      updateBorders: {
        range: { sheetId, startRowIndex: 0, endRowIndex: numRows, startColumnIndex: 0, endColumnIndex: numColumns },
        top: { style: 'SOLID', width: 1, color: GRID_BORDER },
        bottom: { style: 'SOLID', width: 1, color: GRID_BORDER },
        left: { style: 'SOLID', width: 1, color: GRID_BORDER },
        right: { style: 'SOLID', width: 1, color: GRID_BORDER },
        innerHorizontal: { style: 'SOLID', width: 1, color: GRID_BORDER },
        innerVertical: { style: 'SOLID', width: 1, color: GRID_BORDER },
      },
    })
  }

  if (quantityColIndex != null) {
    requests.push({
      repeatCell: {
        range: { sheetId, startRowIndex: 1, endRowIndex: numRows, startColumnIndex: quantityColIndex, endColumnIndex: quantityColIndex + 1 },
        cell: { userEnteredFormat: { numberFormat: { type: 'NUMBER', pattern: '0' }, horizontalAlignment: 'RIGHT' } },
        fields: 'userEnteredFormat(numberFormat,horizontalAlignment)',
      },
    })
  }
  if (priceColIndex != null) {
    requests.push({
      repeatCell: {
        range: { sheetId, startRowIndex: 1, endRowIndex: numRows, startColumnIndex: priceColIndex, endColumnIndex: priceColIndex + 1 },
        cell: { userEnteredFormat: { numberFormat: { type: 'CURRENCY', pattern: '$#,##0.00' }, horizontalAlignment: 'RIGHT' } },
        fields: 'userEnteredFormat(numberFormat,horizontalAlignment)',
      },
    })
  }

  // Auto-resize every column to fit its content (run after the format
  // requests above so header font/size changes are accounted for).
  requests.push({
    autoResizeDimensions: {
      dimensions: { sheetId, dimension: 'COLUMNS', startIndex: 0, endIndex: numColumns },
    },
  })

    // Explicit minimum widths for columns whose header/content autosize
  // tends to underestimate — applied after autoResize so these win.
  for (const { index, pixelSize } of columnWidths) {
    requests.push({
      updateDimensionProperties: {
        range: { sheetId, dimension: 'COLUMNS', startIndex: index, endIndex: index + 1 },
        properties: { pixelSize },
        fields: 'pixelSize',
      },
    })
  }

  // Hide the meta/helper columns instead of just labeling them.
  for (const colIndex of hiddenColumnIndexes) {
    requests.push({
      updateDimensionProperties: {
        range: { sheetId, dimension: 'COLUMNS', startIndex: colIndex, endIndex: colIndex + 1 },
        properties: { hiddenByUser: true },
        fields: 'hiddenByUser',
      },
    })
  }

  return requests
}

/**
 * Looks up the banded range ids currently on a sheet, so a caller can
 * pass them into buildFormattingRequests() to be deleted before a fresh
 * one is added (otherwise banding stacks on every re-import/sync).
 */
export async function getExistingBandedRangeIds(sheets, spreadsheetId, sheetId) {
  const meta = await sheets.spreadsheets.get({
    spreadsheetId,
    fields: 'sheets(properties(sheetId),bandedRanges(bandedRangeId))',
  })
  const sheet = (meta.data.sheets ?? []).find((s) => s.properties?.sheetId === sheetId)
  return (sheet?.bandedRanges ?? []).map((b) => b.bandedRangeId).filter((id) => id != null)
}

/**
 * Applies the standard BOM formatting to a sheet. Safe to call after
 * every import/sync — clears old banding first so it doesn't stack.
 */
export async function applyBomFormatting(sheets, spreadsheetId, sheetId, opts) {
  const existingBandedRangeIds = await getExistingBandedRangeIds(sheets, spreadsheetId, sheetId)
  const requests = buildFormattingRequests({ sheetId, existingBandedRangeIds, ...opts })
  if (!requests.length) return
  await sheets.spreadsheets.batchUpdate({ spreadsheetId, requestBody: { requests } })
}
