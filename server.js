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
  maxHttpBufferSize: 200 * 1024 * 1024 // Maksimal 200MB
});

// Port utama untuk Web Panel Heroku
const PANEL_PORT = process.env.PORT || 3000;
// Port khusus untuk Bot WA di dalam terminal agar tidak bentrok (EADDRINUSE)
const BOT_PORT = '8080';

const WORKSPACE_DIR = path.join(__dirname, 'workspace');

if (!fs.existsSync(WORKSPACE_DIR)) {
  fs.mkdirSync(WORKSPACE_DIR, { recursive: true });
}

app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json({ limit: '200mb' }));
app.use(express.urlencoded({ limit: '200mb', extended: true }));

// Konfigurasi Multer: Maksimal Upload 200MB
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, WORKSPACE_DIR),
  filename: (req, file, cb) => cb(null, file.originalname)
});

const upload = multer({
  storage: storage,
  limits: { fileSize: 200 * 1024 * 1024 }
});

// Fungsi otomatis memperbaiki package.json & menghapus node_modules bawaan ZIP
function autoFixBotFolder(dirPath) {
  if (!fs.existsSync(dirPath)) return;
  const items = fs.readdirSync(dirPath, { withFileTypes: true });

  for (const item of items) {
    const fullPath = path.join(dirPath, item.name);

    // 1. Hapus node_modules bawaan ZIP agar tidak Segmentation fault di Node v20
    if (item.isDirectory() && item.name === 'node_modules') {
      fs.rmSync(fullPath, { recursive: true, force: true });
      continue;
    }

    // 2. Hapus package-lock.json lama agar tidak mengunci versi binary lama
    if (!item.isDirectory() && item.name === 'package-lock.json') {
      fs.rmSync(fullPath, { force: true });
      continue;
    }

    // 3. Patch package.json agar better-sqlite3 kompatibel dengan Node v20 tanpa error node-gyp
    if (!item.isDirectory() && item.name === 'package.json') {
      try {
        const pkg = JSON.parse(fs.readFileSync(fullPath, 'utf8'));
        let modified = false;

        if (pkg.dependencies && pkg.dependencies['better-sqlite3']) {
          pkg.dependencies['better-sqlite3'] = 'latest';
          modified = true;
        }
        if (pkg.optionalDependencies && pkg.optionalDependencies['better-sqlite3']) {
          pkg.optionalDependencies['better-sqlite3'] = 'latest';
          modified = true;
        }

        if (modified) {
          fs.writeFileSync(fullPath, JSON.stringify(pkg, null, 2));
        }
      } catch (err) {
        console.error('Gagal memproses package.json:', err.message);
      }
    }

    // Cek juga ke dalam sub-folder
    if (item.isDirectory() && item.name !== '.git') {
      autoFixBotFolder(fullPath);
    }
  }
}

// Fungsi meratakan sub-folder tunggal hasil ekstrak ZIP ke /workspace utama
function flattenSingleSubfolder(dirPath) {
  const extractedItems = fs.readdirSync(dirPath).filter(name => name !== '__MACOSX');
  if (extractedItems.length === 1) {
    const singleFolder = path.join(dirPath, extractedItems[0]);
    if (fs.existsSync(singleFolder) && fs.statSync(singleFolder).isDirectory()) {
      const subItems = fs.readdirSync(singleFolder);
      for (const subItem of subItems) {
        const srcPath = path.join(singleFolder, subItem);
        const destPath = path.join(dirPath, subItem);
        if (fs.existsSync(destPath)) {
          fs.rmSync(destPath, { recursive: true, force: true });
        }
        fs.renameSync(srcPath, destPath);
      }
      fs.rmSync(singleFolder, { recursive: true, force: true });
    }
  }
}

// Endpoint API: Upload Script Bot (Auto-Extract & Auto-Fix jika .zip)
app.post('/api/upload', (req, res) => {
  upload.single('scriptFile')(req, res, (err) => {
    if (err instanceof multer.MulterError) {
      return res.status(400).json({ error: `Ukuran file melebihi 200MB (${err.message})` });
    } else if (err) {
      return res.status(500).json({ error: `Kesalahan upload: ${err.message}` });
    }

    if (!req.file) {
      return res.status(400).json({ error: 'Tidak ada file yang dipilih.' });
    }

    const uploadedPath = req.file.path;
    const fileName = req.file.originalname;

    if (fileName.endsWith('.zip')) {
      try {
        const zip = new AdmZip(uploadedPath);
        zip.extractAllTo(WORKSPACE_DIR, true);
        fs.unlinkSync(uploadedPath);

        // Pindahkan isi sub-folder ke /workspace utama & jalankan auto-fix
        flattenSingleSubfolder(WORKSPACE_DIR);
        autoFixBotFolder(WORKSPACE_DIR);

        io.emit(
          'term-output',
          `\r\n\x1b[1;32m[SYSTEM] ${fileName} berhasil diekstrak ke /workspace & di-patch untuk Node ${process.version}!\x1b[0m\r\n` +
          `\x1b[1;33m[TIPS] Klik tombol "Fix & npm install" lalu "npm start" untuk menjalankan bot.\x1b[0m\r\n`
        );

        return res.json({ message: `File ${fileName} berhasil diekstrak & dioptimalkan untuk Node v20!` });
      } catch (zipErr) {
        return res.status(500).json({ error: `Gagal mengekstrak ZIP: ${zipErr.message}` });
      }
    }

    io.emit('term-output', `\r\n\x1b[1;32m[SYSTEM] File ${fileName} berhasil di-upload ke /workspace!\x1b[0m\r\n`);
    res.json({ message: `File ${fileName} (${(req.file.size / (1024 * 1024)).toFixed(2)} MB) berhasil diupload!` });
  });
});

