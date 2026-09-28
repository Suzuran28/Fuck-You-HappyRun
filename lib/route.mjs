/**
 * 路径构建模块 —— 基于 Map.png 的跑道区域 + 寻路算法
 *
 * 由于无法直接解析 Map.jpg 的像素→经纬度映射（缺少地理参照），
 * 本模块采用「跑道边界框 + 路网/障碍寻路」混合策略：
 *   1. 以配置中心经纬度为原点，定义一个矩形跑道区域（来自 beforeRunV260 的围栏或手填）。
 *   2. 在该区域内生成若干「跑道节点」（沿外圈跑道环线分布）。
 *   3. 用 A* 寻路在节点图上规划一条从起点出发、经过若干打卡点、回到起点的路径。
 *   4. 把规划路径作为 genTrack 的引导，让轨迹沿该路径而非纯椭圆。
 *
 * 这样做的好处：轨迹落在跑道区域内、有明显方向变化、且不是完美椭圆，
 * 更接近真实跑步轨迹，同时仍可通过 detail 页速度上色校验。
 *
 * 真实落地时，centerLat/centerLon/loopRadius 取自 config.run，即可对齐 Map.png 上的操场。
 */

import { calcDistance } from './track.mjs';

/** 节点：经纬度 + id */
function node(id, lat, lon) {
  return { id, lat, lon };
}

/**
 * 在跑道区域内生成环形节点图。
 * @param {object} cfg
 * @param {number} cfg.centerLat
 * @param {number} cfg.centerLon
 * @param {number} cfg.loopRadius  跑道半径（米）
 * @param {number} cfg.nodesPerLap 每圈节点数（默认 24）
 * @returns {{ nodes: object[], edges: Map<string,string[]>, lapLength: number }}
 */
export function buildTrackGraph(cfg) {
  const { centerLat, centerLon, loopRadius = 200, nodesPerLap = 24 } = cfg;
  const latPerM = (1 / 111320);
  const lonPerM = (1 / (111320 * Math.cos((centerLat * Math.PI) / 180)));
  const aRad = loopRadius * 1.2;
  const bRad = loopRadius * 0.8;

  const nodes = [];
  for (let i = 0; i < nodesPerLap; i++) {
    const theta = (i / nodesPerLap) * Math.PI * 2;
    const lat = centerLat + aRad * latPerM * Math.sin(theta);
    const lon = centerLon + bRad * lonPerM * Math.cos(theta);
    nodes.push(node(`n${i}`, +lat.toFixed(6), +lon.toFixed(6)));
  }

  // 邻接：每个节点连接前后一个（环形），并可跨1-2个节点做"切线"捷径模拟变道
  const edges = new Map();
  for (let i = 0; i < nodes.length; i++) {
    const prev = nodes[(i - 1 + nodes.length) % nodes.length];
    const cur = nodes[i];
    const next = nodes[(i + 1) % nodes.length];
    const next2 = nodes[(i + 2) % nodes.length];
    edges.set(cur.id, [prev.id, next.id, next2.id]);
  }

  // 一圈长度（近似）
  let lapLength = 0;
  for (let i = 0; i < nodes.length; i++) {
    const a = nodes[i];
    const b = nodes[(i + 1) % nodes.length];
    lapLength += calcDistance(a.lat, a.lon, b.lat, b.lon);
  }

  return { nodes, edges, lapLength };
}

/**
 * A* 寻路（在节点图上）。
 * @param {object[]} nodes
 * @param {Map} edges
 * @param {string} startId
 * @param {string} goalId
 * @returns {object[]} 节点路径（含起止），找不到返回 []
 */
export function aStar(nodes, edges, startId, goalId) {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const h = (id) => {
    const a = byId.get(id);
    const b = byId.get(goalId);
    return calcDistance(a.lat, a.lon, b.lat, b.lon);
  };
  const open = new Set([startId]);
  const gScore = new Map([[startId, 0]]);
  const fScore = new Map([[startId, h(startId)]]);
  const came = new Map();
  while (open.size) {
    // 取 f 最小
    let cur = null;
    let curF = Infinity;
    for (const id of open) {
      const f = fScore.get(id) ?? Infinity;
      if (f < curF) {
        curF = f;
        cur = id;
      }
    }
    if (cur === goalId) {
      const path = [cur];
      while (came.has(path[0])) path.unshift(came.get(path[0]));
      return path.map((id) => byId.get(id));
    }
    open.delete(cur);
    for (const nb of edges.get(cur) || []) {
      const a = byId.get(cur);
      const b = byId.get(nb);
      const tentative = (gScore.get(cur) ?? Infinity) + calcDistance(a.lat, a.lon, b.lat, b.lon);
      if (tentative < (gScore.get(nb) ?? Infinity)) {
        came.set(nb, cur);
        gScore.set(nb, tentative);
        fScore.set(nb, tentative + h(nb));
        open.add(nb);
      }
    }
  }
  return [];
}

