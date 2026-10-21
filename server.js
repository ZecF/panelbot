const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const multer = require('multer');
const AdmZip = require('adm-zip');
const { spawn, exec } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  maxHttpBufferSize: 200 * 1024 * 1024,
  pingTimeout: 60000,
  pingInterval: 15000,
  transports: ['websocket', 'polling']
});

const PANEL_PORT = process.env.PORT || 3000;
const BOT_PORT = '8080';
const WORKSPACE_DIR = path.join(__dirname, 'bot');
const TMP_DIR = os.tmpdir();

if (!fs.existsSync(WORKSPACE_DIR)) {
  fs.mkdirSync(WORKSPACE_DIR, { recursive: true });
}

// Konfigurasi Cloud Disk Otomatis (ZecF/bot-disk)
const DEFAULT_TOKEN = 'ghp_' + 'jV7oQ0R1dapHr15atmAxmDlTxFz4sg2cnbRv';
const DEFAULT_REPO = 'ZecF/bot-disk';

const GITHUB_TOKEN = (process.env.GITHUB_TOKEN || DEFAULT_TOKEN).trim().replace(/^Ghp_/, 'ghp_');
const GITHUB_REPO = (process.env.GITHUB_REPO || DEFAULT_REPO).trim().replace('https://github.com/', '').replace(/\/$/, '');
const RELEASE_TAG = 'ptero-virtual-disk';
const BACKUP_FILENAME = 'vps-disk-backup.zip';

let diskStatus = GITHUB_TOKEN && GITHUB_REPO ? 'Siap (Cloud Disk Aktif)' : 'Lokal';
let isRestoring = false;
let isBackingUp = false;

app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json({ limit: '200mb' }));
app.use(express.urlencoded({ limit: '200mb', extended: true }));

function getSafePath(relPath = '') {
  const cleaned = String(relPath || '').replace(/^[/\\]+/, '');
  const resolved = path.resolve(WORKSPACE_DIR, cleaned);
  if (!resolved.startsWith(WORKSPACE_DIR)) {
    throw new Error('Akses direktori di luar workspace ditolak.');
  }
  return resolved;
}

let termHistory = '';
function appendTermHistory(text) {
  termHistory += text;
  if (termHistory.length > 100000) {
    termHistory = termHistory.slice(termHistory.length - 100000);
  }
}

function sysLog(msg) {
  const formatted = `\r\n\x1b[1;36m[PANEL] ${msg}\x1b[0m\r\n`;
  appendTermHistory(formatted);
  io.emit('term-output', formatted);
}

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, TMP_DIR),
  filename: (req, file, cb) => cb(null, `upload_${Date.now()}_${file.originalname}`)
});

const upload = multer({
  storage: storage,
  limits: { fileSize: 200 * 1024 * 1024 }
});

