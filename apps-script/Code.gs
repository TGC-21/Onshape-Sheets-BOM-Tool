// Set this once when deploying the container-bound script.
const BACKEND_URL = 'https://YOUR-BOM-BACKEND.example.com';

function onOpen() {
  SpreadsheetApp.getUi().createMenu('Onshape BOM')
    .addItem('Import…', 'showImportSidebar').addItem('Manage vendor listings', 'showVendorCatalog').addItem('Sync now', 'syncNow')
    .addToUi();
}
function showImportSidebar() { SpreadsheetApp.getUi().showSidebar(HtmlService.createHtmlOutputFromFile('sidebar').setTitle('Onshape BOM Import')); }
function showVendorCatalog() { SpreadsheetApp.getUi().showSidebar(HtmlService.createHtmlOutputFromFile('vendor-catalog').setTitle('Vendor Listings')); }
function getConfiguration() { return { spreadsheetId: SpreadsheetApp.getActive().getId(), sheetName: SpreadsheetApp.getActiveSheet().getName() }; }
function backendRequest_(method, path, body) {
  const base = BACKEND_URL;
  if (base.indexOf('YOUR-BOM-BACKEND') !== -1) throw new Error('Set BACKEND_URL in apps-script/Code.gs before using the menu.');
  const options = { method: method, muteHttpExceptions: true, headers: { Accept: 'application/json' } };
  if (body !== undefined) { options.contentType = 'application/json'; options.payload = JSON.stringify(body); }
  const response = UrlFetchApp.fetch(base.replace(/\/$/, '') + path, options); let result;
  try { result = JSON.parse(response.getContentText()); } catch (_) { result = {}; }
  if (response.getResponseCode() < 200 || response.getResponseCode() >= 300) throw new Error(result.error || ('Backend request failed (' + response.getResponseCode() + ').'));
  return result;
}
function searchDocuments(query, limit) { return backendRequest_('get', '/api/onshape/documents?q=' + encodeURIComponent(query || '') + '&limit=' + (limit || 25)); }
function listAssemblies(documentId, workspaceId) { return backendRequest_('get', '/api/onshape/elements?documentId=' + encodeURIComponent(documentId) + '&workspaceId=' + encodeURIComponent(workspaceId)); }
function getVendorCatalog() { return backendRequest_('get', '/api/catalog'); }
function saveVendorPart(part) { return backendRequest_('post', '/api/catalog', part); }
function importVendorCsv(rows) { return backendRequest_('post', '/api/catalog/csv', { rows: rows }); }
function importBom(selection) { const c = getConfiguration(); return backendRequest_('post', '/api/import', { documentId: selection.documentId, workspaceId: selection.workspaceId, elementId: selection.elementId, spreadsheetId: c.spreadsheetId, sheetName: selection.sheetName || c.sheetName }); }
function syncNow() {
  const c = getConfiguration();
  try { const r = backendRequest_('post', '/api/sync', { spreadsheetId: c.spreadsheetId, sheetName: c.sheetName }); SpreadsheetApp.getActive().toast('Sync complete: ' + (r.rowsUpdated || 0) + ' updated, ' + (r.rowsInserted || 0) + ' inserted, ' + (r.rowsDeleted || 0) + ' deleted.', 'Onshape BOM', 8); return r; }
  catch (e) { SpreadsheetApp.getUi().alert('Onshape BOM sync failed', e.message, SpreadsheetApp.getUi().ButtonSet.OK); throw e; }
}
