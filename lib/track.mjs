/**
 * 伪造跑步轨迹 / 步数 / 陀螺仪数据（重写版）
 *
 * ── 关键修正（来自 detail 页源码还原） ──
 * 真实小程序的跑步点（fullPoints / record.file / OSS 轨迹文件）是【数组】而非对象：
 *
 *   point = [ a, o, s, p, b, c, d, e, l ]
 *            |  |  |  |  |  |  |  |  └─ lose(丢失定位标记, 0/1/null)
 *            |  |  |  |  |  |  |  └─── 第7位 desc(描述字符串, 一般 null)
 *            |  |  |  |  |  |  └────── 第6位 pace(配速, 数字)
 *            |  |  |  |  |  └───────── 第5位 distance(累计距离, 米, int)
 *            |  |  |  |  └──────────── 第4位 isPause(暂停标记 1=null)
 *            |  |  |  └─────────────── 第3位 p(是否离线点/补点, 0/1/null)
 *            |  |  └────────────────── 第2位 s(瞬时速度 m/s)
 *            |  └────────────────────── 第1位 o(longitude 经度)
 *            └───────────────────────── 第0位 a(latitude 纬度)
 *
 * 这正是 setLocation 里 push 的：
 *   [latitude, longitude, speed, isPause?1:null, parseInt(distance), pace, desc, null, lose?1:null]
 *
 * detail 页 fullPoints 计算属性用 w(t,9) 解构成 {a,o,s,p,b,c,d,e,l}，
 * makePolyline 用 t.a/t.o 画线，computePointsSpeed 用相邻点 Haversine 距离算速度上色。
 * 所以文件里必须是数组——旧版 genTrack 生成 {longitude,latitude,time,accuracy} 对象，
 * detail 解构会直接抛错 → 点进去无路径、速度无变化。
 *
 * ── 速度变化设计 ──
 * 速度每 N±Random(0~M) 秒切换一个目标配速区间（在合理慢跑范围 2.8~4.5 m/s），
 * 相邻点之间速度平滑过渡（避免瞬时跳变被肉眼/简单阈值发现）。
 *
 * ── 距离设计 ──
 * 总距离 = 目标 × (1 + K%)，保证略大于目标，同时受时间窗约束。
 */

const EARTH_R = 6378137; // 米（与小程序 calcDistance 用的 6378.137 km 一致）

function toRad(d) {
  return (d * Math.PI) / 180;
}

/** 两点距离（米），与小程序 calcDistance 一致（Haversine, 6378.137km） */
export function calcDistance(lat1, lon1, lat2, lon2) {
  const o = toRad(lat1);
  const a = toRad(lat2);
  const u = o - a;
  const s = toRad(lon1) - toRad(lon2);
  const c = 2 * Math.asin(
    Math.sqrt(Math.pow(Math.sin(u / 2), 2) + Math.cos(o) * Math.cos(a) * Math.pow(Math.sin(s / 2), 2)),
  );
  let v = c * 6378.137;
  v = Math.round(1e4 * v) / 1e4;
  v = v * 1000;
  v = parseFloat(v.toFixed(2));
  return v || 0;
}

/** 线性插值随机数 [min,max) */
function rand(min, max) {
  return min + Math.random() * (max - min);
}

/**
 * 生成一条在跑道区域内、带速度变化的轨迹点序列（数组格式）。
 *
 * @param {object} opts
 * @param {number} opts.centerLat      跑步区域中心纬度
 * @param {number} opts.centerLon      跑步区域中心经度
 * @param {number} opts.targetMeters    目标距离（米）
 * @param {number} opts.usedTimeS      目标用时（秒）
 * @param {number} opts.startTsMs      起始毫秒时间戳
 * @param {number} [opts.loopRadius]   跑道半径（米），用于环形跑道
 * @param {number} [opts.speedChangeN] 速度切换基准间隔（秒）
 * @param {number} [opts.speedChangeM] 速度切换间隔随机抖动（秒）
 * @param {number} [opts.distanceK]    距离目标上浮比例（0.05 表示 +5%）
 * @param {number} [opts.sampleHz]     采样频率（Hz），默认 1Hz
 * @param {number} [opts.seed]         （暂未用，保留）
 * @returns {object[]} 轨迹点数组，每个点为 [lat,lon,s,p,dist,pace,desc,null,lose]
 */
