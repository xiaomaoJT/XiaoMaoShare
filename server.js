'use strict';
/**
 * 局域网互传 —— 零依赖单文件服务
 *
 * 同一个 Wi-Fi 下，任意手机 / 电脑打开 http://<本机IP>:8788 即可互传
 * 文字、图片、任意文件。所有内容只存在本机 ./data 目录，不出局域网。
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

const ROOT = __dirname;
const DATA_DIR = path.join(ROOT, 'data');
const FILES_DIR = path.join(DATA_DIR, 'files');
const INDEX_FILE = path.join(DATA_DIR, 'index.json');
const PUBLIC_DIR = path.join(ROOT, 'public');

const BASE_PORT = Number(process.env.PORT || 8788);
const MAX_FILE = 4 * 1024 * 1024 * 1024; // 4GB 单文件上限
const MAX_TEXT = 50 * 1024;              // 文字消息 50KB 上限

fs.mkdirSync(FILES_DIR, { recursive: true });

/* ------------------------------------------------------------------ 索引 */

let items = loadIndex();

function loadIndex() {
  try {
    const arr = JSON.parse(fs.readFileSync(INDEX_FILE, 'utf8'));
    return Array.isArray(arr) ? arr : [];
  } catch {
    return [];
  }
}

// 丢掉磁盘上文件已不存在的记录
items = items.filter((it) => !it.file || fs.existsSync(path.join(FILES_DIR, it.file)));

let saveTimer = null;
function saveIndex() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    fs.writeFile(INDEX_FILE, JSON.stringify(items), () => {});
  }, 60);
}

const newId = () => Date.now().toString(36) + crypto.randomBytes(3).toString('hex');

/* ------------------------------------------------------------------ 工具 */

const MIME = {
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif',
  '.webp': 'image/webp', '.svg': 'image/svg+xml', '.bmp': 'image/bmp', '.avif': 'image/avif',
  '.heic': 'image/heic', '.ico': 'image/x-icon',
  '.mp4': 'video/mp4', '.webm': 'video/webm', '.mov': 'video/quicktime', '.m4v': 'video/mp4',
  '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.m4a': 'audio/mp4', '.aac': 'audio/aac',
  '.pdf': 'application/pdf',
  '.txt': 'text/plain; charset=utf-8', '.md': 'text/plain; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.csv': 'text/plain; charset=utf-8',
  '.zip': 'application/zip', '.html': 'text/plain; charset=utf-8',
};

function mimeOf(name, fallback) {
  const ext = path.extname(String(name || '')).toLowerCase();
  return MIME[ext] || fallback || 'application/octet-stream';
}

