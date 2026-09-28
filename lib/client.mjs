/**
 * happyrun HTTP 客户端 —— 复刻 app-service.js 请求/响应拦截器
 *
 * 协议要点（run.md §2）：
 *  - 未登录白名单接口之外，未登录态直接抛 "登录失效"
 *  - POST：整体 AES 加密，body = { ostype:5, data: "<base64>" }
 *  - content-type: application/x-www-form-urlencoded
 *  - header.flag 为真时，该接口错误静默返回 false（flag 接口语义）
 *  - 响应：
 *      * 整串密文（旧式）→ JSON.parse(Decrypt(...))
 *      * { status:1, data:"<b64>" } → JSON.parse(Decrypt(data))，data 为空返回 null
 *      * status 101/102/103 → 登录失效（throw AuthExpired）
 *      * info==="跑步记录已存在" → 返回 "has"（上传逻辑据此判重）
 */
import { buildPostBody, decrypt } from './signer.mjs';

const WHITELIST = new Set(['getSchoolInfo', 'loginByCode', 'departmentList', 'UserInfo', 'loginAuth']);

export class AuthExpiredError extends Error {
  constructor(msg) {
    super(msg || '登录失效（token 过期）');
    this.name = 'AuthExpiredError';
    this.code = 'AUTH_EXPIRED';
  }
}

export class ApiError extends Error {
  constructor(msg, status) {
    super(msg);
    this.name = 'ApiError';
    this.code = status;
  }
}

/**
 * @param {object} opts
 * @param {string} opts.baseUrl  服务端入口，默认 https://tyxyzhpt.tyut.edu.cn
 * @param {object} opts.common  公共参数 { school_id, term_id, course_id, class_id, student_num, card_id, uid, token }
 */
export function createClient({ baseUrl = 'https://tyxyzhpt.tyut.edu.cn', common = {} } = {}) {
  let globalFlag = false;

  async function post(method, tData = {}, { flag = false, extraHeaders = {} } = {}) {
    // 末段白名单校验（与拦截器一致）
    const seg = method.substring(method.lastIndexOf('/') + 1);
    if (!WHITELIST.has(seg)) {
      const isLogin = !!(common.uid && common.token);
      const sn = common.student_num;
      if (!isLogin || (isLogin && sn == 0)) {
        throw new AuthExpiredError('登录失效');
      }
    }

    const url = `${baseUrl}/v3/api.php/${method}`;
    const body = buildPostBody(tData, common);
    globalFlag = !!flag;

    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        ...(flag ? { flag: true } : {}),
        ...extraHeaders,
      },
      body: `ostype=${body.ostype}&data=${encodeURIComponent(body.data)}`,
    });

    let e;
    const rawText = await res.text();
    try {
      e = JSON.parse(rawText);
    } catch {
      throw new ApiError(`非 JSON 响应: ${rawText.slice(0, 200)}`, res.status);
    }

    if (res.status !== 200) {
      if (globalFlag) return false;
      throw new ApiError(`请求超时 / HTTP ${res.status}`, res.status);
    }

    // 分支 A：整串密文
    if (typeof e.data === 'string' && typeof e === 'string') {
      return JSON.parse(decrypt(e.data.replace(/\s+/g, '')));
    }
    if (typeof e.data === 'string' && typeof e === 'object' && e.status === undefined) {
      return JSON.parse(decrypt(e.data.replace(/\s+/g, '')));
    }

    // 分支 B：{ status, info, data, offlinePoints? }
    if (e.status === 1) {
      if (!e.data || e.data.length <= 0) {
        // getTimestampV278 / getCaptureStatus 会带 offlinePoints
        if (e.offlinePoints) return { offlinePoints: e.offlinePoints };
        return null;
      }
      const u = JSON.parse(decrypt(e.data));
      // B1：带 offlinePoints 的接口
      if (method.endsWith('Run/getTimestampV278') || method.endsWith('Run2/getCaptureStatus')) {
        return { ...u, offlinePoints: e.offlinePoints || [] };
      }
      // B2：getVenaPointInfo 重新打包
      if (method.endsWith('Run2/getVenaPointInfo')) {
        return { list: u, offlinePoints: e.offlinePoints || [] };
      }
      return u;
    }

    // 分支 C：业务错误
    if (e.info === '跑步记录已存在') return 'has';
    if ([101, 102, 103].includes(e.status)) {
      throw new AuthExpiredError(e.info || '登录失效');
    }
    if (globalFlag) return false;
    throw new ApiError(e.info || '未知错误', e.status);
  }

  /** 更新公共参数（如刷新登录态后） */
  function setCommon(patch) {
    Object.assign(common, patch);
  }

  function getCommon() {
    return { ...common };
  }

  return { post, setCommon, getCommon };
}
