import type { ChartDetection, ColorPatch, Calibration, RGB, Illuminant } from '../types';
import { COLOR_CARD, ILLUMINANTS } from './references';
import { srgbToLinear, rgbToLab, rgbDeltaE } from './color';
import { fitColorMatrix, fitExposure, mat3Vec } from './matrix';
import { connectedComponents } from './imaging';

// 检测用缩略图长边
const THUMB_LONG_EDGE = 320;

export interface Thumbnail {
  data: ImageData;
  scale: number; // 原图 / 缩略图
}

export function makeThumbnail(img: ImageBitmap | HTMLCanvasElement): Thumbnail {
  const w0 = img.width;
  const h0 = img.height;
  const scale = Math.max(w0, h0) / THUMB_LONG_EDGE;
  const w = Math.max(2, Math.round(w0 / scale));
  const h = Math.max(2, Math.round(h0 / scale));
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const ctx = c.getContext('2d', { willReadFrequently: true })!;
  ctx.drawImage(img, 0, 0, w, h);
  return { data: ctx.getImageData(0, 0, w, h), scale };
}

interface Blob {
  cx: number;
  cy: number;
  r: number;
  mean: RGB;
}

/**
 * 色卡检测（两阶段）：
 * 1) 检测白色卡基——画面左上 ROI 内高亮、低饱和、近矩形的大连通域，
 *    它覆盖整张卡，不依赖哪些色块恰好高饱和；
 * 2) 在卡基内边距里按 6×3 等分网格，逐块采样并与参考色做 Lab 色差校验。
 */
export function detectColorChart(thumb: Thumbnail): ChartDetection {
  const { data, width: w, height: h } = thumb.data;

  // ---- 阶段 1：卡基掩码 ----
  // 光源无关判据：卡基是画面内最亮的漫反射表面之一。
  // 不能用低饱和（白炽灯下白卡基也偏暖黄），改用“三通道最小值高 + 亮度居前”。
  const lumaAt = new Float32Array(w * h);
  let lumaSum = 0;
  for (let i = 0, p = 0; i < w * h; i++, p += 4) {
    const luma = 0.2126 * data[p] + 0.7152 * data[p + 1] + 0.0722 * data[p + 2];
    lumaAt[i] = luma;
    lumaSum += luma;
  }
  const lumaMean = lumaSum / (w * h);
  const baseMask = new Uint8Array(w * h);
  for (let i = 0, p = 0; i < w * h; i++, p += 4) {
    const minCh = Math.min(data[p], data[p + 1], data[p + 2]);
    // 亮于画面均值 1.25 倍，且最弱通道也足够高（排除纯色块与暗背景）
    if (lumaAt[i] > lumaMean * 1.25 && minCh > 120) baseMask[i] = 255;
  }
  const whiteComps = connectedComponents(baseMask, w, h);
  // 卡基按协议在画面左上角：质心限制在左上 40% 宽、38% 高内
  const roiX = w * 0.4;
  const roiY = h * 0.38;
  // 6:3 色卡的卡基宽高比约 1.7~2.2
  let base: { x0: number; y0: number; x1: number; y1: number; fill: number; score: number } | null = null;
  for (const c of whiteComps) {
    if (c.cx > roiX || c.cy > roiY) continue;
    const bw = c.maxX - c.minX;
    const bh = c.maxY - c.minY;
    if (bw < w * 0.1 || bh < h * 0.05) continue;
    const aspect = bw / Math.max(1, bh);
    if (aspect < 1.4 || aspect > 2.4) continue;
    const fill = c.pixels.length / Math.max(1, bw * bh);
    if (fill < 0.45) continue;
    // 评分：左上角位置是首要判据（拍摄协议保证），再用宽高比接近 1.72 与填充率加权
    const cornerDist = (c.cx / w) * 0.6 + (c.cy / h) * 0.6;
    const aspectPenalty = Math.abs(aspect - 1.72) * 0.5;
    const score = 2 - cornerDist - aspectPenalty + (fill - 0.5) * 0.5;
    if (!base || score > base.score) {
      base = { x0: c.minX, y0: c.minY, x1: c.maxX, y1: c.maxY, fill, score };
    }
  }
  if (!base) return { found: false, confidence: 0.15 };

  // ---- 阶段 2：卡基内 6×3 等分，采样点取每格中心 ----
  // 网格区几何比例由色卡设计决定：宽占卡基 90%、高占 86%，居中。
  const gridW = (base.x1 - base.x0) * 0.9;
  const gridH = (base.y1 - base.y0) * 0.86;
  const gx0 = (base.x0 + base.x1) / 2 - gridW / 2;
  const gy0 = (base.y0 + base.y1) / 2 - gridH / 2;
  const cellW = gridW / COLOR_CARD.cols;
  const cellH = gridH / COLOR_CARD.rows;
  const stepX = cellW;
  const stepY = cellH;
  const originX = gx0 + cellW * (COLOR_CARD.cols - 1) / 2;
  const originY = gy0 + cellH * (COLOR_CARD.rows - 1) / 2;
  const cellRadius = Math.min(cellW, cellH) * 0.3;

  const fit: GridFit = {
    originX,
    originY,
    ux: 1,
    uy: 0,
    stepX,
    stepY,
    cellRadius,
    regularity: 1,
  };

  // 粗到细两级对齐搜索：先大步长找大致偏移，再小步长精修，避免过拟合
  const aligned = alignGrid(data, w, h, [], fit);

  // 采样 18 块
  const patches: ColorPatch[] = [];
  let validCells = 0;
  let colorScore = 0;
  for (const ref of COLOR_CARD.patches) {
    const gx = ref.col - (COLOR_CARD.cols - 1) / 2;
    const gy = ref.row - (COLOR_CARD.rows - 1) / 2;
    const px = aligned.originX + gx * aligned.stepX;
    const py = aligned.originY + gy * aligned.stepY;
    const measured = samplePatch(data, w, h, px, py, aligned.cellRadius);
    if (measured) {
      validCells++;
      colorScore += rgbDeltaE({ r: measured.r * 255, g: measured.g * 255, b: measured.b * 255 }, ref.ref);
    }
    patches.push({
      row: ref.row,
      col: ref.col,
      ref: ref.ref,
      nx: px / w,
      ny: py / h,
      measured: measured ?? undefined,
    });
  }

  const coverage = validCells / COLOR_CARD.patches.length;
  const meanColorDelta = validCells ? colorScore / validCells : 999;

  // 试解校准矩阵，用拟合残差做客观判据（残差小=采样与参考色存在稳定线性映射=对齐正确）
  const trialChart: ChartDetection = { found: true, patches, confidence: 1 };
  const trialCal = solveCalibration(trialChart);
  const residual = trialCal?.residual ?? Infinity;

  // 置信度综合覆盖率、色差、残差
  const confidence = Math.max(
    0,
    Math.min(1, coverage * 0.45 + Math.max(0, 1 - meanColorDelta / 45) * 0.25 + Math.max(0, 1 - residual / 0.05) * 0.3),
  );
  // 校准残差低于 0.04（线性 RMSE）即认为网格对齐正确、色卡可信
  const found = validCells >= 16 && residual < 0.04;

  if (!found) return { found: false, confidence, patches };

  const corners = [
    { x: base.x0 / w, y: base.y0 / h },
    { x: base.x1 / w, y: base.y0 / h },
    { x: base.x1 / w, y: base.y1 / h },
    { x: base.x0 / w, y: base.y1 / h },
  ];

  return { found: true, corners, patches, confidence };
}