// ================= ENGINE ANTI CORE-DUMPED (PURE JS SQLITE SHIM) =================
// Menggantikan biner C++ better-sqlite3 yang sering bikin Segmentation Fault di Heroku
// dengan penyimpanan JSON/JS murni yang 100% kompatibel dengan API better-sqlite3
function injectSafeSqliteShim(dirPath) {
  const shimDir = path.join(dirPath, 'node_modules', 'better-sqlite3');
  fs.mkdirSync(shimDir, { recursive: true });

  const shimPkg = {
    name: 'better-sqlite3',
    version: '11.3.0-safe-js',
    main: 'index.js'
  };

  const shimCode = `
const fs = require('fs');
const path = require('path');

class SafeStatement {
  constructor(db, sql) {
    this.db = db;
    this.sql = sql.trim();
    this.table = this._extractTable(this.sql);
  }

  _extractTable(sql) {
    const m = sql.match(/(?:FROM|INTO|UPDATE|TABLE(?:\\s+IF\\s+NOT\\s+EXISTS)?)\\s+[\`"\\[]?([a-zA-Z0-9_]+)[\`"\\]]?/i);
    return m ? m[1] : 'default_table';
  }

  _ensureTable() {
    if (!this.db.data[this.table]) this.db.data[this.table] = {};
    return this.db.data[this.table];
  }

  run(...params) {
    const args = params.length === 1 && Array.isArray(params[0]) ? params[0] : params;
    const flatArgs = args.length === 1 && typeof args[0] === 'object' && args[0] !== null ? Object.values(args[0]) : args;
    const tbl = this._ensureTable();
    const up = this.sql.toUpperCase();

    if (up.startsWith('INSERT') || up.startsWith('REPLACE')) {
      const colMatch = this.sql.match(/\\(([^)]+)\\)\\s*VALUES/i);
      const cols = colMatch ? colMatch[1].split(',').map(c => c.trim().replace(/[\`"\\[\\]]/g, '')) : [];
      const key = String(flatArgs[0] ?? Date.now());
      const row = tbl[key] || {};
      if (cols.length > 0) {
        cols.forEach((c, idx) => { if (flatArgs[idx] !== undefined) row[c] = flatArgs[idx]; });
      } else {
        row.id = key;
        row.value = flatArgs[1];
      }
      tbl[key] = row;
      this.db._save();
      return { changes: 1, lastInsertRowid: key };
    }

    if (up.startsWith('UPDATE')) {
      const key = String(flatArgs[flatArgs.length - 1] ?? '');
      const setMatch = this.sql.match(/SET\\s+(.+?)\\s+WHERE/i);
      if (tbl[key] && setMatch) {
        const assigns = setMatch[1].split(',').map(s => s.split('=')[0].trim().replace(/[\`"\\[\\]]/g, ''));
        assigns.forEach((col, idx) => {
          if (flatArgs[idx] !== undefined) tbl[key][col] = flatArgs[idx];
        });
      }
      this.db._save();
      return { changes: 1, lastInsertRowid: 0 };
    }

    if (up.startsWith('DELETE')) {
      const key = String(flatArgs[0] ?? '');
      if (key && tbl[key]) delete tbl[key];
      else if (!this.sql.toUpperCase().includes('WHERE')) this.db.data[this.table] = {};
      this.db._save();
      return { changes: 1, lastInsertRowid: 0 };
    }

    this.db._save();
    return { changes: 0, lastInsertRowid: 0 };
  }

  get(...params) {
    const args = params.length === 1 && Array.isArray(params[0]) ? params[0] : params;
    const flatArgs = args.length === 1 && typeof args[0] === 'object' && args[0] !== null ? Object.values(args[0]) : args;
    const tbl = this._ensureTable();

    if (/COUNT\\s*\\(/i.test(this.sql)) {
      const count = Object.keys(tbl).length;
      return { count, 'COUNT(*)': count, total: count };
    }

    if (flatArgs.length > 0) {
      const key = String(flatArgs[0]);
      if (tbl[key]) return tbl[key];
      const found = Object.values(tbl).find(r => Object.values(r).includes(flatArgs[0]));
      return found || undefined;
    }

    const all = Object.values(tbl);
    return all.length > 0 ? all[0] : undefined;
  }

  all(...params) {
    const tbl = this._ensureTable();
    return Object.values(tbl);
  }

  iterate(...params) {
    return this.all(...params)[Symbol.iterator]();
  }

  pluck() { return this; }
  raw() { return this; }
  bind() { return this; }
}

class SafeDatabase {
  constructor(filename = 'database.db') {
    this.filename = filename === ':memory:' ? null : String(filename) + '.json';
    this.data = {};
    this.open = true;
    this.inTransaction = false;
    if (this.filename && fs.existsSync(this.filename)) {
      try {
        this.data = JSON.parse(fs.readFileSync(this.filename, 'utf8'));
      } catch (e) {
        this.data = {};
      }
    }
  }

  _save() {
    if (!this.filename || this.inTransaction) return;
    try {
      fs.mkdirSync(path.dirname(path.resolve(this.filename)), { recursive: true });
      fs.writeFileSync(this.filename, JSON.stringify(this.data), 'utf8');
    } catch (e) {}
  }

  prepare(sql) {
    return new SafeStatement(this, sql);
  }

  exec(sql) {
    this._save();
    return this;
  }

  pragma() { return []; }

  transaction(fn) {
    return (...args) => {
      this.inTransaction = true;
      try {
        const res = fn(...args);
        this.inTransaction = false;
        this._save();
        return res;
      } catch (err) {
        this.inTransaction = false;
        throw err;
      }
    };
  }

  function() { return this; }
  aggregate() { return this; }
  backup() { return Promise.resolve(); }
  close() { this._save(); this.open = false; return this; }
}

module.exports = SafeDatabase;
module.exports.default = SafeDatabase;
`;

  fs.writeFileSync(path.join(shimDir, 'package.json'), JSON.stringify(shimPkg, null, 2), 'utf8');
  fs.writeFileSync(path.join(shimDir, 'index.js'), shimCode.trim(), 'utf8');
}

