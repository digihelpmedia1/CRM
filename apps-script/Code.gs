/**
 * Digi Help Media CRM — Team Cloud Sync backend (Google Apps Script)
 *
 * Setup:
 *  1. Create a blank Google Sheet (e.g. "DHM CRM Database"), keep it private.
 *  2. Extensions → Apps Script → paste this file → Save.
 *  3. Deploy → New deployment → type "Web app"
 *       Execute as: Me      Who has access: Anyone
 *  4. Copy the /exec URL into CRM → Integrations → Team Cloud Sync on every computer.
 *
 * After editing this code, use Deploy → Manage deployments → Edit → New version.
 */

const LEADS_SHEET = 'CRM_Leads';
const CONFIG_SHEET = 'CRM_Config';
const DELETED_SHEET = 'CRM_Deleted';
const LEAD_HEADERS = ['id', 'updatedAt', 'name', 'phone', 'status', 'assignedTo', 'source', 'platform', 'campaign', 'followUp', 'createdAt', 'json'];

function sheet_(name, headers) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sh = ss.getSheetByName(name);
  if (!sh) {
    sh = ss.insertSheet(name);
    if (headers) { sh.appendRow(headers); sh.setFrozenRows(1); }
  }
  return sh;
}

function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

function doGet(e) {
  try {
    const action = (e && e.parameter && e.parameter.action) || 'pull';
    if (action !== 'pull') return json_({ ok: false, error: 'Unknown action' });
    return json_({ ok: true, leads: readLeads_(), deleted: readDeleted_(), config: readConfig_() });
  } catch (err) {
    return json_({ ok: false, error: String(err) });
  }
}

function doPost(e) {
  const lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    const body = JSON.parse(e.postData.contents);
    if (body.action === 'upsertLeads') return json_({ ok: true, saved: upsertLeads_(body.leads || []) });
    if (body.action === 'deleteLeads') { deleteLeads_(body.ids || []); return json_({ ok: true }); }
    if (body.action === 'saveConfig') return json_({ ok: true, saved: saveConfig_(body.config) });
    return json_({ ok: false, error: 'Unknown action' });
  } catch (err) {
    return json_({ ok: false, error: String(err) });
  } finally {
    lock.releaseLock();
  }
}

function readLeads_() {
  const sh = sheet_(LEADS_SHEET, LEAD_HEADERS);
  const last = sh.getLastRow();
  if (last < 2) return [];
  const jsonCol = LEAD_HEADERS.indexOf('json') + 1;
  return sh.getRange(2, jsonCol, last - 1, 1).getValues()
    .map(r => { try { return JSON.parse(r[0]); } catch (e) { return null; } })
    .filter(Boolean);
}

function upsertLeads_(leads) {
  const sh = sheet_(LEADS_SHEET, LEAD_HEADERS);
  const last = sh.getLastRow();
  const ids = last >= 2 ? sh.getRange(2, 1, last - 1, 2).getValues() : [];
  const index = {};
  ids.forEach((r, i) => { index[r[0]] = { row: i + 2, updatedAt: r[1] }; });
  const appends = [];
  let saved = 0;
  leads.forEach(l => {
    if (!l || !l.id) return;
    const row = [l.id, l.updatedAt || '', l.name || '', l.phone || '', l.status || '', l.assignedTo || '',
      l.source || '', l.platform || '', l.campaign || '', l.followUp || '', l.createdAt || '', JSON.stringify(l)];
    const ex = index[l.id];
    if (ex) {
      // last-write-wins: ignore stale updates
      if (String(ex.updatedAt) && new Date(ex.updatedAt) > new Date(l.updatedAt)) return;
      sh.getRange(ex.row, 1, 1, row.length).setValues([row]);
    } else {
      appends.push(row);
      index[l.id] = { row: -1, updatedAt: l.updatedAt };
    }
    saved++;
  });
  if (appends.length) sh.getRange(sh.getLastRow() + 1, 1, appends.length, LEAD_HEADERS.length).setValues(appends);
  return saved;
}

function deleteLeads_(ids) {
  if (!ids.length) return;
  const set = {};
  ids.forEach(id => { set[id] = true; });
  const sh = sheet_(LEADS_SHEET, LEAD_HEADERS);
  const last = sh.getLastRow();
  if (last >= 2) {
    const col = sh.getRange(2, 1, last - 1, 1).getValues();
    for (let i = col.length - 1; i >= 0; i--) if (set[col[i][0]]) sh.deleteRow(i + 2);
  }
  const del = sheet_(DELETED_SHEET, ['id', 'deletedAt']);
  del.getRange(del.getLastRow() + 1, 1, ids.length, 2).setValues(ids.map(id => [id, new Date().toISOString()]));
}

function readDeleted_() {
  const sh = sheet_(DELETED_SHEET, ['id', 'deletedAt']);
  const last = sh.getLastRow();
  return last < 2 ? [] : sh.getRange(2, 1, last - 1, 1).getValues().map(r => r[0]);
}

function readConfig_() {
  const sh = sheet_(CONFIG_SHEET, ['key', 'value']);
  const v = sh.getRange('B2').getValue();
  try { return v ? JSON.parse(v) : null; } catch (e) { return null; }
}

function saveConfig_(config) {
  if (!config) return false;
  const current = readConfig_();
  if (current && current.updatedAt > config.updatedAt) return false;
  const sh = sheet_(CONFIG_SHEET, ['key', 'value']);
  sh.getRange('A2:B2').setValues([['config', JSON.stringify(config)]]);
  return true;
}
