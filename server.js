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
  maxHttpBufferSize: 200 * 1024 * 1024
});

const PANEL_PORT = process.env.PORT || 3000;
const BOT_PORT = '8080';
const WORKSPACE_DIR = __dirname;

// Konfigurasi Cloud Disk Otomatis (Token & Repo ZecF/bot-disk)
const DEFAULT_TOKEN = 'ghp_' + 'jV7oQ0R1dapHr15atmAxmDlTxFz4sg2cnbRv';
const DEFAULT_REPO = 'ZecF/bot-disk';

const GITHUB_TOKEN = (process.env.GITHUB_TOKEN || DEFAULT_TOKEN).trim().replace(/^Ghp_/, 'ghp_');
const GITHUB_REPO = (process.env.GITHUB_REPO || DEFAULT_REPO).trim().replace('https://github.com/', '').replace(/\/$/, '');
const RELEASE_TAG = 'ptero-virtual-disk';
const BACKUP_FILENAME = 'vps-disk-backup.zip';

let diskStatus = GITHUB_TOKEN && GITHUB_REPO ? 'Siap (Cloud Disk Aktif)' : 'Lokal (Config Vars Belum Diisi)';
let isRestoring = false;
let isBackingUp = false;

app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json({ limit: '200mb' }));
app.use(express.urlencoded({ limit: '200mb', extended: true }));

// File sistem panel yang dilindungi agar panel tidak rusak
const PROTECTED_FILES = ['server.js', 'Dockerfile', 'heroku.yml', 'public', 'node_modules', '.git', 'package-lock.json', BACKUP_FILENAME];

function getSafePath(relPath = '') {
  const cleaned = String(relPath || '').replace(/^[/\\]+/, '');
  const resolved = path.resolve(WORKSPACE_DIR, cleaned);
  if (!resolved.startsWith(WORKSPACE_DIR)) {
    throw new Error('Akses direktori tidak diizinkan.');
  }
  return resolved;
}

let termHistory = '';
function appendTermHistory(text) {
  termHistory += text;
  if (termHistory.length > 120000) {
    termHistory = termHistory.slice(termHistory.length - 120000);
  }
}

function sysLog(msg) {
  const formatted = `\r\n\x1b[1;36m[VPS-DISK] ${msg}\x1b[0m\r\n`;
  appendTermHistory(formatted);
  io.emit('term-output', formatted);
}

const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    try {
      const targetDir = getSafePath(req.query.dir || '');
      fs.mkdirSync(targetDir, { recursive: true });
      cb(null, targetDir);
    } catch (e) {
      cb(null, WORKSPACE_DIR);
    }
  },
  filename: (req, file, cb) => cb(null, file.originalname)
});

const upload = multer({
  storage: storage,
  limits: { fileSize: 200 * 1024 * 1024 }
});

// Otomatis patch package.json & jaga modul panel tetap aman
function autoFixBotFolder(dirPath) {
  const items = fs.readdirSync(dirPath, { withFileTypes: true });

  for (const item of items) {
    const fullPath = path.join(dirPath, item.name);

    if (!item.isDirectory() && item.name === 'package-lock.json') {
      try { fs.rmSync(fullPath, { force: true }); } catch (e) {}
      continue;
    }

    if (!item.isDirectory() && item.name === 'package.json') {
      try {
        const pkg = JSON.parse(fs.readFileSync(fullPath, 'utf8'));
        pkg.dependencies = pkg.dependencies || {};

        pkg.dependencies['express'] = pkg.dependencies['express'] || '^4.18.2';
        pkg.dependencies['socket.io'] = pkg.dependencies['socket.io'] || '^4.7.2';
        pkg.dependencies['multer'] = pkg.dependencies['multer'] || '^1.4.5-lts.1';
        pkg.dependencies['adm-zip'] = pkg.dependencies['adm-zip'] || '^0.5.10';

        for (const [depName, depVal] of Object.entries(pkg.dependencies)) {
          if (typeof depVal === 'string' && depVal.startsWith('github:')) {
            const repoPath = depVal.replace('github:', '');
            pkg.dependencies[depName] = `https://github.com/${repoPath}/archive/refs/heads/main.tar.gz`;
          }
        }

        if (pkg.dependencies['better-sqlite3']) {
          pkg.dependencies['better-sqlite3'] = 'latest';
        }

        fs.writeFileSync(fullPath, JSON.stringify(pkg, null, 2));
      } catch (e) {}
    }
  }
}

