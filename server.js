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

// Fungsi otomatis patch package.json & hapus node_modules bawaan zip
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

        // Jika ekstrak menghasilkan 1 folder pembungkus, pindahkan seluruh isinya ke root utama
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

// Endpoint Daftar File (Hanya menampilkan file bot, menyembunyikan file sistem panel)
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

app.get('/api/specs', (req, res) => {
  res.json({
    node: process.version,
    ram: `${Math.round(os.freemem() / 1024 / 1024)} MB free / ${Math.round(os.totalmem() / 1024 / 1024)} MB`
  });
});

// Sesi Terminal Langsung di Root Utama
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
      PS1: '\\[\\033[01;32m\\]termux@ptero-wa\\[\\033[00m\\]:\\W\\$ '
    }
  });

  shellProcess.stdout.on('data', (data) => io.emit('term-output', data.toString()));
  shellProcess.stderr.on('data', (data) => io.emit('term-output', data.toString()));
  shellProcess.on('close', () => setTimeout(startInteractiveShell, 1000));
}

startInteractiveShell();

io.on('connection', (socket) => {
  socket.emit('term-output', `\x1b[1;36m=== PteroWA Termux Web Terminal (Direct Root Mode) ===\x1b[0m\r\n`);
  socket.emit('term-output', `\x1b[1;33mNode.js ${process.version} | FFmpeg Ready | Bot Port: ${BOT_PORT}\x1b[0m\r\n\r\n`);

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
