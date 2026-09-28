/**
 * OSS 直传 —— run.md §七
 *
 * 流程：
 *   1. getOssSts → 拿 STS 临时凭证（securityToken / accessKeyId / accessKeySecret / bucket / region）
 *   2. 用 STS 凭证直传 OSS（阿里云标准 PUT，走 STS 鉴权）
 *   3. 返回完整 URL，截取 "Public/Upload/file/" 之后部分作为 record_file / gyroscope_file
 *
 * OSS Key 规则（run.md §7.2）：
 *   跑步轨迹：Public/Upload/file/run_record/<Date.now() 末3位>
 *
 * 注意：轨迹文件内容是 Encrypt(JSON.stringify(record.file)) —— AES 加密后的密文。
 * 这里走纯 fetch PUT，不引入 ali-oss SDK，用 STS 凭证手工签名 v1。
 */
import crypto from 'node:crypto';

/**
 * 调 getOssSts 拿临时凭证。
 * @returns {object} STS 凭证
 */
export async function getOssSts(client) {
  const sts = await client.post('WpIndex/getOssSts', {});
  if (!sts) throw new Error('获取 OSS STS 失败');
  // 字段名兼容（不同版本可能叫 accessKeyId / AccessKeyId）
  return normalizeSts(sts);
}

function normalizeSts(s) {
  return {
    accessKeyId: s.accessKeyId || s.AccessKeyId || s.access_key_id,
    accessKeySecret: s.accessKeySecret || s.AccessKeySecret || s.access_key_secret,
    securityToken: s.securityToken || s.SecurityToken || s.security_token,
    bucket: s.bucket || s.Bucket || s.bucketName,
    // 实测 lptiyu-ps95 bucket 在 oss-cn-hangzhou；STS 响应不含 region 字段
    region: s.region || s.Region || 'oss-cn-hangzhou',
    endpoint: s.endpoint || s.Endpoint || null,
  };
}

/**
 * OSS v1 签名（PUT）。
 * 阿里云 OSS STS 直传使用 Authorization: OSS {AccessKeyId}:{Signature}
 *   Signature = base64(hmac-sha1(AccessKeySecret, StringToSign))
 *   StringToSign = METHOD + "\n" + Content-MD5 + "\n" + Content-Type + "\n" + Date(GMT) + "\n" + CanonicalOSSHeaders + CanonicalResource
 */
function signV1(method, accessKeySecret, contentType, date, ossHeaders, canonicalResource) {
  const stringToSign = [
    method.toUpperCase(),
    '', // Content-MD5（可选，置空）
    contentType || '',
    date,
    ossHeaders,
    canonicalResource,
  ].join('\n');
  return crypto.createHmac('sha1', accessKeySecret).update(stringToSign, 'utf8').digest('base64');
}

/**
 * 直传一个文件到 OSS。
 * @param {object} sts    getOssSts 返回的凭证
 * @param {string} ossKey  完整 key，如 Public/Upload/file/run_record/123
 * @param {string|Buffer} body  文件内容
 * @returns {string} OSS 完整 URL
 */
export async function uploadToOSS(sts, ossKey, body) {
  const bucket = sts.bucket;
  const region = sts.region || 'oss-cn-hangzhou';
  const host = sts.endpoint
    ? sts.endpoint.replace(/^https?:\/\//, '')
    : `${bucket}.${region}.aliyuncs.com`;
  const url = `https://${host}/${ossKey}`;

  // 实测真实轨迹文件是 .txt，服务端下载签名不含 Content-Type，
  // 上传时用 text/plain 让对象元数据与下载签名一致（避免 SignatureDoesNotMatch）
  const contentType = 'text/plain';
  const date = new Date().toUTCString();
  const canonicalResource = `/${bucket}/${ossKey}`;
  // STS 必须带 x-oss-security-token 头
  const ossHeaders = `x-oss-security-token:${sts.securityToken}`;
  const signature = signV1('PUT', sts.accessKeySecret, contentType, date, ossHeaders, canonicalResource);
  const authorization = `OSS ${sts.accessKeyId}:${signature}`;

  const buf = typeof body === 'string' ? Buffer.from(body, 'utf8') : body;
  const res = await fetch(url, {
    method: 'PUT',
    headers: {
      'Content-Type': contentType,
      Date: date,
      'x-oss-security-token': sts.securityToken,
      Authorization: authorization,
    },
    body: buf,
  });

  if (!res.ok) {
    const txt = await res.text();
    throw new Error(`OSS PUT 失败 ${res.status}: ${txt.slice(0, 300)}`);
  }
  return url;
}

/**
 * OSS PostObject 上传（与真实小程序 wx.uploadFile 完全一致）。
 * 真实小程序用 multipart/form-data + policy/signature 上传，而非 PUT。
 * @param {object} sts
 * @param {string} ossKey  完整 key
 * @param {string|Buffer} body
 * @returns {string} OSS 完整 URL
 */
export async function uploadByPostObject(sts, ossKey, body) {
  const bucket = sts.bucket;
  const region = sts.region || 'oss-cn-hangzhou';
  const host = sts.endpoint ? sts.endpoint.replace(/^https?:\/\//, '') : `${bucket}.${region}.aliyuncs.com`;
  const url = `https://${host}`;
  const buf = typeof body === 'string' ? Buffer.from(body, 'utf8') : body;

  // policy: base64({"expiration":"...","conditions":[...]}
  const expiration = new Date(Date.now() + 10 * 60 * 1000).toISOString();
  const policyObj = {
    expiration,
    conditions: [
      { bucket },
      ['eq', '$key', ossKey],
    ],
  };
  const policy = Buffer.from(JSON.stringify(policyObj)).toString('base64');
  // signature = base64(hmac-sha1(accessKeySecret, policy))
  const signature = crypto.createHmac('sha1', sts.accessKeySecret).update(policy, 'utf8').digest('base64');

  // 构建 multipart/form-data
  const boundary = '----WebKitFormBoundary' + crypto.randomBytes(8).toString('hex');
  const fields = {
    key: ossKey,
    policy,
    OSSAccessKeyId: sts.accessKeyId,
    signature,
    'x-oss-security-token': sts.securityToken,
  };
  const parts = [];
  for (const [k, v] of Object.entries(fields)) {
    parts.push(`--${boundary}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}`);
  }
  // file part
  parts.push(
    `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${Date.now()}.txt"\r\nContent-Type: text/plain\r\n\r\n`,
  );
  const pre = Buffer.from(parts.join('\r\n'), 'utf8');
  const post = Buffer.from(`\r\n--${boundary}--\r\n`, 'utf8');
  const bodyBuf = Buffer.concat([pre, buf, post]);

  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': `multipart/form-data; boundary=${boundary}` },
    body: bodyBuf,
  });
  if (!res.ok && res.status !== 204) {
    const txt = await res.text();
    throw new Error(`OSS PostObject 失败 ${res.status}: ${txt.slice(0, 300)}`);
  }
  return `${url}/${ossKey}`;
}

