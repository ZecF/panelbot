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
  maxHttpBufferSize: 200 * 1024 * 1024 // Dukungan upload file hingga 200MB
});

const PANEL_PORT = process.env.PORT || 3000;
const BOT_PORT = '8080';

// Langsung menggunakan root folder aplikasi (/app) sebagai direktori kerja utama
const WORKSPACE_DIR = __dirname;

app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json({ limit: '200mb' }));
app.use(express.urlencoded({ limit: '200mb', extended: true }));

// Daftar file/folder milik panel web yang TIDAK BOLEH ikut terhapus atau tertimpa
const PROTECTED_FILES = ['server.js', 'package.json', 'Dockerfile', 'heroku.yml', 'public', 'node_modules', '.git'];

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, WORKSPACE_DIR),
  filename: (req, file, cb) => cb(null, file.originalname)
});

const upload = multer({
  storage: storage,
  limits: { fileSize: 200 * 1024 * 1024 }
});

// Fungsi otomatis patch package.json, ubah github: jadi tarball, & hapus node_modules bawaan zip
function autoFixBotFolder(dirPath) {
  const items = fs.readdirSync(dirPath, { withFileTypes: true });

  for (const item of items) {
    if (PROTECTED_FILES.includes(item.name)) continue;
    const fullPath = path.join(dirPath, item.name);

    if (item.isDirectory() && item.name === 'node_modules') {
      fs.rmSync(fullPath, { recursive: true, force: true });
      continue;
    }
    if (!item.isDirectory() && item.name === 'package-lock.json') {
      fs.rmSync(fullPath, { force: true });
      continue;
    }

    if (!item.isDirectory() && item.name === 'package.json') {
      try {
        const pkg = JSON.parse(fs.readFileSync(fullPath, 'utf8'));
        let modified = false;

        if (pkg.dependencies) {
          for (const [depName, depVal] of Object.entries(pkg.dependencies)) {
            if (typeof depVal === 'string' && depVal.startsWith('github:')) {
              const repoPath = depVal.replace('github:', '');
              pkg.dependencies[depName] = `https://github.com/${repoPath}/archive/refs/heads/main.tar.gz`;
              modified = true;
            }
          }
        }

        if (pkg.dependencies && pkg.dependencies['better-sqlite3']) {
          pkg.dependencies['better-sqlite3'] = 'latest';
          modified = true;
        }

        if (modified) {
          fs.writeFileSync(fullPath, JSON.stringify(pkg, null, 2));
        }
      } catch (e) {}
    }
  }
}

// Fungsi untuk menghitung total ukuran disk folder bot
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

// Endpoint API Statistik Server Real-time untuk Dashboard
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
    disk: `${diskUsedMB} MB / 500 MB`,
    node: process.version
  });
});

// Endpoint Upload: Langsung ekstrak ke root utama & ratakan isinya
app.post('/api/upload', (req, res) => {
  upload.single('scriptFile')(req, res, (err) => {
    if (err) return res.status(500).json({ error: err.message });
    if (!req.file) return res.status(400).json({ error: 'Pilih file terlebih dahulu.' });

    const uploadedPath = req.file.path;
    const fileName = req.file.originalname;

    if (fileName.endsWith('.zip')) {
      try {
        const zip = new AdmZip(uploadedPath);
        zip.extractAllTo(WORKSPACE_DIR, true);
        fs.unlinkSync(uploadedPath);

        const items = fs.readdirSync(WORKSPACE_DIR).filter(n => !PROTECTED_FILES.includes(n) && n !== '__MACOSX');
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

        autoFixBotFolder(WORKSPACE_DIR);

        io.emit('term-output', `\r\n\x1b[1;32m[SYSTEM] ${fileName} berhasil diekstrak langsung ke root utama & di-patch!\x1b[0m\r\n`);
        return res.json({ message: `${fileName} berhasil diekstrak dan siap di-install!` });
      } catch (zipErr) {
        return res.status(500).json({ error: `Gagal ekstrak: ${zipErr.message}` });
      }
    }

    res.json({ message: `File ${fileName} berhasil diupload!` });
  });
});

