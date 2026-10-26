'use strict';
/**
 * 局域网互传 —— 零依赖单文件服务
 *
 * 同一个 Wi-Fi 下，任意手机 / 电脑打开 http://<本机IP>:6767 即可互传
 * 文字、图片、任意文件。所有内容只存在本机 ./data 目录，不出局域网。
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { exec } = require('child_process');

const ROOT = __dirname;
const DATA_DIR = path.join(ROOT, 'data');
const FILES_DIR = path.join(DATA_DIR, 'files');
const INDEX_FILE = path.join(DATA_DIR, 'index.json');
const PUBLIC_DIR = path.join(ROOT, 'public');

const ARGS = process.argv.slice(2);
const OPEN_ON_START = ARGS.includes('--open') || ARGS.includes('-o');

const BASE_PORT = Number(process.env.PORT || 6767);
const MAX_FILE = 4 * 1024 * 1024 * 1024; // 4GB 单文件上限
const MAX_TEXT = 50 * 1024;              // 文字消息 50KB 上限
const MAX_PARTS = 30;                    // 一条消息最多带 30 个附件
const MAX_STAGED = 120;                  // 暂存区上限，防内存/磁盘被灌爆
const STAGE_TTL = 30 * 60e3;             // 暂存文件 30 分钟没发送就清掉
const IS_WIN = process.platform === 'win32';

fs.mkdirSync(FILES_DIR, { recursive: true });

/* ------------------------------------------------------------------ 索引 */

let items = loadIndex();

/**
 * 一条消息 = 若干片段（parts）。这样「一段文字 + 两张图 + 一个压缩包」能合成一条。
 * 老数据只有单一类型，读进来时顺手升级。
 */
function migrateItem(it) {
  if (Array.isArray(it.parts)) return it;
  const parts = [];
  if (it.kind === 'text' || it.text) parts.push({ kind: 'text', text: String(it.text || '') });
  if (it.file) {
    parts.push({
      kind: it.kind === 'image' ? 'image' : 'file',
      fid: it.id,
      name: it.name || '',
      size: it.size || 0,
      mime: it.mime || '',
      file: it.file,
    });
  }
  return { ...it, parts, kind: parts.length === 1 ? parts[0].kind : 'bundle' };
}

function loadIndex() {
  try {
    const arr = JSON.parse(fs.readFileSync(INDEX_FILE, 'utf8'));
    return Array.isArray(arr) ? arr.map(migrateItem) : [];
  } catch {
    return [];
  }
}

// 丢掉磁盘上文件已不存在的记录
items = items.filter((it) =>
  (it.parts || []).every((p) => !p.file || fs.existsSync(path.join(FILES_DIR, p.file)))
);

// fid → { part, item }，/f/:fid 走这里，避免每次遍历全表
let fileIndex = new Map();
function reindexFiles() {
  fileIndex = new Map();
  for (const it of items) {
    for (const p of it.parts || []) {
      if (p.fid && p.file) fileIndex.set(p.fid, { part: p, item: it });
    }
  }
}
reindexFiles();

/**
 * 暂存区：先上传拿 fid，再调 /api/send 一次性组成一条消息。
 * 这样多文件能合并发送，且上传过程依旧是流式落盘，不占内存。
 */
const staged = new Map(); // fid -> { kind, fid, name, size, mime, file, owner, at }

setInterval(() => {
  const now = Date.now();
  for (const [fid, s] of staged) {
    if (now - s.at < STAGE_TTL) continue;
    fs.unlink(path.join(FILES_DIR, s.file), () => {});
    staged.delete(fid);
  }
}, 60e3).unref();

let saveTimer = null;
function saveIndex() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    fs.writeFile(INDEX_FILE, JSON.stringify(items), () => {});
  }, 60);
}

const newId = () => Date.now().toString(36) + crypto.randomBytes(3).toString('hex');

/* ------------------------------------------------------ 设置 / 在线设备 */

const SETTINGS_FILE = path.join(DATA_DIR, 'settings.json');
const SETTING_KEYS = ['allowSend', 'allowText', 'allowImage', 'allowFile'];

// 主设备（跑服务这台机器）可以改；其他设备只能按这里的规则来
let settings = { allowSend: true, allowText: true, allowImage: true, allowFile: true };
try {
  const saved = JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8'));
  for (const k of SETTING_KEYS) if (typeof saved[k] === 'boolean') settings[k] = saved[k];
} catch {
  /* 首次运行用默认值 */
}

function saveSettings() {
  fs.writeFile(SETTINGS_FILE, JSON.stringify(settings, null, 2), () => {});
}

const PRESENCE_TTL = 8000;        // 超过这么久没心跳算离线
const PRESENCE_FORGET = 5 * 60e3; // 离线后再保留多久

const clients = new Map(); // cid -> 设备信息

function clientIp(req) {
  let ip = (req.socket && req.socket.remoteAddress) || '';
  if (ip.startsWith('::ffff:')) ip = ip.slice(7);
  if (ip === '::1') ip = '127.0.0.1';
  return ip;
}

let LAN_IPS = new Set();
function refreshLanIps() {
  LAN_IPS = new Set(lanAddresses().map((n) => n.address));
}

/** 请求是否来自跑服务的这台机器（= 主设备，拥有管理权限） */
function isHostRequest(req) {
  const ip = clientIp(req);
  return ip === '127.0.0.1' || ip === '0.0.0.0' || LAN_IPS.has(ip);
}