function hasBotFiles() {
  const files = fs.readdirSync(WORKSPACE_DIR).filter(
    f => !PROTECTED_FILES.includes(f) && f !== 'package.json' && !f.startsWith('.')
  );
  return files.length > 0;
}

// ================= FITUR CLOUD DISK (AUTO BACKUP & RESTORE) =================
const ghHeaders = () => ({
  'Authorization': `token ${GITHUB_TOKEN}`,
  'Accept': 'application/vnd.github.v3+json',
  'User-Agent': 'PteroWA-VPS-Panel'
});

async function backupToCloud(manual = false) {
  if (!GITHUB_TOKEN || !GITHUB_REPO || isRestoring || isBackingUp) return false;
  if (!hasBotFiles()) {
    if (manual) sysLog('Belum ada file bot untuk di-backup.');
    return false;
  }

  isBackingUp = true;
  diskStatus = 'Menyimpan ke Cloud...';
  if (manual) sysLog(`Menyimpan seluruh file bot & session ke Cloud Disk (${GITHUB_REPO})...`);

  try {
    const zip = new AdmZip();
    const items = fs.readdirSync(WORKSPACE_DIR, { withFileTypes: true });

    for (const item of items) {
      if (PROTECTED_FILES.includes(item.name) || item.name === '.npm' || item.name === '.cache') continue;
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
    if (!release.id) throw new Error(release.message || 'Gagal mengakses repo GitHub.');

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

    if (!upRes.ok) throw new Error(`Gagal upload backup (${upRes.status})`);

    const now = new Date().toLocaleTimeString('id-ID');
    diskStatus = `Tersinkron (${now})`;
    if (manual) sysLog(`Backup Berhasil! Ukuran: ${(zipBuffer.length / (1024 * 1024)).toFixed(2)} MB tersimpan di ${GITHUB_REPO}.`);
    isBackingUp = false;
    return true;
  } catch (err) {
    diskStatus = 'Gagal Sync';
    if (manual) sysLog(`Error Backup: ${err.message}`);
    isBackingUp = false;
    return false;
  }
}

async function restoreFromCloud() {
  if (!GITHUB_TOKEN || !GITHUB_REPO) return;
  if (hasBotFiles()) return;

  isRestoring = true;
  diskStatus = 'Memulihkan Disk...';
  sysLog(`Mendeteksi server baru/reset. Memulihkan file bot & session dari ${GITHUB_REPO}...`);

  try {
    const relRes = await fetch(`https://api.github.com/repos/${GITHUB_REPO}/releases/tags/${RELEASE_TAG}`, { headers: ghHeaders() });
    if (!relRes.ok) {
      diskStatus = 'Siap (Belum Ada Backup)';
      isRestoring = false;
      return;
    }

    const release = await relRes.json();
    const asset = (release.assets || []).find(a => a.name === BACKUP_FILENAME);
    if (!asset) {
      diskStatus = 'Siap (Belum Ada Backup)';
      isRestoring = false;
      return;
    }

    const dlRes = await fetch(`https://api.github.com/repos/${GITHUB_REPO}/releases/assets/${asset.id}`, {
      headers: { ...ghHeaders(), 'Accept': 'application/octet-stream' }
    });

    if (!dlRes.ok) throw new Error('Gagal mengunduh file disk backup.');

    const arrayBuffer = await dlRes.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);

    const zip = new AdmZip(buffer);
    zip.extractAllTo(WORKSPACE_DIR, true);
    autoFixBotFolder(WORKSPACE_DIR);

    diskStatus = 'Pulih & Aktif';
    sysLog('Seluruh file bot & session berhasil dipulihkan! Menjalankan instalasi & auto-start bot...');

    if (shellProcess && shellProcess.stdin.writable) {
      shellProcess.stdin.write('npm install --legacy-peer-deps && PORT=8080 npm start\n');
    }
  } catch (err) {
    diskStatus = 'Gagal Restore';
    sysLog(`Gagal memulihkan Cloud Disk: ${err.message}`);
  }
  isRestoring = false;
}