export function genTrack(opts) {
  const {
    centerLat,
    centerLon,
    targetMeters,
    usedTimeS,
    startTsMs,
    loopRadius = 200, // 400m 标准跑道外圈半径约 200m
    speedChangeN = 45,
    speedChangeM = 20,
    distanceK = 0.04,
    sampleHz = 1,
    // GPS 精度噪声幅度（米）。真实手机 GPS 精度约 ±3~5m，
    // 但连续读数间位置漂移是【相关】的（不是每步独立跳变），
    // 因此用一阶相关漂移模型：漂移量缓慢游走，使相邻点的地理距离
    // 在真实位移基础上叠加小幅波动，自然跨越 computePointsSpeed
    // 的配色阈值（4.16 m/s），在轨迹图上呈现速度变化，
    // 同时不会显著抬高累计距离。
    jitterM = 4,
  } = opts;

  // 目标距离上浮 K%
  const goalMeters = targetMeters * (1 + distanceK);
  // 平均速度（m/s），用于速度区间基准
  const avgSpeed = goalMeters / usedTimeS;
  // 速度区间：在平均速度上下浮动，模拟真实慢跑。
  // 上限放宽到 5.0，使部分时段的瞬时速度能跨过 4.16 m/s 配色阈值，
  // 在轨迹图上产生从绿到黄的速度渐变（真实跑步也会有冲刺段）。
  const speedMin = Math.max(2.3, avgSpeed * 0.78);
  const speedMax = Math.min(5.0, avgSpeed * 1.3);

  // ── 1. 生成速度时间序列：每 N±M 秒切换一个目标速度 ──
  const speeds = []; // {t0, t1, v}
  let t0 = 0;
  while (t0 < usedTimeS) {
    const seg = speedChangeN + rand(-speedChangeM, speedChangeM);
    const t1 = Math.min(usedTimeS, t0 + Math.max(8, seg));
    let v;
    if (speeds.length === 0) {
      v = rand(speedMin, speedMax);
    } else {
      const prev = speeds[speeds.length - 1].v;
      let tries = 0;
      do {
        v = rand(speedMin, speedMax);
        tries++;
      } while (Math.abs(v - prev) < 0.25 && tries < 12);
    }
    speeds.push({ t0, t1, v });
    t0 = t1;
  }

  /** 取某时刻的目标速度（段内线性过渡 30%） */
  function targetSpeedAt(t) {
    for (let i = 0; i < speeds.length; i++) {
      const seg = speeds[i];
      if (t >= seg.t0 && t < seg.t1) {
        const transLen = Math.min(6, (seg.t1 - seg.t0) * 0.3);
        const into = t - seg.t0;
        const prevV = i > 0 ? speeds[i - 1].v : seg.v;
        if (into < transLen && i > 0) {
          return prevV + (seg.v - prevV) * (into / transLen);
        }
        return seg.v * (1 + (Math.random() - 0.5) * 0.04);
      }
    }
    return speeds[speeds.length - 1].v;
  }

  // ── 2. 沿路径采样点 ──
  // 若提供 routeNodes（来自 lib/route.mjs 的 planRoute），则沿该节点路径前进；
  // 否则使用椭圆跑道。
  const aRad = loopRadius * 1.2; // 长轴
  const bRad = loopRadius * 0.8; // 短轴
  const latPerM = 1 / (toRad(1) * EARTH_R);
  const lonPerM = 1 / (toRad(1) * EARTH_R * Math.cos(toRad(centerLat)));

  // ── GPS 相关漂移模型 ──
  // 真实手机 GPS 位置不是每步独立跳变，而是缓慢游走：连续两次读数
  // 的位置差 ≈ 真实位移 + 小幅漂移增量。这样相邻点的地理距离围绕
  // 真实速度波动，自然跨越 computePointsSpeed 的配色阈值（4.16），
  // 同时累计距离不会被噪声显著抬高。
  // driftLat/driftLon 为当前漂移量（米），每步按随机步进更新并被拉回 0。
  let driftLat = 0, driftLon = 0;
  const driftStep = jitterM * 0.6; // 每步漂移增量幅度
  const driftPull = 0.15; // 拉回中心的衰减系数（越小漂移越自由）
  function gpsJitter() {
    driftLat += (Math.random() - 0.5) * 2 * driftStep - driftLat * driftPull;
    driftLon += (Math.random() - 0.5) * 2 * driftStep - driftLon * driftPull;
    // 限制漂移不超出 jitterM 范围
    const mag = Math.sqrt(driftLat * driftLat + driftLon * driftLon);
    if (mag > jitterM) {
      driftLat = (driftLat / mag) * jitterM;
      driftLon = (driftLon / mag) * jitterM;
    }
    return [driftLat * latPerM, driftLon * lonPerM];
  }

  // 构造路径采样器：输入前进距离 d，返回新坐标 (lat,lon)，并维护内部游标。
  // route 是一组 [lat,lon] 节点序列（可能含重复通过的节点）。
  // 走到序列端点时**沿原路折返**（方向取反），不做任何跨点直线跳转——
  // 规划器已保证路径长度 ≥ 目标距离，折返只是"路径不够长"时的兜底。
  function makePathWalker(route) {
    if (!route || route.length < 2) return null;
    let idx = 0; // 当前所在节点索引
    let dir = 1; // 前进方向：+1 沿序列前进，-1 折返
    let curLat = route[0][0];
    let curLon = route[0][1];
    return function advance(d) {
      let remain = d;
      let guard = 0;
      while (remain > 0 && guard++ < 100000) {
        let nextIdx = idx + dir;
        if (nextIdx < 0 || nextIdx >= route.length) {
          dir = -dir; // 到头/到尾 → 折返（相邻节点仍是路网的真实边）
          nextIdx = idx + dir;
          if (nextIdx < 0 || nextIdx >= route.length) break; // 序列只有一个节点
        }
        const next = route[nextIdx];
        const seg = calcDistance(curLat, curLon, next[0], next[1]);
        if (seg <= remain) {
          remain -= seg;
          curLat = next[0];
          curLon = next[1];
          idx = nextIdx;
        } else {
          const r = remain / (seg || 1e-9);
          curLat = curLat + (next[0] - curLat) * r;
          curLon = curLon + (next[1] - curLon) * r;
          remain = 0;
        }
      }
      // 叠加 GPS 相关漂移
      const [jx, jy] = gpsJitter();
      return [curLat + jx, curLon + jy];
    };
  }

  // route 提供时使用，否则用椭圆参数化路径
  let walker = makePathWalker(opts.route);
  let theta = 0;
  let lastLat, lastLon;
  if (walker) {
    lastLat = opts.route[0][0];
    lastLon = opts.route[0][1];
  } else {
    lastLat = centerLat + (aRad * latPerM) * Math.sin(theta);
    lastLon = centerLon + (bRad * lonPerM) * Math.cos(theta);
  }
  const dt = 1 / sampleHz;
  const points = [];
  let totalDist = 0;
  let elapsed = 0;

  // 首点
  points.push([
    +lastLat.toFixed(6),
    +lastLon.toFixed(6),
    +targetSpeedAt(0).toFixed(2),
    null,
    0,
    0,
    null,
    null,
    null,
  ]);

  // 跑到目标距离为止（路网会多圈循环），时间上限 usedTimeS*1.2 防止异常
  const maxElapsed = usedTimeS * 1.2;
  while (totalDist < goalMeters && elapsed < maxElapsed) {
    elapsed += dt;
    const v = targetSpeedAt(Math.min(elapsed, usedTimeS - 1));
    const segDist = v * dt;
    totalDist += segDist;

    let lat, lon;
    if (walker) {
      [lat, lon] = walker(segDist);
    } else {
      // 椭圆跑道
      const avgR = Math.sqrt((aRad * aRad + bRad * bRad) / 2);
      const dTheta = segDist / avgR;
      theta += dTheta;
      const baseLat = centerLat + (aRad * latPerM) * Math.sin(theta);
      const baseLon = centerLon + (bRad * lonPerM) * Math.cos(theta);
      const [jx, jy] = gpsJitter();
      lat = baseLat + jx;
      lon = baseLon + jy;
    }

    const pace = v > 0 ? Math.round(1000 / v) : 0;

    points.push([
      +lat.toFixed(6),
      +lon.toFixed(6),
      +v.toFixed(2),
      null,
      Math.round(totalDist),
      pace,
      null,
      null,
      null,
    ]);
    lastLat = lat;
    lastLon = lon;
  }

  return points;
}