function modelFromUA(ua = '') {
  if (/iPhone/i.test(ua)) return 'iPhone';
  if (/iPad/i.test(ua)) return 'iPad';
  if (/Android/i.test(ua)) return 'Android';
  if (/Windows/i.test(ua)) return 'Windows';
  if (/Macintosh|Mac OS X/i.test(ua)) return 'Mac';
  if (/Linux/i.test(ua)) return 'Linux';
  return '设备';
}

/** 本机对外的局域网地址（二维码、设备名都用它） */
function primaryLanIp() {
  const list = lanAddresses();
  if (list.length) return list[0].address;
  return '127.0.0.1';
}

/** 自动名：机器名 / 型号 + 本机 IP，天生不重名 */
function autoNameFor(req, model) {
  const ip = clientIp(req);
  if (isHostRequest(req)) {
    const host = os.hostname().replace(/\.local$/i, '') || '本机';
    // 用 127.0.0.1 访问时显示真实的内网地址，别让人看到回环地址
    const shown = ip && ip !== '127.0.0.1' && ip !== '::1' ? ip : primaryLanIp();
    return `${host} (${shown})`;
  }
  return `${model} (${ip})`;
}

function touchClient(req, cidRaw, uaRaw) {
  const ip = clientIp(req);
  const admin = isHostRequest(req);
  const ua = String(uaRaw || req.headers['user-agent'] || '').slice(0, 300);
  const model = modelFromUA(ua);

  let cid = String(cidRaw || '').trim().slice(0, 64);
  if (!/^[A-Za-z0-9_-]{3,64}$/.test(cid)) cid = 'c' + crypto.randomBytes(8).toString('hex');

  const now = Date.now();
  let c = clients.get(cid);
  if (!c) {
    c = { cid, model, ip, admin, customName: '', autoName: '', firstSeen: now, lastSeen: now };
    clients.set(cid, c);
  }
  c.ip = ip;
  c.admin = admin;
  // 有些请求不带 UA，别把已经认出来的机型降级成「设备」
  if (model !== '设备' || !c.model) c.model = model;
  c.lastSeen = now;
  c.autoName = autoNameFor(req, c.model);
  return c;
}

const displayName = (c) => c.customName || c.autoName;

function publicClient(c) {
  return { cid: c.cid, name: displayName(c), ip: c.ip, model: c.model, admin: c.admin, since: c.firstSeen };
}

function peersPayload() {
  const now = Date.now();
  const out = [];
  const seen = new Set();
  for (const c of clients.values()) {
    if (now - c.lastSeen > PRESENCE_TTL) continue;
    // 同一台机器开了多个浏览器（比如主机的两个窗口）只算一台设备
    const key = displayName(c) + '|' + c.ip;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(publicClient(c));
  }
  // 主设备排最前，其余按加入时间
  out.sort((a, b) => (b.admin ? 1 : 0) - (a.admin ? 1 : 0) || a.since - b.since);
  return out;
}

/** 某类内容当前是否允许发送（主设备永远允许） */
function canSendType(req, kind) {
  if (isHostRequest(req)) return true;
  if (!settings.allowSend) return false;
  if (kind === 'text') return settings.allowText;
  if (kind === 'image') return settings.allowImage;
  return settings.allowFile;
}

function denyReason(kind) {
  if (!settings.allowSend) return '主设备已关闭其他设备的发送权限';
  if (kind === 'text' && !settings.allowText) return '主设备已关闭文字发送';
  if (kind === 'image' && !settings.allowImage) return '主设备已关闭图片发送';
  if (kind === 'file' && !settings.allowFile) return '主设备已关闭文件发送';
  return '暂无发送权限';
}

/* ------------------------------------------------------------ 二维码 */
/**
 * 极简 QR 编码器（字节模式 / 纠错等级 M / 版本 1-10），够放一个局域网地址。
 * 零依赖，输出 SVG。算法按 ISO/IEC 18004 实现。
 */
