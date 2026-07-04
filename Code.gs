// ====================================================================
// FbSuitesV2 Backend — Google Apps Script v10.0.1
// TM_Config revised: panel-multi-row + config-row with dropdowns
// ====================================================================

const VERSION = 'v10.0.1';

// ─────────── SHEET NAMES ───────────
const SH = {
  INBOX: 'Inbox',
  VIRAL: 'Viral_History',
  CFG:   'TM_Config',
  TOP:   'Top_Comment_History',
  ARC:   'Top_Comment_Archive'
};

const HEADERS = {
  [SH.INBOX]: ['URL Normalized', 'Status', 'Order ID', 'SMM Panel', 'Akun FB', 'Note', 'Submitted At', 'Last Check Time'],
  [SH.VIRAL]: ['Timestamp', 'URL POST', 'Targeting Status', 'Targeting Attempts', 'Targeting Order ID', 'Targeting Comment URLs', 'Targeting Last Run'],
  [SH.CFG]:   ['Type', 'Enabled', 'Value', 'Provider', 'API ID', 'API Key', 'Secret Key', 'Services', 'Like Quantity'],
  [SH.TOP]:   ['Timestamp', 'URL Post', 'Position', 'Author', 'Comment Text', 'Reactions', 'Replies', 'Comment ID'],
  [SH.ARC]:   ['Archived At', 'Original Timestamp', 'URL Post', 'Position', 'Author', 'Comment Text', 'Reactions', 'Replies', 'Comment ID']
};

const COL_INBOX = { URL: 0, STATUS: 1, ORDER_ID: 2, PANEL: 3, AKUN: 4, NOTE: 5, SUBMITTED: 6, LAST_CHECK: 7 };
const COL_VIRAL = { TIMESTAMP: 0, URL: 1, TG_STATUS: 2, TG_ATTEMPTS: 3, TG_ORDER_ID: 4, TG_COMMENT_URLS: 5, TG_LAST_RUN: 6 };
const COL_CFG   = { TYPE: 0, ENABLED: 1, VALUE: 2, PROVIDER: 3, API_ID: 4, API_KEY: 5, SECRET_KEY: 6, SERVICES: 7, LIKE_QTY: 8 };

// ─────────── ALLOWED VALUES ───────────
const TYPE_OPTIONS = [
  'smm_panel_comment',
  'smm_panel_like',
  'komentar',
  'skip_keywords',
  'advertiser_exclude',
  'own_comment_list',
  'smm_priority',
  'target_urls_per_call',
  'inbox_api_batch_limit',
  'dedup_ttl_days',
  'viral_ttl_days'
];
const ENABLED_OPTIONS = ['TRUE', 'FALSE'];
const PANEL_TYPES = ['smm_panel_comment', 'smm_panel_like'];

// ─────────── ROUTER ───────────

function doPost(e) {
  try {
    const payload = JSON.parse(e.postData.contents || '{}');
    const action = String(payload.action || '').toLowerCase();
    return routeAction(action, payload);
  } catch (err) {
    return jsonOut({ ok: false, error: 'BAD_JSON: ' + err.message });
  }
}

function doGet(e) {
  const params = e.parameter || {};
  const action = String(params.action || '').toLowerCase();
  if (!action) return jsonOut({ ok: true, message: 'FbSuitesV2 Backend ' + VERSION, time: nowIso() });
  return routeAction(action, params);
}