function json(res, code, obj) {
  const body = Buffer.from(JSON.stringify(obj));
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': body.length,
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  });
  res.end(body);
}

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) {
        reject(new Error('payload too large'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function lanAddresses() {
  const out = [];
  const nets = os.networkInterfaces();
  const skipIf = /^(utun|awdl|llw|bridge|gif|stf|anpi|ap\d|vmenet|vmnet|docker|tap|tun)/i;
  for (const name of Object.keys(nets)) {
    if (skipIf.test(name)) continue; // 虚拟网卡 / 隧道，同网段设备访问不到
    for (const net of nets[name] || []) {
      if (net.family !== 'IPv4' || net.internal) continue;
      if (net.address.startsWith('169.254.')) continue; // 链路本地地址
      out.push({ name, address: net.address });
    }
  }
  // 常见家用 / 办公网段优先（192.168.x → 10.x → 172.x → 其它）
  const rank = (ip) =>
    ip.startsWith('192.168.') ? 0 : ip.startsWith('10.') ? 1 : ip.startsWith('172.') ? 2 : 3;
  return out.sort((a, b) => rank(a.address) - rank(b.address));
}

/* ------------------------------------------------------------------ 路由 */

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const pathname = decodeURIComponent(url.pathname);
  const method = req.method;

  res.setHeader('X-Content-Type-Options', 'nosniff');

  // 首页
  if (method === 'GET' && (pathname === '/' || pathname === '/index.html')) {
    fs.readFile(path.join(PUBLIC_DIR, 'index.html'), (err, buf) => {
      if (err) {
        res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('页面缺失：public/index.html');
        return;
      }
      res.writeHead(200, {
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'no-cache',
      });
      res.end(buf);
    });
    return;
  }

  // 服务信息
  if (method === 'GET' && pathname === '/api/info') {
    const port = server.address().port;
    json(res, 200, {
      host: os.hostname(),
      port,
      urls: lanAddresses().map((n) => `http://${n.address}:${port}`),
    });
    return;
  }

  // 列表
  if (method === 'GET' && pathname === '/api/list') {
    json(res, 200, { items, count: items.length, now: Date.now() });
    return;
  }

  // 发文字
  if (method === 'POST' && pathname === '/api/text') {
    readBody(req, MAX_TEXT)
      .then((raw) => {
        let text = '';
        let from = '';
        try {
          const body = JSON.parse(raw || '{}');
          text = String(body.text || '');
          from = String(body.from || '').slice(0, 40);
        } catch {
          text = raw;
        }
        text = text.replace(/\u0000/g, '').trim();
        if (!text) return json(res, 400, { error: '内容为空' });
        if (text.length > MAX_TEXT) text = text.slice(0, MAX_TEXT);

        const item = {
          id: newId(),
          kind: 'text',
          text,
          time: Date.now(),
          from: from || '匿名设备',
        };
        items.unshift(item);
        saveIndex();
        json(res, 200, { item });
      })
      .catch(() => json(res, 413, { error: '内容过长' }));
    return;
  }

  // 上传文件（请求体即文件二进制，文件名走 query）
  if (method === 'POST' && pathname === '/api/file') {
    const name = (url.searchParams.get('name') || 'file').slice(-180);
    const from = (url.searchParams.get('from') || '匿名设备').slice(0, 40);
    const declaredType = url.searchParams.get('type') || '';

    const id = newId();
    const ext = path.extname(name).slice(0, 12).replace(/[^\w.]/g, '');
    const stored = id + ext;
    const ws = fs.createWriteStream(path.join(FILES_DIR, stored));

    let size = 0;
    let aborted = false;
    let done = false;

    const fail = (code, msg) => {
      if (done) return;
      done = true;
      aborted = true;
      try { ws.destroy(); } catch {}
      fs.unlink(path.join(FILES_DIR, stored), () => {});
      json(res, code, { error: msg });
    };

    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_FILE) fail(413, '文件过大');
    });

    req.on('aborted', () => fail(499, '已取消'));
    ws.on('error', () => fail(500, '写入失败'));

    ws.on('finish', () => {
      if (done) return;
      done = true;
      if (!size) return fail(400, '空文件');

      const isImage = /^image\//i.test(declaredType) || /\.(png|jpe?g|gif|webp|avif|bmp|svg|heic)$/i.test(name);
      const item = {
        id,
        kind: isImage ? 'image' : 'file',
        name,
        size,
        mime: mimeOf(name, declaredType),
        file: stored,
        time: Date.now(),
        from,
      };
      items.unshift(item);
      saveIndex();
      json(res, 200, { item });
    });

    req.pipe(ws);
    return;
  }

  // 下载 / 预览
  if (method === 'GET' && pathname.startsWith('/f/')) {
    const id = pathname.slice(3);
    const item = items.find((it) => it.id === id && it.file);
    if (!item) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('内容不存在');
      return;
    }
    const filePath = path.join(FILES_DIR, item.file);
    let stat;
    try {
      stat = fs.statSync(filePath);
    } catch {
      res.writeHead(404);
      res.end();
      return;
    }

    const inline = /^(image|video|audio|application\/pdf)/i.test(item.mime) && url.searchParams.get('dl') !== '1';
    const enc = encodeURIComponent(item.name || 'file').replace(
      /['()*]/g,
      (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase()
    );

    res.writeHead(200, {
      'Content-Type': item.mime,
      'Content-Length': stat.size,
      'Content-Disposition': `${inline ? 'inline' : 'attachment'}; filename*=UTF-8''${enc}`,
      'Cache-Control': 'public, max-age=31536000, immutable',
    });
    fs.createReadStream(filePath).pipe(res);
    return;
  }

  // 删除单条
  if (method === 'DELETE' && pathname === '/api/item') {
    const id = url.searchParams.get('id');
    const idx = items.findIndex((it) => it.id === id);
    if (idx === -1) return json(res, 404, { error: '不存在' });
    const [removed] = items.splice(idx, 1);
    if (removed.file) fs.unlink(path.join(FILES_DIR, removed.file), () => {});
    saveIndex();
    json(res, 200, { ok: true });
    return;
  }

  // 清空全部
  if (method === 'DELETE' && pathname === '/api/all') {
    for (const it of items) if (it.file) fs.unlink(path.join(FILES_DIR, it.file), () => {});
    items = [];
    saveIndex();
    json(res, 200, { ok: true });
    return;
  }

  res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end('Not Found');
});

/* ------------------------------------------------------------------ 启动 */

function listen(port, attempt = 0) {
  server.once('error', (err) => {
    if (err.code === 'EADDRINUSE' && attempt < 20) {
      listen(port + 1, attempt + 1);
    } else {
      console.error('启动失败：', err.message);
      process.exit(1);
    }
  });
  server.listen(port, '0.0.0.0', () => {
    const actual = server.address().port;
    const nets = lanAddresses();
    const line = '─'.repeat(46);
    console.log('\n  局域网互传已启动\n' + line);
    console.log(`  本机     http://localhost:${actual}`);
    if (nets.length) {
      for (const n of nets) console.log(`  局域网   http://${n.address}:${actual}   (${n.name})`);
    } else {
      console.log('  未检测到局域网地址，请确认已连接 Wi-Fi');
    }
    console.log(line);
    console.log(`  数据目录 ${DATA_DIR}`);
    console.log(`  已有内容 ${items.length} 条    Ctrl+C 停止\n`);
  });
}

listen(BASE_PORT);

process.on('SIGINT', () => {
  console.log('\n已停止。数据保留在 data/ 目录。');
  process.exit(0);
});