// Endpoint API: Hapus File atau Folder Bot lewat Tombol Sampah (🗑️)
app.post('/api/delete', (req, res) => {
  const { fileName } = req.body;
  if (!fileName) return res.status(400).json({ error: 'Nama file tidak valid.' });

  if (PROTECTED_FILES.includes(fileName)) {
    return res.status(403).json({ error: 'File sistem panel tidak boleh dihapus!' });
  }

  const targetPath = path.join(WORKSPACE_DIR, fileName);
  if (fs.existsSync(targetPath)) {
    try {
      fs.rmSync(targetPath, { recursive: true, force: true });
      io.emit('term-output', `\r\n\x1b[1;33m[SYSTEM] File/Folder "${fileName}" berhasil dihapus.\x1b[0m\r\n`);
      return res.json({ message: `Berhasil menghapus ${fileName}` });
    } catch (err) {
      return res.status(500).json({ error: `Gagal menghapus: ${err.message}` });
    }
  } else {
    return res.status(404).json({ error: 'File tidak ditemukan.' });
  }
});

// Endpoint Daftar File
app.get('/api/files', (req, res) => {
  fs.readdir(WORKSPACE_DIR, { withFileTypes: true }, (err, files) => {
    if (err) return res.status(500).json({ error: err.message });
    const fileList = files
      .filter(f => !PROTECTED_FILES.includes(f.name))
      .map(f => {
        let sizeStr = '-';
        if (!f.isDirectory()) {
          try {
            const stats = fs.statSync(path.join(WORKSPACE_DIR, f.name));
            sizeStr = `${(stats.size / 1024).toFixed(1)} KB`;
          } catch (e) {}
        }
        return { name: f.name, isDirectory: f.isDirectory(), size: sizeStr };
      });
    res.json(fileList);
  });
});

// Sesi Terminal di Root Utama
let shellProcess = null;

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
      PS1: '\\[\\033[01;32m\\]termux@ptero-wa\\[\\033[00m\\]:\\W\\$ '
    }
  });

  shellProcess.stdout.on('data', (data) => io.emit('term-output', data.toString()));
  shellProcess.stderr.on('data', (data) => io.emit('term-output', data.toString()));
  shellProcess.on('close', () => setTimeout(startInteractiveShell, 1000));
}

startInteractiveShell();

io.on('connection', (socket) => {
  socket.emit('term-output', `\x1b[1;36m=== PteroWA Termux Web Terminal (Server Monitor Edition) ===\x1b[0m\r\n`);
  socket.emit('term-output', `\x1b[1;33mNode.js ${process.version} | Bot Port: ${BOT_PORT}\x1b[0m\r\n\r\n`);

  if (shellProcess && shellProcess.stdin.writable) shellProcess.stdin.write('\n');

  socket.on('term-input', (cmd) => {
    if (shellProcess && shellProcess.stdin.writable) shellProcess.stdin.write(cmd);
  });

  socket.on('term-sigint', () => {
    if (shellProcess) {
      shellProcess.kill('SIGINT');
      exec(`pkill -f "node app.js"; pkill -f "node index.js"; pkill -f "node main.js"`, () => {});
      io.emit('term-output', '^C\r\n\x1b[1;33m[SYSTEM] Bot dihentikan.\x1b[0m\r\n');
      if (shellProcess.stdin.writable) shellProcess.stdin.write('\n');
    }
  });

  socket.on('term-restart', () => {
    exec(`pkill -f "node app.js"; pkill -f "node index.js"; pkill -f "node main.js"`, () => {
      startInteractiveShell();
    });
  });
});

server.listen(PANEL_PORT, () => console.log(`Panel aktif di port ${PANEL_PORT}`));
