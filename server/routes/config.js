import { Hono } from 'hono'
import { invalidateColumnLayoutCache } from '../lib/sheets.js'
const config = new Hono()
config.post('/invalidate', async (c) => {
  const { spreadsheetId } = await c.req.json().catch(() => ({}))
  if (!spreadsheetId) return c.json({ error: 'Missing spreadsheetId' }, 400)
  invalidateColumnLayoutCache(spreadsheetId)
  return c.json({ ok: true })
})
export default config