/**
 * 规划一条多圈跑道路径，经过指定数量的"打卡点"（从图中均匀选取）。
 * @param {object} cfg { centerLat, centerLon, loopRadius, laps, checkpoints }
 * @returns {object[]} 节点路径（含重复通过）
 */
export function planRoute(cfg) {
  const { laps = 5, checkpoints = 3 } = cfg;
  const graph = buildTrackGraph(cfg);
  const { nodes, edges, lapLength } = graph;
  // 在一圈上均匀选 checkpoints 个打卡点
  const cpIdx = [];
  for (let i = 0; i < checkpoints; i++) {
    cpIdx.push(Math.floor((i / checkpoints) * nodes.length));
  }
  // 路径：start(节点0) → cp0 → cp1 → ... → 起点附近，重复 laps 次
  const visitOrder = [0, ...cpIdx];
  const fullRoute = [];
  let curId = nodes[0].id;
  for (let lap = 0; lap < laps; lap++) {
    for (let k = 0; k < visitOrder.length; k++) {
      const target = nodes[visitOrder[k]].id;
      if (target === curId) {
        fullRoute.push(nodes[visitOrder[k]]);
        continue;
      }
      const seg = aStar(nodes, edges, curId, target);
      // seg 含起点；去重追加
      for (const n of seg) {
        if (fullRoute.length === 0 || fullRoute[fullRoute.length - 1].id !== n.id) {
          fullRoute.push(n);
        }
      }
      curId = target;
    }
  }
  return { route: fullRoute, lapLength };
}

