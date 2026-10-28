'use strict';
/**
 * 局域网互传 —— 零依赖单文件服务
 *
 * 同一个 Wi-Fi 下，任意手机 / 电脑打开 http://<本机IP>:6767 即可互传
 * 文字、图片、任意文件。所有内容只存在本机 ./data 目录，不出局域网。
 */

const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { exec } = require('child_process');
const pkg = require('./package.json'); // 版本号唯一来源，前端通过 /api/version 读取

const ROOT = __dirname;
/**
 * 数据目录默认跟着代码走（./data），但可以被 XM_DATA_DIR 覆盖。
 * 桌面壳打包后代码在只读的 asar 里，数据得放到用户目录（app.getPath('userData')），
 * 否则写 index.json / 存文件都会失败。
 */
const DATA_DIR = process.env.XM_DATA_DIR ? path.resolve(process.env.XM_DATA_DIR) : path.join(ROOT, 'data');
const FILES_DIR = path.join(DATA_DIR, 'files');
const INDEX_FILE = path.join(DATA_DIR, 'index.json');
const PUBLIC_DIR = path.join(ROOT, 'public');

const ARGS = process.argv.slice(2);
const OPEN_ON_START = ARGS.includes('--open') || ARGS.includes('-o');

const BASE_PORT = Number(process.env.PORT || 6767);
const MAX_FILE = 4 * 1024 * 1024 * 1024; // 4GB 单文件上限
const MAX_PARTS = 30;                    // 一条消息最多带 30 个附件
const MAX_STAGED = 120;                  // 暂存区上限，防内存/磁盘被灌爆
const STAGE_TTL = 30 * 60e3;             // 暂存文件 30 分钟没发送就清掉

/**
 * 文字上限按「UTF-8 字节」算，不能按字符数。
 * 中文一个字占 3 字节，早年 MAX_TEXT=51200「字符」意味着中文只有约 1.7 万字就超限，
 * 而超限后把连接直接 destroy —— 浏览器拿不到任何响应，只看到 Failed to fetch，
 * 看起来就是「发送失败 / 加载失败」，且超过 51200 字符的内容还会被静默截断。
 */
const MAX_TEXT_BYTES = 400 * 1024;       // 单个文字片段上限
const MAX_TEXT_TOTAL = 512 * 1024;       // 一条消息里文字总量上限
const WARN_TEXT_BYTES = 48 * 1024;       // 超过这个量，前端就提示改用「存为 .md」
const MAX_SEND_BODY = 768 * 1024;        // /api/send 请求体上限

const IS_WIN = process.platform === 'win32';

/** UTF-8 字节数 */
const bytesOf = (s) => Buffer.byteLength(String(s == null ? '' : s), 'utf8');

/** 字节数变「人能读的量」：409600 → 400 KB */
const fmtKB = (n) => Math.round(n / 1024) + ' KB';

fs.mkdirSync(FILES_DIR, { recursive: true });

/* ------------------------------------------------------------------ 索引 */

let items = loadIndex();

/**
 * 一条消息 = 若干片段（parts）。这样「一段文字 + 两张图 + 一个压缩包」能合成一条。
 * 老数据只有单一类型，读进来时顺手升级。
 */
// 把「发送对象」统一成 cid 数组：'' / null / undefined / [] → []；字符串 → 单元素；数组 → 去空去重
function asToArray(v) {
  if (v == null || v === '') return [];
  if (Array.isArray(v)) return [...new Set(v.map(String).filter(Boolean))].slice(0, 64);
  return [String(v)];
}

// 已知 cid 解析成展示名（在线取实时名，离线取授权记录里的名字，都没有就取后 4 位）
function nameOfCid(cid) {
  if (!cid) return '';
  const c = clients.get(cid);
  if (c) return displayName(c);
  const d = devices[cid];
  const a = d && d.acc && accounts[d.acc];
  if (a && !a.disabled) return a.name;   // 登录了账户就按账户显示
  return d ? (d.name || d.ip || cid) : cid.slice(-4);
}

function migrateItem(it) {
  if (!Array.isArray(it.parts)) {
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
    it = { ...it, parts, kind: parts.length === 1 ? parts[0].kind : 'bundle' };
  }
  // 旧版 to 是单个字符串，统一成数组，可见性规则才好写
  it.to = asToArray(it.to);
  if (it.to.length && !it.toName) it.toName = '';
  // 已读回执：哪些授权设备读过（复制 / 下载 / 看图都算），按设备去重
  if (!Array.isArray(it.readBy)) it.readBy = [];
  return it;
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
/** 一条消息占用磁盘的全部片段：正文 + 各条补充（补充也能带图片 / 文件） */
function allPartsOf(it) {
  const out = [];
  for (const p of it.parts || []) out.push(p);
  for (const n of it.notes || []) for (const p of n.parts || []) out.push(p);
  return out;
}

function reindexFiles() {
  fileIndex = new Map();
  for (const it of items) {
    for (const p of allPartsOf(it)) {
      if (p.fid && p.file) fileIndex.set(p.fid, { part: p, item: it });
    }
  }
}
reindexFiles();

/* ------------------------------------------------ 文件去重 / 引用计数 */

/**
 * 同一个文件被反复传（改个名、转发一次）在互传场景里太常见了：
 * 存一份就够。删除时要看还有没有别人指着它，否则会把别人的附件一起删掉。
 */
function refCount(file) {
  let n = 0;
  for (const it of items) {
    for (const p of allPartsOf(it)) if (p.file === file) n++;
  }
  return n;
}

/** 同上，但把待发送的暂存项也算进来（暂存区过期清理要用，免得删掉别人正要发的文件） */
function refCountWithStaged(file, exceptFid) {
  let n = refCount(file);
  for (const [fid, s] of staged) if (fid !== exceptFid && s.file === file) n++;
  return n;
}

/** 回收一组片段占用的磁盘文件：还有别的消息或待发项指着它，就留着 */
function unlinkParts(parts) {
  for (const p of parts || []) {
    if (!p.file) continue;
    // 调用方在 splice 掉本条之后才调这里，所以 refCount 只数得到「还活着」的引用。
    // 只要还有 1 个存活引用（含暂存区里的待发项），就不能删盘上的文件。
    if (refCountWithStaged(p.file) >= 1) continue;
    fs.unlink(path.join(FILES_DIR, p.file), () => {});
  }
}

/** 内容完全一样（hash + 大小都对得上）且盘上还在 → 复用那一份 */
function findDuplicate(hash, size) {
  if (!hash || !size) return null;
  const alive = (f) => f && fs.existsSync(path.join(FILES_DIR, f));
  for (const { part } of fileIndex.values()) {
    if (part.hash === hash && part.size === size && alive(part.file)) return part.file;
  }
  for (const s of staged.values()) {
    if (s.hash === hash && s.size === size && alive(s.file)) return s.file;
  }
  return null;
}

/**
 * 暂存区：先上传拿 fid，再调 /api/send 一次性组成一条消息。
 * 这样多文件能合并发送，且上传过程依旧是流式落盘，不占内存。
 */
const staged = new Map(); // fid -> { kind, fid, name, size, mime, file, owner, at }

setInterval(() => {
  const now = Date.now();
  for (const [fid, s] of staged) {
    if (now - s.at < STAGE_TTL) continue;
    // 去重后可能指着别人正在用的那份，别顺手删掉
    if (refCountWithStaged(s.file, fid) === 0) fs.unlink(path.join(FILES_DIR, s.file), () => {});
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

// keepDays：内容保留天数，0 = 永不自动清理
const clampDays = (v) => Math.max(0, Math.min(3650, Math.floor(Number(v) || 0)));

// 主设备（跑服务这台机器）可以改；其他设备只能按这里的规则来
let settings = { allowSend: true, allowText: true, allowImage: true, allowFile: true, keepDays: 0 };
try {
  const saved = JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8'));
  for (const k of SETTING_KEYS) if (typeof saved[k] === 'boolean') settings[k] = saved[k];
  if (saved && Number.isFinite(Number(saved.keepDays))) settings.keepDays = clampDays(saved.keepDays);
} catch {
  /* 首次运行用默认值 */
}

function saveSettings() {
  fs.writeFile(SETTINGS_FILE, JSON.stringify(settings, null, 2), () => {});
}

/* -------------------------------------------------- 过期内容自动清理 */

function fmtBytes(n) {
  n = Number(n) || 0;
  if (n >= 1024 ** 3) return (n / 1024 ** 3).toFixed(2) + ' GB';
  if (n >= 1024 ** 2) return (n / 1024 ** 2).toFixed(1) + ' MB';
  return Math.max(1, Math.round(n / 1024)) + ' KB';
}

/**
 * 互传的内容大多是「传完就走」，攒久了既占磁盘又难翻。
 * 设了保留天数就定期把过期内容连同文件一起清掉（文件有人共用就先留着）。
 * 手动标了「保留」（it.keep）的不动 —— 那是用户点名要留的东西，主动删除外。
 */
function sweepExpired() {
  const days = Number(settings.keepDays) || 0;
  if (days <= 0) return 0;
  const cutoff = Date.now() - days * 864e5;
  const gone = items.filter((it) => !it.keep && Number(it.time || 0) < cutoff);
  if (!gone.length) return 0;

  let bytes = 0;
  for (const it of gone) for (const p of allPartsOf(it)) bytes += Number(p.size) || 0;

  items = items.filter((it) => it.keep || Number(it.time || 0) >= cutoff);
  reindexFiles();                              // 先重索引，引用计数才数得准
  for (const it of gone) unlinkParts(allPartsOf(it));
  saveIndex();
  console.log(`  自动清理 清掉 ${gone.length} 条超过 ${days} 天的内容（约 ${fmtBytes(bytes)}）`);
  return gone.length;
}
setInterval(() => { try { sweepExpired(); } catch { /* 清理失败不影响服务 */ } }, 6 * 3600e3).unref();

/* ------------------------------------------------------------- ZIP 打包 */

/**
 * 一次下载多条内容：浏览器没有「多文件打包」这种能力，只能服务端现打一个 zip。
 * 走 store（不压缩）——照片、视频、压缩包本来就已经压过，再压一遍纯属浪费 CPU。
 */
const ZIP_MAX_TOTAL = 2 * 1024 ** 3;   // 单次打包上限，超了让用户分批

const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    t[i] = c;
  }
  return t;
})();

function crc32Update(crc, buf) {
  let c = (~crc) >>> 0;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (~c) >>> 0;
}

function dosStamp(ms) {
  const d = new Date(Number(ms) || Date.now());
  return {
    time: ((d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1)) & 0xffff,
    date: (((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate()) & 0xffff,
  };
}

/** Windows / macOS 都不认的那一堆字符，统一换成下划线 */
function safeZipName(s) {
  const BAD = '\\/:*?"<>|';
  let out = '';
  const raw = String(s || 'file');
  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i];
    const code = raw.charCodeAt(i);
    out += (code < 32 || BAD.indexOf(ch) >= 0) ? '_' : ch;
  }
  return out.trim().slice(-120) || 'file';
}

async function crcOfFile(abs) {
  let crc = 0;
  for await (const chunk of fs.createReadStream(abs, { highWaterMark: 256 * 1024 })) {
    crc = crc32Update(crc, chunk);
  }
  return crc >>> 0;
}

/** 边算边写，不把整个包憋在内存里（几个 G 的视频也能打包） */
async function streamZip(res, files) {
  const write = (buf) => new Promise((resolve) => {
    if (res.write(buf)) resolve();
    else res.once('drain', resolve);
  });
  const pipe = (abs) => new Promise((resolve, reject) => {
    const rs = fs.createReadStream(abs, { highWaterMark: 256 * 1024 });
    rs.on('error', reject);
    rs.on('data', (c) => { if (!res.write(c)) { rs.pause(); res.once('drain', () => rs.resume()); } });
    rs.on('end', resolve);
  });

  const central = [];
  let offset = 0;

  for (const f of files) {
    const nameBuf = Buffer.from(f.name, 'utf8');
    const crc = await crcOfFile(f.abs);
    const { time, date } = dosStamp(f.time);

    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0);
    lh.writeUInt16LE(20, 4);
    lh.writeUInt16LE(0x0800, 6);       // bit 11：文件名按 UTF-8 解，中文名才不乱码
    lh.writeUInt16LE(0, 8);            // 0 = store
    lh.writeUInt16LE(time, 10);
    lh.writeUInt16LE(date, 12);
    lh.writeUInt32LE(crc, 14);
    lh.writeUInt32LE(f.size, 18);
    lh.writeUInt32LE(f.size, 22);
    lh.writeUInt16LE(nameBuf.length, 26);
    lh.writeUInt16LE(0, 28);
    await write(lh);
    await write(nameBuf);
    await pipe(f.abs);

    central.push({ nameBuf, crc, size: f.size, time, date, offset });
    offset += 30 + nameBuf.length + f.size;
  }

  const cdStart = offset;
  let cdSize = 0;
  for (const e of central) {
    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0);
    ch.writeUInt16LE(20, 4);
    ch.writeUInt16LE(20, 6);
    ch.writeUInt16LE(0x0800, 8);
    ch.writeUInt16LE(0, 10);
    ch.writeUInt16LE(e.time, 12);
    ch.writeUInt16LE(e.date, 14);
    ch.writeUInt32LE(e.crc, 16);
    ch.writeUInt32LE(e.size, 20);
    ch.writeUInt32LE(e.size, 24);
    ch.writeUInt16LE(e.nameBuf.length, 28);
    ch.writeUInt32LE(e.offset, 42);
    await write(ch);
    await write(e.nameBuf);
    cdSize += 46 + e.nameBuf.length;
  }

  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(central.length, 8);
  end.writeUInt16LE(central.length, 10);
  end.writeUInt32LE(cdSize, 12);
  end.writeUInt32LE(cdStart, 16);
  await write(end);
  res.end();
}

/* -------------------------------------------- 每台设备的单独发送权限 */

const PERM_KEYS = ['send', 'text', 'image', 'file'];

/**
 * 某台设备的独立权限。没单独设过 = 全开。
 * 最终能不能发，是这个权限 ∩ 全局设置（主设备不受两者限制）。
 */
function permsOf(cid) {
  const d = cid && devices[cid];
  const p = (d && d.perms) || {};
  return {
    send: p.send !== false,
    text: p.text !== false,
    image: p.image !== false,
    file: p.file !== false,
  };
}

/* ---------------------------------------------------- 临时提权（专属密码） */
/**
 * 主设备之外的设备，输对专属密码后临时获得主设备级的管理能力
 * （改权限、审批设备、配 Telegram、清空全部、删别人发的内容）。
 * 记账维度是设备指纹 cid，并要求该设备已经通过接入许可。
 */
