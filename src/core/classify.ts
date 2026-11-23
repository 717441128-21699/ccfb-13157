import type {
  TongueColorClass,
  CoatingClass,
  Lab,
  RGB,
  TeethMark,
  Crack,
} from '../types';
import {
  TONGUE_COLOR_PROTOTYPES,
  TONGUE_COLOR_ORDER,
  COATING_PROTOTYPES,
} from './references';
import { deltaE } from './color';
import type { Dent } from './imaging';

/** 舌色五分类：Lab 空间最近邻原型，返回类别与到各类的距离 */
export function classifyTongueColor(lab: Lab): {
  cls: TongueColorClass;
  distances: Record<TongueColorClass, number>;
} {
  const distances = {} as Record<TongueColorClass, number>;
  let best: TongueColorClass = 'lightRed';
  let bestD = Infinity;
  for (const c of TONGUE_COLOR_ORDER) {
    const d = deltaE(lab, TONGUE_COLOR_PROTOTYPES[c].lab);
    distances[c] = d;
    if (d < bestD) {
      bestD = d;
      best = c;
    }
  }
  // 光源稳健性仲裁：深绛必须足够暗（实测深绛 L*≤45.1，红 L*≥47.5）。
  // 暖光把红舌压暗到 L*≈47 时仍应归红，避免跨光源类别跳变。
  if (best === 'deepRed' && lab.L > 46 && distances.red < distances.deepRed + 8) {
    best = 'red';
  }
  return { cls: best, distances };
}

/**
 * 舌苔三分类（覆盖率 + 粗糙度 + 黄度的类条件评分）。
 * 三个特征在合成数据三光源下标定，用高斯型隶属度打分后取最大类，
 * 比硬阈值更能容忍单特征在极端光源下的漂移。
 */
export function classifyCoating(
  coverage: number,
  coatLab: Lab,
  roughness = 0,
  yellowness = 0,
): { cls: CoatingClass; distances: Record<CoatingClass, number> } {
  const distances = {} as Record<CoatingClass, number>;
  for (const c of ['thinWhite', 'thickWhite', 'greasyYellow'] as CoatingClass[]) {
    distances[c] = deltaE(coatLab, COATING_PROTOTYPES[c].lab);
  }

  // 隶属度函数（高斯），参数来自三光源合成数据的实测分布。
  // 决策逻辑：黄腻优先（黄度强）；厚白要求覆盖率达到下限且粗糙度高；其余薄白。
  const g = (x: number, mu: number, sd: number): number => Math.exp(-((x - mu) ** 2) / (2 * sd * sd));
  const scoreThin = g(coverage, 0.09, 0.06) * g(yellowness, 13, 5) * g(roughness, 4.5, 2.5);
  // 厚白：覆盖率需 ≥0.1（硬门槛），且粗糙度高；覆盖率不足时得分被压到接近 0
  const coverageGate = coverage >= 0.1 ? 1 : 0.15;
  const scoreThick = coverageGate * g(coverage, 0.16, 0.08) * g(yellowness, 12, 5) * g(roughness, 7.5, 2.5);
  const scoreYellow = g(yellowness, 26, 5) * (0.5 + 0.5 * g(coverage, 0.3, 0.25));

  const scores: [CoatingClass, number][] = [
    ['thinWhite', scoreThin],
    ['thickWhite', scoreThick],
    ['greasyYellow', scoreYellow],
  ];
  scores.sort((a, b) => b[1] - a[1]);
  return { cls: scores[0][0], distances };
}

/** 把像素坐标的凹陷转成归一化齿痕标注 */
export function toTeethMarks(dents: Dent[], w: number, h: number): TeethMark[] {
  return dents.map((d) => ({
    x: d.x / w,
    y: d.y / h,
    depth: Math.min(1, d.depth * 4),
  }));
}

/**
 * 裂纹连通域过滤：按组件尺寸、长宽比和走向生成标注。
 * comps 为裂纹掩码的连通域。
 */
export function toCracks(
  comps: { pixels: number[]; minX: number; minY: number; maxX: number; maxY: number }[],
  w: number,
  h: number,
): Crack[] {
  const out: Crack[] = [];
  const minArea = Math.max(18, w * h * 0.0002);
  for (const c of comps) {
    const bw = c.maxX - c.minX + 1;
    const bh = c.maxY - c.minY + 1;
    const area = c.pixels.length;
    if (area < minArea) continue;
    // 裂纹细长：长边 ≥14px，长宽比 ≥3，填充率低
    const span = Math.max(bw, bh);
    const thin = Math.max(1, Math.min(bw, bh));
    const aspect = span / thin;
    const fill = area / (bw * bh);
    if (span < 14) continue;
    if (aspect < 3 || fill > 0.45) continue;
    const cx = (c.minX + c.maxX) / 2 / w;
    const cy = (c.minY + c.maxY) / 2 / h;
    const angleDeg = (Math.atan2(bh, bw) * 180) / Math.PI;
    out.push({
      x: cx,
      y: cy,
      length: span,
      angleDeg: Math.round(angleDeg),
    });
  }
  out.sort((a, b) => b.length - a.length);
  return out.slice(0, 12);
}

/** 分类结果的中文标签工具 */
export const TONGUE_LABELS: Record<TongueColorClass, string> = {
  pale: '淡白',
  lightRed: '淡红',
  red: '红',
  deepRed: '绛',
  purple: '紫',
};

export const COATING_LABELS: Record<CoatingClass, string> = {
  thinWhite: '薄白',
  thickWhite: '厚白',
  greasyYellow: '黄腻',
};

export function rgbLabel(c: RGB): string {
  return `RGB(${Math.round(c.r)}, ${Math.round(c.g)}, ${Math.round(c.b)})`;
}