/**
 * 截取 OSS URL 中 "Public/Upload/file/" 之后的部分，作为 record_file / gyroscope_file。
 * run.md §6.3: record_file = url.split("Public/Upload/file/")[1] || 1
 */
export function ossKeyFromUrl(url) {
  const idx = url.indexOf('Public/Upload/file/');
  if (idx === -1) return 1;
  return url.substring(idx + 'Public/Upload/file/'.length);
}

/**
 * 生成 OSS key（实测真实格式，来自真实记录 564954 的 file 字段）：
 *   Public/Upload/file/run_record/<毫秒末3位>/<YYYY-MM-DD>/<毫秒时间戳>-<随机数>.txt
 * run.md §7.2 的「末3位」描述不完整，真实路径有三层 + .txt 扩展名。
 * @param {number} [tsMs] 起始毫秒时间戳，默认 Date.now()
 * @returns {string} 完整 OSS key（含 Public/Upload/file/ 前缀）
 */
export function runRecordKey(tsMs = Date.now()) {
  return fileKey('run_record', tsMs);
}

/**
 * 生成陀螺仪文件 OSS key（真实小程序 uploadGyr 用 run_gyroscope 前缀）：
 *   Public/Upload/file/run_gyroscope/<毫秒末3位>/<YYYY-MM-DD>/<毫秒时间戳>-<随机数>.txt
 * 注意：真实小程序 gyroscope_file 字段传的是【完整 OSS key】（含 Public/Upload/file/ 前缀），
 * 不像 record_file 那样剥离前缀。
 * @param {number} [tsMs] 默认 Date.now()
 * @returns {string} 完整 OSS key
 */
export function gyroscopeKey(tsMs = Date.now()) {
  return fileKey('run_gyroscope', tsMs);
}

/**
 * 从 OSS 下载文件（只读，用于诊断/校验已上传轨迹文件）。
 * 用 STS 凭证做 GET v1 签名。
 * @param {object} sts
 * @param {string} ossKey  完整 key 或 stripped key（run_record/... 形式）
 * @returns {string} 文件内容
 */
export async function fetchOssFile(sts, ossKey) {
  const bucket = sts.bucket;
  const region = sts.region || 'oss-cn-hangzhou';
  const host = sts.endpoint ? sts.endpoint.replace(/^https?:\/\//, '') : `${bucket}.${region}.aliyuncs.com`;
  const fullKey = ossKey.startsWith('Public/Upload/file/') ? ossKey : `Public/Upload/file/${ossKey}`;
  const url = `https://${host}/${fullKey}`;
  const date = new Date().toUTCString();
  const canonicalResource = `/${bucket}/${fullKey}`;
  const ossHeaders = `x-oss-security-token:${sts.securityToken}`;
  const signature = signV1('GET', sts.accessKeySecret, '', date, ossHeaders, canonicalResource);
  const authorization = `OSS ${sts.accessKeyId}:${signature}`;
  const res = await fetch(url, {
    method: 'GET',
    headers: { Date: date, 'x-oss-security-token': sts.securityToken, Authorization: authorization },
  });
  if (!res.ok) {
    const txt = await res.text();
    throw new Error(`OSS GET 失败 ${res.status}: ${txt.slice(0, 300)}`);
  }
  return await res.text();
}

/**
 * 内部：生成带统一格式的 OSS 文件 key。
 *   Public/Upload/file/<subDir>/<毫秒末3位>/<YYYY-MM-DD>/<毫秒时间戳>-<随机数>.txt
 */
function fileKey(subDir, tsMs = Date.now()) {
  const ms = String(tsMs);
  const tail3 = ms.slice(-3);
  const d = new Date(tsMs);
  const dateStr = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  const rand = Math.floor(Math.random() * 900 + 100); // 3 位随机数
  return `Public/Upload/file/${subDir}/${tail3}/${dateStr}/${ms}-${rand}.txt`;
}