interface GridFit {
  originX: number;
  originY: number;
  ux: number;
  uy: number;
  stepX: number;
  stepY: number;
  cellRadius: number;
  regularity: number;
}

/**
 * 网格标定：色卡按拍摄协议基本轴对齐，直接用候选色块的整体包围盒
 * 按 6 列 × 3 行等分。比 PCA 更稳健（PCA 在只有部分饱和块可见时主轴会偏）。
 */
function fitGrid(blobs: Blob[]): GridFit | null {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  let rSum = 0;
  for (const b of blobs) {
    minX = Math.min(minX, b.cx - b.r);
    maxX = Math.max(maxX, b.cx + b.r);
    minY = Math.min(minY, b.cy - b.r);
    maxY = Math.max(maxY, b.cy + b.r);
    rSum += b.r;
  }
  const width = maxX - minX;
  const height = maxY - minY;
  if (width < 20 || height < 10) return null;

  const stepX = width / (COLOR_CARD.cols - 1);
  const stepY = height / (COLOR_CARD.rows - 1);
  if (stepX < 4 || stepY < 3) return null;

  // 网格中心 = 包围盒中心
  const originX = (minX + maxX) / 2;
  const originY = (minY + maxY) / 2;
  const meanR = rSum / blobs.length;

  // 规整度：每个 blob 中心到最近网格点的距离（相对步长）
  let resid = 0;
  for (const b of blobs) {
    const gx = Math.round((b.cx - originX) / stepX);
    const gy = Math.round((b.cy - originY) / stepY);
    const px = originX + gx * stepX;
    const py = originY + gy * stepY;
    resid += Math.hypot(b.cx - px, b.cy - py);
  }
  const regularity = Math.max(0, 1 - resid / blobs.length / (stepX * 0.5));

  return {
    originX,
    originY,
    ux: 1,
    uy: 0,
    stepX,
    stepY,
    cellRadius: Math.max(2, meanR * 0.7),
    regularity,
  };
}