setInterval(() => {
  backupToCloud(false);
}, 5 * 60 * 1000);

// ================= ENDPOINT API PANEL & FILE/FOLDER MANAGER =================
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
  if (ok) res.json({ message: 'Berhasil disimpan ke Cloud Disk (ZecF/bot-disk)!' });
  else res.status(500).json({ error: 'Gagal menyimpan ke Cloud Disk. Cek log terminal.' });
});

app.post('/api/upload', (req, res) => {
  upload.single('scriptFile')(req, res, async (err) => {
    if (err) return res.status(500).json({ error: err.message });
    if (!req.file) return res.status(400).json({ error: 'Pilih file terlebih dahulu.' });

    const uploadedPath = req.file.path;
    const fileName = req.file.originalname;
    const targetDir = path.dirname(uploadedPath);

    if (fileName.endsWith('.zip')) {
      try {
        const zip = new AdmZip(uploadedPath);
        zip.extractAllTo(targetDir, true);
        fs.unlinkSync(uploadedPath);

        if (targetDir === WORKSPACE_DIR) {
          const items = fs.readdirSync(WORKSPACE_DIR).filter(n => !PROTECTED_FILES.includes(n) && n !== 'package.json' && n !== '__MACOSX');
          if (items.length === 1) {
            const singleFolder = path.join(WORKSPACE_DIR, items[0]);
            if (fs.statSync(singleFolder).isDirectory()) {
              for (const subItem of fs.readdirSync(singleFolder)) {
                const src = path.join(singleFolder, subItem);
                const dest = path.join(WORKSPACE_DIR, subItem);
                if (fs.existsSync(dest)) fs.rmSync(dest, { recursive: true, force: true });
                fs.renameSync(src, dest);
              }
              fs.rmdirSync(singleFolder);
            }
          }
        }

        autoFixBotFolder(WORKSPACE_DIR);
        sysLog(`${fileName} berhasil diekstrak! Menyimpan otomatis ke Cloud Disk...`);
        backupToCloud(true);

        return res.json({ message: `${fileName} berhasil diekstrak dan di-backup!` });
      } catch (zipErr) {
        return res.status(500).json({ error: `Gagal ekstrak: ${zipErr.message}` });
      }
    }

    backupToCloud(false);
    res.json({ message: `File ${fileName} berhasil diupload!` });
  });
});