function routeAction(action, payload) {
  switch (action) {
    case 'setup_all_sheets':       return handleSetupAllSheets(payload);
    case 'get_scraper_config':     return handleGetScraperConfig(payload);
    case 'submit':                 return handleSubmit(payload);
    case 'submit_viral':           return handleSubmitViral(payload);
    case 'update_status':          return handleUpdateStatus(payload);
    case 'getstatuscheckjobs':     return handleGetStatusCheckJobs(payload);
    case 'batchupdateinbox':       return handleBatchUpdateInbox(payload);
    case 'gettargetingconfig':     return handleGetTargetingConfig(payload);
    case 'gettargetingjobs':       return handleGetTargetingJobs(payload);
    case 'batchupdatetargeting':   return handleBatchUpdateTargeting(payload);
    case 'gettopcommentjobs':      return handleGetTopCommentJobs(payload);
    case 'appendtopcomments':      return handleAppendTopComments(payload);
    case 'archivetopcomments':     return handleArchiveTopComments(payload);
    case 'cleanupolddata':         return handleCleanupOldData(payload);
    case 'install_status_trigger': return jsonOut(installStatusCheckerTrigger());
    default:                       return jsonOut({ ok: false, error: 'UNKNOWN_ACTION: ' + action });
  }
}

// ─────────── UTILITIES ───────────

function jsonOut(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

function nowIso() { return new Date().toISOString(); }

function withLock(fn) {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(30000)) throw new Error('LOCK_TIMEOUT');
  try { return fn(); } finally { lock.releaseLock(); }
}

