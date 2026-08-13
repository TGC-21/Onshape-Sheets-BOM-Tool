// server/index.js — app entry point.
//
// Phase 0: server skeleton + /api/health.
// Phase 1: /api/onshape/documents and /api/onshape/elements.
//
// Later phases add /api/import (Phase 2/3), /api/sync (Phase 4), and the
// Apps Script integration (Phase 5) calls straight into these routes.

import 'dotenv/config'
import { Hono } from 'hono'
import { serve } from '@hono/node-server'

import health from './routes/health.js'
import onshapeLookup from './routes/onshape-lookup.js'
import importRoute from './routes/import.js'
import syncRoute from './routes/sync.js'
import catalogRoute from './routes/catalog.js'

const app = new Hono()

app.use('/api/*', async (c, next) => {
  const expected = process.env.BACKEND_API_TOKEN
  if (expected && c.req.header('Authorization') !== `Bearer ${expected}`) return c.json({ error: 'Unauthorized' }, 401)
  await next()
})

app.get('/', (c) => c.text('onshape-bom-sheets backend is running'))
app.route('/api/health', health)
app.route('/api/onshape', onshapeLookup)
app.route('/api/import', importRoute)
app.route('/api/sync', syncRoute)
app.route('/api/catalog', catalogRoute)

const port = parseInt(process.env.PORT, 10) || 8787

serve({ fetch: app.fetch, port }, (info) => {
  console.log(`[server] listening on http://localhost:${info.port}`)
})