// Endpoint API: Daftar File di Workspace
app.get('/api/files', (req, res) => {
  fs.readdir(WORKSPACE_DIR, { withFileTypes: true }, (err, files) => {
    if (err) return res.status(500).json({ error: err.message });
    const fileList = files.map(f => {
      let sizeStr = '-';
      if (!f.isDirectory()) {
        try {
          const stats = fs.statSync(path.join(WORKSPACE_DIR, f.name));
          sizeStr = `${(stats.size / 1024).toFixed(1)} KB`;
        } catch (e) {}
      }
      return {
        name: f.name,
        isDirectory: f.isDirectory(),
        size: sizeStr
      };
    });
    res.json(fileList);
  });
});

// Endpoint API: Spesifikasi Server
app.get('/api/specs', (req, res) => {
  res.json({
    node: process.version,
    platform: `${os.type()} ${os.release()} (${os.arch()})`,
    ram: `${Math.round(os.freemem() / 1024 / 1024)} MB free / ${Math.round(os.totalmem() / 1024 / 1024)} MB`
  });
});

// Mesin Terminal Interaktif ala Termux (Bash Shell)
let shellProcess = null;

function startInteractiveShell() {
  if (shellProcess) {
    try {
      shellProcess.kill('SIGKILL');
    } catch (e) {}
  }

  // Menjalankan bash dengan PORT=8080 agar bot tidak bentrok dengan PORT utama Heroku
  shellProcess = spawn('bash', ['-i'], {
    cwd: WORKSPACE_DIR,
    env: {
      ...process.env,
      PORT: BOT_PORT,
      SERVER_PORT: BOT_PORT,
      TERM: 'xterm-256color',
      PS1: '\\[\\033[01;32m\\]termux@ptero-wa\\[\\033[00m\\]:\\[\\033[01;34m\\]\\w\\[\\033[00m\\]\\$ '
    }
  });

  shellProcess.stdout.on('data', (data) => {
    io.emit('term-output', data.toString());
  });

  shellProcess.stderr.on('data', (data) => {
    io.emit('term-output', data.toString());
  });

  shellProcess.on('close', (code) => {
    io.emit('term-output', `\r\n\x1b[1;31m[Shell berhenti (kode ${code}). Merestart shell...]\x1b[0m\r\n`);
    setTimeout(startInteractiveShell, 1000);
  });
}

startInteractiveShell();

io.on('connection', (socket) => {
  socket.emit('term-output', `\x1b[1;36m=== PteroWA Termux Web Terminal ===\x1b[0m\r\n`);
  socket.emit('term-output', `\x1b[1;33mNode.js ${process.version} | FFmpeg Ready | Bot Port: ${BOT_PORT}\x1b[0m\r\n\r\n`);

  if (shellProcess && shellProcess.stdin.writable) {
    shellProcess.stdin.write('\n');
  }

  socket.on('term-input', (cmd) => {
    if (shellProcess && shellProcess.stdin.writable) {
      shellProcess.stdin.write(cmd);
    }
  });

  // Stop Bot (CTRL+C) + bersihkan proses bot di port 8080
  socket.on('term-sigint', () => {
    if (shellProcess) {
      shellProcess.kill('SIGINT');
      exec(`pkill -f "node app.js"; pkill -f "node index.js"; pkill -f "node main.js"`, () => {});
      io.emit('term-output', '^C\r\n\x1b[1;33m[SYSTEM] Proses bot dihentikan.\x1b[0m\r\n');
      if (shellProcess.stdin.writable) shellProcess.stdin.write('\n');
    }
  });

  // Restart Shell penuh
  socket.on('term-restart', () => {
    io.emit('term-output', '\r\n\x1b[1;33m[SYSTEM] Merestart sesi terminal & membersihkan port...\x1b[0m\r\n');
    exec(`pkill -f "node app.js"; pkill -f "node index.js"; pkill -f "node main.js"`, () => {
      startInteractiveShell();
    });
  });
});

server.listen(PANEL_PORT, () => {
  console.log(`PteroWA Panel berjalan di port ${PANEL_PORT} (Bot Port: ${BOT_PORT})`);
});