// ── Haversine（latlon [lat,lon]） ──
function haversineLL(a, b) {
  const R = 6378137, toR = Math.PI / 180;
  const dLat = (b[0] - a[0]) * toR, dLon = (b[1] - a[1]) * toR;
  const la1 = a[0] * toR, la2 = b[0] * toR;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(la1) * Math.cos(la2) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

/**
 * 索引版 A*（在 netNodes/netEdges 上寻路）：**只在边上移动**，返回节点索引序列。
 * 与上面 aStar() 的区别是入参用索引而非对象，供 planRunRouteNet 直接使用。
 * @returns {number[]|null} 含首尾的节点索引序列；不可达返回 null
 */
function aStarIdx(adj, netNodes, from, to) {
  if (from === to) return [from];
  const h = (i) => haversineLL(netNodes[i], netNodes[to]);
  const open = new Set([from]);
  const g = new Map([[from, 0]]);
  const f = new Map([[from, h(from)]]);
  const came = new Map();
  while (open.size) {
    let cur = null;
    let best = Infinity;
    for (const id of open) {
      const v = f.get(id) ?? Infinity;
      if (v < best) { best = v; cur = id; }
    }
    if (cur === to) {
      const path = [cur];
      while (came.has(path[0])) path.unshift(came.get(path[0]));
      return path;
    }
    open.delete(cur);
    for (const nb of adj[cur]) {
      const tentative = (g.get(cur) ?? Infinity) + haversineLL(netNodes[cur], netNodes[nb]);
      if (tentative < (g.get(nb) ?? Infinity)) {
        came.set(nb, cur);
        g.set(nb, tentative);
        f.set(nb, tentative + h(nb));
        open.add(nb);
      }
    }
  }
  return null;
}

/**
 * 在手画道路网上规划一条跑步路径（随机起点 → A* 依次走完目标点 → 顺路游走补足距离）。
 *
 * 关键约束（修复"横穿地图"）：
 *   1. **全程只在路网的边上移动**（A* 寻路 + 邻居游走），不出现两点之间直线跨越；
 *   2. 目标点（服务端打卡点）**必须全部走到**，不因目标距离已满而截断——
 *      因此路径可能比 targetMeters 长，调用方应按实际长度上调距离/用时；
 *   3. **不做闭环**：目标点到齐 + 累计距离达到 targetMeters 就结束（可能是任意位置）；
 *      genTrack 的 walker 到序列端点会沿原路折返，不会跳点。
 *
 * @param {number[][]} netNodes  节点经纬度 [[lat,lon],...]
 * @param {number[][]} netEdges  双向边 [[i,j],...]
 * @param {number[][]} goals     目标点 [[lat,lon],...]（服务端打卡点），可空
 * @param {number} targetMeters  目标距离（米）；目标点走完若超过它，就以实际走完为准
 * @param {object} [opts]
 * @param {number[]} [opts.checkpointNodes]  其它打卡点节点索引（还差距离时顺路经过）
 * @param {number}   [opts.goalMaxOffM]      目标点离路网超过该米数则放弃（避免越野直线）
 * @param {object}   [opts.meta]             出口参数：{ mandatoryM 走完目标的里程, totalM 总长,
 *                                            reachedTarget 是否达标, skippedGoals 未纳入目标, goalCount }
 * @returns {number[]|null} 节点索引序列
 */
export function planRunRouteNet(netNodes, netEdges, goals, targetMeters, opts = {}) {
  if (!netNodes || netNodes.length < 2 || !netEdges || netEdges.length === 0) return null;
  const { checkpointNodes = [], goalMaxOffM = 60, maxWanderIter = 20000 } = opts;
  // checkpointNodes 只接受本图内的合法索引（越界会让 A* 的 h() 读到 undefined 而抛错）
  const cps = checkpointNodes.filter((i) => Number.isInteger(i) && i >= 0 && i < netNodes.length);
  const adj = netNodes.map(() => []);
  for (const [a, b] of netEdges) {
    if (a < 0 || b < 0 || a >= netNodes.length || b >= netNodes.length) continue;
    adj[a].push(b);
    adj[b].push(a);
  }

  const route = [];
  const push = (i) => { if (!route.length || route[route.length - 1] !== i) route.push(i); };
  const nearestNodeOf = (g) => {
    let best = 0, bestD = Infinity;
    for (let k = 0; k < netNodes.length; k++) {
      const d = haversineLL(netNodes[k], g);
      if (d < bestD) { bestD = d; best = k; }
    }
    return { idx: best, d: bestD };
  };
  const distOf = (a, b) => haversineLL(netNodes[a], netNodes[b]);

  const start = Math.floor(Math.random() * netNodes.length);
  push(start);
  let cur = start;
  let acc = 0;

  /** 沿路网 A* 走到 toIdx（不跨边、不直线跳跃）；到达返回 true */
  const goTo = (toIdx) => {
    const p = aStarIdx(adj, netNodes, cur, toIdx);
    if (!p || p.length === 0) return false;
    for (let i = 1; i < p.length; i++) acc += distOf(p[i - 1], p[i]);
    for (const i of p) push(i);
    cur = toIdx;
    return true;
  };

  // ── ① 必到目标（本次选中的打卡点）：全部走完，不做距离裁剪 ──
  // 按"当前位置最近的优先"重排只为缩短总里程，不会少走任何一个目标点。
  // 目标离路网 > goalMaxOffM 或 A* 不可达 → 跳过并记录到 meta.skippedGoals（不直线跨图）。
  const targets = [];
  const skipped = [];
  for (const g of goals || []) {
    const n = nearestNodeOf(g);
    if (n.d > goalMaxOffM) { skipped.push({ goal: g, why: `离最近路网节点 ${n.d.toFixed(0)}m > ${goalMaxOffM}m` }); continue; }
    if (!targets.includes(n.idx)) targets.push(n.idx);
  }
  const pending = targets.slice();
  while (pending.length) {
    pending.sort((a, b) => distOf(cur, a) - distOf(cur, b));
    const t = pending.shift();
    if (!goTo(t)) skipped.push({ goal: netNodes[t], why: '路网上不可达（图不连通）' });
  }

  // 走完全部必到目标时的里程（后面补距离的游走不算在内）
  const mandatoryM = acc;

  // ── ② 可选：目标距离还没到，就顺路经过其它打卡点节点（同样只在路网上走）──
  const visited = new Set(route);
  if (acc < targetMeters) {
    for (const cn of cps) {
      if (acc >= targetMeters) break;
      if (visited.has(cn)) continue;
      if (goTo(cn)) for (const i of route) visited.add(i);
    }
  }

  // ── ③ 距离仍不足 → 沿路网继续游走补足；到点即止（不闭环）──
  const goalMinDist = (i) => {
    let best = Infinity;
    for (let k = 0; k < netNodes.length; k++) {
      if (visited.has(k)) continue;
      const d = distOf(i, k);
      if (d < best) best = d;
    }
    if (best === Infinity) {
      const ref = route.length >= 2 ? route[route.length - 2] : route[route.length - 1];
      return distOf(i, ref);
    }
    return best;
  };
  let iter = 0;
  while (acc < targetMeters && iter++ < maxWanderIter) {
    const lastPrev = route.length >= 2 ? route[route.length - 2] : -1;
    let neighbors = adj[cur].filter((n) => n !== lastPrev);
    if (neighbors.length === 0) neighbors = adj[cur].slice();
    if (neighbors.length === 0) break;
    neighbors.sort((i, j) => goalMinDist(i) - goalMinDist(j));
    const next =
      Math.random() < 0.2 && neighbors.length > 1
        ? neighbors[Math.floor(Math.random() * Math.min(3, neighbors.length))]
        : neighbors[0];
    acc += distOf(cur, next);
    push(next);
    visited.add(next);
    cur = next;
  }

  if (opts.meta) {
    opts.meta.mandatoryM = mandatoryM;             // 走完全部目标点时的里程
    opts.meta.totalM = acc;                        // 含补距离游走的总长
    opts.meta.reachedTarget = acc >= targetMeters; // 是否已达到目标距离
    opts.meta.skippedGoals = skipped;              // 未能纳入路径的必到目标（调用方应告警/中止）
    opts.meta.goalCount = targets.length;
  }
  return route;
}
