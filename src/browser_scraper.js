// FbSuitesV2 - Profile Launcher v1.2
// Changes v1.1 → v1.2:
//   - Data files (cookies.txt, profiles/, state.json) di %APPDATA%\FbSuitesV2
//   - CRX renamed to Tampermonkey.crx
//   - Auto-open 2 tabs per profile: chrome://extensions/ + facebook.com

const { chromium } = require('playwright');
const fetch = require('node-fetch');
const fs = require('fs');
const path = require('path');
const readline = require('readline');
const AdmZip = require('adm-zip');
const { HttpsProxyAgent } = require('https-proxy-agent');
const { spawn } = require('child_process');

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
const ask = (q) => new Promise(r => rl.question(q, r));

const API_BASE = 'http://127.0.0.1:10101';

// ★ v1.2: Data files di %APPDATA%\FbSuitesV2 (writable tanpa admin)
const DATA_DIR = path.join(process.env.APPDATA, 'FbSuitesV2');
const COOKIE_FILE = path.join(DATA_DIR, 'cookies.txt');
const PROFILES_DIR = path.join(DATA_DIR, 'profiles');
const STATE_FILE = path.join(DATA_DIR, '.state.json');

// ★ v1.2: CRX file di install dir (read-only, tapi cukup buat extract)
const CRX_FILE = path.join(__dirname, 'Tampermonkey.crx');
const EXTENSION_PATH = path.join(DATA_DIR, 'tampermonkey');

const ROTATE_COUNTRY = 'ID';
const ROTATE_WAIT_MS = 3_000;
const IP_VERIFY_TIMEOUT_MS = 30_000;
const IP_VERIFY_RETRY = 3;

function parseCookieLine(line) {
  const tick1 = line.indexOf('`');
  if (tick1 === -1) throw new Error('Backtick pertama gak ketemu');
  const tick2 = line.indexOf('`', tick1 + 1);
  if (tick2 === -1) throw new Error('Backtick kedua gak ketemu');

  const idStr = line.substring(0, tick1).trim();
  const label = line.substring(tick1 + 1, tick2).trim();
  const rest = line.substring(tick2 + 1);

  const id = parseInt(idStr, 10);
  if (!id || id < 1) throw new Error(`ID invalid: "${idStr}"`);
  if (!label) throw new Error('Label kosong');

  const pipe1 = rest.indexOf('|');
  if (pipe1 === -1) throw new Error('Pipe pertama gak ketemu di rest');
  const pipe2 = rest.indexOf('|', pipe1 + 1);
  if (pipe2 === -1) throw new Error('Pipe kedua gak ketemu di rest');

  const declaredCUser = rest.substring(0, pipe1).trim();
  const password = rest.substring(pipe1 + 1, pipe2).trim();
  const cookieStr = rest.substring(pipe2 + 1).trim();

  const raw = cookieStr.split(';').filter(c => c.includes('='));
  if (raw.length === 0) throw new Error('Cookie string kosong');

  const cookies = raw.map(c => {
    const [name, ...value] = c.trim().split('=');
    return {
      name: name.trim(),
      value: value.join('=').trim(),
      domain: '.facebook.com',
      path: '/',
    };
  });

  const cUserFromCookie = cookies.find(c => c.name === 'c_user')?.value;
  if (!cUserFromCookie) throw new Error('c_user gak ketemu di cookieString');

  if (declaredCUser && declaredCUser !== cUserFromCookie) {
    console.log(`   ⚠️ Warning ID ${id}: c_user mismatch`);
  }

  return { id, label, password, cUser: cUserFromCookie, cookies };
}

