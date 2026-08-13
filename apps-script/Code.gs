// Set this once when deploying the container-bound script.
const BACKEND_URL = 'https://YOUR-BOM-BACKEND.example.com';
const BACKEND_API_TOKEN = 'YOUR-BOM-BACKEND-TOKEN';
// hello
function onOpen() {
  SpreadsheetApp.getUi().createMenu('Onshape BOM')
    .addItem('Import…', 'showImportSidebar').addItem('Manage vendor listings', 'showVendorCatalog').addItem('Configure columns…', 'showColumnConfig').addItem('Sync now', 'syncNow').addItem('Format sheet', 'formatSheetNow')
    .addToUi();
  // Re-apply validation when a configured spreadsheet is reopened.
  try { applyColumnValidation_(); } catch (_) {}
}
function showImportSidebar() { SpreadsheetApp.getUi().showSidebar(HtmlService.createHtmlOutputFromFile('sidebar').setTitle('Onshape BOM Import')); }
function showVendorCatalog() { SpreadsheetApp.getUi().showSidebar(HtmlService.createHtmlOutputFromFile('vendor-catalog').setTitle('Vendor Listings')); }
function showColumnConfig() { SpreadsheetApp.getUi().showSidebar(HtmlService.createHtmlOutputFromFile('column-config').setTitle('Configure BOM Columns')); }
function installTriggers() { ScriptApp.getProjectTriggers().filter(t => t.getHandlerFunction() === 'handleVendorSelectionEdit').forEach(t => ScriptApp.deleteTrigger(t)); ScriptApp.newTrigger('handleVendorSelectionEdit').forSpreadsheet(SpreadsheetApp.getActive()).onEdit().create(); }
function defaultColumnConfig_() { return [{id:'name',label:'Name',source:'onshape',type:'text',editable:false},{id:'partNumber',label:'Part Number',source:'onshape',type:'text',editable:false},{id:'quantity',label:'Quantity',source:'onshape',type:'number',editable:false},{id:'level',label:'Level',source:'onshape',type:'number',editable:false},{id:'parent',label:'Parent',source:'onshape',type:'text',editable:false},{id:'priority',label:'Priority',source:'user',type:'dropdown',options:['Low','Medium','High'],editable:true},{id:'owner',label:'Owner',source:'user',type:'dropdown',options:[],editable:true},{id:'purchased',label:'Purchased',source:'user',type:'checkbox',editable:true},{id:'inInventory',label:'In Inventory?',source:'user',type:'checkbox',editable:true},{id:'vendor',label:'Vendor',source:'vendor',type:'text',editable:false},{id:'vendorPartNumber',label:'Vendor Part Number',source:'vendor',type:'text',editable:false},{id:'purchaseUrl',label:'Purchase URL',source:'vendor',type:'url',editable:false},{id:'price',label:'Price',source:'vendor',type:'number',editable:false},{id:'availability',label:'Availability',source:'vendor',type:'text',editable:false}]; }
function configSheet_() { const ss=SpreadsheetApp.getActive(); let sheet=ss.getSheetByName('Config'); if(!sheet) { sheet=ss.insertSheet('Config'); sheet.hideSheet(); } return sheet; }
function getColumnConfig() { const sheet=configSheet_(); const value=sheet.getRange('A1').getValue(); return value ? JSON.parse(value) : defaultColumnConfig_(); }
function saveColumnConfig(config) { config=config||defaultColumnConfig_(); configSheet_().getRange('A1').setValue(JSON.stringify(config)); applyColumnOrder_(config); applyColumnValidation_(); return true; }
function applyColumnOrder_(config) { const sheet=SpreadsheetApp.getActiveSheet(); const active=config.filter(c=>c.enabled!==false); const max=Math.max(sheet.getLastColumn(), active.length+1); for(let i=0;i<active.length;i++){const wanted=active[i].label;const headers=sheet.getRange(1,1,1,max).getValues()[0];const current=headers.indexOf(wanted)+1;const target=i+2;if(current>0&&current!==target)sheet.moveColumns(sheet.getRange(1,current,sheet.getMaxRows(),1),target);} }
function applyColumnValidation_() {
  const sheet = SpreadsheetApp.getActiveSheet();
  const config = getColumnConfig();
  const rowCount = Math.max(sheet.getMaxRows() - 1, 1);
  let displayIndex = 0;
  config.forEach((column) => {
    if (column.enabled === false) return;
    const columnIndex = displayIndex++;
    if (column.source !== 'user') return;
    const range = sheet.getRange(2, columnIndex + 2, rowCount, 1);
    // Clear an older rule first, but do not change any cell values.
    range.setDataValidation(null);
    if (column.type === 'checkbox') {
      range.setDataValidation(SpreadsheetApp.newDataValidation().requireCheckbox().setAllowInvalid(false).build());
    } else if (column.type === 'dropdown' && column.options && column.options.length) {
      range.setDataValidation(SpreadsheetApp.newDataValidation().requireValueInList(column.options, true).setAllowInvalid(false).build());
    }
  });
}
function getConfiguration() { return { spreadsheetId: SpreadsheetApp.getActive().getId(), sheetName: SpreadsheetApp.getActiveSheet().getName() }; }
function backendRequest_(method, path, body) {
  const base = BACKEND_URL;
  if (base.indexOf('YOUR-BOM-BACKEND') !== -1) throw new Error('Set BACKEND_URL in apps-script/Code.gs before using the menu.');
  const options = { method: method, muteHttpExceptions: true, headers: { Accept: 'application/json', Authorization: 'Bearer ' + BACKEND_API_TOKEN } };
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
function getVendorMatches(partNumber) { return backendRequest_('get', '/api/catalog/matches?partNumber=' + encodeURIComponent(partNumber || '')); }
function getVendorMatchesBatch(partNumbers) { return backendRequest_('post', '/api/catalog/matches', { partNumbers: partNumbers }); }
function headerColumn_(sheet, label, fallback) { const headers=sheet.getRange(1,1,1,Math.max(sheet.getLastColumn(),1)).getValues()[0]; const i=headers.indexOf(label); return i >= 0 ? i + 1 : fallback; }
function vendorLabel_(v) { return String(v.vendorName||'') + ' — ' + String(v.vendorPartNumber||''); }
function applyVendorDropdowns_() { const sheet=SpreadsheetApp.getActiveSheet(); const pnCol=headerColumn_(sheet,'Part Number',3), vendorCol=headerColumn_(sheet,'Vendor',9), rows=Math.max(sheet.getLastRow()-1,0); if(!rows)return; const pns=sheet.getRange(2,pnCol,rows,1).getValues().map(r=>String(r[0]||'')); const matches=getVendorMatchesBatch([...new Set(pns.filter(Boolean))]).matches||{}; pns.forEach((pn,i)=>{const labels=(matches[pn.trim().toUpperCase().replace(/\s+/g,' ')]||[]).map(vendorLabel_),cell=sheet.getRange(i+2,vendorCol);if(labels.length)cell.setDataValidation(SpreadsheetApp.newDataValidation().requireValueInList(labels,true).setAllowInvalid(false).build());else cell.clearDataValidations()}) }
function handleVendorSelectionEdit(e) { if(!e||!e.range||e.range.getRow()<2)return; const sheet=e.range.getSheet(),row=e.range.getRow(),vendorCol=headerColumn_(sheet,'Vendor',9),inventoryCol=headerColumn_(sheet,'In Inventory?',0);if(inventoryCol&&e.range.getColumn()===inventoryCol){const hidden=['Vendor','Vendor Part Number','Purchase URL','Price','Availability'];hidden.forEach(label=>{const col=headerColumn_(sheet,label,0);if(col)sheet.getRange(row,col).setFontColor(e.value==='TRUE'?'#999999':null)});return}if(e.range.getColumn()!==vendorCol)return;const pn=sheet.getRange(row,headerColumn_(sheet,'Part Number',3)).getValue();try{const selected=(getVendorMatches(pn).listings||[]).find(v=>vendorLabel_(v)===String(e.value||''));if(!selected)return;const set=(label,value)=>{const col=headerColumn_(sheet,label,0);if(col)sheet.getRange(row,col).setValue(value==null?'':value)};set('Vendor Part Number',selected.vendorPartNumber);set('Purchase URL',selected.purchaseUrl);set('Price',selected.latestPrice);set('Availability',selected.availability);const id=headerColumn_(sheet,'Listing Id (hidden — do not edit)',28),snap=headerColumn_(sheet,'Listing Snapshot (hidden — do not edit)',29);sheet.getRange(row,id).setValue(selected.id);sheet.getRange(row,snap).setValue(JSON.stringify(selected))}catch(_) {}}
function importBom(selection) {
  const c = getConfiguration();
  const result = backendRequest_('post', '/api/import', { documentId: selection.documentId, workspaceId: selection.workspaceId, elementId: selection.elementId, spreadsheetId: c.spreadsheetId, sheetName: selection.sheetName || c.sheetName });
  applyColumnValidation_();
  applyVendorDropdowns_();
  return result;
}
function formatSheetNow() {
  const c = getConfiguration();
  try { backendRequest_('post', '/api/format', { spreadsheetId: c.spreadsheetId, sheetName: c.sheetName }); SpreadsheetApp.getActive().toast('Formatting reapplied.', 'Onshape BOM', 5); }
  catch (e) { SpreadsheetApp.getUi().alert('Onshape BOM formatting failed', e.message, SpreadsheetApp.getUi().ButtonSet.OK); throw e; }
}
function syncNow() {
  const c = getConfiguration();
  try { const r = backendRequest_('post', '/api/sync', { spreadsheetId: c.spreadsheetId, sheetName: c.sheetName }); applyColumnValidation_(); applyVendorDropdowns_(); SpreadsheetApp.getActive().toast('Sync complete: ' + (r.rowsUpdated || 0) + ' updated, ' + (r.rowsInserted || 0) + ' inserted, ' + (r.rowsDeleted || 0) + ' deleted.', 'Onshape BOM', 8); return r; }
  catch (e) { SpreadsheetApp.getUi().alert('Onshape BOM sync failed', e.message, SpreadsheetApp.getUi().ButtonSet.OK); throw e; }
}