const ELEVATED_FILE = path.join(DATA_DIR, 'elevated.json');
const ELEVATE_PASSWORD = String(process.env.ELEVATE_PASSWORD || 'xiaomao');
const ELEVATE_TTL = 8 * 60 * 60e3;      // 提权有效期 8 小时
const ELEVATE_TRY_LIMIT = 5;
const ELEVATE_TRY_WINDOW = 10 * 60e3;

let elevated = {}; // cid -> { cid, name, ip, at }
try {
  const saved = JSON.parse(fs.readFileSync(ELEVATED_FILE, 'utf8'));
  if (saved && typeof saved === 'object') elevated = saved;
} catch {
  /* 首次运行 */
}

function saveElevated() {
  fs.writeFile(ELEVATED_FILE, JSON.stringify(elevated, null, 2), () => {});
}

const elevateTries = new Map(); // ip -> { n, until }
function elevateBlocked(ip) {
  const t = elevateTries.get(ip);
  if (!t) return false;
  if (Date.now() > t.until) { elevateTries.delete(ip); return false; }
  return t.n >= ELEVATE_TRY_LIMIT;
}
function elevateFail(ip) {
  const t = elevateTries.get(ip) || { n: 0, until: 0 };
  t.n += 1;
  t.until = Date.now() + ELEVATE_TRY_WINDOW;
  elevateTries.set(ip, t);
}

function elevateRec(cid) {
  const e = cid && elevated[cid];
  if (!e) return null;
  if (Date.now() - e.at > ELEVATE_TTL) {
    delete elevated[cid];
    saveElevated();
    return null;
  }
  return e;
}

/** 这台设备当前是否处在提权状态（主设备天然算，cid 为空就不算） */
function isElevated(req, cid) {
  if (isHostRequest(req)) return false; // 是主设备就不用「提权」这个概念
  return !!elevateRec(cid);
}

/**
 * 管理级能力 = 主控设备 / 专属密码提权 / 主控账户 / 管理员账户。
 * 能审批设备、能删改别人的内容，但改不了全局设置和账户清单。
 */
function canManage(req, cid) {
  if (isHostRequest(req) || isElevated(req, cid)) return true;
  const r = roleOf(req, cid);
  return r === 'owner' || r === 'admin';
}

/** 配置级能力：只有主控设备、专属密码提权、主控账户能改设置与账户 */
function canConfig(req, cid) {
  if (isHostRequest(req) || isElevated(req, cid)) return true;
  return roleOf(req, cid) === 'owner';
}

/* ------------------------------------------------------ Telegram 远程 */

const TG_FILE = path.join(DATA_DIR, 'telegram.json');
const TG_MAX_UPLOAD = 48 * 1024 * 1024; // Bot API 单文件上限 50MB，留点余量
const TG_TIMEOUT = 12000;
const TG_MAX_MEDIA = 6;                  // 一条消息最多转发几个附件，防刷屏
const TG_TRY_LIMIT = 5;                  // 密码错几次就锁一会儿
const TG_TRY_WINDOW = 10 * 60e3;

// token 单独存一个文件：settings 会随 /api/list 发给每台设备，绝不能混进去
// enabled 默认关：没在主设备设置里显式打开之前，任何设备都不该看到 TG 入口
let tg = { token: '', chatId: '', botUser: '', enabled: false };
try {
  const saved = JSON.parse(fs.readFileSync(TG_FILE, 'utf8'));
  if (typeof saved.token === 'string') tg.token = saved.token.trim();
  if (typeof saved.chatId === 'string') tg.chatId = saved.chatId.trim();
  if (typeof saved.botUser === 'string') tg.botUser = saved.botUser;
  if (typeof saved.enabled === 'boolean') tg.enabled = saved.enabled;
} catch {
  /* 没配置过 */
}

function saveTg() {
  fs.writeFile(TG_FILE, JSON.stringify(tg, null, 2), { mode: 0o600 }, () => {});
}

const tgReady = () => !!(tg.enabled && tg.token && tg.chatId);

const maskToken = (t) => (!t ? '' : t.length <= 12 ? '••••••' : t.slice(0, 6) + '••••' + t.slice(-4));

/**
 * 对外状态。token 和接收人 id 只回给主设备，其他设备只知道「能不能用、是哪个 bot」。
 * unlocked 是本机是否已用密码解锁（主设备天然解锁）。
 */
function publicTg(c) {
  const admin = !!(c && c.admin);
  return {
    ready: tgReady(),
    enabled: !!tg.enabled,
    configured: !!tg.token,
    bot: tg.botUser || '',
    unlocked: !!(c && (admin || c.tgUnlocked)),
    target: admin ? tg.chatId : '',
    tokenMask: admin ? maskToken(tg.token) : '',
  };
}

const tgTries = new Map(); // ip -> { n, until }
function tgTryBlocked(ip) {
  const t = tgTries.get(ip);
  if (!t) return false;
  if (Date.now() > t.until) { tgTries.delete(ip); return false; }
  return t.n >= TG_TRY_LIMIT;
}
function tgTryFail(ip) {
  const t = tgTries.get(ip) || { n: 0, until: 0 };
  t.n += 1;
  t.until = Date.now() + TG_TRY_WINDOW;
  tgTries.set(ip, t);
}

/** 网络错误翻译成人话——大概率是没代理 */
function tgFriendly(e) {
  const code = (e && e.code) || '';
  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') return '域名解析失败，检查网络或代理';
  if (code === 'ECONNREFUSED' || code === 'ECONNRESET' || code === 'EPIPE') return '连不上 api.telegram.org，可能需要代理';
  if (code === 'ETIMEDOUT') return '连接超时，可能需要代理';
  if (code === 'CERT_HAS_EXPIRED') return '证书过期，检查系统时间';
  return (e && e.message) || '网络错误';
}