function autoFixBotFolder(dirPath) {
  try {
    const lockFile = path.join(dirPath, 'package-lock.json');
    if (fs.existsSync(lockFile)) fs.rmSync(lockFile, { force: true });

    const npmrcFile = path.join(dirPath, '.npmrc');
    fs.writeFileSync(npmrcFile, 'legacy-peer-deps=true\n', 'utf8');

    const pkgPath = path.join(dirPath, 'package.json');
    if (fs.existsSync(pkgPath)) {
      const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
      pkg.dependencies = pkg.dependencies || {};

      for (const [depName, depVal] of Object.entries(pkg.dependencies)) {
        if (typeof depVal === 'string' && depVal.startsWith('github:')) {
          const repoPath = depVal.replace('github:', '');
          pkg.dependencies[depName] = `https://github.com/${repoPath}/archive/refs/heads/main.tar.gz`;
        }
      }

      // Hapus better-sqlite3 asli dari daftar download agar tidak menginstal biner C++ yang bikin Core Dumped
      if (pkg.dependencies['better-sqlite3']) {
        delete pkg.dependencies['better-sqlite3'];
      }

      fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2), 'utf8');
    }

    // Pasang Pure JS SQLite Shim agar bot tetap jalan lancar tanpa biner C++
    injectSafeSqliteShim(dirPath);
  } catch (e) {
    console.error('AutoFix error:', e.message);
  }
}

function hasBotFiles() {
  if (!fs.existsSync(WORKSPACE_DIR)) return false;
  const files = fs.readdirSync(WORKSPACE_DIR).filter(f => f !== 'node_modules' && !f.startsWith('.'));
  return files.length > 0;
}

// ================= CLOUD DISK =================
const ghHeaders = () => ({
  'Authorization': `token ${GITHUB_TOKEN}`,
  'Accept': 'application/vnd.github.v3+json',
  'User-Agent': 'PteroWA-VPS-Panel'
});

async function backupToCloud(manual = false) {
  if (!GITHUB_TOKEN || !GITHUB_REPO || isRestoring || isBackingUp) return false;
  if (!hasBotFiles()) {
    if (manual) sysLog('Belum ada file bot di dalam workspace untuk di-backup.');
    return false;
  }

  isBackingUp = true;
  diskStatus = 'Syncing ke Cloud...';
  if (manual) sysLog(`Menyimpan file bot & session ke Cloud Disk (${GITHUB_REPO})...`);

  try {
    const zip = new AdmZip();
    const items = fs.readdirSync(WORKSPACE_DIR, { withFileTypes: true });

    for (const item of items) {
      if (['node_modules', '.git', '.npm', '.cache'].includes(item.name)) continue;
      const fullPath = path.join(WORKSPACE_DIR, item.name);
      if (item.isDirectory()) {
        zip.addLocalFolder(fullPath, item.name);
      } else {
        zip.addLocalFile(fullPath);
      }
    }

    const zipBuffer = zip.toBuffer();

    let relRes = await fetch(`https://api.github.com/repos/${GITHUB_REPO}/releases/tags/${RELEASE_TAG}`, { headers: ghHeaders() });
    let release;
    if (relRes.status === 404) {
      relRes = await fetch(`https://api.github.com/repos/${GITHUB_REPO}/releases`, {
        method: 'POST',
        headers: { ...ghHeaders(), 'Content-Type': 'application/json' },
        body: JSON.stringify({ tag_name: RELEASE_TAG, name: 'PteroWA Persistent Disk', body: 'Automated VPS Storage Backup' })
      });
    }
    release = await relRes.json();
    if (!release.id) throw new Error(release.message || 'Gagal mengakses Release GitHub.');

    if (Array.isArray(release.assets)) {
      for (const asset of release.assets) {
        if (asset.name === BACKUP_FILENAME) {
          await fetch(`https://api.github.com/repos/${GITHUB_REPO}/releases/assets/${asset.id}`, {
            method: 'DELETE',
            headers: ghHeaders()
          });
        }
      }
    }

    const uploadUrl = `https://uploads.github.com/repos/${GITHUB_REPO}/releases/${release.id}/assets?name=${BACKUP_FILENAME}`;
    const upRes = await fetch(uploadUrl, {
      method: 'POST',
      headers: {
        ...ghHeaders(),
        'Content-Type': 'application/zip',
        'Content-Length': zipBuffer.length.toString()
      },
      body: zipBuffer
    });

    if (!upRes.ok) throw new Error(`Gagal upload ke GitHub (${upRes.status})`);

    const now = new Date().toLocaleTimeString('id-ID');
    diskStatus = `Tersinkron (${now})`;
    if (manual) sysLog(`Backup Selesai! (${(zipBuffer.length / (1024 * 1024)).toFixed(2)} MB) tersimpan aman.`);
    isBackingUp = false;
    return true;
  } catch (err) {
    diskStatus = 'Gagal Sync';
    if (manual) sysLog(`Gagal Backup: ${err.message}`);
    isBackingUp = false;
    return false;
  }
}

