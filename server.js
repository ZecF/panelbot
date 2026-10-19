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

app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json({ limit: '200mb' }));
app.use(express.urlencoded({ limit: '200mb', extended: true }));

const PROTECTED_FILES = ['server.js', 'package.json', 'Dockerfile', 'heroku.yml', 'public', 'node_modules', '.git'];

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, WORKSPACE_DIR),
  filename: (req, file, cb) => cb(null, file.originalname)
});

const upload = multer({
  storage: storage,
  limits: { fileSize: 200 * 1024 * 1024 }
});

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

        io.