function parseRangeInput(input) {
  const ids = new Set();
  const parts = input.split(',').map(p => p.trim()).filter(Boolean);
  for (const part of parts) {
    if (part.includes('-')) {
      const [start, end] = part.split('-').map(n => parseInt(n.trim(), 10));
      if (!start || !end || start > end) throw new Error(`Range invalid: "${part}"`);
      for (let i = start; i <= end; i++) ids.add(i);
    } else {
      const n = parseInt(part, 10);
      if (!n) throw new Error(`ID invalid: "${part}"`);
      ids.add(n);
    }
  }
  return [...ids].sort((a, b) => a - b);
}

async function callRotateAPI(port) {
  const url = `${API_BASE}/api/proxy?t=2&num=1&country=${ROTATE_COUNTRY}&port=${port}`;
  try {
    const res = await fetch(url, { timeout: 15000 });
    const data = await res.json();
    return { ok: true, data };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

async function fetchIPViaProxy(port) {
  const agent = new HttpsProxyAgent(`http://127.0.0.1:${port}`);
  try {
    const res = await fetch('https://wtfismyip.com/json', { agent, timeout: IP_VERIFY_TIMEOUT_MS });
    const data = await res.json();
    return data.YourFuckingIPAddress;
  } catch (e1) {
    try {
      const res = await fetch('https://api.ipify.org', { agent, timeout: IP_VERIFY_TIMEOUT_MS });
      return (await res.text()).trim();
    } catch (e2) {
      throw new Error(`Both IP services fail: ${e2.message}`);
    }
  }
}

async function verifyIP(port) {
  for (let i = 1; i <= IP_VERIFY_RETRY; i++) {
    try { return await fetchIPViaProxy(port); }
    catch (e) { if (i < IP_VERIFY_RETRY) await new Promise(r => setTimeout(r, 3000)); }
  }
  return null;
}

async function forceRotatePort(port) {
  console.log(`🔄 Force rotate port ${port}...`);
  const apiRes = await callRotateAPI(port);
  if (!apiRes.ok) {
    console.log(`   ❌ Rotate API FAIL: ${apiRes.error}`);
    return { port, success: false, ip: null };
  }
  console.log(`   ✓ API success: ${JSON.stringify(apiRes.data).substring(0, 100)}`);
  await new Promise(r => setTimeout(r, ROTATE_WAIT_MS));
  const newIP = await verifyIP(port);
  if (newIP) {
    console.log(`   🌍 Port ${port} new IP: ${newIP}`);
    return { port, success: true, ip: newIP };
  } else {
    console.log(`   ⚠️ IP verify gagal, tapi API success — asumsi IP udah ganti`);
    return { port, success: true, ip: 'unverified' };
  }
}

function extractCrx(crxPath, outDir) {
  console.log(`📦 Extract CRX → ${outDir}...`);
  const buf = fs.readFileSync(crxPath);
  let zipStart = -1;
  for (let i = 0; i < buf.length - 4; i++) {
    if (buf[i] === 0x50 && buf[i+1] === 0x4B && buf[i+2] === 0x03 && buf[i+3] === 0x04) {
      zipStart = i;
      break;
    }
  }
  if (zipStart === -1) throw new Error('ZIP signature gak ketemu di CRX');
  console.log(`   ✓ ZIP payload mulai dari byte ${zipStart}`);
  const zipBuf = buf.slice(zipStart);
  if (fs.existsSync(outDir)) fs.rmSync(outDir, { recursive: true, force: true });
  fs.mkdirSync(outDir, { recursive: true });
  const zip = new AdmZip(zipBuf);
  zip.extractAllTo(outDir, true);
  if (!fs.existsSync(path.join(outDir, 'manifest.json'))) {
    throw new Error('Extract sukses tapi manifest.json gak ada');
  }
  console.log(`   ✓ Extract sukses, manifest.json ditemukan`);
}

function readState() {
  if (!fs.existsSync(STATE_FILE)) return { activeProfiles: [] };
  try { return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); }
  catch (e) { return { activeProfiles: [] }; }
}
function writeState(state) {
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2), 'utf8');
}
function isPidAlive(pid) {
  try { process.kill(pid, 0); return true; }
  catch (e) { return false; }
}
function cleanupDeadEntries(state) {
  const before = state.activeProfiles.length;
  state.activeProfiles = state.activeProfiles.filter(p => {
    const alive = isPidAlive(p.pid);
    if (!alive) console.log(`   🧹 Released ID ${p.id} (${p.label}) — PID ${p.pid} mati`);
    return alive;
  });
  if (before !== state.activeProfiles.length) writeState(state);
  return state;
}