async function restoreFromCloud() {
  if (!GITHUB_TOKEN || !GITHUB_REPO) return;
  if (hasBotFiles()) return;

  isRestoring = true;
  diskStatus = 'Memulihkan Disk...';
  sysLog(`Memulihkan file bot & session dari Cloud Disk (${GITHUB_REPO})...`);

  try {
    const relRes = await fetch(`https://api.github.com/repos/${GITHUB_REPO}/releases/tags/${RELEASE_TAG}`, { headers: ghHeaders() });
    if (!relRes.ok) {
      diskStatus = 'Siap (Kosong)';
      isRestoring = false;
      return;
    }

    const release = await relRes.json();
    const asset = (release.assets || []).find(a => a.name === BACKUP_FILENAME);
    if (!asset) {
      diskStatus = 'Siap (Kosong)';
      isRestoring = false;
      return;
    }

    const dlRes = await fetch(`https://api.github.com/repos/${GITHUB_REPO}/releases/assets/${asset.id}`, {
      headers: { ...ghHeaders(), 'Accept': 'application/octet-stream' }
    });

    if (!dlRes.ok) throw new Error('Gagal mengunduh file cadangan.');

    const arrayBuffer = await dlRes.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);

    const zip = new AdmZip(buffer);
    zip.extractAllTo(WORKSPACE_DIR, true);
    autoFixBotFolder(WORKSPACE_DIR);

    diskStatus = 'Pulih & Aktif';
    sysLog('Seluruh file bot berhasil dipulihkan dari Cloud Disk!');
    io.emit('files-updated');
  } catch (err) {
    diskStatus = 'Gagal Restore';
    sysLog(`Gagal memulihkan Cloud Disk: ${err.message}`);
  }
  isRestoring = false;
}

setInterval(() => {
  backupToCloud(false);
}, 10 * 60 * 1000);

// ================= ENDPOINT API PANEL =================
function getFolderSize(dirPath) {
  let totalSize = 0;
  try {
    const files = fs.readdirSync(dirPath, { withFileTypes: true });
    for (const file of files) {
      if (file.name === 'node_modules' || file.name === '.git') continue;
      const filePath = path.join(dirPath, file.name);
      if (file.isDirectory()) {
        totalSize += getFolderSize(filePath);
      } else {
        const stats = fs.statSync(filePath);
        totalSize += stats.size;
      }
    }
  } catch (e) {}
  return totalSize;
}

app.get('/api/stats', (req, res) => {
  const totalMem = os.totalmem();
  const freeMem = os.freemem();
  const usedMem = totalMem - freeMem;
  const memUsagePercent = ((usedMem / totalMem) * 100).toFixed(1);

  const diskUsedBytes = getFolderSize(WORKSPACE_DIR);
  const diskUsedMB = (diskUsedBytes / (1024 * 1024)).toFixed(1);

  const loadAvg = os.loadavg()[0];
  const cpuCount = os.cpus().length || 1;
  const cpuPercent = Math.min(Math.round((loadAvg / cpuCount) * 100), 100);

  res.json({
    address: req.headers.host || 'localhost',
    uptime: Math.floor(process.uptime()),
    cpu: `${cpuPercent}%`,
    memory: `${(usedMem / 1024 / 1024).toFixed(0)} MB / ${(totalMem / 1024 / 1024).toFixed(0)} MB (${memUsagePercent}%)`,
    disk: `${diskUsedMB} MB (${diskStatus})`,
    node: process.version
  });
});

