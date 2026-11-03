'use strict';
/**
 * 纯 Node 的自签证书生成器（零依赖，不需要 openssl）。
 *
 * 为什么需要它：Windows 默认不带 openssl，PATH 里也基本不会有，
 * 于是 `spawnSync openssl ENOENT`，HTTPS 直接降级不可用。
 * 这里用 node:crypto 生成 RSA 密钥，自己拼 X.509 DER 并签名，
 * 一条外部命令都不依赖，三个平台行为一致。
 *
 * 生成的证书包含浏览器必需的全部要素：
 *   - v3、随机序列号、SHA-256 + RSA 签名
 *   - basicConstraints CA:TRUE（和 openssl -x509 的默认行为一致）
 *   - keyUsage: digitalSignature + keyEncipherment
 *   - extendedKeyUsage: serverAuth
 *   - subjectAltName: DNS:localhost + 本机各网卡 IP（Chrome 只认 SAN，不看 CN）
 */

const crypto = require('node:crypto');

/* ---------------------------------------------------------------- DER 编码 */

/** 长度字段：<128 一字节；否则 0x8x + 大端字节数 */
function derLen(n) {
  if (n < 0x80) return Buffer.from([n]);
  const bytes = [];
  let v = n;
  while (v > 0) { bytes.unshift(v & 0xff); v = Math.floor(v / 256); }
  return Buffer.from([0x80 | bytes.length, ...bytes]);
}

/** 拼一个 TLV：tag + 长度 + 内容 */
function tlv(tag, body) {
  const b = Buffer.isBuffer(body) ? body : Buffer.from(body);
  return Buffer.concat([Buffer.from([tag]), derLen(b.length), b]);
}

const seq = (...items) => tlv(0x30, Buffer.concat(items));
const set = (...items) => tlv(0x31, Buffer.concat(items));

/** 正整数（最高位为 1 时补一个 0x00，免得被当成负数） */
function derInt(buf) {
  let b = Buffer.isBuffer(buf) ? buf : Buffer.from(buf);
  while (b.length > 1 && b[0] === 0 && !(b[1] & 0x80)) b = b.subarray(1);
  if (b[0] & 0x80) b = Buffer.concat([Buffer.from([0]), b]);
  return tlv(0x02, b);
}

/** 点分 OID → DER（首字节 40*a+b，其余 base-128 变长） */
function derOid(str) {
  const parts = String(str).split('.').map(Number);
  const out = [40 * parts[0] + parts[1]];
  for (const p of parts.slice(2)) {
    const stack = [p & 0x7f];
    let v = Math.floor(p / 128);
    while (v > 0) { stack.unshift((v & 0x7f) | 0x80); v = Math.floor(v / 128); }
    out.push(...stack);
  }
  return tlv(0x06, Buffer.from(out));
}

const derNull = () => Buffer.from([0x05, 0x00]);
const derUtf8 = (s) => tlv(0x0c, Buffer.from(String(s), 'utf8'));
const derBool = (v) => tlv(0x01, Buffer.from([v ? 0xff : 0x00]));
const derOctet = (b) => tlv(0x04, b);

/** BIT STRING：首个字节是「未用位数」，签名值/密钥位串都是 0 */
function derBitString(b, unused = 0) {
  return tlv(0x03, Buffer.concat([Buffer.from([unused]), b]));
}

/** UTCTime：YYMMDDHHMMSSZ（2050 年前用 UTC，之后该换 GeneralizedTime） */
function derUtcTime(d) {
  const p = (n) => String(n).padStart(2, '0');
  const s = p(d.getUTCFullYear() % 100) + p(d.getUTCMonth() + 1) + p(d.getUTCDate()) +
    p(d.getUTCHours()) + p(d.getUTCMinutes()) + p(d.getUTCSeconds()) + 'Z';
  return tlv(0x17, Buffer.from(s, 'ascii'));
}

/* ---------------------------------------------------------------- 结构拼装 */

const OID_SHA256_RSA = '1.2.840.113549.1.1.11';
const OID_CN = '2.5.4.3';

/** AttributeTypeAndValue 的 RDN：SET { SEQ { OID, UTF8String } } */
const rdn = (oid, value) => set(seq(derOid(oid), derUtf8(value)));

/** Extension：SEQ { OID, [critical BOOLEAN], OCTET STRING(内层 DER) } */
const ext = (oid, critical, valueDer) =>
  seq(derOid(oid), critical ? derBool(true) : Buffer.alloc(0), derOctet(valueDer));

