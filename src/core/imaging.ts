// CPU 侧二值图工具：连通域、轮廓、凸包凹陷（齿痕）、区域统计
// 掩码均为 Uint8Array，索引 y * w + x，255=前景

export interface Component {
  id: number;
  pixels: number[];
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
  cx: number;
  cy: number;
}

/** 4-邻接连通域标记，返回各组件（像素以索引形式收集） */
export function connectedComponents(mask: Uint8Array, w: number, h: number): Component[] {
  const labels = new Int32Array(w * h).fill(-1);
  const comps: Component[] = [];
  const parent: number[] = [];

  const find = (x: number): number => {
    let r = x;
    while (parent[r] !== r) r = parent[r];
    while (parent[x] !== x) {
      const nxt = parent[x];
      parent[x] = r;
      x = nxt;
    }
    return r;
  };
  const union = (a: number, b: number): void => {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent[Math.max(ra, rb)] = Math.min(ra, rb);
  };

  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      if (mask[i] === 0) continue;
      const nbr: number[] = [];
      if (x > 0 && labels[i - 1] >= 0) nbr.push(labels[i - 1]);
      if (y > 0 && labels[i - w] >= 0) nbr.push(labels[i - w]);
      if (nbr.length === 0) {
        const id = comps.length;
        parent.push(id);
        labels[i] = id;
        comps.push({
          id,
          pixels: [i],
          minX: x, maxX: x, minY: y, maxY: y,
          cx: 0, cy: 0,
        });
      } else {
        const root = find(nbr[0]);
        labels[i] = root;
        const c = comps[root];
        c.pixels.push(i);
        if (x < c.minX) c.minX = x;
        if (x > c.maxX) c.maxX = x;
        if (y < c.minY) c.minY = y;
        if (y > c.maxY) c.maxY = y;
        for (const n of nbr.slice(1)) union(root, n);
      }
    }
  }

  // 合并并计算质心
  const merged = new Map<number, Component>();
  for (const c of comps) {
    const root = find(c.id);
    let target = merged.get(root);
    if (!target) {
      target = { ...c, id: root, pixels: [] };
      merged.set(root, target);
    }
    for (const p of c.pixels) target.pixels.push(p);
    target.minX = Math.min(target.minX, c.minX);
    target.maxX = Math.max(target.maxX, c.maxX);
    target.minY = Math.min(target.minY, c.minY);
    target.maxY = Math.max(target.maxY, c.maxY);
  }
  const out: Component[] = [];
  for (const c of merged.values()) {
    let sx = 0;
    let sy = 0;
    for (const p of c.pixels) {
      sx += p % w;
      sy += Math.floor(p / w);
    }
    c.cx = sx / c.pixels.length;
    c.cy = sy / c.pixels.length;
    out.push(c);
  }
  out.sort((a, b) => b.pixels.length - a.pixels.length);
  return out;
}

/** 取最大组件并输出仅含该组件的新掩码 */
export function largestComponentMask(mask: Uint8Array, w: number, h: number): { mask: Uint8Array; comp: Component | null } {
  const comps = connectedComponents(mask, w, h);
  const out = new Uint8Array(w * h);
  if (comps.length === 0) return { mask: out, comp: null };
  const comp = comps[0];
  for (const p of comp.pixels) out[p] = 255;
  return { mask: out, comp };
}

/** 边界追踪：组件的外轮廓点（Moore 邻域简化版——逐行收集边缘像素再排序代价高，这里直接收集边缘点集合） */
export function boundaryPoints(comp: Component, w: number, h: number): { x: number; y: number }[] {
  const set = new Set(comp.pixels);
  const pts: { x: number; y: number }[] = [];
  for (const p of comp.pixels) {
    const x = p % w;
    const y = (p / w) | 0;
    const isBoundary =
      x === 0 || y === 0 || x === w - 1 || y === h - 1 ||
      !set.has(p - 1) || !set.has(p + 1) || !set.has(p - w) || !set.has(p + w);
    if (isBoundary) pts.push({ x, y });
  }
  return pts;
}

/** Andrew 单调链凸包 */
export function convexHull(points: { x: number; y: number }[]): { x: number; y: number }[] {
  const pts = points.slice().sort((a, b) => (a.x === b.x ? a.y - b.y : a.x - b.x));
  if (pts.length <= 1) return pts;
  const cross = (o: { x: number; y: number }, a: { x: number; y: number }, b: { x: number; y: number }) =>
    (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);
  const lower: { x: number; y: number }[] = [];
  for (const p of pts) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], p) <= 0) lower.pop();
    lower.push(p);
  }
  const upper: { x: number; y: number }[] = [];
  for (let i = pts.length - 1; i >= 0; i--) {
    const p = pts[i];
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], p) <= 0) upper.pop();
    upper.push(p);
  }
  lower.pop();
  upper.pop();
  return lower.concat(upper);
}

function pointLineDist(p: { x: number; y: number }, a: { x: number; y: number }, b: { x: number; y: number }): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len2 = dx * dx + dy * dy;
  if (len2 === 0) return Math.hypot(p.x - a.x, p.y - a.y);
  const t = ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2;
  const tt = Math.max(0, Math.min(1, t));
  return Math.hypot(p.x - (a.x + tt * dx), p.y - (a.y + tt * dy));
}

