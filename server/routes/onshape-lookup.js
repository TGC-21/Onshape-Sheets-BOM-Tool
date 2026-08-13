// server/routes/onshape-lookup.js
//
// Phase 1: document + assembly picker endpoints. This is exactly what the
// Apps Script sidebar (Phase 5) will call to let a user search for a
// document and pick an assembly element inside it, without ever leaving
// the spreadsheet.
//
// GET /api/onshape/documents?q=...&limit=...
// GET /api/onshape/elements?documentId=...&workspaceId=...
//
// Ported from an earlier project's onshape-lookup.js. The bom-preview
// branch from that file is intentionally left out here — BOM parsing is
// Phase 2 (flat import) and Phase 3 (subassembly recursion), not Phase 1.

import { Hono } from 'hono'
import { onshapeGet } from '../lib/onshape.js'

const onshapeLookup = new Hono()

onshapeLookup.get('/documents', async (c) => {
  const q = (c.req.query('q') || '').trim()
  const limit = Math.min(parseInt(c.req.query('limit'), 10) || 20, 20)
  try {
    const params = new URLSearchParams({
      limit: String(limit),
      sortColumn: 'modifiedAt',
      sortOrder: 'desc',
    })
    if (q) params.set('q', q)

    const data = await onshapeGet(`/documents?${params.toString()}`)
    const documents = (data.items ?? [])
      .map((doc) => ({
        id: doc.id,
        name: doc.name,
        modifiedAt: doc.modifiedAt,
        thumbnailUrl: doc.thumbnail?.href ?? null,
        workspaceId: doc.defaultWorkspace?.id ?? null,
        owner: doc.owner?.name ?? null,
      }))
      // A document with no default workspace isn't usable for the BOM
      // endpoint's 'w' branch downstream — drop it here rather than
      // making the frontend/Apps Script side re-check this.
      .filter((d) => d.workspaceId)

    return c.json({ documents, query: q || null })
  } catch (err) {
    console.error('[onshape-lookup:documents]', err)
    return c.json({ error: err.message ?? 'Internal server error' }, 500)
  }
})

onshapeLookup.get('/elements', async (c) => {
  const documentId = c.req.query('documentId')
  const workspaceId = c.req.query('workspaceId')
  if (!documentId || !workspaceId) {
    return c.json({ error: 'documentId and workspaceId query params are required' }, 400)
  }

  try {
    const elements = await onshapeGet(`/documents/d/${documentId}/w/${workspaceId}/elements`)
    const assemblies = (elements ?? [])
      .filter((el) => el.elementType === 'ASSEMBLY')
      .map((el) => ({ id: el.id, name: el.name, documentId, workspaceId }))

    return c.json({ assemblies, count: assemblies.length })
  } catch (err) {
    console.error('[onshape-lookup:elements]', err)
    if (/Onshape API 404/.test(err.message)) {
      return c.json({ error: 'Document or workspace not found — it may have been deleted or moved.' }, 404)
    }
    return c.json({ error: err.message ?? 'Internal server error' }, 500)
  }
})

export default onshapeLookup
