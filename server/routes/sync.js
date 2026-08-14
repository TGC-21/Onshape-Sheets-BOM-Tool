import { Hono } from 'hono'
import { buildHierarchyRows } from '../lib/onshape.js'
import { annotateWithSourceKeys } from '../lib/rowIdentity.js'
import { getAssemblyRef } from '../lib/registry.js'
import { syncHierarchyBom } from '../lib/sheets.js'
import { attachVendorSnapshots } from '../lib/catalogRows.js'

const sync = new Hono()

sync.post('/', async (c) => {
  let body
  try { body = await c.req.json() } catch { return c.json({ error: 'Request body must be JSON.' }, 400) }
  const { spreadsheetId, sheetName } = body ?? {}
  if (!spreadsheetId) return c.json({ error: 'Missing required field(s): spreadsheetId' }, 400)
  try {
    const ref = await getAssemblyRef(spreadsheetId, sheetName || '')
    if (!ref) return c.json({ error: 'No assembly is registered for this spreadsheet and tab. Run /api/import first.' }, 404)
    // Same ordering as /api/import: vendor snapshot attached before the
    // content hash is computed, so vendor-only changes still count as a
    // row change on sync.
    const builtRows = await buildHierarchyRows(ref.documentId, ref.workspaceId, ref.elementId)
    const rows = annotateWithSourceKeys(await attachVendorSnapshots(builtRows))
    const result = await syncHierarchyBom(spreadsheetId, rows, { sheetName: sheetName || undefined })
    return c.json({ ok: true, ...result })
  } catch (err) {
    console.error('[sync]', err)
    return c.json({ error: err.message ?? 'Internal server error' }, /404/.test(err.message) ? 404 : 500)
  }
})

export default sync
