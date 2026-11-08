const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const multer = require('multer');
const { v4: uuidv4 } = require('uuid');
const path = require('path');
const fs = require('fs');
const { Pool } = require('pg');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const PORT = process.env.PORT || 3000;
const UPLOAD_DIR = path.join(__dirname, 'uploads');

if (!fs.existsSync(UPLOAD_DIR)) {
    fs.mkdirSync(UPLOAD_DIR, { recursive: true });
}

const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.DATABASE_URL ? { rejectUnauthorized: false } : false
});

async function initDb() {
    if (!process.env.DATABASE_URL) return;
    try {
        await pool.query(`
            CREATE TABLE IF NOT EXISTS files (
                id SERIAL PRIMARY KEY,
                stored_name VARCHAR(255) NOT NULL,
                original_name VARCHAR(255) NOT NULL,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );
        `);
    } catch (err) {
        console.error('DB init error:', err);
    }
}
initDb();

const storage = multer.diskStorage({
    destination: (req, file, cb) => cb(null, UPLOAD_DIR),
    filename: (req, file, cb) => {
        const uniqueId = uuidv4();
        const originalName = Buffer.from(file.originalname, 'latin1').toString('utf8');
        cb(null, `${uniqueId}-${originalName}`);
    }
});
const upload = multer({ storage });

async function getFileList() {
    if (!process.env.DATABASE_URL) return [];
    try {
        const res = await pool.query('SELECT stored_name, original_name FROM files ORDER BY id DESC');
        return res.rows.map(row => ({
            originalName: row.original_name,
            url: `/download/${row.stored_name}`
        }));
    } catch (e) {
        return [];
    }
}

app.get('/', (req, res) => {
    res.send(`
<!DOCTYPE html>
<html lang="ja">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>ファイル転送</title>
    <script src="/socket.io/socket.io.js"></script>
    <style>
        body { font-family: -apple-system, sans-serif; max-width: 500px; margin: 20px auto; padding: 0 16px; color: #333; }
        .box { border: 2px dashed #007bff; padding: 24px 16px; text-align: center; border-radius: 12px; background: #f8f9fa; }
        input[type="file"] { margin-bottom: 16px; width: 100%; }
        button { background: #007bff; color: white; border: none; padding: 12px 24px; border-radius: 8px; font-size: 16px; font-weight: bold; width: 100%; cursor: pointer; }
        .progress-bar { width: 0%; height: 8px; background: #28a745; border-radius: 4px; transition: width 0.1s; margin-top: 10px; }
        li { margin-bottom: 12px; word-break: break-all; }
        a { color: #007bff; font-weight: bold; }
    </style>
</head>
<body>
    <h2>📁 ファイル転送</h2>
    
    <div class="box">
        <input type="file" id="fileInput"><br>
        <button onclick="uploadFile()">送信</button>
        <div style="background:#e9ecef; border-radius:4px; margin-top:10px;">
            <div id="progress" class="progress-bar"></div>
        </div>
        <p id="status"></p>
    </div>

    <h3>共有ファイル一覧</h3>
    <ul id="fileList"></ul>

    <script>
        const socket = io();
        socket.on('update-files', (files) => renderFiles(files));

        function renderFiles(files) {
            const list = document.getElementById('fileList');
            list.innerHTML = files.map(f => 
                `<li><a href="${f.url}" download="${f.originalName}">${f.originalName}</a></li>`
            ).join('');
        }

        function uploadFile() {
            const input = document.getElementById('fileInput');
            const status = document.getElementById('status');
            const progressBar = document.getElementById('progress');
            if (!input.files.length) return alert('ファイルを選択してください');

            const xhr = new XMLHttpRequest();
            const formData = new FormData();
            formData.append('file', input.files[0]);

            xhr.upload.onprogress = (e) => {
                if (e.lengthComputable) {
                    const percent = Math.round((e.loaded / e.total) * 100);
                    progressBar.style.width = percent + '%';
                    status.textContent = `送信中... ${percent}%`;
                }
            };

            xhr.onload = () => {
                if (xhr.status === 200) {
                    status.textContent = '送信完了！';
                    input.value = '';
                    setTimeout(() => { progressBar.style.width = '0%'; }, 2000);
                } else {
                    status.textContent = 'エラー';
                }
            };

            xhr.open('POST', '/upload', true);
            xhr.send(formData);
        }
    </script>
</body>
</html>
    `);
});

app.post('/upload', upload.single('file'), async (req, res) => {
    if (!req.file) return res.status(400).json({ error: 'ファイルがありません' });
    const storedName = req.file.filename;
    const originalName = Buffer.from(req.file.originalname, 'latin1').toString('utf8');

    try {
        if (process.env.DATABASE_URL) {
            await pool.query('INSERT INTO files (stored_name, original_name) VALUES ($1, $2)', [storedName, originalName]);
        }
        io.emit('update-files', await getFileList());
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: 'DB保存エラー' });
    }
});

app.get('/download/:filename', (req, res) => {
    const filePath = path.join(UPLOAD_DIR, req.params.filename);
    if (fs.existsSync(filePath)) {
        const originalName = req.params.filename.substring(req.params.filename.indexOf('-') + 1);
        res.download(filePath, originalName);
    } else {
        res.status(404).send('ファイルが見つかりません');
    }
});

io.on('connection', async (socket) => {
    socket.emit('update-files', await getFileList());
});

server.listen(PORT, () => console.log(`Server started on port ${PORT}`));