/** Telegram 的英文错误翻成人话——这些提示用户是要看着自己动手改的 */
function tgExplain(desc) {
  const d = String(desc || '');
  if (/chat not found/i.test(d)) return '接收人 ID 不对，或对方还没跟机器人说过话';
  if (/Unauthorized|invalid token/i.test(d)) return 'Token 无效，或已被 BotFather 重置';
  if (/blocked by the user/i.test(d)) return '对方把机器人拉黑了';
  if (/initiate conversation|bot can't initiate/i.test(d)) return '接收人要先打开机器人会话发一句 /start';
  if (/user is deactivated/i.test(d)) return '接收人账号已注销';
  if (/message is too long/i.test(d)) return '内容超过 Telegram 的长度上限';
  if (/Too Many Requests/i.test(d)) return '请求太频繁，被 Telegram 限流了';
  if (/Butterfly|wrong file/i.test(d)) return '这个文件 Telegram 不收';
  return d;
}

/** 走系统里配的代理（Node 自己不认这些环境变量，这里手动开隧道） */
function tgProxy() {
  const raw = process.env.HTTPS_PROXY || process.env.https_proxy ||
    process.env.HTTP_PROXY || process.env.http_proxy || '';
  if (!raw) return null;
  try { return new URL(raw); } catch { return null; }
}

function tgRequest(apiPath, headers, body) {
  return new Promise((resolve, reject) => {
    const opts = {
      hostname: 'api.telegram.org',
      port: 443,
      path: apiPath,
      method: 'POST',
      headers,
      timeout: TG_TIMEOUT,
    };

    const onRes = (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        let d = null;
        try { d = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch {}
        if (d && d.ok) return resolve(d.result);
        reject(new Error(tgExplain((d && d.description) || ('Telegram 返回 HTTP ' + res.statusCode))));
      });
    };

    const send = (req) => {
      req.setTimeout(TG_TIMEOUT, () => req.destroy(Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' })));
      req.on('error', (e) => reject(new Error(tgFriendly(e))));
      req.end(body);
    };

    const proxy = tgProxy();
    if (!proxy) return send(https.request(opts, onRes));

    const auth = proxy.username
      ? {
        'Proxy-Authorization': 'Basic ' + Buffer.from(
          decodeURIComponent(proxy.username) + ':' + decodeURIComponent(proxy.password || '')
        ).toString('base64'),
      }
      : {};

    const tun = http.request({
      host: proxy.hostname,
      port: Number(proxy.port) || 80,
      method: 'CONNECT',
      path: 'api.telegram.org:443',
      headers: Object.assign({ host: 'api.telegram.org:443' }, auth),
      timeout: TG_TIMEOUT,
    });

    tun.on('connect', (res, socket) => {
      if (res.statusCode !== 200) {
        socket.destroy();
        return reject(new Error('代理拒绝了连接（HTTP ' + res.statusCode + '）'));
      }
      send(https.request(Object.assign({}, opts, {
        socket,
        agent: false,
        servername: 'api.telegram.org',
      }), onRes));
    });
    tun.on('timeout', () => tun.destroy(Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' })));
    tun.on('error', (e) => {
      const why = e && (e.code === 'ECONNREFUSED' || e.code === 'ENOTFOUND')
        ? '地址或端口不对'
        : String(tgExplain(e && e.message));
      reject(new Error('代理连不上：' + why));
    });
    tun.end();
  });
}

function tgCall(method, params) {
  const body = Buffer.from(JSON.stringify(params || {}));
  return tgRequest(`/bot${tg.token}/${method}`, {
    'Content-Type': 'application/json',
    'Content-Length': body.length,
  }, body);
}

/** 带文件的上传（sendPhoto / sendDocument）：手搓 multipart，零依赖 */
function tgUpload(method, fields, field, filePath, fileName, mime) {
  let st;
  try { st = fs.statSync(filePath); } catch { return Promise.reject(new Error('文件不在磁盘上了')); }
  if (st.size > TG_MAX_UPLOAD) return Promise.reject(new Error('超过 48MB，Telegram 传不了'));

  const boundary = '----XiaoMao' + crypto.randomBytes(12).toString('hex');
  const chunks = [];
  for (const k of Object.keys(fields || {})) {
    chunks.push(Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${fields[k]}\r\n`
    ));
  }
  const safe = String(fileName || 'file').replace(/["\r\n\\]/g, '_');
  chunks.push(Buffer.from(
    `--${boundary}\r\nContent-Disposition: form-data; name="${field}"; filename="${safe}"\r\n` +
    `Content-Type: ${mime || 'application/octet-stream'}\r\n\r\n`
  ));
  chunks.push(fs.readFileSync(filePath));
  chunks.push(Buffer.from(`\r\n--${boundary}--\r\n`));
  const body = Buffer.concat(chunks);

  return tgRequest(`/bot${tg.token}/${method}`, {
    'Content-Type': 'multipart/form-data; boundary=' + boundary,
    'Content-Length': body.length,
  }, body);
}

/**
 * 把一条消息转发到 Telegram：文字走 sendMessage，图片走 sendPhoto，其他文件走 sendDocument。
 * 文字先发，保证在会话里的顺序不乱；文字发不出去说明网络/配置有问题，直接停，不再一个个试。
 */
async function tgSendItem(item) {
  const parts = Array.isArray(item.parts) ? item.parts : [];
  const texts = parts.filter((p) => p.kind === 'text' && p.text).map((p) => p.text);
  const media = parts.filter((p) => p.kind !== 'text' && p.file);
  const failed = [];
  let sent = 0;

  const text = texts.join('\n\n').trim();
  if (text) {
    const head = '📨 ' + (item.from || '设备') +
      (item.to && item.to.length ? '（仅 ' + (item.toName || '指定设备') + ' 可见）' : '');
    // 上限 4096，留出前缀和截断标记的余量
    const body = text.length > 3600 ? text.slice(0, 3600) + '\n\n…（内容过长，已截断）' : text;
    try {
      await tgCall('sendMessage', {
        chat_id: tg.chatId,
        text: head + '\n\n' + body,
        disable_web_page_preview: true,
      });
      sent++;
    } catch (e) {
      failed.push('文字：' + e.message);
      return { sent, failed, skipped: [] };
    }
  }

  const skipped = [];
  for (let i = 0; i < media.length && i < TG_MAX_MEDIA; i++) {
    const p = media[i];
    try {
      await tgUpload(
        p.kind === 'image' ? 'sendPhoto' : 'sendDocument',
        { chat_id: tg.chatId },
        p.kind === 'image' ? 'photo' : 'document',
        path.join(FILES_DIR, p.file), p.name || p.file, p.mime
      );
      sent++;
    } catch (e) {
      failed.push((p.name || '附件') + '：' + e.message);
    }
  }
  if (media.length > TG_MAX_MEDIA) {
    skipped.push(`另有 ${media.length - TG_MAX_MEDIA} 个附件没转发（单条最多 ${TG_MAX_MEDIA} 个）`);
  }

  if (!sent && !failed.length) failed.push('没有可发送的内容');
  return { sent, failed, skipped };
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

/** 请求是否来自跑服务的这台机器（= 主设备，拥有管理权限） */
function isHostRequest(req) {
  if (hasHostToken(req)) return true;
  // 只有「回环地址 + localhost 地址栏」才算本机，防止端口转发把别人变成主设备
  const ip = clientIp(req);
  return (ip === '127.0.0.1' || ip === '::1') && isLoopbackHostHeader(req);
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
  // 顺手记下提权状态：主设备永远是主设备，其它设备可能用专属密码提过权
  c.elevated = c.admin || !!elevateRec(cid);
  // 这台设备登录的账户：身份就是它，换设备登录同一个账户还是同一个人
  c.acc = (devices[cid] && devices[cid].acc) || '';
  c.lastSeen = now;
  c.autoName = autoNameFor(req, c.model);
  return c;
}

/** 展示名：登录了账户就用账户名，否则沿用设备自定义名 / 自动名 */
function displayName(c) {
  const a = c && c.acc && accounts[c.acc];
  if (a && !a.disabled) return a.name;
  return c.customName || c.autoName;
}

function publicClient(c) {
  const a = c.acc && accounts[c.acc];
  const role = a && !a.disabled ? a.role : 'guest';
  return {
    cid: c.cid, name: displayName(c), ip: c.ip, model: c.model,
    // admin = 跑服务的那台；elevated = 用专属密码临时提过权的
    admin: !!c.admin, elevated: !!c.elevated, since: c.firstSeen,
    // acc = 登录的账户；role = 账户角色（没登录就是 guest）
    acc: c.acc || '', role, roleName: roleLabel(role),
    // dev = 这台设备自己的名字（账户名占了 name，设备名单独给，界面上好分层显示）
    dev: c.customName || c.autoName || '',
  };
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

/**
 * 某类内容当前是否允许发送。
 * cid 是这台设备的指纹：全局开关只管「整体放不放行」，per-device perms 管「这一台」。
 * 主设备永远允许。
 */
function canSendType(req, kind, cid) {
  if (isHostRequest(req)) return true;
  // 角色是第一道闸门：设备身份（未登录）能发文字和附件，其余按角色放宽
  const rc = capsOfRole(roleOf(req, cid));
  if (!rc.send) return false;
  if ((kind === 'image' || kind === 'file') && !rc.attach) return false;
  const p = permsOf(cid);
  if (!settings.allowSend || !p.send) return false;
  if (kind === 'text') return settings.allowText && p.text;
  if (kind === 'image') return settings.allowImage && p.image;
  return settings.allowFile && p.file;
}

/** 能不能发给指定的人（私聊） */
function canSendPriv(req, cid) {
  if (isHostRequest(req)) return true;
  return !!capsOfRole(roleOf(req, cid)).priv;
}

/** 一次性把能力判定结果发给前端，UI 就不用重复推规则了 */
function capsPayload(req, cid) {
  const host = isHostRequest(req);
  const role = roleOf(req, cid);
  const rc = capsOfRole(role);
  return {
    send: canSendType(req, 'text', cid) || canSendType(req, 'image', cid) || canSendType(req, 'file', cid),
    text: canSendType(req, 'text', cid),
    image: canSendType(req, 'image', cid),
    file: canSendType(req, 'file', cid),
    // priv = 能不能只发给指定的人；moderate = 能不能删改别人的内容
    priv: host || !!rc.priv,
    moderate: host || !!rc.moderate,
    devices: host || !!rc.devices,
    role,
  };
}

function denyReason(kind, cid) {
  if (!capsOfRole(roleOf(null, cid)).send) return '这台设备没有发送权限';
  const p = permsOf(cid);
  if (!settings.allowSend) return '主设备已关闭其他设备的发送权限';
  if (!p.send) return '主设备已禁止这台设备发送内容';
  if (kind === 'text' && !(settings.allowText && p.text)) return '这台设备的文字发送被限制';
  if (kind === 'image' && !(settings.allowImage && p.image)) return '这台设备的图片发送被限制';
  if (kind === 'file' && !(settings.allowFile && p.file)) return '这台设备的文件发送被限制';
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
// 隐藏的「自动授权」密码：新设备输这个，直接写入授权名单，不用主设备再去点确认
const AUTO_APPROVE_PASSWORD = String(process.env.SHARE_AUTO_PASSWORD || 'XiaoMao');

// 已授权设备：**按设备指纹（cid）记账**，IP 只用于显示和排查。
// 为什么不能拿 IP 当 key：端口转发 / 代理 / 虚拟网卡 / 公司网关会让多台设备共用同一个来源 IP，
// 按 IP 存会互相覆盖 —— 后登录的设备一获批，前一台立刻掉线。
let devices = {}; // cid -> { cid, ip, name, model, firstSeen, approvedAt, lastSeen }
try {
  const saved = JSON.parse(fs.readFileSync(DEVICES_FILE, 'utf8'));
  if (saved && typeof saved === 'object') devices = saved;
} catch {
  /* 首次运行 */
}

/**
 * 一次性迁移：旧版授权按 IP 记账（key 是 IP，且没有 cid）。
 * 这类记录既会「同 IP 换设备就继承授权」，也会「同 IP 多设备互相覆盖」。
 * 全部作废，让它们重新走「密码 + 主设备同意」，之后按 cid 记账。
 */
const legacyDeviceIps = [];
for (const [key, v] of Object.entries(devices)) {
  if (!v || typeof v !== 'object' || !v.cid || key !== v.cid) {
    delete devices[key];
    legacyDeviceIps.push((v && v.ip) || key);
  }
}

// 补 device perms：旧版本没有「每台设备单独限权」这个概念，补默认全开 = 行为不变
let permsMigrated = false;
for (const key of Object.keys(devices)) {
  const d = devices[key];
  if (!d || typeof d !== 'object') continue;
  if (!d.perms || typeof d.perms !== 'object') {
    d.perms = { send: true, text: true, image: true, file: true };
    permsMigrated = true;
  }
}

function saveDevices() {
  fs.writeFile(DEVICES_FILE, JSON.stringify(devices, null, 2), () => {});
}
if (legacyDeviceIps.length || permsMigrated) saveDevices();

/**
 * 个人资料：头像颜色 / 上传的头像。
 * 按设备指纹（cid）记账，和 devices 一样是「谁就是谁」，不走 IP。
 * 头像图存成文件，只留文件名；没设过就不在表里出现（前端按名字哈希取色兜底）。
 */
const PROFILES_FILE = path.join(DATA_DIR, 'profiles.json');
const AVATAR_DIR = path.join(DATA_DIR, 'avatars');
let profiles = {};
try {
  const saved = JSON.parse(fs.readFileSync(PROFILES_FILE, 'utf8'));
  if (saved && typeof saved === 'object') profiles = saved;
} catch {
  /* 首次运行 */
}

function saveProfiles() {
  fs.writeFile(PROFILES_FILE, JSON.stringify(profiles, null, 2), () => {});
}

/* ---------------------------------------------------- 账户（身份，可跨设备） */
/**
 * 两种身份：设备身份（过了接入许可就算）和账户身份（登录后才有）。
 * devices[cid].acc 记着「这台设备当前登录的是谁」，同一个账户可以在多台设备上登录，
 * 头像、颜色、消息归属都跟着账户走。
 * 不登录也能用：设备身份给基础能力（发 / 附件 / 私聊），管理类能力要账户角色。
 * 账户由主控在「设置 → 账户」里配置；密码只存 scrypt 派生值，明文不落盘、也不下发。
 */
const ACCOUNTS_FILE = path.join(DATA_DIR, 'accounts.json');
const ROLES = ['owner', 'admin', 'member'];
const ROLE_LABEL = { owner: '主控', admin: '管理员', member: '成员' };
/**
 * 三档角色各自能干什么：
 *   send     发消息        attach   传图片 / 文件     priv   只发给指定的人
 *   moderate 删改他人内容   devices  审批与管理设备    config 改全局设置
 *   accounts 管理账户
 */
const ROLE_CAPS = {
  owner: { send: 1, attach: 1, priv: 1, moderate: 1, devices: 1, config: 1, accounts: 1 },
  admin: { send: 1, attach: 1, priv: 1, moderate: 1, devices: 1, config: 0, accounts: 0 },
  member: { send: 1, attach: 1, priv: 1, moderate: 0, devices: 0, config: 0, accounts: 0 },
};

let accounts = {}; // accId -> { id, name, role, salt, hash, createdAt, lastLogin, disabled }
try {
  const saved = JSON.parse(fs.readFileSync(ACCOUNTS_FILE, 'utf8'));
  if (saved && typeof saved === 'object') accounts = saved;
} catch {
  /* 首次运行 */
}

function saveAccounts() {
  fs.writeFile(ACCOUNTS_FILE, JSON.stringify(accounts, null, 2), () => {});
}

const roleLabel = (r) => ROLE_LABEL[r] || '未登录';
// 未登录、但已通过接入许可的设备：按「设备身份」给基础能力（发 / 附件 / 私聊），
// 删改他人、设备管理、全局设置、账户管理仍要账户角色——所以这几项不给。
// 安全性由入口的 authState 全局拦截兜底：未授权设备根本到不了这里。
const DEVICE_CAPS = { send: 1, attach: 1, priv: 1, moderate: 0, devices: 0, config: 0, accounts: 0 };
const capsOfRole = (r) => ROLE_CAPS[r] || DEVICE_CAPS;

/** 密码只留派生值：scrypt + 每账户独立盐，比裸 sha256 抗字典 */
function hashPass(pass, salt) {
  return crypto.scryptSync(String(pass), String(salt), 32).toString('hex');
}
function setAccPass(acc, pass) {
  acc.salt = crypto.randomBytes(12).toString('hex');
  acc.hash = hashPass(pass, acc.salt);
}
function checkAccPass(acc, pass) {
  if (!acc || !acc.hash || !acc.salt) return false;
  const a = Buffer.from(acc.hash, 'hex');
  const b = Buffer.from(hashPass(pass, acc.salt), 'hex');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

/**
 * 主控账户：首次运行自动建一个，**先不设密码**。
 * 主控设备（跑服务的这台）靠身份天然就是 owner，不用登录；
 * 别的设备想登这个账户，必须先让主控在设置里设个密码，否则谁都能冒充。
 */
const OWNER_ID = (function ensureOwner() {
  for (const a of Object.values(accounts)) {
    if (a && a.role === 'owner') return a.id;
  }
  const id = 'u' + crypto.randomBytes(8).toString('hex');
  accounts[id] = {
    id, name: '主控', role: 'owner', salt: '', hash: '',
    createdAt: Date.now(), lastLogin: 0,
  };
  saveAccounts();
  console.log('  已创建主控账户（还没设密码，主控设备上可直接使用）');
  return id;
})();

/** 这台设备当前登录的账户；账户被停用等同于没登录 */
function accOfCid(cid) {
  const d = cid && devices[cid];
  const a = d && d.acc && accounts[d.acc];
  return a && !a.disabled ? a : null;
}

/** 资料（头像 / 颜色）记在哪把钥匙上：登录了按账户记，没登录按设备记 */
function keyOfCid(cid) {
  const a = accOfCid(cid);
  return a ? a.id : String(cid || '');
}

/** 当前请求的身份角色：主控设备 / 专属密码提权 = owner，未登录 = guest */
function roleOf(req, cid) {
  if (req && isHostRequest(req)) return 'owner';
  if (elevateRec(cid)) return 'owner';
  const a = accOfCid(cid);
  return a ? a.role : 'guest';
}

/** 两个人是不是同一个人：同一个账户 = 同一个人（多设备登录同一账户） */
function samePerson(a, b) {
  if (!a || !b) return false;
  if (a === b) return true;
  const ka = keyOfCid(a), kb = keyOfCid(b);
  return !!ka && ka === kb;
}

/** 主控设备也要有一条设备记录，否则它的资料没处挂、设备列表里也看不到它 */
function ensureDeviceRec(cid, req) {
  if (!cid) return null;
  let d = devices[cid];
  if (d) return d;
  const ua = String((req && req.headers['user-agent']) || '').slice(0, 300);
  const model = modelFromUA(ua);
  d = devices[cid] = {
    cid,
    ip: clientIp(req),
    name: autoNameFor(req, model),
    model,
    firstSeen: Date.now(),
    approvedAt: Date.now(),
    lastSeen: Date.now(),
    perms: { send: true, text: true, image: true, file: true },
  };
  saveDevices();
  return d;
}

/** 主控设备自动绑到主控账户：它本来就是这台机器的管理员，没必要再登录一次 */
function bindHostDevice(cid, req) {
  const d = ensureDeviceRec(cid, req);
  if (!d) return d;
  let dirty = false;
  if (!d.host) { d.host = true; dirty = true; }
  if (!d.acc) { d.acc = OWNER_ID; dirty = true; }
  if (dirty) saveDevices();
  return d;
}

/** 给前端的账户信息（不含盐和派生值） */
function publicAcc(a) {
  const p = profiles[a.id] || {};
  return {
    id: a.id,
    name: a.name,
    role: a.role,
    roleName: roleLabel(a.role),
    color: p.color || '',
    avatar: p.avatar ? (p.at || 1) : 0,
    hasPass: !!a.hash,
    disabled: !!a.disabled,
    lastLogin: a.lastLogin || 0,
    createdAt: a.createdAt || 0,
  };
}

const ROLE_RANK = { owner: 0, admin: 1, member: 2 };
function accountList(includeDisabled) {
  return Object.values(accounts)
    .filter((a) => a && (includeDisabled || !a.disabled))
    .sort((a, b) => (ROLE_RANK[a.role] ?? 9) - (ROLE_RANK[b.role] ?? 9) ||
      (a.createdAt || 0) - (b.createdAt || 0))
    .map(publicAcc);
}

// 登录也防爆破：同一个 IP 连错几次就锁一会儿
const LOGIN_TRY_LIMIT = 6;
const LOGIN_TRY_WINDOW = 10 * 60e3;
const loginTries = new Map(); // ip -> { n, until }
function loginBlocked(ip) {
  const t = loginTries.get(ip);
  if (!t) return false;
  if (Date.now() > t.until) { loginTries.delete(ip); return false; }
  return t.n >= LOGIN_TRY_LIMIT;
}
function loginFail(ip) {
  const t = loginTries.get(ip) || { n: 0, until: 0 };
  t.n += 1;
  t.until = Date.now() + LOGIN_TRY_WINDOW;
  loginTries.set(ip, t);
}

/** 某项资料的公开形态：颜色 + 头像版本号（版本号用来破缓存） */
function profEntry(key) {
  const p = profiles[key];
  if (!p || (!p.color && !p.avatar)) return null;
  return { color: p.color || '', avatar: p.avatar ? (p.at || 1) : 0 };
}

/**
 * 给前端的资料表，仍然按 cid 索引（前端各处都拿消息的 owner=cid 去查，不用改）。
 * 变的只是「这份资料属于谁」：登录了账户的设备，头像和颜色跟着账户走，
 * 于是同一个账户在多台设备上显示成同一个人。
 */
function publicProfiles() {
  const out = {};
  for (const cid of Object.keys(devices)) {
    const key = keyOfCid(cid);
    const e = profEntry(key);
    if (!e) continue;
    out[cid] = Object.assign(e, { name: nameOfCid(cid), key });
  }
  // 设备授权被撤销了，但历史消息还挂着它的 cid：资料照旧给出去，头像别突然变回首字
  for (const cid of Object.keys(profiles)) {
    if (out[cid] || accounts[cid]) continue;
    const e = profEntry(cid);
    if (e) out[cid] = Object.assign(e, { name: nameOfCid(cid), key: cid });
  }
  return out;
}

/** 删掉某台设备当前的头像文件（换新图 / 恢复默认时用） */
function dropAvatar(cid) {
  const p = profiles[cid];
  if (!p || !p.avatar) return;
  try { fs.unlinkSync(path.join(AVATAR_DIR, p.avatar)); } catch { /* 文件已不在就算了 */ }
  p.avatar = '';
}

/**
 * 主设备身份不能只看 IP：
 * 走端口转发 / 容器 / 反向代理时，局域网其他设备的请求会被中转成 127.0.0.1 或主机 LAN IP，
 * 于是「陌生设备被当成主设备」。这里改成：本机浏览器用 localhost 打开，或者带着主设备令牌。
 */
const HOST_FILE = path.join(DATA_DIR, 'host.json');
const HOST_COOKIE = 'xmhost';
const hostToken = (() => {
  try {
    const saved = JSON.parse(fs.readFileSync(HOST_FILE, 'utf8'));
    if (saved && typeof saved.token === 'string' && /^[A-Za-z0-9_-]{20,}$/.test(saved.token)) return saved.token;
  } catch { /* 首次运行 */ }
  const t = crypto.randomBytes(18).toString('base64url');
  try { fs.writeFileSync(HOST_FILE, JSON.stringify({ token: t }, null, 2), { mode: 0o600 }); } catch { /* 只读目录也能跑 */ }
  return t;
})();

function sameToken(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || !a.length || a.length !== b.length) return false;
  try { return crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b)); } catch { return false; }
}

function cookieOf(req, name) {
  const raw = String(req.headers.cookie || '');
  for (const part of raw.split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    if (part.slice(0, i).trim() !== name) continue;
    try { return decodeURIComponent(part.slice(i + 1).trim()); } catch { return part.slice(i + 1).trim(); }
  }
  return '';
}

/** 请求里是否带了主设备令牌（?host=token 或 cookie） */
function hasHostToken(req) {
  if (sameToken(req.__hostQ, hostToken)) return true;
  return sameToken(cookieOf(req, HOST_COOKIE), hostToken);
}

/** 地址栏是 localhost / 127.0.0.1 才算「本机打开」（被中转的请求 Host 仍是局域网地址） */
function isLoopbackHostHeader(req) {
  const name = String(req.headers.host || '').toLowerCase().split(':')[0];
  return name === 'localhost' || name === '127.0.0.1' || name === '[::1]' || name === '::1';
}

// 待审批 / 被拒的申请（临时，不落盘）
const pending = new Map(); // cid -> { cid, ip, name, model, at, status }

/** 取请求里的设备指纹：显式传参 > 请求头（URL 查询串由调用方先读出来传进来） */
function cidOf(req, given) {
  const c = given != null ? given : (req.headers['x-xm-cid'] || '');
  return String(c || '').slice(0, 64);
}

/** 这个 IP 上是否有已授权设备（只给带不了指纹的静态请求用） */
function anyDeviceAtIp(ip) {
  for (const k in devices) if (devices[k].ip === ip) return true;
  return false;
}

/**
 * 准入判定。
 * 身份 = 设备指纹，跟 IP 无关：同一个 IP 上同时挂 5 台设备也互不影响。
 * 只有 /f/ 下载、二维码这类由 <img>/<a> 直接发起的请求带不了请求头，
 * 这种（strict=false）才退化成「这个 IP 上有授权设备就放行」，否则图片会全裂。
 */
function authState(req, given, strict) {
  if (isHostRequest(req)) return { authorized: true, status: 'host', cid: '' };

  const cid = cidOf(req, given);
  if (cid) {
    const d = devices[cid];
    if (d) {
      d.ip = clientIp(req);
      d.lastSeen = Date.now();
      return { authorized: true, status: 'approved', cid };
    }
    const p = pending.get(cid);
    if (p && p.status === 'rejected') return { authorized: false, status: 'rejected', cid };
    if (p) return { authorized: false, status: 'pending', cid };
    return { authorized: false, status: 'none', cid };
  }

  if (!strict && anyDeviceAtIp(clientIp(req))) return { authorized: true, status: 'approved', cid: '' };
  return { authorized: false, status: 'none', cid: '' };
}

/**
 * 本次请求对应的是哪台设备。
 * 优先用准入阶段已经查过库的结果；兜底再看查询串 / 请求头。
 */
function reqCid(req, auth) {
  if (auth && auth.cid) return auth.cid;
  return cidOf(req, req.__cidQ);
}

function pendingList() {
  return [...pending.values()].filter((p) => p.status === 'pending').sort((a, b) => a.at - b.at);
}

function deviceList() {
  return Object.values(devices).sort((a, b) => (b.approvedAt || 0) - (a.approvedAt || 0));
}

// 定期清理掉线设备
setInterval(() => {
  const now = Date.now();
  for (const [cid, c] of clients) {
    if (now - c.lastSeen > PRESENCE_FORGET) clients.delete(cid);
  }
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

/**
 * 读请求体。
 * 超限**不能掐连接**：一掐，浏览器只收到 ECONNRESET，拿不到任何 HTTP 响应，
 * 前端就只能弹一个没有上下文的「Failed to fetch」。
 * 这里改成：超了就停止缓存（不浪费内存）但继续把流读完，最后 reject 一个带
 * tooBig 标记的错误，由路由统一回 413 JSON，用户才能看到「太长了该怎么做」。
 */
function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let tooBig = false;
    let done = false;

    function settle(fn) {
      if (done) return;
      done = true;
      fn();
    }

    req.on('data', (c) => {
      size += c.length;
      if (size > limit) { tooBig = true; return; }
      chunks.push(c);
    });
    req.on('end', () => settle(() => {
      if (tooBig) {
        const e = new Error('payload too large');
        e.tooBig = true;
        e.size = size;
        reject(e);
      } else {
        resolve(Buffer.concat(chunks).toString('utf8'));
      }
    }));
    req.on('aborted', () => settle(() => reject(new Error('aborted'))));
    req.on('error', (e) => settle(() => reject(e)));
  });
}

/** 请求体相关的兜底：超限给 413 + 可执行的建议，其它按 bad request */
function badBody(res, tooBigMsg) {
  return function (e) {
    if (e && e.tooBig) json(res, 413, { error: tooBigMsg, tooBig: true });
    else json(res, 400, { error: 'bad request' });
  };
}

/** 所有接口统一告诉客户端当前的上限，前端才能提前拦而不是等服务端报错 */
function limitsPayload() {
  return {
    textBytes: MAX_TEXT_BYTES,
    textTotal: MAX_TEXT_TOTAL,
    warnBytes: WARN_TEXT_BYTES,
    fileBytes: MAX_FILE,
    parts: MAX_PARTS,
  };
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

  // 主设备令牌：地址栏带 ?host=xxx 时种下 cookie，之后的请求都认得它
  req.__hostQ = url.searchParams.get('host') || '';
  req.__cidQ = url.searchParams.get('cid') || '';
  if (sameToken(req.__hostQ, hostToken)) {
    res.setHeader('Set-Cookie',
      `${HOST_COOKIE}=${encodeURIComponent(hostToken)}; Path=/; Max-Age=31536000; SameSite=Lax; HttpOnly`);
  }

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

  // PWA 清单：加到手机主屏后独立窗口打开，没有地址栏，跟原生 App 一个观感
  if (method === 'GET' && (pathname === '/manifest.webmanifest' || pathname === '/manifest.json')) {
    const appName = process.env.APP_NAME || 'XiaoMao 互传';
    const manifest = {
      name: appName,
      short_name: '互传',
      description: '同一 Wi-Fi 下互传文字、图片和文件',
      start_url: './',
      scope: './',
      display: 'standalone',
      orientation: 'portrait',
      background_color: '#f2f4f7',
      theme_color: '#f2f4f7',
      lang: 'zh-CN',
      icons: [
        { src: '/icon.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
        { src: '/icon.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
        { src: '/apple-touch-icon.png', sizes: '180x180', type: 'image/png', purpose: 'any' },
      ],
    };
    res.writeHead(200, {
      'Content-Type': 'application/manifest+json; charset=utf-8',
      'Cache-Control': 'no-cache',
    });
    res.end(JSON.stringify(manifest, null, 2));
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

  // 版本号（package.json 为唯一来源，前端关于弹窗读取）
  if (method === 'GET' && pathname === '/api/version') {
    json(res, 200, { version: pkg.version });
    return;
  }

  // 陌生设备输入接入密码 → 进入待审批
  if (method === 'POST' && pathname === '/api/auth') {
    readBody(req, 8192)
      .then((raw) => {
        let body = {};
        try { body = JSON.parse(raw || '{}'); } catch {}
        const st = authState(req, body.cid);
        if (st.authorized) return json(res, 200, { authorized: true, status: st.status });

        const pw = String(body.password || '').trim();

        // 隐藏密码：输入即自动授权接入，无需主设备再确认
        if (pw === AUTO_APPROVE_PASSWORD) {
          const ip = clientIp(req);
          const ua = String(body.ua || req.headers['user-agent'] || '').slice(0, 300);
          const model = modelFromUA(ua);
          const cid = cidOf(req, body.cid) || crypto.randomBytes(9).toString('base64url');
          if (!devices[cid]) {
            devices[cid] = {
              cid,
              ip,
              name: `${model} (${ip})`,
              model,
              firstSeen: Date.now(),
              approvedAt: Date.now(),
              lastSeen: Date.now(),
              perms: { send: true, text: true, image: true, file: true },
              autoApproved: true,
            };
            saveDevices();
            console.log(`  隐藏密码自动授权设备：${model} (${ip})`);
          }
          return json(res, 200, { authorized: true, status: 'approved', ip, cid });
        }

        if (pw !== GATE_PASSWORD) {
          return json(res, 403, { authorized: false, status: 'wrong-password', error: '密码不正确' });
        }

        const ip = clientIp(req);
        const ua = String(body.ua || req.headers['user-agent'] || '').slice(0, 300);
        const model = modelFromUA(ua);
        // 没有设备指纹就现生成一个，回给前端存起来（授权是按指纹记账的）
        const cid = cidOf(req, body.cid) || crypto.randomBytes(9).toString('base64url');
        const prev = pending.get(cid);
        pending.set(cid, {
          cid,
          ip,
          model,
          name: prev && prev.name ? prev.name : `${model} (${ip})`,
          at: prev && prev.at ? prev.at : Date.now(),
          status: 'pending',
        });
        console.log(`  新设备申请接入：${model} (${ip}) —— 等待主设备确认`);
        json(res, 200, { authorized: false, status: 'pending', ip, cid });
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
        const st = authState(req, body.cid, true);

        if (!st.authorized) {
          return json(res, 200, {
            authorized: false,
            status: st.status,
            ip: clientIp(req),
            admin: false,
            me: null,
            peers: [],
            settings,
            // 未授权设备不下发任何账户清单（避免公开有哪些账户）
            accounts: [],
            role: 'guest',
            roleName: '未登录',
          });
        }

        const cidHere = cidOf(req, body.cid);
        const host = isHostRequest(req);
        // 主控设备自动就是主控账户的那个人，不用登录
        if (host) bindHostDevice(cidHere, req);
        const c = touchClient(req, cidHere, body.ua);
        const effAdmin = canManage(req, cidHere);
        const role = roleOf(req, cidHere);
        const acc = accOfCid(cidHere);
        json(res, 200, {
          authorized: true,
          status: st.status,
          me: publicClient(c),
          peers: peersPayload(),
          settings,
          tg: publicTg(c),
          admin: effAdmin,
          hostAdmin: host,
          elevated: !host && isElevated(req, cidHere),
          canConfig: canConfig(req, cidHere),
          // acc = 当前登录的账户；role 由服务端算好，前端不自己推
          acc: acc ? publicAcc(acc) : null,
          needLogin: false,
          role,
          roleName: roleLabel(role),
          accounts: canConfig(req, cidHere) ? accountList(false) : [],
          caps: capsPayload(req, cidHere),
          limits: limitsPayload(),
          pending: effAdmin ? pendingList().length : 0,
        });
      })
      .catch(() => json(res, 400, { error: 'bad request' }));
    return;
  }

  /* ---------------- 账户登录：它本身也是一种准入方式 ---------------- */
  /**
   * 账户名 + 密码既是「我是谁」，也是「凭什么进来」，所以这个接口排在准入闸门【之前】：
   * 设备被主设备移出授权、或者换了台新设备时，拿着账户密码就能直接进来，
   * 不必再去问接入密码、也不用等主设备点同意。
   * 凭据强度也支持这么排：接入密码是全场共用的一句口令（默认还是 XM），
   * 账户密码是主控单独发给某个人的，谁该进来本来就由账户决定。
   * 放开这道口子后 /api/login 成了唯一的爆破面，所以下面全程共用 IP 限流（连错 6 次锁 10 分钟）。
   */
  if (method === 'POST' && pathname === '/api/login') {
    const ip = clientIp(req);
    if (loginBlocked(ip)) return json(res, 429, { error: '密码错太多次了，过 10 分钟再试' });
    readBody(req, 4096)
      .then((raw) => {
        let body = {};
        try { body = JSON.parse(raw || '{}'); } catch { /* 空 body */ }
        const cidHere = cidOf(req, body.cid);
        if (!cidHere) return json(res, 400, { error: '缺少设备指纹，刷新页面再试' });
        const accId = String(body.acc || '').slice(0, 64);
        const nmIn = String(body.name || '').trim().replace(/\s+/g, ' ').slice(0, 24);
        let a = accounts[accId] || null;
        // 按「账户名 + 密码」登录（前端不再列账户让人选）；也兼容旧的 accId 方式
        if (!a && nmIn) {
          a = Object.values(accounts).find((x) => x && !x.disabled && x.name === nmIn) || null;
        }
        if (!a) {
          // 不区分「账户不存在」和「密码错」，免得被拿来枚举有哪些账户
          loginFail(ip);
          return json(res, 403, { error: '账户名或密码不正确' });
        }
        if (a.disabled) return json(res, 403, { error: '这个账户已被主控停用' });
        // 没设密码的账户不放行：否则谁都能顶着「主控」的名义进来
        if (!a.hash) {
          return json(res, 403, {
            error: a.role === 'owner'
              ? '主控账户还没设密码，暂时只能在主控设备上使用'
              : '这个账户还没设密码，请让主控在「设置 → 账户」里设一个',
          });
        }
        if (loginBlocked(ip)) return json(res, 429, { error: '密码错太多次了，过 10 分钟再试' });
        if (!checkAccPass(a, body.password)) {
          loginFail(ip);
          return json(res, 403, { error: '账户名或密码不正确' });
        }
        loginTries.delete(ip);

        // 这台设备此前没有任何记录 → 这次登录同时把准入也办了；
        // 正卡在待审批里的，直接按通过处理（有账户密码的人不必再等人点同意）
        const admitted = !devices[cidHere];
        const d = ensureDeviceRec(cidHere, req);
        if (!d) return json(res, 400, { error: '缺少设备指纹，刷新页面再试' });
        if (admitted) {
          pending.delete(cidHere);
          d.autoApproved = true;   // 和「隐藏密码自动授权」同一语义：无需主设备手动同意
          d.viaLogin = true;
        }
        d.acc = a.id;
        d.lastSeen = Date.now();
        saveDevices();
        a.lastLogin = Date.now();
        saveAccounts();

        const c = touchClient(req, cidHere, body.ua);
        console.log(`  ${autoNameFor(req, c.model)} 登录为「${a.name}」（${roleLabel(a.role)}）` +
          (admitted ? ' —— 同时通过账户密码准入' : ''));
        const role = roleOf(req, cidHere);
        json(res, 200, {
          ok: true,
          authorized: true,
          admitted,
          me: publicClient(c),
          acc: publicAcc(a),
          role,
          roleName: roleLabel(role),
          admin: canManage(req, cidHere),
          hostAdmin: isHostRequest(req),
          elevated: isElevated(req, cidHere),
          canConfig: canConfig(req, cidHere),
          caps: capsPayload(req, cidHere),
          profiles: publicProfiles(),
          accounts: canConfig(req, cidHere) ? accountList(false) : [],
        });
      })
      .catch(() => json(res, 400, { error: 'bad request' }));
    return;
  }

  /* ---------------- 准入闸门：以下接口都要求已授权 ---------------- */
  // /f/ 下载和二维码是 <img>/<a> 直接发起的，带不了设备指纹，只能按 IP 认
  const lenient = pathname.startsWith('/f/') || pathname.startsWith('/a/') || pathname === '/api/qr' || pathname === '/api/info';
  const auth = authState(req, url.searchParams.get('cid') || undefined, !lenient);
  if (!auth.authorized) {
    return json(res, 401, {
      error: auth.status === 'pending' ? '等待主设备确认' : '设备未授权',
      status: auth.status,
      authorized: false,
    });
  }
  const cid = reqCid(req, auth);   // 准入阶段已认定的设备指纹，权限判定都靠它
  const manage = canManage(req, cid); // 管理级权限：主设备，或用专属密码提过权的设备

  // 已授权设备清单（精简版）：发送 / 改可见范围时用来挑接收人；任何已授权设备都能拉，不含待审/被拒
  if (method === 'GET' && pathname === '/api/devices-lite') {
    const online = new Set();
    for (const c of clients.values()) online.add(c.cid);
    const list = deviceList().map((d) => ({
      // 名字按人走：登录了账户就显示账户名（选接收人时认人比认机器直观）
      cid: d.cid, name: nameOfCid(d.cid) || d.ip || d.cid, model: d.model || '', online: online.has(d.cid),
    }));
    return json(res, 200, { devices: list });
  }

  // 标记「保留」：这条消息连同它的补充说明都不再参与自动清理（手动删除仍可删）
  if (method === 'POST' && pathname === '/api/item/keep') {
    readBody(req, 4096).then((raw) => {
      let body = {};
      try { body = JSON.parse(raw || '{}'); } catch {}
      const id = String(body.id || '');
      const it = items.find((x) => x.id === id);
      if (!it) return json(res, 404, { error: '消息不存在' });
      const cidKeep = cidOf(req, body.cid);
      const isOwner = samePerson(cidKeep, it.owner);
      if (!canManage(req, cidKeep) && !isOwner) {
        return json(res, 403, { error: '只能保留自己发送的内容' });
      }
      // 不传 keep 就是「标为保留」，传 false 取消
      if (body.keep === false) {
        delete it.keep;
        delete it.keepAt;
      } else {
        it.keep = true;
        it.keepAt = Date.now();
      }
      saveIndex();
      json(res, 200, { ok: true, keep: !!it.keep, keepAt: it.keepAt || 0 });
    }).catch(() => json(res, 400, { error: 'bad request' }));
    return;
  }

  // 修改已发消息的可见范围：只能由原发送者或主设备改
  if (method === 'POST' && pathname === '/api/item/visibility') {
    readBody(req, 4096).then((raw) => {
      let body = {};
      try { body = JSON.parse(raw || '{}'); } catch {}
      const id = String(body.id || '');
      const idx = items.findIndex((it) => it.id === id);
      if (idx === -1) return json(res, 404, { error: '消息不存在' });
      const it = items[idx];
      const cidEdit = cidOf(req, body.cid);
      const isOwner = samePerson(cidEdit, it.owner);
      if (!isHostRequest(req) && !isOwner) {
        return json(res, 403, { error: '只有发送者或主设备能修改可见范围' });
      }
      // 接收人里不必包含发送者本人（发送者本来就始终可见），过滤掉更干净
      const toArr = asToArray(body.to).filter((c) => c !== it.owner);
      it.to = toArr;
      it.toName = toArr.map(nameOfCid).join('、');
      saveIndex();
      json(res, 200, { ok: true, item: it });
    }).catch(() => json(res, 400, { error: 'bad request' }));
    return;
  }

  // 编辑已发消息：仅发送者本人可改；只改文字段内容，图片/文件保持原样不可改。
  // 编辑前的完整 parts 快照压入 history，editCount++、editedAt=now，其余字段（含 readBy 已读）不变。
  if (method === 'POST' && pathname === '/api/item/edit') {
    readBody(req, 1 << 20).then((raw) => {
      let body = {};
      try { body = JSON.parse(raw || '{}'); } catch {}
      const id = String(body.id || '');
      const idx = items.findIndex((it) => it.id === id);
      if (idx === -1) return json(res, 404, { error: '消息不存在' });
      const it = items[idx];
      const cidEdit = cidOf(req, body.cid);
      if (!samePerson(cidEdit, it.owner)) {
        return json(res, 403, { error: '只有发送者本人可以编辑' });
      }
      if (!Array.isArray(body.parts)) return json(res, 400, { error: '缺少 parts' });
      const base = Array.isArray(it.parts) && it.parts.length
        ? it.parts
        : (it.text ? [{ kind: 'text', text: it.text }] : []);
      const np = body.parts;
      // 段数、各段类型必须一致；附件引用不得变动，只能改文字内容
      if (np.length !== base.length) return json(res, 400, { error: '段落结构不一致' });
      for (let i = 0; i < base.length; i++) {
        if (np[i].kind !== base[i].kind) return json(res, 400, { error: '段落类型不一致' });
        if (base[i].kind !== 'text' && np[i].fid !== base[i].fid) return json(res, 400, { error: '附件不能修改' });
        if (base[i].kind === 'text' && typeof np[i].text !== 'string') return json(res, 400, { error: '文字内容格式错误' });
      }
      if (!Array.isArray(it.history)) it.history = [];
      it.history.push({ at: it.editedAt || it.time, by: it.owner, parts: JSON.parse(JSON.stringify(base)) });
      it.parts = JSON.parse(JSON.stringify(np));
      it.editCount = (it.editCount || 0) + 1;
      it.editedAt = Date.now();
      saveIndex();
      json(res, 200, { ok: true, item: it });
    }).catch(() => json(res, 400, { error: 'bad request' }));
    return;
  }

  // 追加补充：任意授权设备都能对任一消息追加说明；纯追加、不破坏原文、不重置已读。
  // 内容可以是 Markdown 文字，也可以是图片 / 文件（走同一个上传暂存区）。
  if (method === 'POST' && pathname === '/api/item/note') {
    readBody(req, 1 << 20).then((raw) => {
      let body = {};
      try { body = JSON.parse(raw || '{}'); } catch {}
      const id = String(body.id || '');
      const idx = items.findIndex((it) => it.id === id);
      if (idx === -1) return json(res, 404, { error: '消息不存在' });
      const it = items[idx];
      const cidNote = cidOf(req, body.cid);
      if (!cidNote) return json(res, 403, { error: '未授权的设备' });

      // 兼容只传 text 的老调用；新调用传 parts（文字段 + 附件段）
      const wanted = Array.isArray(body.parts) && body.parts.length
        ? body.parts.slice(0, MAX_PARTS * 2)
        : [{ kind: 'text', text: body.text }];

      const parts = [];
      const picked = [];
      const missing = [];
      let textBytes = 0;

      for (const p of wanted) {
        if (!p) continue;
        if (p.kind === 'text' || p.type === 'text') {
          const t = String(p.text || '').replace(/\u0000/g, '').trim();
          if (!t) continue;
          if (!canSendType(req, 'text', cidNote)) return json(res, 403, { error: denyReason('text', cidNote) });
          textBytes += bytesOf(t);
          parts.push({ kind: 'text', text: t });
          continue;
        }
        const s = staged.get(String(p.fid || ''));
        if (!s || (s.owner && s.owner !== cidNote)) { missing.push(String(p.fid || '')); continue; }
        picked.push(s);
        parts.push({ kind: s.kind, fid: s.fid, name: s.name, size: s.size, mime: s.mime, file: s.file });
      }

      // 宁可整条报错，也不悄悄少补一个附件
      if (missing.length) {
        return json(res, 409, { error: `有 ${missing.length} 个附件已失效，请移除后重新添加` });
      }
      if (!parts.length) return json(res, 400, { error: '补充内容不能为空' });
      if (textBytes > 8 * 1024) return json(res, 413, { error: '补充文字过长（上限 8KB）' });
      for (const s of picked) staged.delete(s.fid);

      if (!Array.isArray(it.notes)) it.notes = [];
      const note = {
        id: newId(),
        by: cidNote,
        at: Date.now(),
        parts,
        // 纯文本丢一份，方便老客户端与搜索
        text: parts.filter((p) => p.kind === 'text').map((p) => p.text).join('\n'),
      };
      it.notes.push(note);
      it.notesVer = (it.notesVer || 0) + 1;
      reindexFiles();
      saveIndex();
      json(res, 200, { ok: true, item: it, note });
    }).catch(() => json(res, 400, { error: 'bad request' }));
    return;
  }

  // 删除补充：补充人本人可删自己的，主设备可删任意一条
  if (method === 'POST' && pathname === '/api/item/note/del') {
    readBody(req, 4096).then((raw) => {
      let body = {};
      try { body = JSON.parse(raw || '{}'); } catch {}
      const id = String(body.id || '');
      const idx = items.findIndex((it) => it.id === id);
      if (idx === -1) return json(res, 404, { error: '消息不存在' });
      const it = items[idx];
      if (!Array.isArray(it.notes)) return json(res, 404, { error: '补充不存在' });

      const nid = String(body.noteId || '');
      const at = Number(body.at || 0);
      let ni = nid ? it.notes.findIndex((n) => n.id === nid) : -1;
      // 老数据没有 note.id，用时间戳 + 补充人兜底
      if (ni === -1 && at) ni = it.notes.findIndex((n) => Number(n.at) === at);
      if (ni === -1) return json(res, 404, { error: '补充不存在' });

      const note = it.notes[ni];
      const cidDel = cidOf(req, body.cid);
      const mine = cidDel && note.by && note.by === cidDel;
      if (!mine && !canManage(req, cidDel)) {
        return json(res, 403, { error: '只能删除自己补充的内容' });
      }

      it.notes.splice(ni, 1);
      unlinkParts(note.parts || []);
      it.notesVer = (it.notesVer || 0) + 1;
      reindexFiles();
      saveIndex();
      json(res, 200, { ok: true, item: it });
    }).catch(() => json(res, 400, { error: 'bad request' }));
    return;
  }

  // 已读回执：任意授权设备对这条消息做了「复制 / 下载 / 看图」之一即记为已读，按设备去重。
  // 主设备用空 cid 访问，不计入回执；同一设备重复阅读不会让计数增加。
  if (method === 'POST' && pathname === '/api/item/read') {
    readBody(req, 4096).then((raw) => {
      let body = {};
      try { body = JSON.parse(raw || '{}'); } catch {}
      const id = String(body.id || '');
      const idx = items.findIndex((it) => it.id === id);
      if (idx === -1) return json(res, 404, { error: '消息不存在' });
      const it = items[idx];
      if (cid) {
        if (!Array.isArray(it.readBy)) it.readBy = [];
        if (!it.readBy.includes(cid)) {
          it.readBy.push(cid);
          saveIndex();
        }
      }
      // 已读数 = 去重后的设备数，且含发送者本人（发送者必然读过自己发出去的内容）
      const seen = new Set((it.readBy || []).filter(Boolean));
      if (it.owner) seen.add(it.owner);
      json(res, 200, { ok: true, read: seen.size });
    }).catch(() => json(res, 400, { error: 'bad request' }));
    return;
  }

  // 管理设备 / 权限（主设备，或用专属密码提过权的设备）
  if (pathname === '/api/devices') {
    if (!manage) return json(res, 403, { error: '没有管理权限' });

    if (method === 'GET') {
      const list = deviceList();
      // 每台设备当前登的是哪个账户：管理页要显示「谁在用这台机器」
      const accInfo = {};
      for (const v of list) {
        const a = v.acc && accounts[v.acc];
        accInfo[v.cid] = a
          ? { id: a.id, name: a.name, role: a.role, roleName: roleLabel(a.role), disabled: !!a.disabled }
          : null;
      }
      return json(res, 200, {
        devices: list,
        accInfo: accInfo,
        perms: list.reduce(function (m, v) { m[v.cid] = permsOf(v.cid); return m; }, {}),
        pending: pendingList(),
        rejected: [...pending.values()].filter((p) => p.status === 'rejected'),
        elevated: Object.keys(elevated).filter(function (k) { return elevateRec(k); }),
      });
    }
    if (method === 'DELETE') {
      // ?all=1 一键撤销全部授权，强迫所有设备重新验证
      if (url.searchParams.get('all') === '1') {
        const n = Object.keys(devices).length;
        devices = {};
        saveDevices();
        // 授权没了，建立在授权之上的提权也一并作废
        const m = Object.keys(elevated).length;
        elevated = {};
        saveElevated();
        for (const [k, p] of pending) if (p.status !== 'rejected') pending.delete(k);
        console.log(`  主设备撤销了全部设备授权（${n} 台，其中 ${m} 台的提权同时失效）`);
        return json(res, 200, { ok: true, removed: n });
      }
      // ?dupes=1 同一 IP 只保留最新的一台，其余视为历史遗留
      // （清过浏览器数据 / 换过浏览器 / 重装过，都会在同一 IP 上堆出不再回来的旧指纹）
      if (url.searchParams.get('dupes') === '1') {
        const selfCid = cidOf(req, url.searchParams.get('cid') || undefined);
        const stamp = (v) => Number(v.lastSeen || v.approvedAt || v.firstSeen || 0);
        const byIp = new Map();
        for (const v of Object.values(devices)) {
          const ip = String(v.ip || '');
          if (!ip) continue;                      // 没有 IP 的不参与分组
          if (!byIp.has(ip)) byIp.set(ip, []);
          byIp.get(ip).push(v);
        }
        const removed = [];
        const kept = [];
        for (const [ip, list] of byIp) {
          if (list.length < 2) continue;
          // 正在操作的那台永远保留，避免把管理端自己清掉
          list.sort((a, b) => {
            if (a.cid === selfCid) return -1;
            if (b.cid === selfCid) return 1;
            return stamp(b) - stamp(a);
          });
          kept.push({ ip, cid: list[0].cid, name: list[0].name || '' });
          for (let i = 1; i < list.length; i++) {
            const v = list[i];
            if (v.host) continue;   // 主控设备的授权永远留着
            delete devices[v.cid];
            if (elevated[v.cid]) delete elevated[v.cid];
            removed.push({ ip, cid: v.cid, name: v.name || '' });
          }
        }
        if (removed.length) {
          saveDevices();
          saveElevated();
          console.log(`  主设备移除了 ${removed.length} 台同 IP 的历史设备（每个 IP 保留最新一台）`);
        }
        return json(res, 200, { ok: true, removed: removed.length, kept, list: removed });
      }
      const cidKey = String(url.searchParams.get('cid') || '').slice(0, 64);
      if (devices[cidKey] && devices[cidKey].host) {
        return json(res, 400, { error: '主控设备本身就是管理员，它的授权不能移除' });
      }
      if (devices[cidKey]) {
        const nm = devices[cidKey].name || devices[cidKey].ip || cidKey;
        delete devices[cidKey];
        saveDevices();
        if (elevated[cidKey]) { delete elevated[cidKey]; saveElevated(); }
        console.log(`  主设备移除了设备授权：${nm}`);
      }
      pending.delete(cidKey);
      return json(res, 200, { ok: true });
    }
  }

  if (method === 'POST' && (pathname === '/api/devices/approve' || pathname === '/api/devices/reject')) {
    if (!manage) return json(res, 403, { error: '没有管理权限' });
    readBody(req, 4096)
      .then((raw) => {
        let body = {};
        try { body = JSON.parse(raw || '{}'); } catch {}
        // 审批按设备指纹走：同一个 IP 上可能同时挂着好几台设备
        const cid = String(body.cid || '').slice(0, 64);
        const p = pending.get(cid);

        if (pathname.endsWith('/approve')) {
          if (!p) return json(res, 404, { error: '申请已失效，请让对方刷新页面重新申请' });
          devices[cid] = {
            cid,
            ip: p.ip || clientIp(req),
            name: p.name || p.ip || cid,
            model: p.model || '',
            firstSeen: p.at || Date.now(),
            approvedAt: Date.now(),
            lastSeen: Date.now(),
            // 新授权的设备默认全开，主设备可以随后逐项收紧
            perms: { send: true, text: true, image: true, file: true },
          };
          saveDevices();
          pending.delete(cid);
          console.log(`  已授权设备：${devices[cid].name}  （当前共 ${Object.keys(devices).length} 台）`);
          return json(res, 200, { ok: true });
        }

        pending.set(cid, {
          cid,
          ip: p ? p.ip : clientIp(req),
          model: p ? p.model : '',
          name: p ? p.name : cid,
          at: p ? p.at : Date.now(),
          status: 'rejected',
        });
        console.log(`  已拒绝设备接入：${(p && p.name) || cid}`);
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

  /**
   * 本人的资料：名字 / 头像颜色 / 上传的头像。只能改自己。
   * 头像走 base64 内联上传（前端已裁成方形小图），省掉一套 multipart 解析。
   */
  if (method === 'POST' && pathname === '/api/me/profile') {
    readBody(req, 1024 * 1024)
      .then((raw) => {
        let body = {};
        try { body = JSON.parse(raw || '{}'); } catch {}
        const self = String(cid || body.cid || '').slice(0, 64);
        // 请求里带了指纹就以它为准，防止替别人改资料
        if (cid && body.cid && String(body.cid) !== cid) return json(res, 403, { error: '只能修改自己的资料' });
        if (!self) return json(res, 403, { error: '只能修改自己的资料' });

        const c = touchClient(req, self, '');
        const acc = accOfCid(self);
        // 资料挂在身份上：登录了记在账户名下（多设备共用一份），没登录才记在这台设备上
        const key = acc ? acc.id : self;
        if (typeof body.name === 'string') {
          const nm = String(body.name).trim().replace(/\s+/g, ' ').slice(0, 24);
          if (acc) {
            // 账户名就是「你是谁」，改了所有设备一起变
            if (nm) { acc.name = nm; saveAccounts(); }
          } else {
            c.customName = nm;
            // 顺手落到 devices 里：离线设备在「发送人 / 已读」里也能显示这个名字
            if (devices[self]) { devices[self].name = c.customName || devices[self].name; saveDevices(); }
          }
        }

        const p = profiles[key] || (profiles[key] = { color: '', avatar: '', at: 0 });
        if (typeof body.color === 'string') {
          const col = String(body.color).trim().toLowerCase();
          if (!col) p.color = '';
          else if (/^#[0-9a-f]{6}$/.test(col)) p.color = col;
          else return json(res, 400, { error: '颜色格式不对' });
        }

        if (body.avatar === null || body.avatar === '') {
          dropAvatar(key);
        } else if (typeof body.avatar === 'string' && body.avatar) {
          const m = /^data:image\/(png|jpe?g|webp);base64,([A-Za-z0-9+/=]+)$/i.exec(body.avatar);
          if (!m) return json(res, 400, { error: '头像只支持 PNG / JPG / WebP' });
          const buf = Buffer.from(m[2], 'base64');
          if (!buf.length) return json(res, 400, { error: '图片内容为空' });
          if (buf.length > 600 * 1024) return json(res, 413, { error: '头像太大了（上限 600 KB）' });
          const ext = m[1].toLowerCase().startsWith('png') ? 'png' : m[1].toLowerCase() === 'webp' ? 'webp' : 'jpg';
          const file = `${key}-${Date.now().toString(36)}.${ext}`;
          try {
            fs.mkdirSync(AVATAR_DIR, { recursive: true });
            fs.writeFileSync(path.join(AVATAR_DIR, file), buf);
          } catch {
            return json(res, 500, { error: '头像保存失败，检查 data 目录权限' });
          }
          dropAvatar(key);
          p.avatar = file;
        }

        p.at = Date.now();
        if (!p.color && !p.avatar) delete profiles[key];
        saveProfiles();
        json(res, 200, {
          ok: true, me: publicClient(c), peers: peersPayload(),
          acc: accOfCid(self) ? publicAcc(accOfCid(self)) : null,
          profile: profiles[key] || null, profiles: publicProfiles(),
        });
      })
      .catch(() => json(res, 400, { error: 'bad request' }));
    return;
  }

  // 主设备：单独给某台设备设定能发什么
  if (method === 'POST' && pathname === '/api/devices/perms') {
    if (!manage) return json(res, 403, { error: '没有管理权限' });
    readBody(req, 4096)
      .then((raw) => {
        let body = {};
        try { body = JSON.parse(raw || '{}'); } catch {}
        const target = String(body.cid || '').slice(0, 64);
        if (!devices[target]) return json(res, 404, { error: '这台设备还没有授权记录' });

        const src = body.perms || {};
        const next = permsOf(target);
        for (const k of PERM_KEYS) if (typeof src[k] === 'boolean') next[k] = src[k];
        devices[target].perms = next;
        saveDevices();
        console.log(`  调整设备权限：${devices[target].name || target} → ` +
          PERM_KEYS.map((k) => k + '=' + (next[k] ? '开' : '关')).join(' '));
        json(res, 200, { ok: true, cid: target, perms: next });
      })
      .catch(() => json(res, 400, { error: 'bad request' }));
    return;
  }

  // 主设备改权限（只作用于「其他设备」整体，单台设备的限制走 /api/devices/perms）
  if (method === 'POST' && pathname === '/api/settings') {
    if (!canConfig(req, cid)) return json(res, 403, { error: '没有管理权限，只有主控能改全局设置' });
    readBody(req, 8192)
      .then((raw) => {
        let body = {};
        try { body = JSON.parse(raw || '{}'); } catch {}
        for (const k of SETTING_KEYS) if (typeof body[k] === 'boolean') settings[k] = body[k];
        if ('keepDays' in body) settings.keepDays = clampDays(body.keepDays);
        saveSettings();
        json(res, 200, { settings });
      })
      .catch(() => json(res, 400, { error: 'bad request' }));
    return;
  }

  // 主设备生成二维码（其他设备扫码直接打开）
  if (method === 'GET' && pathname === '/api/qr') {
    if (!manage) return json(res, 403, { error: '没有管理权限' });
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
    const host = isHostRequest(req);
    if (host && cid) bindHostDevice(cid, req);
    const me = cid ? touchClient(req, cid, '') : null;
    // 已通过接入许可即可看内容；账户登录是可选的「跨设备身份」，不再强制
    // （未授权设备已在入口的 authState 全局拦截，进不到这里）
    // 私聊内容只有收发双方能看到；to 为空 = 全网可见
    // 「双方」按人算：同一个账户的另一台设备也该看得见自己发的私聊
    const visible = me
      ? items.filter((it) => {
        const t = it.to || [];
        // 私聊也按「人」算：指定发给某个账户时，那个账户的每台设备都该看到
        return t.length === 0 || t.some((x) => samePerson(me.cid, x)) || samePerson(me.cid, it.owner);
      })
      : items.filter((it) => (it.to || []).length === 0);
    const role = roleOf(req, cid);
    const acc = accOfCid(cid);
    json(res, 200, {
      items: visible,
      count: visible.length,
      peers: peersPayload(),
      settings,
      tg: publicTg(me),
      me: me ? publicClient(me) : null,
      admin: manage,
      hostAdmin: host,
      elevated: isElevated(req, cid),
      canConfig: canConfig(req, cid),
      acc: acc ? publicAcc(acc) : null,
      role,
      roleName: roleLabel(role),
      accounts: canConfig(req, cid) ? accountList(false) : [],
      caps: capsPayload(req, cid),
      profiles: publicProfiles(),
      limits: limitsPayload(),
      pending: manage ? pendingList().length : 0,
      now: Date.now(),
    });
    return;
  }

  // 批量打包下载：勾选多条内容，一次拿走
  if (method === 'GET' && pathname === '/api/zip') {
    const ids = String(url.searchParams.get('ids') || '')
      .split(',').map((s) => s.trim()).filter(Boolean).slice(0, 300);
    const me = cid ? clients.get(cid) : null;
    // 已通过接入许可即可打包下载（未授权设备已在入口 authState 处被拦下）
    // 跟 /api/list 同一套可见性规则：私聊内容不能打包给别人
    const visible = me
      ? items.filter((it) => {
        const t = it.to || [];
        return t.length === 0 || t.some((x) => samePerson(me.cid, x)) || samePerson(me.cid, it.owner);
      })
      : items.filter((it) => (it.to || []).length === 0);
    const chosen = visible.filter((it) => ids.indexOf(it.id) !== -1);
    if (!chosen.length) return json(res, 404, { error: '没有可打包的内容' });

    const used = new Map();
    const files = [];
    let total = 0;
    for (const it of chosen) {
      for (const p of it.parts || []) {
        if (!p.file) continue;
        const abs = path.join(FILES_DIR, p.file);
        let st;
        try { st = fs.statSync(abs); } catch { continue; }
        const raw = safeZipName(p.name || ('文件-' + it.id));
        const n = (used.get(raw) || 0) + 1;
        used.set(raw, n);
        const dot = raw.lastIndexOf('.');
        const name = n === 1
          ? raw
          : (dot > 0 ? raw.slice(0, dot) + ' (' + n + ')' + raw.slice(dot) : raw + ' (' + n + ')');
        total += st.size;
        files.push({ abs, name, size: st.size, time: it.time });
      }
    }
    if (!files.length) return json(res, 404, { error: '选中的内容里没有文件（纯文字不用打包）' });
    // probe=1：只问「能不能打、多大」，不真的打包——前端用它提前把错误挑出来
    if (url.searchParams.get('probe') === '1') {
      return json(res, 200, {
        ok: true, count: files.length, size: total, tooBig: total > ZIP_MAX_TOTAL,
      });
    }
    if (total > ZIP_MAX_TOTAL) {
      return json(res, 413, { error: '选中的内容有 ' + fmtBytes(total) + '，太大了，请分批下载' });
    }

    const ascii = 'XiaoMao-' + new Date().toISOString().slice(0, 10).replace(/-/g, '') + '.zip';
    const cn = '小毛互传-' + new Date().toISOString().slice(0, 10) + '.zip';
    res.writeHead(200, {
      'Content-Type': 'application/zip',
      'Content-Disposition':
        'attachment; filename="' + ascii + '"; filename*=UTF-8\'\'' + encodeURIComponent(cn),
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
    });
    streamZip(res, files).catch(() => { try { res.end(); } catch {} });
    return;
  }

  /* ---------------- 临时提权：专属密码，无需主设备二次确认 ---------------- */

  // 提权：输对专属密码立刻拥有管理权限（仅限已经通过接入许可的设备）
  if (method === 'POST' && pathname === '/api/elevate') {
    const ip = clientIp(req);
    if (isHostRequest(req)) return json(res, 200, { ok: true, admin: true, elevated: false, host: true });
    if (!cid) return json(res, 403, { error: '这台设备还没有通过接入许可' });
    if (elevateBlocked(ip)) return json(res, 429, { error: '密码错太多次了，过 10 分钟再试' });

    readBody(req, 4096)
      .then((raw) => {
        let body = {};
        try { body = JSON.parse(raw || '{}'); } catch {}
        if (String(body.password || '').trim() !== ELEVATE_PASSWORD) {
          elevateFail(ip);
          return json(res, 403, { error: '专属密码不正确' });
        }
        elevateTries.delete(ip);
        const c = touchClient(req, cid, '');
        elevated[cid] = { cid, name: displayName(c), ip, at: Date.now() };
        saveElevated();
        c.elevated = true;
        console.log(`  ${displayName(c)} 用专属密码临时提权（8 小时内有效）`);
        json(res, 200, { ok: true, admin: true, elevated: true, host: false });
      })
      .catch(() => json(res, 400, { error: 'bad request' }));
    return;
  }

  // 交回临时提权
  if (method === 'POST' && pathname === '/api/elevate/off') {
    if (cid && elevated[cid]) {
      delete elevated[cid];
      saveElevated();
      const c = clients.get(cid);
      if (c) c.elevated = false;
      console.log('  已收回临时提权：' + cid.slice(-4));
    }
    json(res, 200, { ok: true, admin: isHostRequest(req), elevated: false, host: isHostRequest(req) });
    return;
  }

  /* ---------------- 账户：换个身份登录这台设备 ---------------- */

  // 退出登录：这台设备回到「设备身份」（接入许可还在，不用重新输接入密码；
  // 收发照常，只是回到最基础那档能力，管理类接口会拒绝）
  if (method === 'POST' && pathname === '/api/logout') {
    readBody(req, 4096)
      .then((raw) => {
        let body = {};
        try { body = JSON.parse(raw || '{}'); } catch { /* 空 body */ }
        const cidHere = cidOf(req, body.cid) || cid;
        const d = cidHere && devices[cidHere];
        if (d && d.acc) {
          // 主控设备本身就是主控身份，退出只会把自己降成设备身份，没有意义
          if (d.acc === OWNER_ID && isHostRequest(req)) {
            return json(res, 400, { error: '主控设备本身就是主控身份，不用退出登录' });
          }
          console.log(`  ${nameOfCid(cidHere)} 退出了账户登录`);
          delete d.acc;
          saveDevices();
        }
        const c = cidHere ? touchClient(req, cidHere, '') : null;
        const role = roleOf(req, cidHere);
        json(res, 200, {
          ok: true,
          me: c ? publicClient(c) : null,
          acc: null,
          role,
          roleName: roleLabel(role),
          admin: canManage(req, cidHere),
          canConfig: canConfig(req, cidHere),
          caps: capsPayload(req, cidHere),
          profiles: publicProfiles(),
          accounts: canConfig(req, cidHere) ? accountList(false) : [],
        });
      })
      .catch(() => json(res, 400, { error: 'bad request' }));
    return;
  }

  // 账户清单：主控能看全部（含已停用），其他人只看得到能登录的那些
  if (method === 'GET' && pathname === '/api/accounts') {
    const full = canConfig(req, cid);
    return json(res, 200, {
      accounts: accountList(full),
      full,
      ownerId: OWNER_ID,
      self: accOfCid(cid) ? accOfCid(cid).id : '',
    });
  }

  // 新建 / 修改账户（只有主控）
  if (method === 'POST' && pathname === '/api/accounts') {
    if (!canConfig(req, cid)) return json(res, 403, { error: '只有主控能管理账户' });
    readBody(req, 16 * 1024)
      .then((raw) => {
        let body = {};
        try { body = JSON.parse(raw || '{}'); } catch { /* 空 body */ }
        const id = String(body.id || '');
        const isNew = !id;
        let a = isNew ? null : accounts[id];
        if (!isNew && !a) return json(res, 404, { error: '账户不存在' });

        const name = String(body.name || '').trim().replace(/\s+/g, ' ').slice(0, 24);
        if (!name) return json(res, 400, { error: '账户名不能为空' });
        for (const k of Object.keys(accounts)) {
          if (accounts[k].id !== id && accounts[k].name === name) {
            return json(res, 400, { error: '已经有同名账户了，换一个名字' });
          }
        }

        const role = String(body.role || '');
        if (role && ROLES.indexOf(role) < 0) return json(res, 400, { error: '不认识这种角色' });
        const pass = body.password == null ? null : String(body.password);

        if (isNew) {
          if (pass !== null && pass !== '' && pass.length < 4) {
            return json(res, 400, { error: '密码至少 4 位' });
          }
          const nid = 'u' + crypto.randomBytes(8).toString('hex');
          a = accounts[nid] = {
            id: nid, name, role: role || 'member', salt: '', hash: '',
            createdAt: Date.now(), lastLogin: 0,
          };
          // 新建时可以不设密码，之后由主控补；不设密码的账户登录会被挡回来
          if (pass) setAccPass(a, pass);
          saveAccounts();
          console.log(`  主控新建账户「${name}」（${roleLabel(a.role)}）`);
          return json(res, 200, { ok: true, account: publicAcc(a), accounts: accountList(true) });
        }

        // 修改：主控这个角色不允许改，避免出现两个主控或者没主控
        if (a.role === 'owner' && role && role !== 'owner') {
          return json(res, 400, { error: '主控账户的角色不能改' });
        }
        if (a.role !== 'owner' && role === 'owner') {
          return json(res, 400, { error: '已经有主控账户了，不能再提一个' });
        }
        if (typeof body.disabled === 'boolean' && a.role === 'owner' && body.disabled) {
          return json(res, 400, { error: '主控账户不能停用' });
        }
        a.name = name;
        if (role) a.role = role;
        if (pass) {
          if (pass.length < 4) return json(res, 400, { error: '密码至少 4 位' });
          setAccPass(a, pass);
        } else if (body.clearPass === true && a.role !== 'owner') {
          a.salt = '';
          a.hash = '';
        }
        if (typeof body.disabled === 'boolean') a.disabled = body.disabled;
        saveAccounts();
        json(res, 200, { ok: true, account: publicAcc(a), accounts: accountList(true) });
      })
      .catch(() => json(res, 400, { error: 'bad request' }));
    return;
  }

  // 删除账户（只有主控；主控账户本身删不掉）
  if (method === 'DELETE' && pathname === '/api/accounts') {
    if (!canConfig(req, cid)) return json(res, 403, { error: '只有主控能管理账户' });
    const id = String(url.searchParams.get('id') || '');
    const a = accounts[id];
    if (!a) return json(res, 404, { error: '账户不存在' });
    if (a.role === 'owner') return json(res, 400, { error: '主控账户不能删除' });

    // 正在用这个账户的设备退回设备身份（还能收发，但管理能力没了），
    // 别把它们留在不存在的身份上
    let kicked = 0;
    for (const k of Object.keys(devices)) {
      if (devices[k].acc === id) { delete devices[k].acc; kicked++; }
    }
    dropAvatar(id);
    if (profiles[id] && !profiles[id].avatar && !profiles[id].color) delete profiles[id];
    delete accounts[id];
    saveAccounts();
    saveDevices();
    saveProfiles();
    console.log(`  主控删除了账户「${a.name}」` + (kicked ? `（${kicked} 台设备退回设备身份）` : ''));
    json(res, 200, { ok: true, kicked, accounts: accountList(true) });
    return;
  }

  // 发文字。长度按 UTF-8 字节算，超限回 413 并带上可执行的建议
  if (method === 'POST' && pathname === '/api/text') {
    readBody(req, MAX_TEXT_BYTES + 8192)
      .then((raw) => {
        let text = '';
        let cid = '';
        let toArr = [];
        try {
          const body = JSON.parse(raw || '{}');
          text = String(body.text || '');
          cid = String(body.cid || '');
          toArr = asToArray(body.to);
        } catch {
          text = raw;
        }
        cid = cidOf(req, cid) || cid;
        if (!canSendType(req, 'text', cid)) return json(res, 403, { error: denyReason('text', cid) });
        if (toArr.length && !canSendPriv(req, cid)) {
          return json(res, 403, { error: '当前身份不能只发给指定的人，请登录账户后再试' });
        }

        text = text.replace(/\u0000/g, '').trim();
        if (!text) return json(res, 400, { error: '内容为空' });
        // 超了也是拒，不在服务端悄悄截断
        if (bytesOf(text) > MAX_TEXT_BYTES) {
          return json(res, 413, {
            error: '文字有 ' + fmtKB(bytesOf(text)) + '，超过上限 ' + fmtKB(MAX_TEXT_BYTES) +
              '。建议拆开发送，或改用「存为 .md」',
            tooBig: true,
          });
        }

        const c = touchClient(req, cid, '');
        toArr = toArr.filter((x) => x !== c.cid); // 发送者本就可见
        const toName = toArr.map(nameOfCid).join('、');

        const item = {
          id: newId(),
          kind: 'text',
          text,
          parts: [{ kind: 'text', text }],
          time: Date.now(),
          from: displayName(c),
          owner: c.cid,
          to: toArr,
          toName,
          readBy: [],
        };
        items.unshift(item);
        saveIndex();
        json(res, 200, { item });
      })
      .catch(badBody(res, '文字超过 ' + fmtKB(MAX_TEXT_BYTES) + '，建议拆开，或改用「存为 .md」发送'));
    return;
  }

  // 上传到暂存区：只落盘，不产生消息；稍后由 /api/send 一次性组成一条消息
  if (method === 'POST' && (pathname === '/api/upload' || pathname === '/api/file')) {
    const name = (url.searchParams.get('name') || 'file').slice(-180);
    const declaredType = url.searchParams.get('type') || '';
    const isImage = /^image\//i.test(declaredType) || /\.(png|jpe?g|gif|webp|avif|bmp|svg|heic)$/i.test(name);
    const cidHere = cidOf(req, url.searchParams.get('cid'));

    if (!canSendType(req, isImage ? 'image' : 'file', cidHere)) {
      return json(res, 403, { error: denyReason(isImage ? 'image' : 'file', cidHere) });
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
    // 边写边算指纹：写完就知道这份内容是不是已经存过一份了
    const hash = crypto.createHash('sha256');

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
      hash.update(chunk);
    });

    req.on('aborted', () => fail(499, '已取消'));
    ws.on('error', () => fail(500, '写入失败'));

    ws.on('finish', () => {
      if (done) return;
      done = true;
      if (!size) return fail(400, '空文件');

      const digest = hash.digest('hex');
      let stored_ = stored;
      const dup = findDuplicate(digest, size);
      if (dup) {
        // 内容磁盘上已经有了，刚写的这份直接丢掉，指向原来那份
        fs.unlink(path.join(FILES_DIR, stored), () => {});
        stored_ = dup;
      }

      const part = {
        kind: isImage ? 'image' : 'file',
        fid: id,
        name,
        size,
        mime: mimeOf(name, declaredType),
        file: stored_,
        hash: digest,
      };
      staged.set(id, { ...part, owner: owner.cid, at: Date.now() });
      json(res, 200, { part, deduped: !!dup });
    });

    req.pipe(ws);
    return;
  }

  /**
   * 合并发送。parts 是有序的：文字和附件可以交替出现，
   * 于是「一段文字 + 两张图 + 一段文字 + 一个压缩包」就是一条消息。
   */
  if (method === 'POST' && pathname === '/api/send') {
    readBody(req, MAX_SEND_BODY)
      .then((raw) => {
        let body = {};
        try { body = JSON.parse(raw || '{}'); } catch { /* 空 body */ }

        const ownerCid = cidOf(req, body.cid);
        const owner = touchClient(req, ownerCid, '');
        // 多选发送：to 是 cid 数组；过滤掉自己（发送者本就可见），避免无意义项
        let to = asToArray(body.to).filter((c) => c !== owner.cid);
        if (to.length && !canSendPriv(req, ownerCid)) {
          return json(res, 403, { error: '当前身份不能只发给指定的人，请登录账户后再试' });
        }
        const toName = to.map(nameOfCid).join('、');

        const wanted = Array.isArray(body.parts) ? body.parts.slice(0, MAX_PARTS * 2) : [];
        const parts = [];
        const picked = [];
        const missing = [];
        let textBytes = 0;

        for (const p of wanted) {
          if (!p) continue;
          if (p.type === 'text' || p.kind === 'text') {
            const t = String(p.text || '').replace(/\u0000/g, '').trim();
            if (!t) continue;
            if (!canSendType(req, 'text', ownerCid)) return json(res, 403, { error: denyReason('text', ownerCid) });

            const piece = t;
            const need = bytesOf(piece);
            // 单段超了：只能截断，而截断就是丢内容 —— 宁可直接拒，也别让人以为发全了
            if (need > MAX_TEXT_BYTES) {
              return json(res, 413, {
                error: '其中有一段文字就有 ' + fmtKB(need) + '，超过单段上限 ' +
                  fmtKB(MAX_TEXT_BYTES) + '。建议拆开发送，或改用「存为 .md」',
                tooBig: true,
              });
            }
            if (textBytes + need > MAX_TEXT_TOTAL) {
              return json(res, 413, {
                error: '这条消息的文字总量超过 ' + fmtKB(MAX_TEXT_TOTAL) +
                  '，建议拆开发送，或改用「存为 .md」',
                tooBig: true,
              });
            }
            textBytes += need;
            parts.push({ kind: 'text', text: piece });
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

        // 发送时引用：只收 id，服务端回填发送者与片段，避免客户端伪造。
        // 引用「补充」时前端会带 note（该条补充在 notes 里的下标），按那条的作者回填。
        let quote = null;
        if (body.quote && body.quote.id) {
          const qItem = items.find((x) => x.id === String(body.quote.id));
          if (qItem) {
            let qBy = qItem.owner;
            let qByName = qItem.from;
            let qtext = '';
            const ni = Number(body.quote.note);
            const note = Number.isInteger(ni) && ni >= 0 && qItem.notes ? qItem.notes[ni] : null;
            if (note) {
              const nparts = (note.parts && note.parts.length)
                ? note.parts
                : (note.text ? [{ kind: 'text', text: note.text }] : []);
              qtext = nparts.filter((p) => p.kind === 'text').map((p) => p.text || '').join('\n');
              qBy = note.by || qItem.owner;
              qByName = nameOfCid(qBy) || qItem.from;
            } else {
              qtext = (qItem.parts || []).filter((p) => p.kind === 'text').map((p) => p.text || '').join('\n');
            }
            const snip = String(body.quote.snippet || qtext || '').replace(/\s+/g, ' ').trim().slice(0, 140);
            quote = { id: qItem.id, by: qBy, byName: qByName, snippet: snip };
          }
        }

        const item = {
          id: newId(),
          kind: parts.length === 1 ? parts[0].kind : 'bundle',
          text: (parts.find((p) => p.kind === 'text') || {}).text || '',
          parts,
          time: Date.now(),
          from: displayName(owner),
          owner: owner.cid,
          to,
          toName,
          quote,
          notes: [],
          notesVer: 0,
          readBy: [],
        };
        items.unshift(item);
        reindexFiles();
        saveIndex();
        json(res, 200, { item });
      })
      .catch(badBody(res, '内容超过 ' + fmtKB(MAX_SEND_BODY) + '，建议少带一些附件，或改用「存为 .md」发送'));
    return;
  }

  /* ---------------- Telegram 远程（主设备配置，各端密码解锁） ---------------- */

  // 主设备：读写 Bot 配置（token 只回掩码，留空表示不改）
  if (method === 'POST' && pathname === '/api/tg/config') {
    if (!canConfig(req, cid)) return json(res, 403, { error: '没有管理权限，只有主控能配 Telegram' });
    readBody(req, 8192)
      .then(async (raw) => {
        let body = {};
        try { body = JSON.parse(raw || '{}'); } catch {}
        const prev = tg.token;

        if (typeof body.token === 'string') {
          const t = body.token.trim();
          if (!t) {
            tg.token = '';
            tg.botUser = '';
          } else if (t !== prev) {
            if (!/^\d{5,}:[\w-]{20,}$/.test(t)) {
              return json(res, 400, { error: 'Token 格式不对，应该像 123456789:AAH... 这样' });
            }
            tg.token = t;
            try {
              const me = await tgCall('getMe');
              tg.botUser = me && me.username ? '@' + me.username : '';
            } catch (e) {
              tg.token = prev; // 验不过就不落盘，别把好配置弄坏
              return json(res, 400, { error: 'Token 验证失败：' + e.message });
            }
          }
        }

        if (typeof body.chatId === 'string') {
          const id = body.chatId.trim();
          if (id && !/^(-?\d{1,20}|@[A-Za-z0-9_]{4,64})$/.test(id)) {
            return json(res, 400, { error: '接收人 ID 应是数字（如 123456789）或 @频道名' });
          }
          tg.chatId = id;
        }
        if (typeof body.enabled === 'boolean') tg.enabled = body.enabled;

        saveTg();
        json(res, 200, { tg: Object.assign(publicTg({ admin: true }), {
          chatId: tg.chatId,
          tokenMask: maskToken(tg.token),
        }) });
      })
      .catch(() => json(res, 400, { error: 'bad request' }));
    return;
  }

  // 主设备：发一条测试消息，确认握手成功
  if (method === 'POST' && pathname === '/api/tg/test') {
    if (!canConfig(req, cid)) return json(res, 403, { error: '没有管理权限，只有主控能测 Telegram' });
    if (!tgReady()) return json(res, 400, { error: '还没配置好 Token 或接收人' });
    tgCall('sendMessage', {
      chat_id: tg.chatId,
      text: '🤖 XiaoMao 互传 · 测试消息\n\n配置已生效。之后在任意设备输入密码解锁，就能把消息同步到这里。',
      disable_web_page_preview: true,
    })
      .then(() => json(res, 200, { ok: true }))
      .catch((e) => json(res, 400, { error: e.message }));
    return;
  }

  // 各端：输入密码解锁本机的 Telegram 发送能力
  if (method === 'POST' && pathname === '/api/tg/unlock') {
    const ip = clientIp(req);
    if (!tgReady()) return json(res, 400, { error: '主设备还没配置 Telegram 机器人' });
    if (tgTryBlocked(ip)) return json(res, 429, { error: '密码错太多次了，过 10 分钟再试' });

    readBody(req, 4096)
      .then((raw) => {
        let body = {};
        try { body = JSON.parse(raw || '{}'); } catch {}
        if (String(body.password || '').trim() !== GATE_PASSWORD) {
          tgTryFail(ip);
          return json(res, 403, { error: '密码不正确' });
        }
        tgTries.delete(ip);
        const c = touchClient(req, body.cid, '');
        c.tgUnlocked = true;
        console.log(`  ${displayName(c)} 解锁了 Telegram 远程发送`);
        json(res, 200, { ok: true, tg: publicTg(c) });
      })
      .catch(() => json(res, 400, { error: 'bad request' }));
    return;
  }

  // 各端：关掉本机的解锁状态
  if (method === 'POST' && pathname === '/api/tg/lock') {
    readBody(req, 4096)
      .then((raw) => {
        let body = {};
        try { body = JSON.parse(raw || '{}'); } catch {}
        const c = touchClient(req, body.cid, '');
        c.tgUnlocked = false;
        json(res, 200, { ok: true, tg: publicTg(c) });
      })
      .catch(() => json(res, 400, { error: 'bad request' }));
    return;
  }

  // 把某条消息转发到 Telegram（本地已经发完，这一步只是同步出去）
  if (method === 'POST' && pathname === '/api/tg/push') {
    readBody(req, 4096)
      .then(async (raw) => {
        let body = {};
        try { body = JSON.parse(raw || '{}'); } catch {}
        if (!tgReady()) return json(res, 400, { error: '主设备还没配置 Telegram' });

        const c = touchClient(req, body.cid, '');
        if (!c.admin && !c.tgUnlocked) return json(res, 403, { error: '请先输入密码解锁 Telegram 发送' });

        const item = items.find((x) => x.id === String(body.id || ''));
        if (!item) return json(res, 404, { error: '消息不存在' });
        if (item.owner !== c.cid && !c.admin) return json(res, 403, { error: '只能同步自己发的消息' });
        if (item.tgAt) return json(res, 200, { ok: true, sent: 0, dup: true });

        try {
          const r = await tgSendItem(item);
          if (r.sent > 0 && !item.tgAt) {
            item.tgAt = Date.now();
            saveIndex();
          }
          json(res, 200, { ok: r.sent > 0, sent: r.sent, failed: r.failed, skipped: r.skipped });
        } catch (e) {
          json(res, 502, { error: e.message });
        }
      })
      .catch(() => json(res, 400, { error: 'bad request' }));
    return;
  }

  // 头像：/a/<cid>?v=<版本号>。由 <img>/background-image 直接取，带不了请求头，走宽松准入
  if (method === 'GET' && pathname.startsWith('/a/')) {
    const who = decodeURIComponent(pathname.slice(3)).slice(0, 64);
    const p = profiles[who];
    if (!p || !p.avatar) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('没有头像');
      return;
    }
    const abs = path.join(AVATAR_DIR, p.avatar);
    let st;
    try { st = fs.statSync(abs); } catch { res.writeHead(404); res.end(); return; }
    const ext = path.extname(p.avatar).slice(1).toLowerCase();
    const mime = ext === 'png' ? 'image/png' : ext === 'webp' ? 'image/webp' : 'image/jpeg';
    res.writeHead(200, {
      'Content-Type': mime,
      'Content-Length': st.size,
      'Cache-Control': 'private, max-age=604800',
    });
    fs.createReadStream(abs).pipe(res);
    return;
  }

  // 文本类文件在线预览：直接返回解码后的文字，前端按扩展名渲染 Markdown / JSON / CSV / 纯文本。
  // 图片 / 视频 / 音频 / PDF 不用这个接口 —— 它们由浏览器自己渲染（走下面的 /f/ 内联）。
  if (method === 'GET' && pathname === '/api/file/text') {
    const fid = String(url.searchParams.get('id') || '');
    const hit = fileIndex.get(fid);
    if (!hit) return json(res, 404, { error: '文件不存在' });
    const part = hit.part;
    const nm = String(part.name || '');
    const ext = (nm.split('.').pop() || '').toLowerCase();
    const TEXT_EXT = new Set([
      'txt', 'md', 'markdown', 'text', 'log', 'csv', 'tsv', 'json', 'jsonc', 'yml', 'yaml',
      'xml', 'html', 'htm', 'css', 'scss', 'less', 'js', 'mjs', 'cjs', 'ts', 'jsx', 'tsx',
      'vue', 'py', 'go', 'rs', 'java', 'kt', 'swift', 'c', 'cc', 'cpp', 'h', 'hpp', 'cs',
      'sh', 'bash', 'zsh', 'fish', 'bat', 'ps1', 'sql', 'ini', 'conf', 'cfg', 'env', 'toml',
      'gitignore', 'dockerfile', 'makefile', 'patch', 'diff', 'rtf',
    ]);
    const mime = String(part.mime || '');
    // 只认明确的文本型 mime：写 /xml/ 这种模糊匹配会把 docx（mime 里带 openxmlformats）当成文本
    const isText = /^text\//i.test(mime) || TEXT_EXT.has(ext) ||
      /^application\/(json|ld\+json|xml|x-yaml|yaml|x-sh|x-shellscript|javascript|ecmascript|x-httpd-php|x-python|x-ruby|sql)\b/i.test(mime);
    if (!isText) return json(res, 415, { error: '这类文件不支持在线预览' });

    const filePath = path.join(FILES_DIR, part.file);
    let stat;
    try { stat = fs.statSync(filePath); } catch { return json(res, 404, { error: '文件已不在磁盘上' }); }
    const MAX_TEXT = 2 * 1024 * 1024;
    if (stat.size > MAX_TEXT) {
      return json(res, 413, { error: '超过 2 MB 的文本不在这里展开，请下载后查看', tooBig: true });
    }
    let buf;
    try { buf = fs.readFileSync(filePath); } catch { return json(res, 500, { error: '读取失败' }); }
    // 前 8KB 里出现 NUL 就按二进制处理，免得把乱码塞进界面
    if (buf.subarray(0, 8192).includes(0)) return json(res, 415, { error: '这不是文本文件' });
    json(res, 200, {
      ok: true,
      name: nm,
      size: stat.size,
      mime,
      ext,
      text: buf.toString('utf8'),
    });
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
    const cidDel = cidOf(req, url.searchParams.get('cid'));
    const me = cidDel ? clients.get(cidDel) : null;
    const isMine = me && samePerson(me.cid, target.owner);
    if (!canManage(req, cidDel) && !isMine) {
      return json(res, 403, { error: '只能删除自己发送的内容' });
    }

    items.splice(idx, 1);
    unlinkParts(allPartsOf(target));
    reindexFiles();
    saveIndex();
    json(res, 200, { ok: true });
    return;
  }

  // 清空全部：主设备，或用专属密码提过权的设备。
  // 手动标了「保留」的不清 —— 那是用户点名要留的东西；真要删就单独删那一条。
  if (method === 'DELETE' && pathname === '/api/all') {
    if (!manage) return json(res, 403, { error: '没有管理权限，只有主设备可以清空' });
    const keepers = items.filter((it) => it.keep);
    const goners = items.filter((it) => !it.keep);
    items = keepers;               // 先把保留的留下，再按引用计数删文件
    reindexFiles();
    for (const it of goners) unlinkParts(allPartsOf(it));
    saveIndex();
    if (keepers.length) console.log(`  清空内容：保留 ${keepers.length} 条已标记「保留」的消息`);
    json(res, 200, { ok: true, kept: keepers.length });
    return;
  }

  res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end('Not Found');
});

/* ------------------------------------------------------------------ 启动 */

/**
 * 「启动」是一个可以被调用的动作，而不是文件末尾的一行副作用。
 *
 * 原因：桌面壳（Electron）要自己掌握生命周期 —— 它 require 本文件、调 startServer()
 * 拿到端口，把窗口指到本机地址；退出时调 stopServer()。
 * 所以这条路径上不 process.exit：宿主不是终端时，退不退出该由宿主决定，
 * 一个端口被占不该把整个桌面程序带下线。
 */

/** 当前的实际地址信息（每次都重算：端口、在线情况、内容条数都会变） */
function serverInfo() {
  const addr = server.address();
  const port = addr && typeof addr === 'object' ? addr.port : 0;
  return {
    running: !!server.listening,
    port,
    hostUrl: `http://localhost:${port}/?host=${hostToken}`, // 本机地址 = 主设备身份
    localUrl: `http://localhost:${port}/`,
    lan: lanAddresses().map((n) => ({
      name: n.name, address: n.address, url: `http://${n.address}:${port}/`,
    })),
    dataDir: DATA_DIR,
    count: items.length,
  };
}

/** 终端里那套 banner。桌面壳不打印（它有自己的界面），所以消息体单独收敛在这里 */
function printBanner(info) {
  const line = '─'.repeat(46);
  console.log('\n  XiaoMao 互传已启动\n' + line);
  console.log(`  本机     ${info.hostUrl}`);
  if (info.lan.length) {
    for (const n of info.lan) console.log(`  局域网   ${n.url}   (${n.name})`);
    console.log('\n  手机连同一个 Wi-Fi，在浏览器里打开上面「局域网」地址');
  } else {
    console.log('  未检测到局域网地址，请确认已连上 Wi-Fi / 网线');
  }
  console.log(line);
  console.log(`  数据目录 ${info.dataDir}`);
  console.log(`  已有内容 ${info.count} 条`);

  // 把已授权设备打到控制台，省得「到底谁被放行了」全靠猜
  const approved = deviceList();
  if (legacyDeviceIps.length) {
    console.log(`  授权重置 旧版按 IP 记录的授权已作废 ${legacyDeviceIps.length} 条（${legacyDeviceIps.join('、')}）`);
    console.log('            这些设备下次访问要重新输入密码并重新同意');
  }
  if (approved.length) {
    console.log(`  已授权   ${approved.length} 台`);
    for (const d of approved) console.log(`           ${d.name || d.ip}   ${d.ip}`);
  } else {
    console.log('  已授权   暂无（除主设备外，谁都要先过密码这一关）');
  }

  console.log('  主设备   用上面的「本机」地址打开一次（带 ?host= 会自动记住），即拥有删除 / 权限设置');
  console.log(`  其他设备 用「局域网」地址打开，输入密码 ${GATE_PASSWORD} 后需主设备同意；输入隐藏密码 ${AUTO_APPROVE_PASSWORD} 则自动授权`);
  console.log(`  停止服务 ${IS_WIN ? '按 Ctrl+C，或双击「停止.bat」' : '按 Ctrl+C'}\n`);

  if (IS_WIN && info.lan.length) {
    console.log('  首次运行如果 Windows 弹出防火墙提示，请勾选「专用网络」并允许。\n');
  }
}

/** 在一个端口上 listen 一次；占用就抛 EADDRINUSE，由调用方决定要不要往上试 */
function listenOnce(port) {
  return new Promise((resolve, reject) => {
    const onErr = (err) => {
      server.removeListener('listening', onOk);
      reject(err);
    };
    const onOk = () => {
      server.removeListener('error', onErr);
      resolve();
    };
    server.once('error', onErr);
    server.once('listening', onOk);
    server.listen(port, '0.0.0.0');
  });
}

/**
 * 启动服务。端口被占自动往后试（6767 → 6768 → …），和 CLI 的老行为一致。
 * @param {{port?:number, tries?:number, banner?:boolean, open?:boolean}} [opts]
 * @returns {Promise<ReturnType<typeof serverInfo>>}
 */
async function startServer(opts = {}) {
  if (server.listening) return serverInfo();

  const base = Number(opts.port) || BASE_PORT;
  const tries = Number.isInteger(opts.tries) ? opts.tries : 20;
  let lastErr = null;

  for (let i = 0; i < tries; i++) {
    try {
      await listenOnce(base + i);
      lastErr = null;
      break;
    } catch (err) {
      lastErr = err;
      if (err.code !== 'EADDRINUSE') break; // 权限之类的问题，换端口也没用
    }
  }
  if (lastErr) throw lastErr;

  sweepExpired(); // 开张前先把过期内容清掉，banner 上的条数才是真实存量
  const info = serverInfo();
  if (opts.banner !== false) printBanner(info);
  if (opts.open) openBrowser(info.hostUrl);
  return info;
}

/** 关掉服务。先断掉 keep-alive 长连接，否则 close 会一直等着它们超时 */
function stopServer() {
  return new Promise((resolve) => {
    if (!server.listening) return resolve();
    if (typeof server.closeAllConnections === 'function') server.closeAllConnections();
    server.close(() => resolve());
    setTimeout(resolve, 1500).unref(); // 兜底，别让宿主退出时卡住
  });
}

// 直接 `node server.js` 时保持原本的 CLI 行为；被 require（桌面壳）时什么都不做
if (require.main === module) {
  startServer({ open: OPEN_ON_START }).catch((err) => {
    console.error('启动失败：', err.message);
    process.exit(1);
  });

  process.on('SIGINT', () => {
    console.log('\n已停止。数据保留在 data/ 目录。');
    process.exit(0);
  });
}

module.exports = { startServer, stopServer, serverInfo, hostToken, lanAddresses, DATA_DIR, FILES_DIR };