const QR = (() => {
  // 版本 → [每块纠错码字数, 组1块数, 组1数据码字, 组2块数, 组2数据码字]
  const SPEC = {
    1: [10, 1, 16, 0, 0], 2: [16, 1, 28, 0, 0], 3: [26, 1, 44, 0, 0],
    4: [18, 2, 32, 0, 0], 5: [24, 2, 43, 0, 0], 6: [16, 4, 27, 0, 0],
    7: [18, 4, 31, 0, 0], 8: [22, 2, 38, 2, 39], 9: [22, 3, 36, 2, 37],
    10: [26, 4, 43, 1, 44],
  };
  const ALIGN = {
    1: [], 2: [6, 18], 3: [6, 22], 4: [6, 26], 5: [6, 30],
    6: [6, 34], 7: [6, 22, 38], 8: [6, 24, 42], 9: [6, 26, 46], 10: [6, 28, 50],
  };

  const EXP = new Uint8Array(512);
  const LOG = new Uint8Array(256);
  (() => {
    let x = 1;
    for (let i = 0; i < 255; i++) {
      EXP[i] = x;
      LOG[x] = i;
      x <<= 1;
      if (x & 0x100) x ^= 0x11d;
    }
    for (let i = 255; i < 512; i++) EXP[i] = EXP[i - 255];
  })();
  const mul = (a, b) => (a === 0 || b === 0 ? 0 : EXP[LOG[a] + LOG[b]]);

  function genPoly(deg) {
    let g = [1];
    for (let i = 0; i < deg; i++) {
      const next = new Array(g.length + 1).fill(0);
      for (let j = 0; j < g.length; j++) {
        next[j] ^= g[j];
        next[j + 1] ^= mul(g[j], EXP[i]);
      }
      g = next;
    }
    return g;
  }

  function ecc(data, ecLen) {
    const gen = genPoly(ecLen);
    const buf = data.concat(new Array(ecLen).fill(0));
    for (let i = 0; i < data.length; i++) {
      const f = buf[i];
      if (!f) continue;
      for (let j = 0; j < gen.length; j++) buf[i + j] ^= mul(gen[j], f);
    }
    return buf.slice(data.length);
  }

  function pickVersion(len) {
    for (let v = 1; v <= 10; v++) {
      const s = SPEC[v];
      const cap = s[1] * s[2] + s[3] * s[4];
      const header = 4 + (v <= 9 ? 8 : 16);
      if (cap * 8 >= header + len * 8) return v;
    }
    return 0;
  }

  function encodeBytes(bytes, version) {
    const s = SPEC[version];
    const dataCw = s[1] * s[2] + s[3] * s[4];
    const bits = [];
    const push = (val, len) => { for (let i = len - 1; i >= 0; i--) bits.push((val >> i) & 1); };

    push(4, 4);                                   // 字节模式
    push(bytes.length, version <= 9 ? 8 : 16);
    for (const b of bytes) push(b, 8);

    const cap = dataCw * 8;
    for (let i = 0; i < 4 && bits.length < cap; i++) bits.push(0); // 终止符
    while (bits.length % 8 !== 0) bits.push(0);

    const cw = [];
    for (let i = 0; i < bits.length; i += 8) {
      let v = 0;
      for (let j = 0; j < 8; j++) v = (v << 1) | bits[i + j];
      cw.push(v);
    }
    const PAD = [0xec, 0x11];
    let k = 0;
    while (cw.length < dataCw) cw.push(PAD[k++ % 2]);
    return cw;
  }

  function interleave(dataCw, version) {
    const [ecLen, g1, g1d, g2, g2d] = SPEC[version];
    const blocks = [];
    let p = 0;
    for (let i = 0; i < g1; i++) { blocks.push(dataCw.slice(p, p + g1d)); p += g1d; }
    for (let i = 0; i < g2; i++) { blocks.push(dataCw.slice(p, p + g2d)); p += g2d; }

    const eccs = blocks.map((b) => ecc(b, ecLen));
    const out = [];
    const maxLen = Math.max(...blocks.map((b) => b.length));
    for (let i = 0; i < maxLen; i++) for (const b of blocks) if (i < b.length) out.push(b[i]);
    for (let i = 0; i < ecLen; i++) for (const e of eccs) out.push(e[i]);
    return out;
  }

  function maskFn(mask, x, y) {
    switch (mask) {
      case 0: return (x + y) % 2 === 0;
      case 1: return y % 2 === 0;
      case 2: return x % 3 === 0;
      case 3: return (x + y) % 3 === 0;
      case 4: return (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0;
      case 5: return ((x * y) % 2) + ((x * y) % 3) === 0;
      case 6: return (((x * y) % 2) + ((x * y) % 3)) % 2 === 0;
      default: return (((x + y) % 2) + ((x * y) % 3)) % 2 === 0;
    }
  }

  function formatBits(mask) {
    const data = (0 << 3) | mask; // 纠错等级 M = 00
    let rem = data;
    for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
    return ((data << 10) | rem) ^ 0x5412;
  }

  function versionBits(version) {
    let rem = version;
    for (let i = 0; i < 12; i++) rem = (rem << 1) ^ ((rem >>> 11) * 0x1f25);
    return (version << 12) | rem;
  }

  function baseMatrix(version) {
    const size = version * 4 + 17;
    const mod = Array.from({ length: size }, () => new Array(size).fill(0));
    const fn = Array.from({ length: size }, () => new Array(size).fill(false));

    const set = (x, y, dark) => { mod[y][x] = dark ? 1 : 0; fn[y][x] = true; };

    // 定位图形（含分隔带）
    const finder = (cx, cy) => {
      for (let dy = -4; dy <= 4; dy++) {
        for (let dx = -4; dx <= 4; dx++) {
          const x = cx + dx, y = cy + dy;
          if (x < 0 || y < 0 || x >= size || y >= size) continue;
          const d = Math.max(Math.abs(dx), Math.abs(dy));
          set(x, y, d !== 2 && d !== 4);
        }
      }
    };
    finder(3, 3); finder(size - 4, 3); finder(3, size - 4);

    // 时序图形
    for (let i = 0; i < size; i++) {
      if (!fn[6][i]) set(i, 6, i % 2 === 0);
      if (!fn[i][6]) set(6, i, i % 2 === 0);
    }

    // 校准图形
    const centers = ALIGN[version];
    for (let i = 0; i < centers.length; i++) {
      for (let j = 0; j < centers.length; j++) {
        const isCorner =
          (i === 0 && j === 0) ||
          (i === 0 && j === centers.length - 1) ||
          (i === centers.length - 1 && j === 0);
        if (isCorner) continue;
        const cx = centers[i], cy = centers[j];
        for (let dy = -2; dy <= 2; dy++) {
          for (let dx = -2; dx <= 2; dx++) {
            set(cx + dx, cy + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
          }
        }
      }
    }

    // 预留格式信息区
    for (let i = 0; i < 9; i++) {
      if (!fn[8][i]) set(i, 8, false);
      if (!fn[i][8]) set(8, i, false);
    }
    for (let i = 0; i < 8; i++) {
      if (!fn[8][size - 1 - i]) set(size - 1 - i, 8, false);
      if (!fn[size - 1 - i][8]) set(8, size - 1 - i, false);
    }
    set(8, size - 8, true); // 固定的黑点

    // 版本信息（v7+）
    if (version >= 7) {
      const bits = versionBits(version);
      for (let i = 0; i < 18; i++) {
        const bit = ((bits >> i) & 1) === 1;
        const a = size - 11 + (i % 3);
        const b = Math.floor(i / 3);
        set(a, b, bit);
        set(b, a, bit);
      }
    }
    return { size, mod, fn, set };
  }

  function drawFormat(ctx, mask) {
    const { size, set } = ctx;
    const bits = formatBits(mask);
    const bit = (i) => ((bits >> i) & 1) === 1;

    for (let i = 0; i <= 5; i++) set(8, i, bit(i));
    set(8, 7, bit(6));
    set(8, 8, bit(7));
    set(7, 8, bit(8));
    for (let i = 9; i < 15; i++) set(14 - i, 8, bit(i));

    for (let i = 0; i < 8; i++) set(size - 1 - i, 8, bit(i));
    for (let i = 8; i < 15; i++) set(8, size - 15 + i, bit(i));
    set(8, size - 8, true);
  }

  function placeData(ctx, data) {
    const { size, mod, fn } = ctx;
    let i = 0;
    for (let right = size - 1; right >= 1; right -= 2) {
      if (right === 6) right = 5;
      for (let vert = 0; vert < size; vert++) {
        for (let j = 0; j < 2; j++) {
          const x = right - j;
          const upward = ((right + 1) & 2) === 0;
          const y = upward ? size - 1 - vert : vert;
          if (fn[y][x]) continue;
          if (i < data.length * 8) {
            mod[y][x] = (data[i >>> 3] >> (7 - (i & 7))) & 1;
            i++;
          }
        }
      }
    }
  }

  function applyMask(ctx, mask) {
    const { size, mod, fn } = ctx;
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        if (fn[y][x]) continue;
        if (maskFn(mask, x, y)) mod[y][x] ^= 1;
      }
    }
  }

  function penalty(mod, size) {
    let score = 0;
    // 规则1：连续同色
    for (let y = 0; y < size; y++) {
      let run = 1;
      for (let x = 1; x < size; x++) {
        if (mod[y][x] === mod[y][x - 1]) run++;
        else { if (run >= 5) score += 3 + (run - 5); run = 1; }
      }
      if (run >= 5) score += 3 + (run - 5);
    }
    for (let x = 0; x < size; x++) {
      let run = 1;
      for (let y = 1; y < size; y++) {
        if (mod[y][x] === mod[y - 1][x]) run++;
        else { if (run >= 5) score += 3 + (run - 5); run = 1; }
      }
      if (run >= 5) score += 3 + (run - 5);
    }
    // 规则2：2x2 同色块
    for (let y = 0; y < size - 1; y++) {
      for (let x = 0; x < size - 1; x++) {
        const v = mod[y][x];
        if (v === mod[y][x + 1] && v === mod[y + 1][x] && v === mod[y + 1][x + 1]) score += 3;
      }
    }
    // 规则3：类似定位图形的 1011101
    const pat = [1, 0, 1, 1, 1, 0, 1];
    const matchAt = (get, len, i) => {
      for (let k = 0; k < 7; k++) if (get(i + k) !== pat[k]) return false;
      const before = [1, 2, 3, 4].every((d) => i - d < 0 || get(i - d) === 0);
      const after = [7, 8, 9, 10].every((d) => i + d >= len || get(i + d) === 0);
      return before || after;
    };
    for (let y = 0; y < size; y++) {
      for (let x = 0; x <= size - 7; x++) if (matchAt((i) => mod[y][i], size, x)) score += 40;
    }
    for (let x = 0; x < size; x++) {
      for (let y = 0; y <= size - 7; y++) if (matchAt((i) => mod[i][x], size, y)) score += 40;
    }
    // 规则4：深色比例
    let dark = 0;
    for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) dark += mod[y][x];
    const pct = (dark * 100) / (size * size);
    score += Math.floor(Math.abs(pct - 50) / 5) * 10;
    return score;
  }

  function matrix(text) {
    const bytes = [...Buffer.from(String(text), 'utf8')];
    const version = pickVersion(bytes.length);
    if (!version) throw new Error('内容过长，无法生成二维码');

    const dataCw = encodeBytes(bytes, version);
    const finalCw = interleave(dataCw, version);

    let best = null;
    for (let mask = 0; mask < 8; mask++) {
      const ctx = baseMatrix(version);
      drawFormat(ctx, mask);
      placeData(ctx, finalCw);
      applyMask(ctx, mask);
      const score = penalty(ctx.mod, ctx.size);
      if (!best || score < best.score) best = { score, mod: ctx.mod, mask };
    }
    return { size: best.mod.length, mod: best.mod, version, mask: best.mask };
  }

  function svg(text, px = 240, quiet = 4) {
    const { size, mod } = matrix(text);
    const dim = size + quiet * 2;
    let path = '';
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        if (mod[y][x]) path += `M${x + quiet} ${y + quiet}h1v1h-1z`;
      }
    }
    return (
      `<svg xmlns="http://www.w3.org/2000/svg" width="${px}" height="${px}" viewBox="0 0 ${dim} ${dim}" ` +
      `shape-rendering="crispEdges"><rect width="${dim}" height="${dim}" fill="#fff"/>` +
      `<path d="${path}" fill="#000"/></svg>`
    );
  }

  return { matrix, svg };
})();