/**
 * 网格对齐搜索：在初始中心 ±1.5 步长范围内平移网格原点，
 * 对每个候选位置采样全部 18 个色块，计算与参考色的色差总分，取最优。
 * 同时微调步长（±10%），容忍包围盒估计偏差。
 */
function alignGrid(
  data: Uint8ClampedArray,
  w: number,
  h: number,
  blobs: Blob[],
  init: GridFit,
): GridFit {
  let best: GridFit = init;
  let bestScore = Infinity;
  const radius = init.cellRadius;

  // 初始几何来自卡基 bbox 等分，已足够准确；只做小范围精细校正，
  // 避免大平移把网格带到错误的局部最优。
  const scoreAt = (ox: number, oy: number, sx: number, sy: number): number => {
    let total = 0;
    let n = 0;
    for (const ref of COLOR_CARD.patches) {
      const gx = ref.col - (COLOR_CARD.cols - 1) / 2;
      const gy = ref.row - (COLOR_CARD.rows - 1) / 2;
      const px = ox + gx * sx;
      const py = oy + gy * sy;
      const m = samplePatch(data, w, h, px, py, radius);
      if (!m) continue;
      const measuredRgb: RGB = { r: m.r * 255, g: m.g * 255, b: m.b * 255 };
      total += rgbDeltaE(measuredRgb, ref.ref);
      n++;
    }
    return n >= 12 ? total / n : Infinity;
  };

  // 以初始等分为基线。两级搜索：粗扫（步长 0.5）定位，再在最优点附近细扫（0.15）。
  const baseline = scoreAt(init.originX, init.originY, init.stepX, init.stepY);
  bestScore = baseline;
  best = { ...init };

  const search = (cx: number, cy: number, csx: number, csy: number, shifts: number[], scales: number[]): void => {
    for (const kx of scales) {
      for (const ky of scales) {
        const sx = csx * kx;
        const sy = csy * ky;
        for (const dx of shifts) {
          for (const dy of shifts) {
            const ox = cx + dx * init.stepX;
            const oy = cy + dy * init.stepY;
            const score = scoreAt(ox, oy, sx, sy);
            if (score < bestScore) {
              bestScore = score;
              best = { ...init, originX: ox, originY: oy, stepX: sx, stepY: sy };
            }
          }
        }
      }
    }
  };
  // 粗扫：平移 ±1 步长，缩放 ±5%
  search(init.originX, init.originY, init.stepX, init.stepY,
    [-1, -0.5, 0, 0.5, 1], [0.97, 1, 1.03]);
  // 细扫：在当前最优点 ±0.4 步长内精修
  search(best.originX, best.originY, best.stepX, best.stepY,
    [-0.4, -0.2, 0, 0.2, 0.4], [0.99, 1, 1.01]);

  // 用最佳对齐下的 blob 残差更新规整度（无候选 blob 时保留初始值）
  if (blobs.length > 0) {
    let resid = 0;
    for (const b of blobs) {
      const gx = Math.round((b.cx - best.originX) / best.stepX);
      const gy = Math.round((b.cy - best.originY) / best.stepY);
      resid += Math.hypot(b.cx - (best.originX + gx * best.stepX), b.cy - (best.originY + gy * best.stepY));
    }
    best.regularity = Math.max(0, 1 - resid / blobs.length / (best.stepX * 0.5));
  }
  return best;
}

function samplePatch(data: ImageData['data'], w: number, h: number, cx: number, cy: number, radius: number): RGB | null {
  const r = Math.max(1.5, radius);
  const x0 = Math.max(0, Math.round(cx - r * 0.55));
  const x1 = Math.min(w - 1, Math.round(cx + r * 0.55));
  const y0 = Math.max(0, Math.round(cy - r * 0.55));
  const y1 = Math.min(h - 1, Math.round(cy + r * 0.55));
  let rr = 0;
  let gg = 0;
  let bb = 0;
  let n = 0;
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      const i = (y * w + x) * 4;
      rr += data[i];
      gg += data[i + 1];
      bb += data[i + 2];
      n++;
    }
  }
  if (n < 4) return null;
  return { r: rr / n / 255, g: gg / n / 255, b: bb / n / 255 };
}

/**
 * 由色卡测量值求解校色参数：
 * 先由灰阶/白块拟合曝光增益，再在增益归一化后的数据上求 3x3 最小二乘矩阵。
 */
