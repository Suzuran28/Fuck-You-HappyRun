/**
 * buildRecord + uploadRecord 复刻 —— run.md §5 / §6
 *
 * 白名单字段（run.md §6.4）：
 *   term_id, game_id, start_time, end_time, log_data, file_img,
 *   is_running_area_valid, mobileDeviceId, mobileModel, mobileOsVersion,
 *   step_info, step_num, used_time, distance, record_img, record_file
 *
 * start_time 容差修正（run.md §5.2）：
 *   start_time==0 → end_time - used_time；若仍晚于 point_list[0].time 再减 180s
 *   start_time!=0 但晚于 point_list[0].time → 减 3s
 */
const UPLOAD_FIELDS = [
  'term_id', 'game_id', 'start_time', 'end_time', 'log_data', 'file_img',
  'is_running_area_valid', 'mobileDeviceId', 'mobileModel', 'mobileOsVersion',
  'step_info', 'step_num', 'used_time', 'distance', 'record_img', 'record_file',
];

/** 白名单字段过滤 */
export function pickRecord(record) {
  const v = {};
  for (const k of UPLOAD_FIELDS) {
    if (k in record) v[k] = record[k];
  }
  return v;
}

/**
 * start_time 容差修正（与源码 fixStartTime 一致）
 * point_list 中打卡点的 time 为秒级字符串。
 */
export function fixStartTime(v, record) {
  const pointList = record.point_list || [];
  const first = pointList[0];
  if (!first || first.time == null) return;

  const firstTime = parseInt(first.time, 10); // 秒

  if (v.start_time === 0) {
    v.start_time = v.end_time - v.used_time;
    if (v.start_time > firstTime) {
      v.start_time = firstTime - 180;
    }
  } else if (v.start_time !== 0) {
    if (v.start_time > firstTime) {
      v.start_time = firstTime - 3;
    }
  }
}

/**
 * 组装一条完整的 record —— 复刻真实小程序 record getter（app-service.js）。
 *
 * 关键（源码 record getter）：
 *   i = clocks.filter(pass).sort().map(保留 [distance,latitude,longitude,point_id,time])
 *        .map(t => ({...t, longtitude: t.longitude, time: parseInt(t.time)||""}))
 *        .forEach(t => delete t.distance)   ← 打卡点经过记录
 *   u = groupPoints(fullPoints)              ← 轨迹点（file，加密上传 OSS）
 *   l = i.length>0 ? JSON.stringify(i) : ""  ← log_data = 打卡点 JSON
 *   log_num = i.length                        ← 打卡点数量（如 3）
 *   file = u                                  ← 轨迹点（OSS 加密文件）
 *   point_list = i                            ← 同 log_data 的原数组
 *
 * 即：log_data 是【打卡点经过记录】的 JSON 字符串，不是轨迹点！
 *     file 才是轨迹点，加密后上传 OSS。
 *
 * @param {object} o
 * @param {object} o.common       登录态公共参数（取 term_id）
 * @param {number} o.type          1=正式跑, 2=自由跑
 * @param {string|number} o.game_id 跑步区域/活动码
 * @param {number} o.start_time_sec 起始秒级时间戳
 * @param {number} o.end_time_sec   结束秒级时间戳
 * @param {number} o.distance     距离（公里）
 * @param {number} o.used_time    用时（秒）
 * @param {object[]} o.points      轨迹点数组 [lat,lon,s,p,dist,pace,desc,null,lose]
 * @param {string} o.step_info     JSON 字符串 {interval:60,list}
 * @param {number} o.step_num     总步数
 * @param {object[]} [o.point_list] 打卡点列表（正式跑），每项含 {point_id,latitude,longitude,time}
 * @param {string} [o.record_img]  截图 URL
 * @param {string} [o.mobileModel] 设备型号
 */
export function buildRecord(o) {
  // 轨迹点 → file（对象格式 [{a,o,s,p,b,c,d,e,l}]，加密后上传 OSS）
  const toObj = (p) => ({ a: p[0], o: p[1], s: p[2], p: p[3], b: p[4], c: p[5], d: p[6], e: p[7], l: p[8] });
  const fileObjs = o.points.map(toObj);

  // 打卡点经过记录 → log_data + point_list + log_num
  // 复刻源码 record getter：
  //   i = clocks.filter(pass).sort()
  //       .map(pick(["distance","latitude","longitude","point_id","time"]))
  //       .map(t => ({...t, longtitude: t.longitude, time: parseInt(t.time)||""}))
  //       .forEach(t => delete t.distance)
  //   l = i.length>0 ? JSON.stringify(i) : ""
  //   log_data = l, log_num = i.length, point_list = i
  // 关键：time 是 parseInt 返回的【数字】（或空字符串 ""），不是字符串包裹的数字。
  const passList = (o.point_list || []).map((p) => {
    const item = {
      point_id: p.point_id,
      latitude: p.latitude,
      longitude: p.longitude,
      time: parseInt(p.time, 10) || '',
    };
    return item;
  }).map((t) => ({ ...t, longtitude: t.longitude }));

  // log_data = 打卡点经过记录 JSON 字符串（空数组时为空字符串）
  const logData = passList.length > 0 ? JSON.stringify(passList) : '';

  return {
    term_id: o.common.term_id || 1, // 被服务端 common 覆盖
    game_id: o.game_id,
    type: o.type,
    showType: o.type,
    start_time: o.start_time_sec,
    end_time: o.end_time_sec,
    distance: o.distance,
    used_time: o.used_time,
    time: o.used_time,
    log_data: logData,       // ← 打卡点经过记录 JSON（非轨迹点）
    log_num: passList.length, // ← 打卡点数量（如 3）
    file: fileObjs,           // ← 轨迹点（加密上传 OSS + detail 页渲染）
    file_img: '',
    record_img: o.record_img || '',
    record_file: '', // OSS 上传后回填
    is_running_area_valid: 1,
    mobileDeviceId: 1,
    mobileModel: o.mobileModel || 'iPhone14,3',
    mobileOsVersion: 1,
    step_info: o.step_info,
    step_num: o.step_num,
    point_list: passList, // ← 同 log_data 原数组（不上传，仅 fixStartTime 用）
    // 陀螺仪原始数据（补传用）
    gyr: null,
  };
}
