/**
 * happyrun 签名 / AES 加解密 —— 从 references/artifacts/signer.mjs 复刻
 * 还原自小程序主包 app-service.js 模块 90c5 / ed08，已自检通过。
 *
 *   SignMD5(params, salt) = md5( keys.sort().reduce((a,k)=>a+`${k}${params[k]}`,'') + salt )
 *   Encrypt/Decrypt      = AES-128-CBC / PKCS7 → base64
 */
import crypto from 'node:crypto';

export const SALT = 'rDJiNB9j7vD2';
export const AES_KEY = 'Wet2C8d34f62ndi3';
export const AES_IV = 'K6iv85jBD8jgf32D';

export function md5(str) {
  return crypto.createHash('md5').update(str, 'utf8').digest('hex');
}

/** 6 位随机数字字符串，与小程序 random6() 一致 */
export function random6() {
  return String(parseInt(1e6 * Math.random()) + 1e6).substring(1, 7);
}

/**
 * SignMD5 —— 参数字典排序拼接 key+value，末尾追加 salt，整体 MD5。
 * 注意 value 直接字符串拼接（不做 encodeURIComponent），与小程序一致。
 */
export function SignMD5(params, salt = SALT) {
  const sorted = Object.keys(params)
    .sort()
    .reduce((acc, k) => acc + `${k}${params[k]}`, '');
  return md5(sorted + salt);
}

/** AES-128-CBC / PKCS7 加密 → base64 */
export function encrypt(plaintext, key = AES_KEY, iv = AES_IV) {
  const cipher = crypto.createCipheriv('aes-128-cbc', Buffer.from(key, 'utf8'), Buffer.from(iv, 'utf8'));
  let enc = cipher.update(plaintext, 'utf8', 'base64');
  enc += cipher.final('base64');
  return enc;
}

/** AES-128-CBC / PKCS7 解密 → utf8 */
export function decrypt(cipherB64, key = AES_KEY, iv = AES_IV) {
  const decipher = crypto.createDecipheriv('aes-128-cbc', Buffer.from(key, 'utf8'), Buffer.from(iv, 'utf8'));
  let dec = decipher.update(cipherB64, 'base64', 'utf8');
  dec += decipher.final('utf8');
  return dec;
}

/**
 * 组装 POST body —— 复刻请求拦截器 §2.1：
 *   base = { ...common, ...t.data, timestamp, version:1, nonce, ostype:5 }
 *   sign = SignMD5(base, SALT)
 *   body = { ostype:5, data: Encrypt(JSON.stringify({...base, sign})) }
 *   uid 为空字符串时删除（源码: ""===i.uid&&delete i.uid）
 */
export function buildPostBody(tData = {}, common = {}) {
  const base = {
    ...common,
    ...tData,
    timestamp: Date.now() / 1e3, // 秒级浮点
    version: 1,
    nonce: random6(),
    ostype: 5,
  };
  // 与小程序拦截器一致：空字符串 uid 删除
  if (base.uid === '') delete base.uid;
  // 防御：config 缺字段导致 undefined/null 时删除，避免签名基底与
  // JSON.stringify 明文不一致（JSON.stringify 会省略 undefined，但
  // SignMD5 的 `${params[k]}` 会把 undefined 转成 "undefined" 拼入签名串 → 签名错乱）
  for (const k of Object.keys(base)) {
    if (base[k] === undefined || base[k] === null) delete base[k];
  }
  const sign = SignMD5(base, SALT);
  const payload = JSON.stringify({ ...base, sign });
  return { ostype: 5, data: encrypt(payload, AES_KEY, AES_IV) };
}

/**
 * 组装带签名的 GET URL —— 复刻 makeUrl2（H5 / WebView 签名）。
 * base = { timestamp, nonce, ...queryData }；删除空值；追加 sign。
 */
export function buildGetUrl(baseUrl, queryData = {}) {
  const base = { timestamp: Date.now() / 1e3, nonce: random6(), ...queryData };
  for (const k in base) if (base[k] + '' === '') delete base[k];
  const sign = SignMD5(base, SALT);
  const qs = new URLSearchParams();
  for (const k of Object.keys(base)) qs.append(k, base[k]);
  qs.append('sign', sign);
  const sep = baseUrl.includes('?') ? '&' : '?';
  return `${baseUrl}${sep}${qs.toString()}`;
}