/**
 * 生成步数切片 —— 复刻真实小程序 step_info 格式。
 *
 * 真实小程序（pages_run/app-service.js）：
 *   - 跑步时每 60s 把累积的陀螺仪样本 O 传给 calculateSteps，结果 push 进 step_info
 *   - record getter: step_info: JSON.stringify({interval:60, list: e.step_info})
 *   - step_num: e.step_info.reduce((a,b)=>a+b, 0) || 1
 *
 * step_info 的 list 每项 = 每 60s 窗口的估算步数。
 * 真实跑步步频约 150 步/分钟，因此每窗口约 150 步。
 * 实测服务端对 step_num 不做严格校验（step_num=83 的骑行记录也通过），
 * 因此只需生成合理的真实跑步步数即可。
 *
 * @param {number} usedTimeS 用时秒
 * @param {number} distanceKm 距离公里（用于推算合理步频）
 * @returns {{step_info: string, step_num: number}}
 */
export function genSteps(usedTimeS, distanceKm) {
  const intervals = Math.max(1, Math.ceil(usedTimeS / 60));
  const avgPace = (distanceKm * 1000) / usedTimeS; // m/s
  // 真实跑步约 0.7~0.8 步/米（步幅约 1.2~1.4m），取 0.75 步/米
  const stepsPerMin = Math.round(avgPace * 60 * 0.75);
  const list = [];
  for (let i = 0; i < intervals; i++) {
    // 每分钟步数有 ±15% 波动
    const jitter = Math.floor((Math.random() - 0.5) * stepsPerMin * 0.3);
    list.push(Math.max(1, stepsPerMin + jitter));
  }
  const step_num = list.reduce((a, b) => a + b, 0) || 1;
  return {
    step_info: JSON.stringify({ interval: 60, list }),
    step_num,
  };
}

