export const DEFAULT_COLUMN_CONFIG = [
  { id: 'name', label: 'Name', source: 'onshape', field: 'name', type: 'text', editable: false },
  { id: 'partNumber', label: 'Part Number', source: 'onshape', field: 'partNumber', type: 'text', editable: false },
  { id: 'quantity', label: 'Quantity', source: 'onshape', field: 'quantity', type: 'number', editable: false },
  { id: 'level', label: 'Level', source: 'onshape', field: 'level', type: 'number', editable: false },
  { id: 'parent', label: 'Parent', source: 'onshape', field: 'parent', type: 'text', editable: false },
  { id: 'priority', label: 'Priority', source: 'user', type: 'dropdown', options: ['Low', 'Medium', 'High'], editable: true },
  { id: 'owner', label: 'Owner', source: 'user', type: 'dropdown', options: [], editable: true },
  { id: 'purchased', label: 'Purchased', source: 'user', type: 'checkbox', editable: true },
  { id: 'vendor', label: 'Vendor', source: 'vendor', field: 'vendor', type: 'text', editable: false },
  { id: 'vendorPartNumber', label: 'Vendor Part Number', source: 'vendor', field: 'vendorPartNumber', type: 'text', editable: false },
  { id: 'purchaseUrl', label: 'Purchase URL', source: 'vendor', field: 'purchaseUrl', type: 'url', editable: false },
  { id: 'price', label: 'Price', source: 'vendor', field: 'price', type: 'number', editable: false },
  { id: 'availability', label: 'Availability', source: 'vendor', field: 'availability', type: 'text', editable: false },
]

export function normalizeColumnConfig(input) {
  if (!Array.isArray(input) || !input.length) return DEFAULT_COLUMN_CONFIG
  const ids = new Set()
  return input.filter((column) => {
    if (!column?.id || ids.has(column.id)) return false
    ids.add(column.id)
    return ['onshape', 'user', 'vendor'].includes(column.source) && ['text', 'number', 'url', 'checkbox', 'dropdown'].includes(column.type)
  }).map((column) => ({ ...column, label: String(column.label || column.id), editable: column.source === 'user' }))
}