export interface Dent {
  x: number;
  y: number;
  depth: number; // 凹陷深度（像素）
}

/**
 * 齿痕检测：舌体左右边缘相对局部平滑轮廓的凹陷。
 * 取每行左右边界 x(y)，用大窗口滑动平均得到“无齿痕”平滑基线，
 * 真实边界相对基线向内回缩超过阈值且持续若干行才判齿痕。
 * 自然椭圆舌体的平滑弯曲不会误报，只有局部凹口才触发。
 */
export function detectDents(
  comp: Component,
  w: number,
  h: number,
): Dent[] {
  const width = comp.maxX - comp.minX;
  const height = comp.maxY - comp.minY;
  const inSet = new Set(comp.pixels);

  const rowLeft = new Map<number, number>();
  const rowRight = new Map<number, number>();
  for (const p of comp.pixels) {
    const x = p % w;
    const y = (p / w) | 0;
    if (!inSet.has(p - 1) || x === comp.minX) {
      if (!rowLeft.has(y) || x < rowLeft.get(y)!) rowLeft.set(y, x);
    }
    if (!inSet.has(p + 1) || x === comp.maxX) {
      if (!rowRight.has(y) || x > rowRight.get(y)!) rowRight.set(y, x);
    }
  }

  // 窗口需小于齿痕凹陷的纵向尺度，但大于单行噪声
  const win = Math.max(7, Math.round(height * 0.12));
  const half = Math.floor(win / 2);
  const minDepth = width * 0.025;
  const minRun = Math.max(2, Math.round(height * 0.025));

  const dents: Dent[] = [];
  const evalSide = (rows: Map<number, number>, isLeft: boolean): void => {
    const ys = [...rows.keys()].sort((a, b) => a - b);
    if (ys.length < win) return;
    const xAt = new Map(ys.map((y) => [y, rows.get(y)!]));

    const baseline = new Map<number, number>();
    for (const y of ys) {
      let s = 0;
      let n = 0;
      for (let k = -half; k <= half; k++) {
        const v = xAt.get(y + k);
        if (v !== undefined) {
          s += v;
          n++;
        }
      }
      if (n > 0) baseline.set(y, s / n);
    }

    let run: { y: number; x: number; depth: number }[] = [];
    const flush = (): void => {
      if (run.length >= minRun) {
        let best = run[0];
        for (const r of run) if (r.depth > best.depth) best = r;
        dents.push({ x: best.x, y: best.y, depth: best.depth / width });
      }
      run = [];
    };

    for (const y of ys) {
      if (y < comp.cy - height * 0.4 || y > comp.cy + height * 0.4) {
        flush();
        continue;
      }
      const x = xAt.get(y)!;
      const base = baseline.get(y)!;
      const indent = isLeft ? x - base : base - x;
      // 深度需在合理区间：过浅是噪声，过深（>0.45 舌宽）是分割/补全边缘伪影
      if (indent >= minDepth && indent / width <= 0.45) run.push({ y, x, depth: indent });
      else flush();
    }
    flush();
  };

  evalSide(rowLeft, true);
  evalSide(rowRight, false);

  dents.sort((a, b) => b.depth - a.depth);
  const kept: Dent[] = [];
  for (const d of dents) {
    if (kept.every((k) => Math.hypot(k.x - d.x, k.y - d.y) > width * 0.12)) kept.push(d);
  }
  return kept.slice(0, 8);
}

/** 区域内 Lab 中位值（对三个通道分别取中位数，避免高光/阴影离群影响） */
export function medianLab(
  pixels: number[],
  labBuf: Float32Array | Uint8Array,
  isFloat: boolean,
): { L: number; a: number; b: number } {
  const n = pixels.length;
  if (n === 0) return { L: 0, a: 0, b: 0 };
  const ls = new Float64Array(n);
  const as = new Float64Array(n);
  const bs = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const p = pixels[i] * 4;
    if (isFloat) {
      ls[i] = (labBuf as Float32Array)[p];
      as[i] = (labBuf as Float32Array)[p + 1];
      bs[i] = (labBuf as Float32Array)[p + 2];
    } else {
      // RGBA8 回退：引擎已按 Lab 量程编码进字节
      ls[i] = ((labBuf as Uint8Array)[p] / 255) * 100;
      as[i] = ((labBuf as Uint8Array)[p + 1] / 255) * 120 - 60;
      bs[i] = ((labBuf as Uint8Array)[p + 2] / 255) * 120 - 60;
    }
  }
  const med = (arr: Float64Array): number => {
    const s = Array.from(arr).sort((x, y) => x - y);
    const mid = s.length >> 1;
    return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
  };
  return { L: med(ls), a: med(as), b: med(bs) };
}

/** 区域内 sRGB 均值（0~255） */
export function meanRgb(pixels: number[], rgbBuf: Uint8Array): { r: number; g: number; b: number } {
  if (pixels.length === 0) return { r: 0, g: 0, b: 0 };
  let r = 0;
  let g = 0;
  let b = 0;
  for (const p of pixels) {
    const i = p * 4;
    r += rgbBuf[i];
    g += rgbBuf[i + 1];
    b += rgbBuf[i + 2];
  }
  const n = pixels.length;
  return { r: r / n, g: g / n, b: b / n };
}