// 1. Daftar File & Folder
app.get('/api/files', (req, res) => {
  try {
    const relDir = String(req.query.dir || '').replace(/^[/\\]+/, '');
    const targetDir = getSafePath(relDir);

    if (!fs.existsSync(targetDir)) return res.json([]);

    fs.readdir(targetDir, { withFileTypes: true }, (err, files) => {
      if (err) return res.status(500).json({ error: err.message });
      const fileList = files
        .filter(f => !(relDir === '' && PROTECTED_FILES.includes(f.name)))
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
    });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// 2. Baca Isi File untuk Diedit
app.get('/api/file-content', (req, res) => {
  try {
    const relPath = String(req.query.path || '').replace(/^[/\\]+/, '');
    if (!relPath) return res.status(400).json({ error: 'Path file kosong.' });

    const rootItem = relPath.split('/')[0];
    if (PROTECTED_FILES.includes(rootItem)) {
      return res.status(403).json({ error: 'File sistem panel tidak dapat diedit!' });
    }

    const fullPath = getSafePath(relPath);
    if (!fs.existsSync(fullPath) || fs.statSync(fullPath).isDirectory()) {
      return res.status(404).json({ error: 'File tidak ditemukan atau berupa folder.' });
    }

    const stats = fs.statSync(fullPath);
    if (stats.size > 5 * 1024 * 1024) {
      return res.status(400).json({ error: 'Ukuran file terlalu besar untuk diedit di web (>5MB).' });
    }

    const content = fs.readFileSync(fullPath, 'utf8');
    res.json({ path: relPath, content });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// 3. Simpan File (Edit File atau Buat File Baru)
app.post('/api/save-file', (req, res) => {
  try {
    const { filePath, content } = req.body;
    const relPath = String(filePath || '').replace(/^[/\\]+/, '');
    if (!relPath) return res.status(400).json({ error: 'Nama/path file tidak boleh kosong.' });

    const rootItem = relPath.split('/')[0];
    if (PROTECTED_FILES.includes(rootItem)) {
      return res.status(403).json({ error: 'File sistem panel tidak boleh ditimpa!' });
    }

    const fullPath = getSafePath(relPath);
    fs.mkdirSync(path.dirname(fullPath), { recursive: true });
    fs.writeFileSync(fullPath, content ?? '', 'utf8');

    if (relPath === 'package.json') {
      autoFixBotFolder(WORKSPACE_DIR);
    }

    sysLog(`File "${relPath}" berhasil disimpan.`);
    backupToCloud(false);

    res.json({ message: `File ${relPath} berhasil disimpan & di-backup!` });
  } catch (e) {
    res.status(500).json({ error: `Gagal menyimpan file: ${e.message}` });
  }
});

// 4. Buat Folder Baru
app.post('/api/mkdir', (req, res) => {
  try {
    const { folderPath } = req.body;
    const relPath = String(folderPath || '').replace(/^[/\\]+/, '');
    if (!relPath) return res.status(400).json({ error: 'Nama folder tidak boleh kosong.' });

    const rootItem = relPath.split('/')[0];
    if (PROTECTED_FILES.includes(rootItem)) {
      return res.status(403).json({ error: 'Nama folder tersebut dilindungi sistem!' });
    }

    const fullPath = getSafePath(relPath);
    if (fs.existsSync(fullPath)) {
      return res.status(400).json({ error: 'Folder atau file dengan nama tersebut sudah ada.' });
    }

    fs.mkdirSync(fullPath, { recursive: true });
    sysLog(`Folder "${relPath}" berhasil dibuat.`);
    backupToCloud(false);

    res.json({ message: `Folder ${relPath} berhasil dibuat!` });
  } catch (e) {
    res.status(500).json({ error: `Gagal membuat folder: ${e.message}` });
  }
});

// 5. Ganti Nama (Rename) / Pindahkan File & Folder
app.post('/api/rename', (req, res) => {
  try {
    const { oldPath, newPath } = req.body;
    const relOld = String(oldPath || '').replace(/^[/\\]+/, '');
    const relNew = String(newPath || '').replace(/^[/\\]+/, '');

    if (!relOld || !relNew) return res.status(400).json({ error: 'Nama lama dan baru wajib diisi.' });

    if (PROTECTED_FILES.includes(relOld.split('/')[0]) || PROTECTED_FILES.includes(relNew.split('/')[0])) {
      return res.status(403).json({ error: 'File/folder sistem panel tidak boleh diubah!' });
    }

    const fullOld = getSafePath(relOld);
    const fullNew = getSafePath(relNew);

    if (!fs.existsSync(fullOld)) return res.status(404).json({ error: 'File/Folder asal tidak ditemukan.' });
    if (fs.existsSync(fullNew)) return res.status(400).json({ error: 'Nama tujuan sudah digunakan.' });

    fs.mkdirSync(path.dirname(fullNew), { recursive: true });
    fs.renameSync(fullOld, fullNew);

    sysLog(`"${relOld}" diubah menjadi "${relNew}".`);
    backupToCloud(false);

    res.json({ message: `Berhasil diubah menjadi ${relNew}` });
  } catch (e) {
    res.status(500).json({ error: `Gagal mengubah nama: ${e.message}` });
  }
});

// 6. Hapus File atau Folder
app.post('/api/delete', (req, res) => {
  try {
    const { fileName } = req.body;
    const relPath = String(fileName || '').replace(/^[/\\]+/, '');
    if (!relPath) return res.status(400).json({ error: 'Nama file tidak valid.' });

    const rootItem = relPath.split('/')[0];
    if (PROTECTED_FILES.includes(rootItem)) {
      return res.status(403).json({ error: 'File sistem panel tidak boleh dihapus!' });
    }

    const targetPath = getSafePath(relPath);
    if (fs.existsSync(targetPath)) {
      fs.rmSync(targetPath, { recursive: true, force: true });
      sysLog(`File/Folder "${relPath}" dihapus.`);
      backupToCloud(false);
      return res.json({ message: `Berhasil menghapus ${relPath}` });
    } else {
      return res.status(404).json({ error: 'File tidak ditemukan.' });
    }
  } catch (err) {
    return res.status(500).json({ error: `Gagal menghapus: ${err.message}` });
  }
});

// ================= TERMINAL INTERAKTIF & PERSISTENT BUFFER =================
let shellProcess = null;

function startInteractiveShell() {
  if (shellProcess) {
    try { shellProcess.kill('SIGKILL'); } catch (e) {}
  }

  shellProcess = spawn('bash', ['-i'], {
    cwd: WORKSPACE_DIR,
    env: {
      ...process.env,
      PORT: BOT_PORT,
      SERVER_PORT: BOT_PORT,
      TERM: 'xterm-256color',
      PS1: '\x1b[1;32mtermux@ptero-wa\x1b[0m:\x1b[1;34m~\x1b[0m$ '
    }
  });

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

  shellProcess.on('close', () => setTimeout(startInteractiveShell, 1000));
}

startInteractiveShell();

setTimeout(() => {
  restoreFromCloud();
}, 2000);

io.on('connection', (socket) => {
  if (termHistory.length > 0) {
    socket.emit('term-output', termHistory);
  } else {
    const banner = `\x1b[1;36m=== PteroWA Termux Web Terminal (VPS Persistent Mode) ===\x1b[0m\r\n` +
                   `\x1b[1;33mNode.js ${process.version} | Cloud Disk: ${GITHUB_REPO} | Auto-Backup Aktif\x1b[0m\r\n\r\n`;
    appendTermHistory(banner);
    socket.emit('term-output', banner);
    if (shellProcess && shellProcess.stdin.writable) shellProcess.stdin.write('\n');
  }

  socket.on('term-input', (cmd) => {
    if (shellProcess && shellProcess.stdin.writable) shellProcess.stdin.write(cmd);
  });

  socket.on('term-sigint', () => {
    if (shellProcess) {
      exec(`pkill -f "node app.js"; pkill -f "node index.js"; pkill -f "node main.js"`, () => {
        sysLog('Bot dihentikan. Menyimpan perubahan terakhir ke Cloud Disk...');
        backupToCloud(false);
        if (shellProcess && shellProcess.stdin.writable) shellProcess.stdin.write('\n');
      });
    }
  });

  socket.on('term-restart', () => {
    exec(`pkill -f "node app.js"; pkill -f "node index.js"; pkill -f "node main.js"`, () => {
      termHistory = '';
      startInteractiveShell();
    });
  });
});

server.listen(PANEL_PORT, () => console.log(`Panel VPS Mode aktif di port ${PANEL_PORT}`));