function normalizeUrl(url) {
  if (!url) return '';
  try {
    let u = String(url).trim().replace(/^["']+|["']+$/g, '');
    if (!/^https?:\/\//i.test(u)) u = 'https://' + u.replace(/^\/+/, '');
    const urlObj = new URL(u);
    urlObj.hostname = 'www.facebook.com';
    urlObj.protocol = 'https:';
    const strip = ['__cft__', '__tn__', '_rdc', '_rdr', 'notif_id', 'notif_t', 'ref', 'fref', 'source', 'sfnsn', 'mibextid', '__xts__'];
    strip.forEach(p => {
      const keys = [];
      urlObj.searchParams.forEach((v, k) => { if (k === p || k.startsWith(p + '[')) keys.push(k); });
      keys.forEach(k => urlObj.searchParams.delete(k));
    });
    return urlObj.toString().replace(/\/$/, '');
  } catch (e) { return String(url).trim(); }
}

function isEnabledTrue(val) {
  const s = String(val || '').trim().toUpperCase();
  return s === 'TRUE' || s === 'YES' || s === 'Y' || s === '1';
}

function splitCsv(s) {
  return String(s || '').split(/[,\n]/).map(x => x.trim()).filter(Boolean);
}

// ─────────── SHEET HELPERS ───────────

function getSheet(name, createIfMissing) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sh = ss.getSheetByName(name);
  if (!sh && createIfMissing) {
    sh = ss.insertSheet(name);
    if (HEADERS[name]) {
      sh.getRange(1, 1, 1, HEADERS[name].length).setValues([HEADERS[name]]);
      sh.getRange(1, 1, 1, HEADERS[name].length).setFontWeight('bold').setBackground('#f0f0f0');
      sh.setFrozenRows(1);
    }
    if (name === SH.CFG) applyTmConfigValidation(sh);
  }
  return sh;
}

function applyTmConfigValidation(sh) {
  const maxRow = 500;

  // Kolom A (Type) — dropdown
  const typeRule = SpreadsheetApp.newDataValidation()
    .requireValueInList(TYPE_OPTIONS, true)
    .setAllowInvalid(false)
    .build();
  sh.getRange(2, COL_CFG.TYPE + 1, maxRow - 1, 1).setDataValidation(typeRule);

  // Kolom B (Enabled) — dropdown
  const enabledRule = SpreadsheetApp.newDataValidation()
    .requireValueInList(ENABLED_OPTIONS, true)
    .setAllowInvalid(false)
    .build();
  sh.getRange(2, COL_CFG.ENABLED + 1, maxRow - 1, 1).setDataValidation(enabledRule);
}

function findRowByColumn(sheet, colIndex1Based, needle) {
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) return -1;
  const values = sheet.getRange(2, colIndex1Based, lastRow - 1, 1).getValues();
  for (let i = 0; i < values.length; i++) {
    if (String(values[i][0]) === String(needle)) return i + 2;
  }
  return -1;
}

// ─────────── TM CONFIG LOADER ───────────

function loadTmConfig() {
  const sh = getSheet(SH.CFG, false);
  const result = {
    komentar: [],
    skip_keywords: [],
    advertiser_exclude: [],
    own_comment_list: [],
    smm_priority: [],
    target_urls_per_call: 20,
    inbox_api_batch_limit: 20,
    dedup_ttl_days: 30,
    viral_ttl_days: 60,
    smm_panel_comment: [],
    smm_panel_like: []
  };
  if (!sh || sh.getLastRow() < 2) return result;

  const rows = sh.getRange(2, 1, sh.getLastRow() - 1, HEADERS[SH.CFG].length).getValues();

  rows.forEach(row => {
    const type = String(row[COL_CFG.TYPE] || '').trim();
    if (!type) return;
    if (!isEnabledTrue(row[COL_CFG.ENABLED])) return;

    const value = String(row[COL_CFG.VALUE] || '');

    if (PANEL_TYPES.indexOf(type) >= 0) {
      // Panel row
      const panel = {
        name: value.trim(),
        provider: String(row[COL_CFG.PROVIDER] || '').trim(),
        api_id: String(row[COL_CFG.API_ID] || '').trim(),
        api_key: String(row[COL_CFG.API_KEY] || '').trim(),
        secret_key: String(row[COL_CFG.SECRET_KEY] || '').trim(),
        services: splitCsv(row[COL_CFG.SERVICES]),
        like_quantity: Number(row[COL_CFG.LIKE_QTY]) || 0
      };
      if (panel.name) result[type].push(panel);
      return;
    }

    // Config row
    switch (type) {
      case 'komentar':
      case 'skip_keywords':
      case 'advertiser_exclude':
      case 'own_comment_list':
      case 'smm_priority':
        splitCsv(value).forEach(v => result[type].push(v));
        break;
      case 'target_urls_per_call':
      case 'inbox_api_batch_limit':
      case 'dedup_ttl_days':
      case 'viral_ttl_days':
        result[type] = Number(value) || result[type];
        break;
    }
  });

  return result;
}

// ─────────── HANDLERS ───────────

function handleSetupAllSheets(payload) {
  const created = [];
  Object.values(SH).forEach(name => {
    const existed = !!SpreadsheetApp.getActiveSpreadsheet().getSheetByName(name);
    getSheet(name, true);
    if (!existed) created.push(name);
  });

  // Seed TM_Config kalau kosong
  const cfg = getSheet(SH.CFG, true);
  if (cfg.getLastRow() < 2) {
    const seed = [
      ['komentar',              'TRUE', 'Mantap bang!\nKeren\nWow',                      '', '', '', '', '', ''],
      ['skip_keywords',         'TRUE', '',                                              '', '', '', '', '', ''],
      ['advertiser_exclude',    'TRUE', '',                                              '', '', '', '', '', ''],
      ['own_comment_list',      'TRUE', '',                                              '', '', '', '', '', ''],
      ['smm_priority',          'TRUE', 'IRFAN BP,JOVIE BP,ABDUL BP,BRIAN BP,Fewfeed BP','', '', '', '', '', ''],
      ['target_urls_per_call',  'TRUE', '20',                                            '', '', '', '', '', ''],
      ['inbox_api_batch_limit', 'TRUE', '20',                                            '', '', '', '', '', ''],
      ['dedup_ttl_days',        'TRUE', '30',                                            '', '', '', '', '', ''],
      ['viral_ttl_days',        'TRUE', '60',                                            '', '', '', '', '', '']
    ];
    cfg.getRange(2, 1, seed.length, 9).setValues(seed);
    applyTmConfigValidation(cfg);
  }

  return jsonOut({ ok: true, created_sheets: created, message: 'Setup complete' });
}

function handleGetScraperConfig(payload) {
  return jsonOut({ ok: true, config: loadTmConfig(), version: VERSION });
}

function handleSubmit(payload) {
  return withLock(() => {
    const url = payload.url || payload.url_normalized;
    if (!url) return jsonOut({ ok: false, error: 'URL_MISSING' });
    const normalizedUrl = normalizeUrl(url);
    const sh = getSheet(SH.INBOX, true);

    const dupRow = findRowByColumn(sh, COL_INBOX.URL + 1, normalizedUrl);
    if (dupRow > 0) return jsonOut({ ok: false, reason: 'duplicate', existing_row: dupRow });

    const row = new Array(HEADERS[SH.INBOX].length).fill('');
    row[COL_INBOX.URL] = normalizedUrl;
    row[COL_INBOX.STATUS] = 'Baru';
    row[COL_INBOX.AKUN] = payload.akun_fb || '';
    row[COL_INBOX.NOTE] = payload.note || '';
    row[COL_INBOX.SUBMITTED] = nowIso();
    sh.appendRow(row);

    if (payload.dual_write || payload.dual_write_viral) {
      handleSubmitViral({ url: normalizedUrl, timestamp: nowIso() });
    }
    return jsonOut({ ok: true, row: sh.getLastRow(), url_normalized: normalizedUrl });
  });
}

function handleSubmitViral(payload) {
  return withLock(() => {
    const url = payload.url || payload.url_post;
    if (!url) return jsonOut({ ok: false, error: 'URL_MISSING' });
    const normalizedUrl = normalizeUrl(url);
    const sh = getSheet(SH.VIRAL, true);

    const dupRow = findRowByColumn(sh, COL_VIRAL.URL + 1, normalizedUrl);
    if (dupRow > 0) return jsonOut({ ok: false, reason: 'duplicate', existing_row: dupRow });

    const row = new Array(HEADERS[SH.VIRAL].length).fill('');
    row[COL_VIRAL.TIMESTAMP] = payload.timestamp || nowIso();
    row[COL_VIRAL.URL] = normalizedUrl;
    row[COL_VIRAL.TG_STATUS] = 'Belum';
    row[COL_VIRAL.TG_ATTEMPTS] = 0;
    sh.appendRow(row);
    return jsonOut({ ok: true, row: sh.getLastRow() });
  });
}

function handleUpdateStatus(payload) {
  return withLock(() => {
    const url = payload.url || payload.url_normalized;
    if (!url) return jsonOut({ ok: false, error: 'URL_MISSING' });
    const normalizedUrl = normalizeUrl(url);
    const sh = getSheet(SH.INBOX, false);
    if (!sh) return jsonOut({ ok: false, error: 'INBOX_MISSING' });

    const rowIdx = findRowByColumn(sh, COL_INBOX.URL + 1, normalizedUrl);
    if (rowIdx < 0) return jsonOut({ ok: false, error: 'ROW_NOT_FOUND' });

    if (payload.status)    sh.getRange(rowIdx, COL_INBOX.STATUS + 1).setValue(payload.status);
    if (payload.order_id)  sh.getRange(rowIdx, COL_INBOX.ORDER_ID + 1).setValue(payload.order_id);
    if (payload.smm_panel) sh.getRange(rowIdx, COL_INBOX.PANEL + 1).setValue(payload.smm_panel);
    if (payload.akun_fb)   sh.getRange(rowIdx, COL_INBOX.AKUN + 1).setValue(payload.akun_fb);
    if (payload.note)      sh.getRange(rowIdx, COL_INBOX.NOTE + 1).setValue(payload.note);
    return jsonOut({ ok: true, row: rowIdx });
  });
}

function handleGetStatusCheckJobs(payload) {
  const sh = getSheet(SH.INBOX, false);
  if (!sh || sh.getLastRow() < 2) return jsonOut({ ok: true, jobs: [] });

  const limit = Number(payload.limit) || 20;
  const data = sh.getRange(2, 1, sh.getLastRow() - 1, HEADERS[SH.INBOX].length).getValues();
  const jobs = [];

  data.forEach((row, idx) => {
    if (jobs.length >= limit) return;
    const status = String(row[COL_INBOX.STATUS] || '').toLowerCase();
    if (!row[COL_INBOX.ORDER_ID]) return;
    if (['proses', 'processing', 'pending', 'in progress', 'partial'].indexOf(status) < 0) return;

    jobs.push({
      row: idx + 2,
      url: row[COL_INBOX.URL],
      order_id: row[COL_INBOX.ORDER_ID],
      smm_panel: row[COL_INBOX.PANEL],
      status: row[COL_INBOX.STATUS],
      last_check: row[COL_INBOX.LAST_CHECK] || ''
    });
  });

  return jsonOut({ ok: true, jobs: jobs });
}

function handleBatchUpdateInbox(payload) {
  return withLock(() => {
    const updates = payload.updates || [];
    if (!updates.length) return jsonOut({ ok: true, updated: 0 });
    const sh = getSheet(SH.INBOX, false);
    if (!sh) return jsonOut({ ok: false, error: 'INBOX_MISSING' });

    let count = 0;
    const now = nowIso();
    updates.forEach(u => {
      const rowIdx = u.row || findRowByColumn(sh, COL_INBOX.URL + 1, normalizeUrl(u.url));
      if (rowIdx < 2) return;
      if (u.status) sh.getRange(rowIdx, COL_INBOX.STATUS + 1).setValue(u.status);
      if (u.note)   sh.getRange(rowIdx, COL_INBOX.NOTE + 1).setValue(u.note);
      sh.getRange(rowIdx, COL_INBOX.LAST_CHECK + 1).setValue(now);
      count++;
    });
    return jsonOut({ ok: true, updated: count });
  });
}

function handleGetTargetingConfig(payload) {
  const cfg = loadTmConfig();
  return jsonOut({
    ok: true,
    komentar_list: cfg.komentar || [],
    smm_panel_comment: cfg.smm_panel_comment || [],
    smm_panel_like: cfg.smm_panel_like || [],
    smm_priority: cfg.smm_priority || [],
    target_urls_per_call: cfg.target_urls_per_call || 20,
    version: VERSION
  });
}

function handleGetTargetingJobs(payload) {
  const sh = getSheet(SH.VIRAL, false);
  if (!sh || sh.getLastRow() < 2) return jsonOut({ ok: true, jobs: [] });

  const limit = Number(payload.limit) || 20;
  const data = sh.getRange(2, 1, sh.getLastRow() - 1, HEADERS[SH.VIRAL].length).getValues();
  const jobs = [];

  data.forEach((row, idx) => {
    if (jobs.length >= limit) return;
    const status = String(row[COL_VIRAL.TG_STATUS] || '').toLowerCase();
    if (status !== 'belum' && status !== 'proses') return;
    const attempts = Number(row[COL_VIRAL.TG_ATTEMPTS]) || 0;
    if (attempts > 3) return;
    const lastRun = row[COL_VIRAL.TG_LAST_RUN];
    if (lastRun && (Date.now() - new Date(lastRun).getTime()) < 30 * 60 * 1000) return;

    jobs.push({
      row: idx + 2,
      url: row[COL_VIRAL.URL],
      status: row[COL_VIRAL.TG_STATUS],
      attempts: attempts,
      order_id: row[COL_VIRAL.TG_ORDER_ID] || ''
    });
  });

  return jsonOut({ ok: true, jobs: jobs });
}

function handleBatchUpdateTargeting(payload) {
  return withLock(() => {
    const updates = payload.updates || [];
    if (!updates.length) return jsonOut({ ok: true, updated: 0 });
    const sh = getSheet(SH.VIRAL, false);
    if (!sh) return jsonOut({ ok: false, error: 'VIRAL_MISSING' });

    let count = 0;
    const now = nowIso();
    updates.forEach(u => {
      const rowIdx = u.row || findRowByColumn(sh, COL_VIRAL.URL + 1, normalizeUrl(u.url));
      if (rowIdx < 2) return;
      if (u.status) sh.getRange(rowIdx, COL_VIRAL.TG_STATUS + 1).setValue(u.status);
      if (typeof u.attempts !== 'undefined') sh.getRange(rowIdx, COL_VIRAL.TG_ATTEMPTS + 1).setValue(u.attempts);
      if (u.order_id) sh.getRange(rowIdx, COL_VIRAL.TG_ORDER_ID + 1).setValue(u.order_id);
      if (u.comment_urls) {
        const existing = sh.getRange(rowIdx, COL_VIRAL.TG_COMMENT_URLS + 1).getValue();
        const merged = existing ? (existing + '\n' + u.comment_urls) : u.comment_urls;
        sh.getRange(rowIdx, COL_VIRAL.TG_COMMENT_URLS + 1).setValue(merged);
      }
      sh.getRange(rowIdx, COL_VIRAL.TG_LAST_RUN + 1).setValue(now);
      count++;
    });
    return jsonOut({ ok: true, updated: count });
  });
}

function handleGetTopCommentJobs(payload) {
  const sh = getSheet(SH.VIRAL, false);
  if (!sh || sh.getLastRow() < 2) return jsonOut({ ok: true, jobs: [] });
  const data = sh.getRange(2, COL_VIRAL.URL + 1, sh.getLastRow() - 1, 1).getValues();
  const urls = data.map(r => r[0]).filter(Boolean);
  return jsonOut({ ok: true, jobs: urls.map(u => ({ url: u })) });
}

function handleAppendTopComments(payload) {
  return withLock(() => {
    const comments = payload.comments || [];
    if (!comments.length) return jsonOut({ ok: true, appended: 0 });
    const sh = getSheet(SH.TOP, true);

    const rows = comments.map(c => [
      c.timestamp || nowIso(),
      c.url || '',
      c.position || '',
      c.author || '',
      c.text || '',
      c.reactions || '',
      c.replies || '',
      c.comment_id || ''
    ]);
    sh.getRange(sh.getLastRow() + 1, 1, rows.length, HEADERS[SH.TOP].length).setValues(rows);
    return jsonOut({ ok: true, appended: rows.length });
  });
}

function handleArchiveTopComments(payload) {
  return withLock(() => {
    const shTop = getSheet(SH.TOP, false);
    const shArc = getSheet(SH.ARC, true);
    if (!shTop || shTop.getLastRow() < 2) return jsonOut({ ok: true, archived: 0 });

    const data = shTop.getRange(2, 1, shTop.getLastRow() - 1, HEADERS[SH.TOP].length).getValues();
    if (!data.length) return jsonOut({ ok: true, archived: 0 });

    const now = nowIso();
    const archiveRows = data.map(r => [now, ...r]);
    shArc.getRange(shArc.getLastRow() + 1, 1, archiveRows.length, archiveRows[0].length).setValues(archiveRows);
    shTop.getRange(2, 1, shTop.getLastRow() - 1, HEADERS[SH.TOP].length).clearContent();

    return jsonOut({ ok: true, archived: archiveRows.length });
  });
}

function handleCleanupOldData(payload) {
  return withLock(() => {
    const cfg = loadTmConfig();
    const inboxTtl = (cfg.dedup_ttl_days || 30) * 86400 * 1000;
    const viralTtl = (cfg.viral_ttl_days || 60) * 86400 * 1000;
    const now = Date.now();
    let deletedInbox = 0, deletedViral = 0;

    const shInbox = getSheet(SH.INBOX, false);
    if (shInbox && shInbox.getLastRow() > 1) {
      const data = shInbox.getRange(2, 1, shInbox.getLastRow() - 1, HEADERS[SH.INBOX].length).getValues();
      for (let i = data.length - 1; i >= 0; i--) {
        const t = data[i][COL_INBOX.SUBMITTED];
        if (!t) continue;
        if (now - new Date(t).getTime() > inboxTtl) { shInbox.deleteRow(i + 2); deletedInbox++; }
      }
    }

    const shViral = getSheet(SH.VIRAL, false);
    if (shViral && shViral.getLastRow() > 1) {
      const data = shViral.getRange(2, 1, shViral.getLastRow() - 1, HEADERS[SH.VIRAL].length).getValues();
      for (let i = data.length - 1; i >= 0; i--) {
        const t = data[i][COL_VIRAL.TIMESTAMP];
        if (!t) continue;
        if (now - new Date(t).getTime() > viralTtl) { shViral.deleteRow(i + 2); deletedViral++; }
      }
    }

    return jsonOut({ ok: true, deleted_inbox: deletedInbox, deleted_viral: deletedViral });
  });
}

// ─────────── STATUS CHECKER CRON ───────────

function statusCheckerCron() {
  const cfg = loadTmConfig();
  const panels = cfg.smm_panel_comment || [];
  const batchLimit = cfg.inbox_api_batch_limit || 20;
  const sh = getSheet(SH.INBOX, false);
  if (!sh || sh.getLastRow() < 2) return;

  const data = sh.getRange(2, 1, sh.getLastRow() - 1, HEADERS[SH.INBOX].length).getValues();
  let processed = 0;

  for (let i = 0; i < data.length && processed < batchLimit; i++) {
    const row = data[i];
    const status = String(row[COL_INBOX.STATUS] || '').toLowerCase();
    const orderId = row[COL_INBOX.ORDER_ID];
    const panelName = row[COL_INBOX.PANEL];
    if (!orderId || !panelName) continue;
    if (['proses', 'processing', 'pending', 'in progress', 'partial'].indexOf(status) < 0) continue;

    const panel = panels.find(p => p.name === panelName);
    if (!panel || !panel.api_key) continue;

    try {
      const statusUrl = panel.provider === 'BP'
        ? 'https://buzzerpanel.id/api/v2'
        : 'https://api.all-uneed.com/api/v2';
      const resp = UrlFetchApp.fetch(statusUrl, {
        method: 'post',
        contentType: 'application/x-www-form-urlencoded',
        payload: { key: panel.api_key, action: 'status', order: String(orderId) },
        muteHttpExceptions: true,
        followRedirects: true
      });
      const json = JSON.parse(resp.getContentText());
      const newStatus = json.status || 'Unknown';
      sh.getRange(i + 2, COL_INBOX.STATUS + 1).setValue(newStatus);
      sh.getRange(i + 2, COL_INBOX.LAST_CHECK + 1).setValue(nowIso());
      if (json.remains !== undefined) {
        sh.getRange(i + 2, COL_INBOX.NOTE + 1).setValue('remains: ' + json.remains + ' | start: ' + (json.start_count || '?'));
      }
      processed++;
    } catch (e) {
      Logger.log('Status check error order ' + orderId + ': ' + e.message);
    }
  }
}

function installStatusCheckerTrigger() {
  ScriptApp.getProjectTriggers().forEach(t => {
    if (t.getHandlerFunction() === 'statusCheckerCron') ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger('statusCheckerCron').timeBased().everyMinutes(10).create();
  return { ok: true, message: 'Status checker trigger installed (every 10 min)' };
}

// ─────────── MANUAL HELPERS ───────────

function runSetup() { return handleSetupAllSheets({}); }
function installTrigger() { return installStatusCheckerTrigger(); }
function reapplyDropdowns() { const sh = getSheet(SH.CFG, false); if (sh) applyTmConfigValidation(sh); }
