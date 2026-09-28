/**
 * 调控配置：集中管理轨迹生成的可调参数。
 * Web UI 与 auto-run.mjs 共用同一份配置，便于"先调参预览、再生成"。
 */

export const DEFAULT_PARAMS = {
  // 跑步目标
  centerLat: 37.87,
  centerLon: 112.55,
  targetKm: 2.5,
  usedTimeS: 900,
  loopRadius: 200, // 跑道半径(米)，对齐 Map.png 操场

  // 速度变化：每 N±Random(0~M) 秒切换目标速度
  speedChangeN: 45, // 基准间隔(秒)
  speedChangeM: 20, // 随机抖动(秒)
  speedMin: 2.8, // 速度下限 m/s（可空，空则按平均速度推算）
  speedMax: 4.5, // 速度上限 m/s

  // 距离上浮：目标 +K% + Random(0~distJitter)%
  distanceK: 0.04, // 4% 基准
  distJitter: 0.02, // 额外随机 0~2%

  // 时间变数：usedTimeS ± Random(0~timeJitterM)%
  timeJitterM: 5,

  // 轨迹点位置微抖动（米），0=关闭
  jitterM: 1,

  // 寻路
  usePathfinding: true,
  laps: 6, // 跑几圈
  checkpoints: 3, // 每圈打卡点数

  // 采样
  sampleHz: 1,
};

/** 读取 config.json 里的 run 字段并合并默认参数 */
export async function loadParams(extraPath = null) {
  let fileParams = {};
  try {
    const fs = await import('node:fs');
    const path = await import('node:path');
    const p = extraPath || path.join(process.cwd(), 'config.json');
    if (fs.existsSync(p)) {
      const cfg = JSON.parse(fs.readFileSync(p, 'utf8'));
      fileParams = { ...cfg.run };
      if (cfg.run && cfg.run.centerLat != null) fileParams.centerLat = cfg.run.centerLat;
      if (cfg.run && cfg.run.centerLon != null) fileParams.centerLon = cfg.run.centerLon;
      if (cfg.run && cfg.run.distanceKm != null) fileParams.targetKm = cfg.run.distanceKm;
      if (cfg.run && cfg.run.usedTimeS != null) fileParams.usedTimeS = cfg.run.usedTimeS;
      if (cfg.run && cfg.run.loopRadius != null) fileParams.loopRadius = cfg.run.loopRadius;
    }
  } catch {
    // 忽略
  }
  return { ...DEFAULT_PARAMS, ...fileParams };
}
