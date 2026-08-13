// server/routes/format.js
//
// POST /api/format — reapplies the standard BOM tab formatting (header
// style, banding, borders, hidden meta columns, number formats) without
// touching any cell values. Used by the "Format sheet" menu command.
//
// body: { spreadsheetId, sheetName? }

import { Hono } from 'hono'
import { formatBomSheet } from '../lib/sheets.js'

const format = new Hono()

format.post('/', async (c) => {
  let body
  try { body = await c.req.json() } catch { return c.json({ error: 'Request body must be JSON.' }, 400) }
  const { spreadsheetId, sheetName } = body ?? {}
  if (!spreadsheetId) return c.json({ error: 'Missing required field(s): spreadsheetId' }, 400)
  try {
    const result = await formatBomSheet(spreadsheetId, { sheetName: sheetName || undefined })
    return c.json({ ok: true, ...result })
  } catch (err) {
    console.error('[format]', err)
    return c.json({ error: err.message ?? 'Internal server error' }, /404/.test(err.message) ? 404 : 500)
  }
})

export default format
s