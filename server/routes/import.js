// server/routes/import.js
//
// Phase 2 added the flat import. Phase 3 adds subassembly recursion —
// this route now always walks the full hierarchy (buildHierarchyRows)
// and writes Level/Parent columns + row grouping via writeHierarchyBom.
// Still no diffing against a previous import (Phase 4) — every call
// wipes the target sheet tab and rewrites it from scratch.
//
// POST /api/import
// body: { documentId, workspaceId, elementId, spreadsheetId, sheetName? }

import { Hono } from 'hono'
import { buildHierarchyRows } from '../lib/onshape.js'
import { writeHierarchyBom } from '../lib/sheets.js'
import { annotateWithSourceKeys } from '../lib/rowIdentity.js'
import { saveAssemblyRef } from '../lib/registry.js'
import { attachVendorSnapshots } from '../lib/catalogRows.js'

const importRoute = new Hono()

importRoute.post('/', async (c) => {
  let body
  try {
    body = await c.req.json()
  } catch {
    return c.json({ error: 'Request body must be JSON.' }, 400)
  }

  const { documentId, workspaceId, elementId, spreadsheetId, sheetName } = body ?? {}
  const missing = ['documentId', 'workspaceId', 'elementId', 'spreadsheetId']
    .filter((key) => !body?.[key])
  if (missing.length) {
    return c.json({ error: `Missing required field(s): ${missing.join(', ')}` }, 400)
  }

  try {
    const rows = await buildHierarchyRows(documentId, workspaceId, elementId)

    if (rows.length === 0) {
      return c.json({
        warning: "This assembly's BOM has no usable rows. Open the BOM tab in Onshape to trigger generation, then try again.",
        rowsWritten: 0,
      })
    }

    // Vendor snapshot is attached BEFORE the source-key/content-hash pass
    // so contentHash covers vendor fields too — otherwise a price change
    // alone wouldn't mark a row as changed on the next sync.
    const rowsWithVendor = await attachVendorSnapshots(rows)
    const annotatedRows = annotateWithSourceKeys(rowsWithVendor)
    const writeResult = await writeHierarchyBom(spreadsheetId, annotatedRows, { sheetName })
    await saveAssemblyRef(spreadsheetId, writeResult.sheetName, { documentId, workspaceId, elementId })
    const subassemblyCount = rows.filter((r) => r.isSubassembly).length

    return c.json({
      ok: true,
      partsFound: rows.length,
      subassembliesFound: subassemblyCount,
      ...writeResult,
    })
  } catch (err) {
    console.error('[import]', err)
    if (/Onshape API 404/.test(err.message)) {
      return c.json({ error: 'Assembly not found in Onshape — check the document/workspace/element ids.' }, 404)
    }
    if (/404/.test(err.message)) {
      return c.json({ error: err.message }, 404)
    }
    return c.json({ error: err.message ?? 'Internal server error' }, 500)
  }
})

export default importRoute