const DEVICES_FILE = path.join(DATA_DIR, 'devices.json');
const GATE_PASSWORD = String(process.env.SHARE_PASSWORD || 'XM');

// 已授权设备：以 IP 为标识，永久生效，除非主设备移除
let devices = {};
try {
  const saved = JSON.parse(fs.readFileSync(DEVICES_FILE, 'utf8'));
  if (saved && typeof saved === 'object') devices = saved;
} catch {
  /* 首次运行 */
}

function saveDevices() {
  fs.writeFile(DEVICES_FILE, JSON.stringify(devices, null, 2), () => {});
}

// 待审批 / 被拒的申请（临时，不落盘）
const pending = new Map(); // ip -> { ip, cid, name, model, at, status }

function authState(req) {
  if (isHostRequest(req)) return { authorized: true, status: 'host' };
  const ip = clientIp(req);
  if (devices[ip]) return { authorized: true, status: 'approved' };
  const p = pending.get(ip);
  if (p && p.status === 'rejected') return { authorized: false, status: 'rejected' };
  if (p) return { authorized: false, status: 'pending' };
  return { authorized: false, status: 'none' };
}

function pendingList() {
  return [...pending.values()].filter((p) => p.status === 'pending').sort((a, b) => a.at - b.at);
}

function deviceList() {
  return Object.values(devices).sort((a, b) => (b.approvedAt || 0) - (a.approvedAt || 0));
}

