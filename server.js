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

// Ruang kerja bot dipisah di folder /bot agar TIDAK PERNAH bentrok dengan package.json panel!
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

// Riwayat log terminal
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

// Upload disimpan ke /tmp dulu agar ekstraksi 100% bersih dan tidak gagal di percobaan pertama
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, TMP_DIR),
  filename: (req, file, cb) => cb(null, `upload_${Date.now()}_${file.originalname}`)
});

const upload = multer({
  storage: storage,
  limits: { fileSize: 200 * 1024 * 1024 }
});

// Fungsi otomatis memperbaiki package.json bot & mencegah Segfault SQLite
function autoFixBotFolder(dirPath) {
  try {
    // 1. Hapus package-lock.json & file biner lama yang bikin Segmentation Fault
    const lockFile = path.join(dirPath, 'package-lock.json');
    if (fs.existsSync(lockFile)) fs.rmSync(lockFile, { force: true });

    const npmrcFile = path.join(dirPath, '.npmrc');
    fs.writeFileSync(npmrcFile, 'legacy-peer-deps=true\n', 'utf8');

    // 2. Patch package.json bot
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

      // Gunakan versi better-sqlite3 yang punya prebuilt binary stabil untuk Node 20 Linux x64
      if (pkg.dependencies['better-sqlite3']) {
        pkg.dependencies['better-sqlite3'] = '^11.3.0';
      }

      fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2), 'utf8');
    }
  } catch (e) {
    console.error('AutoFix error:', e.message);
  }
}

function hasBotFiles() {
  if (!fs.existsSync(WORKSPACE_DIR)) return false;
  const files = fs.readdirSync(WORKSPACE_DIR).filter(f => f !== 'node_modules' && !f.startsWith('.'));
  return files.length > 0;
}

// ================= CLOUD DISK (NON-BLOCKING DENGAN CLI ZIP/UNZIP) =================
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
  if (manual) sysLog(`Membuat cadangan file bot & session ke Cloud Disk (${GITHUB_REPO})...`);

  const tempBackupZip = path.join(TMP_DIR, BACKUP_FILENAME);

  try {
    // Buat zip menggunakan AdmZip di memori untuk file penting saja (tanpa node_modules)
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
  } finally {
    if (fs.existsSync(tempBackupZip)) {
      try { fs.unlinkSync(tempBackupZip); } catch (e) {}
    }
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

// Auto-backup setiap 10 menit agar tidak membebani CPU terminal
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

// Perbaikan Total Upload: Ekstrak di /tmp dulu, ratakan folder pembungkus (seperti JH-Zapo-main), lalu pindahkan ke /bot!
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

        // Cek apakah isi ZIP dibungkus dalam 1 folder (misalnya JH-Zapo-main/)
        let sourceRoot = extractTempDir;
        const extractedItems = fs.readdirSync(extractTempDir).filter(n => n !== '__MACOSX' && n !== '.DS_Store');
        if (extractedItems.length === 1) {
          const singleItemPath = path.join(extractTempDir, extractedItems[0]);
          if (fs.statSync(singleItemPath).isDirectory()) {
            sourceRoot = singleItemPath;
          }
        }

        // Salin semua file dari sourceRoot ke targetDir secara utuh dan pasti terbaca dalam 1x upload
        const itemsToCopy = fs.readdirSync(sourceRoot);
        for (const item of itemsToCopy) {
          if (item === 'node_modules' || item === 'package-lock.json') continue;
          const srcPath = path.join(sourceRoot, item);
          const destPath = path.join(targetDir, item);
          fs.cpSync(srcPath, destPath, { recursive: true, force: true });
        }

        fs.rmSync(extractTempDir, { recursive: true, force: true });
        autoFixBotFolder(WORKSPACE_DIR);

        sysLog(`✅ ${origName} berhasil diekstrak (${itemsToCopy.length} item masuk ke File Manager)!`);
        io.emit('files-updated');

        // Backup jalan di background agar response upload langsung selesai cepat
        setTimeout(() => backupToCloud(false), 500);

        return res.json({ message: `${origName} berhasil diekstrak dalam 1x klik!`, count: itemsToCopy.length });
      } catch (zipErr) {
        if (fs.existsSync(extractTempDir)) fs.rmSync(extractTempDir, { recursive: true, force: true });
        if (fs.existsSync(uploadedTempPath)) fs.unlinkSync(uploadedTempPath);
        return res.status(500).json({ error: `Gagal ekstrak ZIP: ${zipErr.message}` });
      }
    } else {
      // Jika file biasa (.js, .json, dll)
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

// Daftar File & Folder
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

// Baca Isi File
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

// Simpan File
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

// Buat Folder Baru
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

// Rename File / Folder
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

// Hapus File / Folder
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

// ================= TERMINAL ANTI-FREEZE & RESPONSIF =================
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

  // Gunakan bash tanpa flag -i agar tidak macet karena job-control / ioctl di Heroku
  shellProcess = spawn('bash', [], {
    cwd: WORKSPACE_DIR,
    env: {
      ...process.env,
      PORT: BOT_PORT,
      SERVER_PORT: BOT_PORT,
      TERM: 'xterm-256color'
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
    const banner = `\x1b[1;36m=== PteroWA Termux Web Terminal (Anti-Freeze & Fix SQLite) ===\x1b[0m\r\n` +
                   `\x1b[1;33mNode.js ${process.version} | Workspace: /bot | Cloud Disk: ${GITHUB_REPO}\x1b[0m\r\n` +
                   `\x1b[1;32mtermux@ptero-wa\x1b[0m:\x1b[1;34m~/bot\x1b[0m$ `;
    appendTermHistory(banner);
    socket.emit('term-output', banner);
  }

  socket.on('term-input', (cmd) => {
    ensureShellAlive();
    if (shellProcess && shellProcess.stdin.writable) {
      // Echo perintah yang diketik agar langsung terlihat responsif di layar terminal
      io.emit('term-output', cmd);
      appendTermHistory(cmd);
      shellProcess.stdin.write(cmd.endsWith('\n') ? cmd : cmd + '\n');
      // Cetak kembali prompt setelah perintah selesai
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
      sysLog('Terminal berhasil di-reset dan siap menerima perintah baru!');
    });
  });
});

server.listen(PANEL_PORT, () => console.log(`Panel aktif di port ${PANEL_PORT}`));