export function solveCalibration(chart: ChartDetection): Calibration | null {
  if (!chart.found || !chart.patches) return null;
  const measured: [number, number, number][] = [];
  const target: [number, number, number][] = [];
  for (const p of chart.patches) {
    if (!p.measured) continue;
    measured.push([srgbToLinear(p.measured.r * 255), srgbToLinear(p.measured.g * 255), srgbToLinear(p.measured.b * 255)]);
    target.push([srgbToLinear(p.ref.r), srgbToLinear(p.ref.g), srgbToLinear(p.ref.b)]);
  }
  if (measured.length < 8) return null;

  const exposure = fitExposure(measured, target);
  const scaled = measured.map((m) => [m[0] * exposure, m[1] * exposure, m[2] * exposure] as [number, number, number]);
  // 岭阻尼取测量能量的相对值，避免蓝通道低信号时矩阵系数发散
  let energy = 0;
  for (const m of scaled) energy += m[0] * m[0] + m[1] * m[1] + m[2] * m[2];
  const ridge = (energy / (scaled.length * 3)) * 0.02;
  const { matrix, rmse } = fitColorMatrix(scaled, target, ridge);

  // 光源判定：取白色块的校色前测量值，用蓝/红通道比直接分类（比 CCT 反演稳）
  const white = chart.patches.find((p) => p.row === 2 && p.col === 5 && p.measured);
  const estCCT = white ? estimateCCT(white.measured!) : 6500;
  const illuminant = white ? inferIlluminantFromWhite(white.measured!) : inferIlluminantFromCct(estCCT);

  return { matrix, exposure, residual: rmse, estCCT, illuminant };
}

/** 由白块原始 sRGB（0~1）估计相关色温 */
export function estimateCCT(rgb: RGB): number {
  const r = srgbToLinear(rgb.r * 255);
  const g = srgbToLinear(rgb.g * 255);
  const b = srgbToLinear(rgb.b * 255);
  const X = 0.4124564 * r + 0.3575761 * g + 0.1804375 * b;
  const Y = 0.2126729 * r + 0.7151522 * g + 0.072175 * b;
  const Z = 0.0193339 * r + 0.119192 * g + 0.9503041 * b;
  const x = X / (X + Y + Z);
  const y = Y / (X + Y + Z);
  const n = (x - 0.332) / (y - 0.1858);
  const cct = 437 * n ** 3 + 3601 * n ** 2 + 6861 * n + 5517;
  return Math.round(Math.max(2000, Math.min(12000, cct)));
}

/**
 * 由白块原始颜色直接判光源类型（比 CCT 反演稳）：
 * 暖光白炽灯蓝通道显著偏低（B/R 小），阴天日光偏冷（B/R 大），荧光灯居中。
 */
export function inferIlluminantFromWhite(rgb: RGB): Illuminant {
  const br = rgb.b / Math.max(0.01, rgb.r);
  if (br < 0.78) return 'incandescent';
  if (br > 0.97) return 'daylight';
  return 'fluorescent';
}

/** 由校准结果推断光源类型（优先白块直接判定） */
export function inferIlluminant(cal: Calibration | null): Illuminant | '' {
  if (!cal) return '';
  return cal.illuminant;
}

function inferIlluminantFromCct(t: number): Illuminant {
  if (t < 3500) return 'incandescent';
  if (t < 5600) return 'fluorescent';
  return 'daylight';
}

/** 供分析器/测试复用：把校色参数应用到单个 sRGB 颜色 */
export function applyCalibration(rgb: RGB, cal: Calibration): RGB {
  const lin: [number, number, number] = [srgbToLinear(rgb.r), srgbToLinear(rgb.g), srgbToLinear(rgb.b)];
  const scaled: [number, number, number] = [lin[0] * cal.exposure, lin[1] * cal.exposure, lin[2] * cal.exposure];
  const [r, g, b] = mat3Vec(cal.matrix, scaled);
  const enc = (v: number): number => {
    const s = v <= 0.0031308 ? v * 12.92 : 1.055 * Math.pow(Math.max(0, v), 1 / 2.4) - 0.055;
    return Math.min(255, Math.max(0, s * 255));
  };
  return { r: enc(r), g: enc(g), b: enc(b) };
}

/** 找最接近的已知光源（评测时用估计值对照真值） */
export function nearestIlluminant(cct: number): Illuminant {
  let best: Illuminant = 'daylight';
  let bestD = Infinity;
  (Object.keys(ILLUMINANTS) as Illuminant[]).forEach((k) => {
    const d = Math.abs(ILLUMINANTS[k].cct - cct);
    if (d < bestD) {
      bestD = d;
      best = k;
    }
  });
  return best;
}