/**
 * 生成伪造陀螺仪数据 —— 复刻真实小程序采集逻辑。
 *
 * 真实采集（pages_run/app-service.js）：
 *   - listenerAcc: 每次 onAccelerometerChange，若距上次 ≥60ms，push
 *       O.push({ t: Date.now(), ax, ay, az, gx, gy, gz })
 *     其中 ax/ay/az = 加速度计值，gx/gy/gz = 最近一次 onGyroscopeChange 的陀螺仪值。
 *   - 采样间隔 ≈60ms（实测加速度计 interval:"game"≈20ms，但代码限流 ≥60ms → 约 16Hz）。
 *   - endRecordStep: setMap({ gyr: JSON.stringify(O), step_info: [...] })，清空 O。
 *   - buildRecord: record.gyr = e.gyr （JSON 字符串）。
 *   - uploadRecord 补传: createTxt(record.gyr) 直接写明文 JSON 字符串（不加密）→ OSS。
 *
 * 因此真实陀螺仪文件内容是【明文 JSON 字符串】，每个样本为
 *   { t: <毫秒时间戳>, ax, ay, az, gx, gy, gz }
 *   ax/ay/az: 加速度计 (m/s²)，重力 ≈9.8，跑步有 1~3 的波动
 *   gx/gy/gz: 陀螺仪 (rad/s)，静止 ≈0，跑步小幅波动 ±0.5
 *
 * @param {number} usedTimeS 用时秒
 * @param {number} [startTsMs] 起始毫秒时间戳（用于 t 字段），默认 Date.now()
 * @param {object} [opts]
 * @param {boolean} [opts.asString] 返回 JSON.stringify 后的字符串（真实 record.gyr 形态），默认 false（返回数组）
 * @returns {Array<object>|string} 陀螺仪样本数组或其 JSON 字符串
 */
