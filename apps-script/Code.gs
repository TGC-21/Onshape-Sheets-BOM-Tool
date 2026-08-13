// Set this once when deploying the container-bound script.
const BACKEND_URL = 'https://YOUR-BOM-BACKEND.example.com';

function onOpen() {
  SpreadsheetApp.getUi().createMenu('Onshape BOM')
    .addItem('Import…', 'showImportSidebar').addItem('Manage vendor listings', 'showVendorCatalog').addItem('Configure columns…', 'showColumnConfig').addItem('Sync now', 'syncNow')
    .addToUi();
}
function showImportSidebar() { SpreadsheetApp.getUi().showSidebar(HtmlService.createHtmlOutputFromFile('sidebar').setTitle('Onshape BOM Import')); }
function showVendorCatalog() { SpreadsheetApp.getUi().showSidebar(HtmlService.createHtmlOutputFromFile('vendor-catalog').setTitle('Vendor Listings')); }
function showColumnConfig() { SpreadsheetApp.getUi().showSidebar(HtmlService.createHtmlOutputFromFile('column-config').setTitle('Configure BOM Columns')); }
function defaultColumnConfig_() { return [{id:'name',label:'Name',source:'onshape',type:'text',editable:false},{id:'partNumber',label:'Part Number',source:'onshape',type:'text',editable:false},{id:'quantity',label:'Quantity',source:'onshape',type:'number',editable:false},{id:'level',label:'Level',source:'onshape',type:'number',editable:false},{id:'parent',label:'Parent',source:'onshape',type:'text',editable:false},{id:'priority',label:'Priority',source:'user',type:'dropdown',options:['Low','Medium','High'],editable:true},{id:'owner',label:'Owner',source:'user',type:'dropdown',options:[],editable:true},{id:'purchased',label:'Purchased',source:'user',type:'checkbox',editable:true},{id:'vendor',label:'Vendor',source:'vendor',type:'text',editable:false},{id:'vendorPartNumber',label:'Vendor Part Number',source:'vendor',type:'text',editable:false},{id:'purchaseUrl',label:'Purchase URL',source:'vendor',type:'url',editable:false},{id:'price',label:'Price',source:'vendor',type:'number',editable:false},{id:'availability',label:'Availability',source:'vendor',type:'text',editable:false}]; }
function configSheet_() { const ss=SpreadsheetApp.getActive(); let sheet=ss.getSheetByName('Config'); if(!sheet) { sheet=ss.insertSheet('Config'); sheet.hideSheet(); } return sheet; }
function getColumnConfig() { const sheet=configSheet_(); const value=sheet.getRange('A1').getValue(); return value ? JSON.parse(value) : defaultColumnConfig_(); }
function saveColumnConfig(config) { config=config||defaultColumnConfig_(); configSheet_().getRange('A1').setValue(JSON.stringify(config)); applyColumnOrder_(config); applyColumnValidation_(); return true; }
function applyColumnOrder_(config) { const sheet=SpreadsheetApp.getActiveSheet(); const max=Math.max(sheet.getLastColumn(), config.length+1); for(let i=0;i<config.length;i++){const wanted=config[i].label;const headers=sheet.getRange(1,1,1,max).getValues()[0];const current=headers.indexOf(wanted)+1;const target=i+2;if(current>0&&current!==target)sheet.moveColumns(sheet.getRange(1,current,sheet.getMaxRows(),1),target);} }
function applyColumnValidation_() {
  const sheet = SpreadsheetApp.getActiveSheet();
  const config = getColumnConfig();
  config.forEach((column, index) => {
    if (column.source !== 'user') return;
    const range = sheet.getRange(2, index + 2, Math.max(sheet.getMaxRows() - 1, 1), 1);
    if (column.type === 'checkbox') range.insertCheckboxes();
    if (column.type === 'dropdown' && column.options && column.options.length) range.setDataValidation(SpreadsheetApp.newDataValidation().requireValueInList(column.options, true).setAllowInvalid(false).build());
  });
}
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
function searchDocuments(query, limit, scope) { return backendRequest_('get', '/api/onshape/documents?q=' + encodeURIComponent(query || '') + '&limit=' + (limit || 25) + '&scope=' + encodeURIComponent(scope || 'owned')); }
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