// 定期清理掉线设备、刷新本机网卡地址
setInterval(() => {
  const now = Date.now();
  for (const [cid, c] of clients) {
    if (now - c.lastSeen > PRESENCE_FORGET) clients.delete(cid);
  }
  refreshLanIps();
}, 15e3).unref();

/* ------------------------------------------------------------------ 工具 */

const MIME = {
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif',
  '.webp': 'image/webp', '.svg': 'image/svg+xml', '.bmp': 'image/bmp', '.avif': 'image/avif',
  '.heic': 'image/heic', '.ico': 'image/x-icon',
  '.mp4': 'video/mp4', '.webm': 'video/webm', '.mov': 'video/quicktime', '.m4v': 'video/mp4',
  '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.m4a': 'audio/mp4', '.aac': 'audio/aac',
  '.pdf': 'application/pdf',
  '.txt': 'text/plain; charset=utf-8', '.md': 'text/markdown; charset=utf-8',
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

/**
 * 局域网 IPv4 地址。跳过虚拟网卡：macOS 的 utun/awdl/bridge、
 * Windows 的 Hyper-V「vEthernet」/VMware/VirtualBox、以及 Tailscale 之类的隧道，
 * 这些地址同网段的手机是访问不到的。
 */
function lanAddresses() {
  const out = [];
  const nets = os.networkInterfaces();
  const VIRTUAL = /(utun|awdl|llw|bridge|gif\d|stf|anpi|vmenet|vmnet|docker|tap|tun|vethernet|hyper-?v|vmware|virtualbox|loopback|tailscale|zerotier|wsl|虚拟|蓝牙)/i;

  for (const name of Object.keys(nets)) {
    if (VIRTUAL.test(name)) continue;
    for (const net of nets[name] || []) {
      if (net.family !== 'IPv4' && net.family !== 4) continue;
      if (net.internal) continue;
      if (net.address.startsWith('169.254.')) continue; // 链路本地地址
      out.push({ name, address: net.address });
    }
  }
  // 常见家用 / 办公网段优先（192.168.x → 10.x → 172.x → 其它）
  const rank = (ip) =>
    ip.startsWith('192.168.') ? 0 : ip.startsWith('10.') ? 1 : ip.startsWith('172.') ? 2 : 3;
  return out.sort((a, b) => rank(a.address) - rank(b.address));
}

/** 启动后自动打开浏览器（macOS / Windows / Linux 通用） */
function openBrowser(url) {
  const cmd = IS_WIN
    ? `start "" "${url}"`
    : process.platform === 'darwin'
      ? `open "${url}"`
      : `xdg-open "${url}"`;
  try {
    exec(cmd, () => {});
  } catch {
    /* 打不开就算了，控制台里有地址 */
  }
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

  // 静态资源（图标 / 品牌图）
  if (method === 'GET' && /^\/[\w.-]+\.(png|gif|jpe?g|svg|ico|webp)$/i.test(pathname)) {
    const filePath = path.join(PUBLIC_DIR, path.basename(pathname));
    fs.readFile(filePath, (err, buf) => {
      if (err) {
        res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('Not Found');
        return;
      }
      res.writeHead(200, {
        'Content-Type': mimeOf(pathname),
        'Content-Length': buf.length,
        'Cache-Control': 'public, max-age=86400',
      });
      res.end(buf);
    });
    return;
  }

  // 服务信息（未授权也能看：页面顶部要显示地址，准入页也要靠它判断状态）
  if (method === 'GET' && pathname === '/api/info') {
    const port = server.address().port;
    const st = authState(req);
    json(res, 200, {
      host: os.hostname().replace(/\.local$/i, ''),
      port,
      urls: lanAddresses().map((n) => `http://${n.address}:${port}`),
      authorized: st.authorized,
      status: st.status,
      admin: isHostRequest(req),
      ip: clientIp(req),
    });
    return;
  }

  // 陌生设备输入接入密码 → 进入待审批
  if (method === 'POST' && pathname === '/api/auth') {
    readBody(req, 8192)
      .then((raw) => {
        let body = {};
        try { body = JSON.parse(raw || '{}'); } catch {}
        const st = authState(req);
        if (st.authorized) return json(res, 200, { authorized: true, status: st.status });

        if (String(body.password || '').trim() !== GATE_PASSWORD) {
          return json(res, 403, { authorized: false, status: 'wrong-password', error: '密码不正确' });
        }

        const ip = clientIp(req);
        const ua = String(body.ua || req.headers['user-agent'] || '').slice(0, 300);
        const model = modelFromUA(ua);
        const prev = pending.get(ip);
        pending.set(ip, {
          ip,
          cid: String(body.cid || '').slice(0, 64),
          model,
          name: prev && prev.name ? prev.name : `${model} (${ip})`,
          at: prev && prev.at ? prev.at : Date.now(),
          status: 'pending',
        });
        console.log(`  新设备申请接入：${model} (${ip}) —— 等待主设备确认`);
        json(res, 200, { authorized: false, status: 'pending', ip });
      })
      .catch(() => json(res, 400, { error: 'bad request' }));
    return;
  }

  // 设备上线 / 心跳 / 查询授权状态
  if (method === 'POST' && pathname === '/api/hello') {
    readBody(req, 8192)
      .then((raw) => {
        let body = {};
        try { body = JSON.parse(raw || '{}'); } catch { /* 空 body 也算 */ }
        const st = authState(req);

        if (!st.authorized) {
          return json(res, 200, {
            authorized: false,
            status: st.status,
            ip: clientIp(req),
            admin: false,
            me: null,
            peers: [],
            settings,
          });
        }

        const c = touchClient(req, body.cid, body.ua);
        const host = isHostRequest(req);
        json(res, 200, {
          authorized: true,
          status: st.status,
          me: publicClient(c),
          peers: peersPayload(),
          settings,
          admin: c.admin,
          pending: host ? pendingList().length : 0,
        });
      })
      .catch(() => json(res, 400, { error: 'bad request' }));
    return;
  }

  /* ---------------- 准入闸门：以下接口都要求已授权 ---------------- */
  const auth = authState(req);
  if (!auth.authorized) {
    return json(res, 401, {
      error: auth.status === 'pending' ? '等待主设备确认' : '设备未授权',
      status: auth.status,
      authorized: false,
    });
  }

  // 主设备管理授权设备
  if (pathname === '/api/devices') {
    if (!isHostRequest(req)) return json(res, 403, { error: '只有主设备可以管理设备' });

    if (method === 'GET') {
      return json(res, 200, {
        devices: deviceList(),
        pending: pendingList(),
        rejected: [...pending.values()].filter((p) => p.status === 'rejected'),
      });
    }
    if (method === 'DELETE') {
      const ip = String(url.searchParams.get('ip') || '').slice(0, 64);
      if (devices[ip]) {
        delete devices[ip];
        saveDevices();
      }
      pending.delete(ip);
      console.log(`  主设备移除了设备授权：${ip}`);
      return json(res, 200, { ok: true });
    }
  }

  if (method === 'POST' && (pathname === '/api/devices/approve' || pathname === '/api/devices/reject')) {
    if (!isHostRequest(req)) return json(res, 403, { error: '只有主设备可以审批' });
    readBody(req, 4096)
      .then((raw) => {
        let body = {};
        try { body = JSON.parse(raw || '{}'); } catch {}
        const ip = String(body.ip || '').slice(0, 64);
        const p = pending.get(ip);

        if (pathname.endsWith('/approve')) {
          if (!p) return json(res, 404, { error: '申请已失效' });
          devices[ip] = {
            ip,
            name: p.name || ip,
            model: p.model || '',
            firstSeen: p.at || Date.now(),
            approvedAt: Date.now(),
          };
          saveDevices();
          pending.delete(ip);
          console.log(`  已授权设备：${devices[ip].name}`);
          return json(res, 200, { ok: true });
        }

        pending.set(ip, {
          ip,
          cid: p ? p.cid : '',
          model: p ? p.model : '',
          name: p ? p.name : ip,
          at: p ? p.at : Date.now(),
          status: 'rejected',
        });
        console.log(`  已拒绝设备接入：${ip}`);
        json(res, 200, { ok: true });
      })
      .catch(() => json(res, 400, { error: 'bad request' }));
    return;
  }

  // 改名（留空恢复自动名）
  if (method === 'POST' && pathname === '/api/rename') {
    readBody(req, 4096)
      .then((raw) => {
        let body = {};
        try { body = JSON.parse(raw || '{}'); } catch {}
        const c = touchClient(req, body.cid, '');
        c.customName = String(body.name || '').trim().replace(/\s+/g, ' ').slice(0, 24);
        json(res, 200, { me: publicClient(c), peers: peersPayload() });
      })
      .catch(() => json(res, 400, { error: 'bad request' }));
    return;
  }

  // 主设备改权限
  if (method === 'POST' && pathname === '/api/settings') {
    if (!isHostRequest(req)) return json(res, 403, { error: '只有主设备可以修改设置' });
    readBody(req, 8192)
      .then((raw) => {
        let body = {};
        try { body = JSON.parse(raw || '{}'); } catch {}
        for (const k of SETTING_KEYS) if (typeof body[k] === 'boolean') settings[k] = body[k];
        saveSettings();
        json(res, 200, { settings });
      })
      .catch(() => json(res, 400, { error: 'bad request' }));
    return;
  }

  // 主设备生成二维码（其他设备扫码直接打开）
  if (method === 'GET' && pathname === '/api/qr') {
    if (!isHostRequest(req)) return json(res, 403, { error: '只有主设备可以生成二维码' });
    const port = server.address().port;
    const list = lanAddresses();
    const pick = String(url.searchParams.get('ip') || '') || (list[0] && list[0].address);
    if (!pick) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      return res.end('未找到可用的局域网地址');
    }
    const text = `http://${pick}:${port}`;
    const px = Math.min(720, Math.max(120, Number(url.searchParams.get('px')) || 260));
    const svg = QR.svg(text, px);
    res.writeHead(200, {
      'Content-Type': 'image/svg+xml; charset=utf-8',
      'Content-Length': Buffer.byteLength(svg),
      'Cache-Control': 'no-store',
    });
    return res.end(svg);
  }

  // 列表 + 在线设备 + 当前权限
  if (method === 'GET' && pathname === '/api/list') {
    const cid = url.searchParams.get('cid');
    const me = cid ? touchClient(req, cid, '') : null;
    // 私聊内容只有收发双方能看到；to 为空 = 全网可见
    const visible = me
      ? items.filter((it) => !it.to || it.to === me.cid || it.owner === me.cid)
      : items.filter((it) => !it.to);
    const host = isHostRequest(req);
    json(res, 200, {
      items: visible,
      count: visible.length,
      peers: peersPayload(),
      settings,
      me: me ? publicClient(me) : null,
      admin: host,
      pending: host ? pendingList().length : 0,
      now: Date.now(),
    });
    return;
  }

  // 发文字
  if (method === 'POST' && pathname === '/api/text') {
    if (!canSendType(req, 'text')) return json(res, 403, { error: denyReason('text') });
    readBody(req, MAX_TEXT)
      .then((raw) => {
        let text = '';
        let cid = '';
        let to = '';
        try {
          const body = JSON.parse(raw || '{}');
          text = String(body.text || '');
          cid = String(body.cid || '');
          to = String(body.to || '').slice(0, 64);
        } catch {
          text = raw;
        }
        text = text.replace(/\u0000/g, '').trim();
        if (!text) return json(res, 400, { error: '内容为空' });
        if (text.length > MAX_TEXT) text = text.slice(0, MAX_TEXT);

        const c = touchClient(req, cid, '');
        if (to === c.cid) to = ''; // 发给自己就等于群发
        const target = to ? clients.get(to) : null;

        const item = {
          id: newId(),
          kind: 'text',
          text,
          parts: [{ kind: 'text', text }],
          time: Date.now(),
          from: displayName(c),
          owner: c.cid,
          to,
          toName: target ? displayName(target) : '',
        };
        items.unshift(item);
        saveIndex();
        json(res, 200, { item });
      })
      .catch(() => json(res, 413, { error: '内容过长' }));
    return;
  }

  // 上传到暂存区：只落盘，不产生消息；稍后由 /api/send 一次性组成一条消息
  if (method === 'POST' && (pathname === '/api/upload' || pathname === '/api/file')) {
    const name = (url.searchParams.get('name') || 'file').slice(-180);
    const declaredType = url.searchParams.get('type') || '';
    const isImage = /^image\//i.test(declaredType) || /\.(png|jpe?g|gif|webp|avif|bmp|svg|heic)$/i.test(name);

    if (!canSendType(req, isImage ? 'image' : 'file')) {
      return json(res, 403, { error: denyReason(isImage ? 'image' : 'file') });
    }
    if (staged.size >= MAX_STAGED) {
      return json(res, 429, { error: '待发送的文件太多了，先把它们发出去' });
    }

    const owner = touchClient(req, url.searchParams.get('cid'), '');

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

      const part = {
        kind: isImage ? 'image' : 'file',
        fid: id,
        name,
        size,
        mime: mimeOf(name, declaredType),
        file: stored,
      };
      staged.set(id, { ...part, owner: owner.cid, at: Date.now() });
      json(res, 200, { part });
    });

    req.pipe(ws);
    return;
  }

  /**
   * 合并发送。parts 是有序的：文字和附件可以交替出现，
   * 于是「一段文字 + 两张图 + 一段文字 + 一个压缩包」就是一条消息。
   */
  if (method === 'POST' && pathname === '/api/send') {
    readBody(req, 256 * 1024)
      .then((raw) => {
        let body = {};
        try { body = JSON.parse(raw || '{}'); } catch { /* 空 body */ }

        const owner = touchClient(req, body.cid, '');
        let to = String(body.to || '').slice(0, 64);
        if (to === owner.cid) to = ''; // 发给自己就等于群发
        const target = to ? clients.get(to) : null;

        const wanted = Array.isArray(body.parts) ? body.parts.slice(0, MAX_PARTS * 2) : [];
        const parts = [];
        const picked = [];
        const missing = [];

        for (const p of wanted) {
          if (!p) continue;
          if (p.type === 'text' || p.kind === 'text') {
            const t = String(p.text || '').replace(/\u0000/g, '').trim();
            if (!t) continue;
            if (!canSendType(req, 'text')) return json(res, 403, { error: denyReason('text') });
            parts.push({ kind: 'text', text: t.slice(0, MAX_TEXT) });
            continue;
          }
          const s = staged.get(String(p.fid || ''));
          if (!s || (s.owner && s.owner !== owner.cid)) {  // 已被清理 / 已发送 / 不是自己传的
            missing.push(String(p.fid || ''));
            continue;
          }
          picked.push(s);
          parts.push({ kind: s.kind, fid: s.fid, name: s.name, size: s.size, mime: s.mime, file: s.file });
        }

        // 宁可整条报错，也不悄悄少发一个附件
        if (missing.length) {
          return json(res, 409, { error: `有 ${missing.length} 个附件已失效，请移除后重新添加` });
        }
        for (const s of picked) staged.delete(s.fid);

        if (!parts.length) return json(res, 400, { error: '内容为空' });
        if (parts.length > MAX_PARTS * 2) parts.length = MAX_PARTS * 2;

        const item = {
          id: newId(),
          kind: parts.length === 1 ? parts[0].kind : 'bundle',
          text: (parts.find((p) => p.kind === 'text') || {}).text || '',
          parts,
          time: Date.now(),
          from: displayName(owner),
          owner: owner.cid,
          to,
          toName: target ? displayName(target) : '',
        };
        items.unshift(item);
        reindexFiles();
        saveIndex();
        json(res, 200, { item });
      })
      .catch(() => json(res, 400, { error: 'bad request' }));
    return;
  }

  // 下载 / 预览
  if (method === 'GET' && pathname.startsWith('/f/')) {
    const fid = pathname.slice(3);
    const hit = fileIndex.get(fid);
    if (!hit) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('内容不存在');
      return;
    }
    const part = hit.part;
    const filePath = path.join(FILES_DIR, part.file);
    let stat;
    try {
      stat = fs.statSync(filePath);
    } catch {
      res.writeHead(404);
      res.end();
      return;
    }

    const inline = /^(image|video|audio|application\/pdf)/i.test(part.mime) && url.searchParams.get('dl') !== '1';
    const enc = encodeURIComponent(part.name || 'file').replace(
      /['()*]/g,
      (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase()
    );

    res.writeHead(200, {
      'Content-Type': part.mime,
      'Content-Length': stat.size,
      'Content-Disposition': `${inline ? 'inline' : 'attachment'}; filename*=UTF-8''${enc}`,
      'Cache-Control': 'public, max-age=31536000, immutable',
    });
    fs.createReadStream(filePath).pipe(res);
    return;
  }

  // 删除单条：主设备可删任意，其他设备只能删自己发的
  if (method === 'DELETE' && pathname === '/api/item') {
    const id = url.searchParams.get('id');
    const idx = items.findIndex((it) => it.id === id);
    if (idx === -1) return json(res, 404, { error: '不存在' });

    const target = items[idx];
    const cid = url.searchParams.get('cid');
    const me = cid ? clients.get(cid) : null;
    const isMine = me && me.ip === clientIp(req) && target.owner === me.cid;
    if (!isHostRequest(req) && !isMine) {
      return json(res, 403, { error: '只能删除自己发送的内容' });
    }

    items.splice(idx, 1);
    for (const p of target.parts || []) {
      if (p.file) fs.unlink(path.join(FILES_DIR, p.file), () => {});
    }
    reindexFiles();
    saveIndex();
    json(res, 200, { ok: true });
    return;
  }

  // 清空全部：仅主设备
  if (method === 'DELETE' && pathname === '/api/all') {
    if (!isHostRequest(req)) return json(res, 403, { error: '只有主设备可以清空' });
    for (const it of items) {
      for (const p of it.parts || []) {
        if (p.file) fs.unlink(path.join(FILES_DIR, p.file), () => {});
      }
    }
    items = [];
    reindexFiles();
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
    console.log('\n  XiaoMao 互传已启动\n' + line);
    console.log(`  本机     http://localhost:${actual}`);
    if (nets.length) {
      for (const n of nets) console.log(`  局域网   http://${n.address}:${actual}   (${n.name})`);
      console.log('\n  手机连同一个 Wi-Fi，在浏览器里打开上面「局域网」地址');
    } else {
      console.log('  未检测到局域网地址，请确认已连上 Wi-Fi / 网线');
    }
    console.log(line);
    console.log(`  数据目录 ${DATA_DIR}`);
    console.log(`  已有内容 ${items.length} 条`);
    console.log('  主设备   本机浏览器（localhost 访问）拥有删除 / 权限设置');
    console.log(`  停止服务 ${IS_WIN ? '按 Ctrl+C，或双击「停止.bat」' : '按 Ctrl+C'}\n`);

    if (IS_WIN && nets.length) {
      console.log('  首次运行如果 Windows 弹出防火墙提示，请勾选「专用网络」并允许。\n');
    }
    if (OPEN_ON_START) openBrowser(`http://localhost:${actual}`);
  });
}

refreshLanIps();
listen(BASE_PORT);

process.on('SIGINT', () => {
  console.log('\n已停止。数据保留在 data/ 目录。');
  process.exit(0);
});