export function genGyro(usedTimeS, startTsMs = Date.now(), opts = {}) {
  const { asString = false } = opts;
  // 真实采样间隔 60ms → 约 16.67Hz；用 60ms 步进。
  const intervalMs = 60;
  const samples = Math.floor((usedTimeS * 1000) / intervalMs);
  const list = [];
  let t = startTsMs;

  // 步频参数：约 2.5 步/秒（150 步/分钟，跑步步频），周期 ≈0.4s
  // 60ms 采样 → 每步约 6.7 个采样点
  const stepPeriod = 6.7; // 采样点数/步
  // 每步的加速度冲击：垂直方向(az)有明显的冲击峰，ax/ay 有小幅摇摆
  // 步态模型：每步一个主冲击 + 一个次要冲击（脚跟落地 + 脚趾离地）
  for (let i = 0; i < samples; i++) {
    const phase = (i % stepPeriod) / stepPeriod; // 0~1 循环
    // 主冲击（脚跟落地，phase≈0）：az 突增 + 噪声
    // 次冲击（脚趾离地，phase≈0.5）：az 次峰
    const heelStrike = Math.exp(-Math.pow((phase - 0.05) * 8, 2)); // 高斯峰
    const toeOff = Math.exp(-Math.pow((phase - 0.55) * 10, 2)) * 0.5;

    // 加速度计（m/s²）：重力 9.8 在 az，步态冲击叠加
    const az = +(9.8 + heelStrike * 3.5 + toeOff * 1.5 + (Math.random() - 0.5) * 0.3).toFixed(3);
    // 水平方向小幅摇摆（走路时身体左右摆）
    const sway = Math.sin(i / stepPeriod * 2 * Math.PI) * 0.6;
    const ax = +(sway + (Math.random() - 0.5) * 0.4).toFixed(3);
    const ay = +(Math.cos(i / stepPeriod * 2 * Math.PI) * 0.3 + (Math.random() - 0.5) * 0.3).toFixed(3);

    // 陀螺仪（rad/s）：跑步时角速度小幅波动
    // 真实跑步陀螺仪各轴约 ±0.1~0.5 rad/s，步态冲击时短暂升高
    const gyroPhase = Math.sin(i / stepPeriod * 2 * Math.PI);
    const gx = +(gyroPhase * 0.25 + (Math.random() - 0.5) * 0.1).toFixed(3);
    const gy = +(Math.cos(i / stepPeriod * 2 * Math.PI) * 0.2 + (Math.random() - 0.5) * 0.08).toFixed(3);
    const gz = +(Math.sin(i / (stepPeriod * 2) * 2 * Math.PI) * 0.1 + (Math.random() - 0.5) * 0.05).toFixed(3);

    list.push({ t, ax, ay, az, gx, gy, gz });
    t += intervalMs;
  }
  return asString ? JSON.stringify(list) : list;
}

// ── 向后兼容旧签名 genTrack(centerLat, centerLon, distanceKm, usedTimeS, startTsMs) ──
export function genTrackLegacy(centerLat, centerLon, distanceKm, usedTimeS, startTsMs = Date.now()) {
  return genTrack({
    centerLat,
    centerLon,
    targetMeters: distanceKm * 1000,
    usedTimeS,
    startTsMs,
  });
}

/**
 * 统计速度变化次数：按 0.2 m/s 分桶，跨越不同桶的次数。
 * 用于校验"速度有变化"。
 * @param {number[][]} points genTrack 返回的点数组
 */
export function countSpeedChanges(points) {
  if (points.length < 2) return 0;
  const sp = points.map((p) => p[2]);
  let changes = 0;
  let lastBucket = Math.round(sp[0] / 0.2);
  for (let i = 1; i < sp.length; i++) {
    const bucket = Math.round(sp[i] / 0.2);
    if (bucket !== lastBucket) {
      changes++;
      lastBucket = bucket;
    }
  }
  return changes;
}