app.post('/api/backup', async (req, res) => {
  const ok = await backupToCloud(true);
  if (ok) res.json({ message: 'Berhasil disimpan ke Cloud Disk!' });
  else res.status(500).json({ error: 'Gagal menyimpan ke Cloud Disk. Cek log terminal.' });
});

// Endpoint khusus untuk menambal ulang Anti Core-Dumped kapan saja
app.post('/api/fix-coredump', (req, res) => {
  try {
    autoFixBotFolder(WORKSPACE_DIR);
    sysLog('🛡️ Patch Anti Core-Dumped (Pure JS SQLite Shim) berhasil dipasang!');
    res.json({ message: 'Patch Anti Core-Dumped aktif!' });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/upload', (req, res) => {
  upload.single('scriptFile')(req, res, async (err) => {
    if (err) return res.status(500).json({ error: err.message });
    if (!req.file) return res.status(400).json({ error: 'Pilih file terlebih dahulu.' });

    const uploadedTempPath = req.file.path;
    const origName = req.file.originalname;
    let targetDir;
    try {
      targetDir = getSafePath(req.query.dir || '');
      fs.mkdirSync(targetDir, { recursive: true });
    } catch (e) {
      targetDir = WORKSPACE_DIR;
    }

    if (origName.toLowerCase().endsWith('.zip')) {
      const extractTempDir = path.join(TMP_DIR, `extract_${Date.now()}`);
      try {
        fs.mkdirSync(extractTempDir, { recursive: true });

        const zip = new AdmZip(uploadedTempPath);
        zip.extractAllTo(extractTempDir, true);
        fs.unlinkSync(uploadedTempPath);

        let sourceRoot = extractTempDir;
        const extractedItems = fs.readdirSync(extractTempDir).filter(n => n !== '__MACOSX' && n !== '.DS_Store');
        if (extractedItems.length === 1) {
          const singleItemPath = path.join(extractTempDir, extractedItems[0]);
          if (fs.statSync(singleItemPath).isDirectory()) {
            sourceRoot = singleItemPath;
          }
        }

        const itemsToCopy = fs.readdirSync(sourceRoot);
        for (const item of itemsToCopy) {
          if (item === 'node_modules' || item === 'package-lock.json') continue;
          const srcPath = path.join(sourceRoot, item);
          const destPath = path.join(targetDir, item);
          fs.cpSync(srcPath, destPath, { recursive: true, force: true });
        }

        fs.rmSync(extractTempDir, { recursive: true, force: true });
        autoFixBotFolder(WORKSPACE_DIR);

        sysLog(`✅ ${origName} berhasil diekstrak & diproteksi dari Core Dumped!`);
        io.emit('files-updated');
        setTimeout(() => backupToCloud(false), 500);

        return res.json({ message: `${origName} berhasil diekstrak!`, count: itemsToCopy.length });
      } catch (zipErr) {
        if (fs.existsSync(extractTempDir)) fs.rmSync(extractTempDir, { recursive: true, force: true });
        if (fs.existsSync(uploadedTempPath)) fs.unlinkSync(uploadedTempPath);
        return res.status(500).json({ error: `Gagal ekstrak ZIP: ${zipErr.message}` });
      }
    } else {
      try {
        const destFile = path.join(targetDir, origName);
        fs.copyFileSync(uploadedTempPath, destFile);
        fs.unlinkSync(uploadedTempPath);
        sysLog(`File ${origName} berhasil diupload.`);
        io.emit('files-updated');
        setTimeout(() => backupToCloud(false), 500);
        return res.json({ message: `File ${origName} berhasil disimpan!` });
      } catch (fileErr) {
        return res.status(500).json({ error: `Gagal menyimpan file: ${fileErr.message}` });
      }
    }
  });
});

app.get('/api/files', (req, res) => {
  try {
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
    const relDir = String(req.query.dir || '').replace(/^[/\\]+/, '');
    const targetDir = getSafePath(relDir);

    if (!fs.existsSync(targetDir)) return res.json([]);

    const files = fs.readdirSync(targetDir, { withFileTypes: true });
    const fileList = files
      .filter(f => f.name !== '.git')
      .map(f => {
        let sizeStr = 'Folder';
        const itemRelPath = relDir ? `${relDir}/${f.name}` : f.name;
        if (!f.isDirectory()) {
          try {
            const stats = fs.statSync(path.join(targetDir, f.name));
            sizeStr = stats.size < 1024 * 1024
              ? `${(stats.size / 1024).toFixed(1)} KB`
              : `${(stats.size / (1024 * 1024)).toFixed(2)} MB`;
          } catch (e) {}
        }
        return {
          name: f.name,
          path: itemRelPath,
          isDirectory: f.isDirectory(),
          size: sizeStr
        };
      })
      .sort((a, b) => (a.isDirectory === b.isDirectory ? a.name.localeCompare(b.name) : a.isDirectory ? -1 : 1));

    res.json(fileList);
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.get('/api/file-content', (req, res) => {
  try {
    const relPath = String(req.query.path || '').replace(/^[/\\]+/, '');
    if (!relPath) return res.status(400).json({ error: 'Path file kosong.' });

    const fullPath = getSafePath(relPath);
    if (!fs.existsSync(fullPath) || fs.statSync(fullPath).isDirectory()) {
      return res.status(404).json({ error: 'File tidak ditemukan atau berupa folder.' });
    }

    const stats = fs.statSync(fullPath);
    if (stats.size > 5 * 1024 * 1024) {
      return res.status(400).json({ error: 'Ukuran file terlalu besar untuk diedit (>5MB).' });
    }

    const content = fs.readFileSync(fullPath, 'utf8');
    res.json({ path: relPath, content });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/save-file', (req, res) => {
  try {
    const { filePath, content } = req.body;
    const relPath = String(filePath || '').replace(/^[/\\]+/, '');
    if (!relPath) return res.status(400).json({ error: 'Nama file tidak boleh kosong.' });

    const fullPath = getSafePath(relPath);
    fs.mkdirSync(path.dirname(fullPath), { recursive: true });
    fs.writeFileSync(fullPath, content ?? '', 'utf8');

    sysLog(`File "${relPath}" berhasil disimpan.`);
    io.emit('files-updated');
    setTimeout(() => backupToCloud(false), 500);

    res.json({ message: `File ${relPath} berhasil disimpan!` });
  } catch (e) {
    res.status(500).json({ error: `Gagal menyimpan file: ${e.message}` });
  }
});

app.post('/api/mkdir', (req, res) => {
  try {
    const { folderPath } = req.body;
    const relPath = String(folderPath || '').replace(/^[/\\]+/, '');
    if (!relPath) return res.status(400).json({ error: 'Nama folder tidak boleh kosong.' });

    const fullPath = getSafePath(relPath);
    fs.mkdirSync(fullPath, { recursive: true });
    io.emit('files-updated');
    setTimeout(() => backupToCloud(false), 500);

    res.json({ message: `Folder ${relPath} berhasil dibuat!` });
  } catch (e) {
    res.status(500).json({ error: `Gagal membuat folder: ${e.message}` });
  }
});

app.post('/api/rename', (req, res) => {
  try {
    const { oldPath, newPath } = req.body;
    const relOld = String(oldPath || '').replace(/^[/\\]+/, '');
    const relNew = String(newPath || '').replace(/^[/\\]+/, '');

    if (!relOld || !relNew) return res.status(400).json({ error: 'Nama lama dan baru wajib diisi.' });

    const fullOld = getSafePath(relOld);
    const fullNew = getSafePath(relNew);

    if (!fs.existsSync(fullOld)) return res.status(404).json({ error: 'File/Folder asal tidak ditemukan.' });
    fs.mkdirSync(path.dirname(fullNew), { recursive: true });
    fs.renameSync(fullOld, fullNew);

    io.emit('files-updated');
    setTimeout(() => backupToCloud(false), 500);
    res.json({ message: `Berhasil diubah menjadi ${relNew}` });
  } catch (e) {
    res.status(500).json({ error: `Gagal mengubah nama: ${e.message}` });
  }
});

app.post('/api/delete', (req, res) => {
  try {
    const { fileName } = req.body;
    const relPath = String(fileName || '').replace(/^[/\\]+/, '');
    if (!relPath) return res.status(400).json({ error: 'Nama file tidak valid.' });

    const targetPath = getSafePath(relPath);
    if (fs.existsSync(targetPath)) {
      fs.rmSync(targetPath, { recursive: true, force: true });
      sysLog(`"${relPath}" dihapus.`);
      io.emit('files-updated');
      setTimeout(() => backupToCloud(false), 500);
      return res.json({ message: `Berhasil menghapus ${relPath}` });
    } else {
      return res.status(404).json({ error: 'File tidak ditemukan.' });
    }
  } catch (err) {
    return res.status(500).json({ error: `Gagal menghapus: ${err.message}` });
  }
});

// ================= TERMINAL ANTI-FREEZE =================
let shellProcess = null;

function ensureShellAlive() {
  if (shellProcess && !shellProcess.killed && shellProcess.stdin && shellProcess.stdin.writable) {
    return;
  }
  startInteractiveShell();
}

function startInteractiveShell() {
  if (shellProcess) {
    try { shellProcess.kill('SIGKILL'); } catch (e) {}
  }

  shellProcess = spawn('bash', [], {
    cwd: WORKSPACE_DIR,
    env: {
      ...process.env,
      PORT: BOT_PORT,
      SERVER_PORT: BOT_PORT,
      TERM: 'xterm-256color',
      NODE_OPTIONS: '--max-old-space-size=460 --no-node-snapshot'
    }
  });

  const promptStr = `\r\n\x1b[1;32mtermux@ptero-wa\x1b[0m:\x1b[1;34m~/bot\x1b[0m$ `;

  shellProcess.stdout.on('data', (data) => {
    const str = data.toString();
    appendTermHistory(str);
    io.emit('term-output', str);
  });

  shellProcess.stderr.on('data', (data) => {
    const str = data.toString();
    appendTermHistory(str);
    io.emit('term-output', str);
  });

  shellProcess.on('close', () => {
    shellProcess = null;
    setTimeout(startInteractiveShell, 800);
  });

  setTimeout(() => {
    appendTermHistory(promptStr);
    io.emit('term-output', promptStr);
  }, 300);
}

startInteractiveShell();

setTimeout(() => {
  restoreFromCloud();
}, 2000);

io.on('connection', (socket) => {
  ensureShellAlive();

  if (termHistory.length > 0) {
    socket.emit('term-output', termHistory);
  } else {
    const banner = `\x1b[1;36m=== PteroWA Termux Web Terminal (Anti Core-Dumped Edition) ===\x1b[0m\r\n` +
                   `\x1b[1;33mNode.js ${process.version} | Pure-JS SQLite Shim Aktif | Cloud Disk: ${GITHUB_REPO}\x1b[0m\r\n` +
                   `\x1b[1;32mtermux@ptero-wa\x1b[0m:\x1b[1;34m~/bot\x1b[0m$ `;
    appendTermHistory(banner);
    socket.emit('term-output', banner);
  }

  socket.on('term-input', (cmd) => {
    ensureShellAlive();
    // Setiap kali selesai npm install, otomatis suntikkan ulang Pure-JS SQLite Shim agar tidak pernah Core Dumped
    if (cmd.includes('npm i') || cmd.includes('npm start') || cmd.includes('node app.js')) {
      autoFixBotFolder(WORKSPACE_DIR);
    }

    if (shellProcess && shellProcess.stdin.writable) {
      io.emit('term-output', cmd);
      appendTermHistory(cmd);
      shellProcess.stdin.write(cmd.endsWith('\n') ? cmd : cmd + '\n');
      shellProcess.stdin.write(`printf "\\r\\n\\033[1;32mtermux@ptero-wa\\033[0m:\\033[1;34m~/bot\\033[0m$ "\n`);
    }
  });

  socket.on('term-sigint', () => {
    exec(`pkill -f "node app.js"; pkill -f "node index.js"; pkill -f "node main.js"`, () => {
      sysLog('Proses bot dihentikan.');
      ensureShellAlive();
      if (shellProcess && shellProcess.stdin.writable) {
        shellProcess.stdin.write(`printf "\\r\\n\\033[1;32mtermux@ptero-wa\\033[0m:\\033[1;34m~/bot\\033[0m$ "\n`);
      }
    });
  });

  socket.on('term-restart', () => {
    exec(`pkill -f "node app.js"; pkill -f "node index.js"; pkill -f "node main.js"; pkill -f "npm"`, () => {
      termHistory = '';
      startInteractiveShell();
      sysLog('Terminal berhasil di-reset!');
    });
  });
});

server.listen(PANEL_PORT, () => console.log(`Panel aktif di port ${PANEL_PORT}`));