/** GeneralName：dNSName [2] IA5String / iPAddress [7] OCTET STRING */
function generalName(type, value) {
  if (type === 'dns') return tlv(0x82, Buffer.from(String(value), 'ascii'));
  if (type === 'ip') {
    const parts = String(value).split('.').map(Number);
    if (parts.length !== 4 || parts.some((n) => !(n >= 0 && n <= 255))) {
      throw new Error('不是合法的 IPv4：' + value);
    }
    return tlv(0x87, Buffer.from(parts));
  }
  throw new Error('不支持的 GeneralName 类型：' + type);
}

/**
 * 生成自签证书。
 * @param {object} opts
 * @param {string} [opts.commonName]  CN，默认 XiaoMaoShare
 * @param {Array<{type:'dns'|'ip', value:string}>} [opts.sans] 备用名称
 * @param {number} [opts.days]  有效期天数，默认 3650
 * @param {number} [opts.bits]  RSA 位数，默认 2048
 * @returns {{key: string, cert: string}} PEM 格式
 */
function createSelfSignedCert(opts = {}) {
  const cn = opts.commonName || 'XiaoMaoShare';
  const days = Number(opts.days) > 0 ? Number(opts.days) : 3650;
  const bits = Number(opts.bits) >= 2048 ? Number(opts.bits) : 2048;
  const sans = Array.isArray(opts.sans) && opts.sans.length
    ? opts.sans
    : [{ type: 'dns', value: 'localhost' }, { type: 'ip', value: '127.0.0.1' }];

  const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', {
    modulusLength: bits,
    publicKeyEncoding: { type: 'spki', format: 'der' },
  });

  const sigAlg = seq(derOid(OID_SHA256_RSA), derNull());
  const name = seq(rdn(OID_CN, cn));

  // 序列号：16 字节随机、最高位清零（保证是正整数），避免每次重启都一样的嗅探问题
  const serial = crypto.randomBytes(16);
  serial[0] &= 0x7f;

  const now = new Date();
  const notBefore = new Date(now.getTime() - 24 * 3600 * 1000);   // 往前提一天，容忍两端时钟偏差
  const notAfter = new Date(now.getTime() + days * 24 * 3600 * 1000);
  const validity = seq(derUtcTime(notBefore), derUtcTime(notAfter));

  const extensions = seq(
    // basicConstraints: CA:TRUE（自签根，与 openssl -x509 默认一致）
    ext('2.5.29.19', true, seq(derBool(true))),
    // keyUsage: digitalSignature(0) + keyEncipherment(2) → 1010 0000
    ext('2.5.29.15', true, derBitString(Buffer.from([0xa0]), 5)),
    // extendedKeyUsage: serverAuth
    ext('2.5.29.37', false, seq(derOid('1.3.6.1.5.5.7.3.1'))),
    // subjectAltName: 浏览器只认这里，不看 CN
    ext('2.5.29.17', false, seq(...sans.map((s) => generalName(s.type, s.value)))),
  );

  const tbs = seq(
    tlv(0xa0, derInt(Buffer.from([2]))),   // version v3
    derInt(serial),
    sigAlg,
    name,                                   // issuer（自签，与 subject 相同）
    validity,
    name,                                   // subject
    publicKey,                              // SubjectPublicKeyInfo（crypto 已给 DER）
    tlv(0xa3, extensions),                  // [3] EXPLICIT Extensions
  );

  const signature = crypto.sign('sha256', tbs, privateKey);
  const certDer = seq(tbs, sigAlg, derBitString(signature));

  const pem = (label, der) => {
    const b64 = der.toString('base64').replace(/(.{64})/g, '$1\n').replace(/\n$/, '');
    return `-----BEGIN ${label}-----\n${b64}\n-----END ${label}-----\n`;
  };

  return {
    key: privateKey.export({ type: 'pkcs8', format: 'pem' }),
    cert: pem('CERTIFICATE', certDer),
  };
}

module.exports = { createSelfSignedCert };

/* 直接跑这个文件时自检：生成一份，打印主题与 SAN，便于手工核对 */
if (require.main === module) {
  const out = createSelfSignedCert({ sans: [{ type: 'dns', value: 'localhost' }, { type: 'ip', value: '127.0.0.1' }] });
  const x = new crypto.X509Certificate(out.cert);
  console.log('subject:', x.subject.replace(/\n/g, ', '));
  console.log('issuer :', x.issuer.replace(/\n/g, ', '));
  console.log('valid  :', x.validFrom, '→', x.validTo);
  console.log('SAN    :', x.subjectAltName);
  // 注意：X509Certificate.checkIssued(自己) 恒为 false（缺 AKID/SKID 时它不做自签判断），
  // 别拿它当结论 —— 真正有意义的是签名能不能被自己的公钥验过
  console.log('签名自验:', x.verify(x.publicKey) ? 'ok' : 'FAIL');
  console.log('--- key.pem ---\n' + out.key.split('\n')[0] + '\n--- cert.pem ---\n' + out.cert.split('\n')[0]);
}
