// server/routes/health.js
//
// Phase 0 connectivity proof. Two independent checks:
//   - Onshape: confirms the key pair is valid (GET /users/session).
//   - Google Sheets: confirms the service account credentials load AND
//     (if a spreadsheetId is passed) that a specific sheet has been
//     shared with it.
//
// GET /api/health                          — checks Onshape auth + that
//                                             service account creds load
// GET /api/health?spreadsheetId=<id>        — also verifies access to a
//                                             specific spreadsheet

import { Hono } from 'hono'
import { checkOnshapeAuth } from '../lib/onshape.js'
import { checkSheetAccess, getServiceAccountEmail } from '../lib/sheets.js'

const health = new Hono()

health.get('/', async (c) => {
  const result = { ok: true, onshape: null, sheets: null }

  try {
    result.onshape = { ok: true, ...(await checkOnshapeAuth()) }
  } catch (err) {
    result.ok = false
    result.onshape = { ok: false, error: err.message }
  }

  try {
    const serviceAccountEmail = getServiceAccountEmail()
    const spreadsheetId = c.req.query('spreadsheetId')
    let sheetAccess = null
    if (spreadsheetId) {
      sheetAccess = await checkSheetAccess(spreadsheetId)
    }
    result.sheets = { ok: true, serviceAccountEmail, sheetAccess }
  } catch (err) {
    result.ok = false
    result.sheets = { ok: false, error: err.message }
  }

  return c.json(result, result.ok ? 200 : 500)
})

export default health