(async () => {
  console.log('═══════════════════════════════════════════');
  console.log('  FB Suites V2 - Profile Launcher v1.2');
  console.log(`  PID: ${process.pid}`);
  console.log(`  Data: ${DATA_DIR}`);
  console.log('═══════════════════════════════════════════\n');

  // ★ v1.2: Ensure DATA_DIR exists
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

  // Extract Tampermonkey extension
  if (!fs.existsSync(path.join(EXTENSION_PATH, 'manifest.json'))) {
    if (!fs.existsSync(CRX_FILE)) {
      console.log(`❌ CRX file gak ada: ${CRX_FILE}`);
      console.log(`   Reinstall FbSuitesV2 (double-click install.bat lagi).`);
      rl.close(); process.exit(1);
    }
    try { extractCrx(CRX_FILE, EXTENSION_PATH); }
    catch (e) { console.log(`❌ Extract CRX fail: ${e.message}`); rl.close(); process.exit(1); }
  } else {
    console.log(`✓ Tampermonkey extension siap`);
  }

  // Cookie file check
  if (!fs.existsSync(COOKIE_FILE)) {
    console.log(`\n⚠️ File cookies.txt belum ada, auto-bikin...`);
    const template = `# Format per baris: ID\`label\`c_user|password|cookieString
# Contoh:
# 1\`AkunIRFAN01\`100012345678|pass123|c_user=100012345678; xs=abc...; fr=xyz...
# 2\`AkunIRFAN02\`100087654321|pass456|c_user=100087654321; xs=def...; fr=uvw...
#
# Hapus baris # di atas, isi pakai akun lo, save, terus run lagi.

`;
    fs.writeFileSync(COOKIE_FILE, template, 'utf8');
    console.log(`✓ File dibuat: ${COOKIE_FILE}`);
    console.log(`📝 Notepad kebuka, paste akun lo di sana, save, terus run lagi.\n`);
    try {
      spawn('notepad.exe', [COOKIE_FILE], { detached: true, stdio: 'ignore' }).unref();
    } catch (e) {
      console.log(`   ⚠️ Gagal buka notepad: ${e.message}`);
      console.log(`   Buka manual: ${COOKIE_FILE}`);
    }
    rl.close(); process.exit(0);
  }

  const rawLines = fs.readFileSync(COOKIE_FILE, 'utf8')
    .split(/\r?\n/)
    .map(l => l.trim())
    .filter(l => l.length > 0 && !l.startsWith('#'));

  const accounts = new Map();
  const idsSeen = new Set();

  for (let i = 0; i < rawLines.length; i++) {
    try {
      const parsed = parseCookieLine(rawLines[i]);
      if (idsSeen.has(parsed.id)) {
        console.log(`   ❌ Baris ${i + 1}: ID ${parsed.id} duplikat, skip`);
        continue;
      }
      idsSeen.add(parsed.id);
      accounts.set(parsed.id, { ...parsed, lineNum: i + 1 });
    } catch (e) {
      console.log(`   ❌ Baris ${i + 1}: ${e.message}`);
    }
  }

  if (accounts.size === 0) {
    console.log('\n❌ Gak ada cookie valid di cookies.txt');
    console.log(`   Edit: ${COOKIE_FILE}`);
    rl.close(); process.exit(1);
  }

  let state = readState();
  state = cleanupDeadEntries(state);
  const lockedIds = new Set(state.activeProfiles.map(p => p.id));

  console.log(`\n📋 Daftar akun (${accounts.size} total):`);
  console.log('───────────────────────────────────────────');
  const sortedIds = [...accounts.keys()].sort((a, b) => a - b);
  for (const id of sortedIds) {
    const acc = accounts.get(id);
    const lockStatus = lockedIds.has(id) ? ' 🔒 LOCKED' : '';
    console.log(`  [${String(id).padStart(3, ' ')}] ${acc.label.padEnd(20, ' ')} c_user=${acc.cUser}${lockStatus}`);
  }
  console.log('───────────────────────────────────────────\n');

  if (lockedIds.size > 0) {
    console.log(`ℹ️ ${lockedIds.size} akun lagi aktif di cmd window lain\n`);
  }

  console.log('Format input: "1,3,5" atau "1-4" atau "1-4,7,9-11"');
  const rangeStr = await ask('Pilih ID yang mau dibuka: ');

  let requestedIds;
  try { requestedIds = parseRangeInput(rangeStr); }
  catch (e) { console.log(`❌ ${e.message}`); rl.close(); process.exit(1); }

  const toOpen = [];
  const skipped = { notFound: [], locked: [] };
  for (const id of requestedIds) {
    if (!accounts.has(id)) { skipped.notFound.push(id); continue; }
    if (lockedIds.has(id)) { skipped.locked.push(id); continue; }
    toOpen.push(accounts.get(id));
  }

  if (skipped.notFound.length > 0) console.log(`⚠️ ID gak ada: ${skipped.notFound.join(', ')}`);
  if (skipped.locked.length > 0) console.log(`⚠️ ID locked: ${skipped.locked.join(', ')}`);

  if (toOpen.length === 0) {
    console.log('\n❌ Gak ada ID valid');
    rl.close(); process.exit(1);
  }

  console.log(`\n🎯 Akan buka ${toOpen.length} akun: ${toOpen.map(a => `${a.id} (${a.label})`).join(', ')}\n`);

  const useProxyAns = await ask('Pakai proxy? (y/n, default y): ');
  const useProxy = !/^n/i.test(useProxyAns.trim());

  let ports = [];
  let rotationResults = [];
  let profilePerPort = 2;

  if (useProxy) {
    const ratioAns = await ask('1 proxy untuk berapa profil? (default 2): ');
    const ratioParsed = parseInt(ratioAns.trim(), 10);
    profilePerPort = (ratioParsed && ratioParsed > 0) ? ratioParsed : 2;

    const portCount = Math.ceil(toOpen.length / profilePerPort);
    console.log(`\n📊 ${toOpen.length} profile butuh ${portCount} port proxy (1 port : ${profilePerPort} profile)\n`);

    for (let i = 0; i < portCount; i++) {
      const portStr = await ask(`Port proxy #${i + 1}: `);
      const port = parseInt(portStr.trim(), 10);
      if (!port) { console.log('❌ Port invalid'); rl.close(); process.exit(1); }
      ports.push(port);
    }
    rl.close();

    console.log('\n🔄 FORCED STARTUP ROTATE — request IP baru untuk semua port...');
    console.log('───────────────────────────────────────────');
    for (const port of ports) {
      const result = await forceRotatePort(port);
      rotationResults.push(result);
    }
    console.log('───────────────────────────────────────────');

    const successCount = rotationResults.filter(r => r.success).length;
    console.log(`✨ Rotate selesai: ${successCount}/${ports.length} port sukses\n`);

    if (successCount === 0) {
      console.log('❌ Semua port gagal rotate. Cek 9proxy GUI lo. Abort.');
      process.exit(1);
    }
  } else {
    rl.close();
    console.log('\n🌐 Mode DIRECT — browser pake internet langsung PC (no proxy)\n');
  }

  if (!fs.existsSync(PROFILES_DIR)) fs.mkdirSync(PROFILES_DIR, { recursive: true });

  console.log(`🚀 Launching ${toOpen.length} browser dengan Tampermonkey...\n`);
  const contexts = [];
  const myClaimed = [];

  for (let i = 0; i < toOpen.length; i++) {
    const acc = toOpen[i];
    const userDataDir = path.join(PROFILES_DIR, `id_${acc.id}`);
    const isReturning = fs.existsSync(userDataDir);

    let port = null, proxyUrl = null, portIP = 'direct';
    if (useProxy) {
      const portIdx = Math.floor(i / profilePerPort);
      port = ports[portIdx];
      proxyUrl = `http://127.0.0.1:${port}`;
      portIP = rotationResults[portIdx].ip || 'unknown';
    }

    console.log(`[ID ${acc.id} | ${acc.label}] ${isReturning ? '🔄 returning' : '🆕 new'}`);
    if (useProxy) console.log(`   proxy=${proxyUrl} | IP=${portIP}`);
    else console.log(`   mode=direct (no proxy)`);

    try {
      const launchOpts = {
        headless: false,
        viewport: null,
        locale: 'id-ID',
        timezoneId: 'Asia/Jakarta',
        args: [
          `--disable-extensions-except=${EXTENSION_PATH}`,
          `--load-extension=${EXTENSION_PATH}`,
          '--disable-blink-features=AutomationControlled',
        ],
      };
      if (useProxy) launchOpts.proxy = { server: proxyUrl };

      const context = await chromium.launchPersistentContext(userDataDir, launchOpts);
      await context.addCookies(acc.cookies);

      // ★ v1.2: buka 2 tab urut — chrome://extensions/ (tab 1) + facebook.com (tab 2)
      const existingPage = context.pages()[0];

      // Tab 1: chrome://extensions/ — karyawan set dev mode + userscript manual (sekali)
      if (existingPage) {
        await existingPage.goto('chrome://extensions/', { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
      } else {
        const p1 = await context.newPage();
        await p1.goto('chrome://extensions/', { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
      }

      // Tab 2: facebook.com — cookie udah ke-inject, ready to work
      const fbPage = await context.newPage();
      await fbPage.goto('https://www.facebook.com/', { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});
      await fbPage.bringToFront();  // focus ke FB tab supaya karyawan langsung liat

      contexts.push({ context, id: acc.id, label: acc.label });
      state.activeProfiles.push({
        id: acc.id, label: acc.label, cUser: acc.cUser,
        port: port || null, ip: portIP, useProxy,
        pid: process.pid, startedAt: Date.now(),
      });
      writeState(state);
      myClaimed.push(acc.id);

      console.log(`   ✅ ID ${acc.id} kebuka (2 tab: extensions + facebook)\n`);
    } catch (e) {
      console.log(`   ❌ ID ${acc.id} fail: ${e.message.substring(0, 150)}\n`);
    }
  }

  console.log('═══════════════════════════════════════════');
  console.log(`✅ ${contexts.length}/${toOpen.length} profile aktif (PID ${process.pid})`);
  console.log(`   Locked: ${myClaimed.join(', ')}`);
  console.log(`   Mode: ${useProxy ? 'PROXY (1:' + profilePerPort + ')' : 'DIRECT'}`);
  console.log(`   Ctrl+C buat tutup semua.`);
  console.log('═══════════════════════════════════════════');

  const cleanup = async () => {
    console.log('\n🛑 Closing browsers & releasing claims...');
    for (const { context } of contexts) {
      try { await context.close(); } catch (e) {}
    }
    const currentState = readState();
    currentState.activeProfiles = currentState.activeProfiles.filter(p => p.pid !== process.pid);
    writeState(currentState);
    console.log(`🧹 Released ${myClaimed.length} claim`);
    process.exit(0);
  };

  process.on('SIGINT', cleanup);
  process.on('SIGTERM', cleanup);

  await new Promise(() => {});
})();
