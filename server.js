const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const multer = require('multer');
const AdmZip = require('adm-zip');
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  maxHttpBufferSize: 200 * 1024 * 1024 // Support buffer besar
});

const PORT = process.env.PORT || 3000;
const WORKSPACE_DIR = path.join(__dirname, 'workspace');

// Pastikan folder workspace tersedia
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
  limits: { fileSize: 200 * 1024 * 1024 } // 200 MB
});

// Endpoint API: Upload Script Bot (Auto-Extract jika .zip)
app.post('/api/upload', (req, res) => {
  upload.single('scriptFile')(req, res, (err) => {
    if (err instanceof multer.MulterError) {
      return res.status(400).json({ error: `Gagal: Ukuran file melebihi batas 200MB (${err.message})` });
    } else if (err) {
      return res.status(500).json({ error: `Terjadi kesalahan: ${err.message}` });
    }

    if (!req.file) {
      return res.status(400).json({ error: 'Tidak ada file yang dipilih.' });
    }

    const uploadedPath = req.file.path;
    const fileName = req.file.originalname;

    // Jika file adalah .zip, ekstrak otomatis ke folder workspace
    if (fileName.endsWith('.zip')) {
      try {
        const zip = new AdmZip(uploadedPath);
        zip.extractAllTo(WORKSPACE_DIR, true);
        fs.unlinkSync(uploadedPath); // Hapus file mentah .zip setelah diekstrak
        io.emit('term-output', `\r\n\x1b[1;32m[SYSTEM] File ${fileName} berhasil di-upload & diekstrak ke /workspace!\x1b[0m\r\n`);
        return res.json({ message: `File ${fileName} berhasil diupload & diekstrak otomatis!` });
      } catch (zipErr) {
        return res.status(500).json({ error: `Gagal mengekstrak ZIP: ${zipErr.message}` });
      }
    }

    io.emit('term-output', `\r\n\x1b[1;32m[SYSTEM] File ${fileName} berhasil di-upload ke /workspace!\x1b[0m\r\n`);
    res.json({ message: `File ${fileName} (${(req.file.size / (1024 * 1024)).toFixed(2)} MB) berhasil diupload!` });
  });
});

// Endpoint API: Cek Daftar File di Workspace
app.get('/api/files', (req, res) => {
  fs.readdir(WORKSPACE_DIR, { withFileTypes: true }, (err, files) => {
    if (err) return res.status(500).json({ error: err.message });
    const fileList = files.map(f => ({
      name: f.name,
      isDirectory: f.isDirectory(),
      size: f.isDirectory() ? '-' : `${(fs.statSync(path.join(WORKSPACE_DIR, f.name)).size / 1024).toFixed(1)} KB`
    }));
    res.json(fileList);
  });
});

// Endpoint API: Cek Spesifikasi Environment
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
    try { shellProcess.kill(); } catch (e) {}
  }

  // Menjalankan bash interaktif di dalam folder workspace
  shellProcess = spawn('bash', ['-i'], {
    cwd: WORKSPACE_DIR,
    env: { ...process.env, TERM: 'xterm-256color', PS1: '\\[\\033[01;32m\\]termux@ptero-wa\\[\\033[00m\\]:\\[\\033[01;34m\\]\\w\\[\\033[00m\\]\\$ ' }
  });

  shellProcess.stdout.on('data', (data) => {
    io.emit('term-output', data.toString());
  });

  shellProcess.stderr.on('data', (data) => {
    io.emit('term-output', data.toString());
  });

  shellProcess.on('close', (code) => {
    io.emit('term-output', `\r\n\x1b[1;31m[Proses shell berhenti dengan kode ${code}. Merestart shell...]\x1b[0m\r\n`);
    setTimeout(startInteractiveShell, 1000);
  });
}

startInteractiveShell();

io.on('connection', (socket) => {
  socket.emit('term-output', `\x1b[1;36m=== Selamat Datang di PteroWA Termux Web Terminal ===\x1b[0m\r\n`);
  socket.emit('term-output', `\x1b[1;33mInfo: Node.js ${process.version}, FFmpeg, ImageMagick, & Git sudah siap digunakan.\x1b[0m\r\n`);
  socket.emit('term-output', `Ketik perintah seperti di Termux (contoh: \x1b[1;32mls\x1b[0m, \x1b[1;32mnpm install\x1b[0m, \x1b[1;32mnode index.js\x1b[0m)\r\n\r\n`);

  // Kirim baris kosong agar prompt bash muncul
  if (shellProcess && shellProcess.stdin.writable) {
    shellProcess.stdin.write('\n');
  }

  // Terima perintah dari pengguna
  socket.on('term-input', (cmd) => {
    if (shellProcess && shellProcess.stdin.writable) {
      shellProcess.stdin.write(cmd);
    }
  });

  // Sinyal CTRL+C untuk menghentikan bot yang sedang jalan
  socket.on('term-sigint', () => {
    if (shellProcess) {
      shellProcess.kill('SIGINT');
      io.emit('term-output', '^C\r\n');
    }
  });

  // Restart Shell penuh
  socket.on('term-restart', () => {
    io.emit('term-output', '\r\n\x1b[1;33m[SYSTEM] Merestart sesi terminal...\x1b[0m\r\n');
    startInteractiveShell();
  });
});

server.listen(PORT, () => {
  console.log(`Panel berjalan di port ${PORT}`);
});
                                                                       
