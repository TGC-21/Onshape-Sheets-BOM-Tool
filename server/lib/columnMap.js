// server/lib/columnMap.js
//
// Hardcoded column layout for V1 (per planning doc §8.5). No Config tab
// yet — this object is deliberately the single source of truth so a
// later Config-tab reader can replace it without touching any other file.
//
// Row layout (1-indexed, header row is row 1):
//   A: (unused / reserved, e.g. could hold a row number later)
//   B: Name
//   C: Part Number
//   D: Quantity
//   E: Level        (Phase 3 — hierarchy depth; blank in Phase 2)
//   F: Parent        (Phase 3 — parent identity key; blank in Phase 2)
//   G: Priority      (user-owned)
//   H: Owner         (user-owned)
//   ...              (hidden meta columns further right)

export const ONSHAPE_COLUMNS = {
  name: 'B',
  partNumber: 'C',
  quantity: 'D',
  level: 'E',
  parent: 'F',
}

export const USER_COLUMNS = {
  priority: 'G',
  owner: 'H',
}
export const VENDOR_COLUMNS = { vendor: 'I', vendorPartNumber: 'J', purchaseUrl: 'K', price: 'L', availability: 'M' }

// Hidden helper columns reserved for re-import diffing (Phase 4). The
// column letters are fixed now so Phase 4 doesn't need a layout
// migration, but Phase 2's importer leaves them blank — sourceKey needs
// itemSource (documentId/wvmType/partIdentity/etc.), which isn't fetched
// until the indented BOM call lands in Phase 3.
export const META_COLUMNS = {
  sourceKey: 'Z',
  contentHash: 'AA',
  listingId: 'AB',
  listingSnapshot: 'AC',
}

const HEADER_LABELS = {
  [ONSHAPE_COLUMNS.name]: 'Name',
  [ONSHAPE_COLUMNS.partNumber]: 'Part Number',
  [ONSHAPE_COLUMNS.quantity]: 'Quantity',
  [ONSHAPE_COLUMNS.level]: 'Level',
  [ONSHAPE_COLUMNS.parent]: 'Parent',
  [USER_COLUMNS.priority]: 'Priority',
  [USER_COLUMNS.owner]: 'Owner',
  [META_COLUMNS.sourceKey]: 'Source Key (hidden — do not edit)',
  [META_COLUMNS.contentHash]: 'Content Hash (hidden — do not edit)',
  [VENDOR_COLUMNS.vendor]: 'Vendor',
  [VENDOR_COLUMNS.vendorPartNumber]: 'Vendor Part Number',
  [VENDOR_COLUMNS.purchaseUrl]: 'Purchase URL',
  [VENDOR_COLUMNS.price]: 'Price',
  [VENDOR_COLUMNS.availability]: 'Availability',
  [META_COLUMNS.listingId]: 'Listing Id (hidden — do not edit)',
  [META_COLUMNS.listingSnapshot]: 'Listing Snapshot (hidden — do not edit)',
}

/** Column letter -> A1 column index (A=1) — used to build the header row. */
export function columnLetterToIndex(letter) {
  let index = 0
  for (const char of letter) {
    index = index * 26 + (char.charCodeAt(0) - 64)
  }
  return index
}

/**
 * Builds a single header row (array of strings, 1-indexed by column
 * letter) wide enough to cover every mapped column, Onshape-owned,
 * user-owned, and meta alike.
 */
export function buildHeaderRow() {
  const maxIndex = Math.max(...Object.keys(HEADER_LABELS).map(columnLetterToIndex))
  const row = new Array(maxIndex).fill('')
  for (const [letter, label] of Object.entries(HEADER_LABELS)) {
    row[columnLetterToIndex(letter) - 1] = label
  }
  return row
}
