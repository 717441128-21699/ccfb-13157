import type {
  Illuminant,
  TongueColorClass,
  CoatingClass,
  RGB,
  SampleGroundTruth,
} from '../types';
import { Rng } from './rng';
import {
  COLOR_CARD,
  ILLUMINANTS,
  TONGUE_COLOR_PROTOTYPES,
  COATING_PROTOTYPES,
} from './references';
import { labToRgb, srgbToLinear, linearToSrgb } from './color';

export interface GeneratedSample {
  canvas: HTMLCanvasElement;
  truth: SampleGroundTruth;
}

export interface SampleOptions {
  width?: number;
  height?: number;
  illuminant: Illuminant;
  tongueColor: TongueColorClass;
  coating: CoatingClass;
  teethMarks: boolean;
  cracks: boolean;
  seed: number;
  /** 色卡是否入镜（默认在） */
  withChart?: boolean;
  /** 传感器噪声强度 */
  noise?: number;
}

// 舌苔覆盖率真值
const COATING_TRUTH_COVERAGE: Record<CoatingClass, number> = {
  thinWhite: 0.18,
  thickWhite: 0.58,
  greasyYellow: 0.62,
};

/**
 * 合成舌象照片：
 * 1) D65 参考色空间绘制场景（脸/唇/牙/舌/苔/裂纹/齿痕/津液高光/色卡），
 * 2) 线性空间施加光源增益、环境光、曝光与传感器噪声，
 * 3) 编码回 sRGB——与真实相机成像链路一致，保证校色算法面对的是物理偏差而非简单加色。
 */
export function generateSample(opts: SampleOptions): GeneratedSample {
  const W = opts.width ?? 640;
  const H = opts.height ?? 640;
  const rng = new Rng(opts.seed);
  const canvas = document.createElement('canvas');
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext('2d', { willReadFrequently: true })!;

  // ---------- 1. D65 场景绘制到浮点线性缓冲 ----------
  const lin = new Float32Array(W * H * 3);
  const setLin = (x: number, y: number, r: number, g: number, b: number, alpha = 1): void => {
    if (x < 0 || y < 0 || x >= W || y >= H) return;
    const i = (y * W + x) * 3;
    lin[i] = lin[i] * (1 - alpha) + r * alpha;
    lin[i + 1] = lin[i + 1] * (1 - alpha) + g * alpha;
    lin[i + 2] = lin[i + 2] * (1 - alpha) + b * alpha;
  };
  const rgbLin = (c: RGB): [number, number, number] => [
    srgbToLinear(c.r),
    srgbToLinear(c.g),
    srgbToLinear(c.b),
  ];

  // 背景：面部皮肤（暖米色，带轻微径向渐变）
  const skin = rgbLin({ r: 224, g: 183, b: 158 });
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const vignette = 1 - 0.12 * Math.hypot((x - W / 2) / W, (y - H / 2) / H);
      setLin(x, y, skin[0] * vignette, skin[1] * vignette, skin[2] * vignette);
    }
  }

  // 口腔：深色椭圆开口
  const mouthCx = W * 0.5;
  const mouthCy = H * 0.52;
  const mouthRx = W * 0.34;
  const mouthRy = H * 0.3;
  const mouth = rgbLin({ r: 74, g: 38, b: 42 });
  fillEllipse(lin, W, H, mouthCx, mouthCy, mouthRx, mouthRy, mouth);

  // 嘴唇：口腔外圈红色环（暗红，与舌色形成区分）
  const lip = rgbLin({ r: 150, g: 60, b: 66 });
  fillEllipseRing(lin, W, H, mouthCx, mouthCy, mouthRx * 1.12, mouthRy * 1.14, mouthRx, mouthRy, lip);

  // 上排牙齿：口腔顶部白色条带
  const teeth = rgbLin({ r: 238, g: 232, b: 220 });
  for (let x = 0; x < W; x++) {
    for (let y = 0; y < H; y++) {
      const dx = (x - mouthCx) / (mouthRx * 0.82);
      const dy = (y - (mouthCy - mouthRy * 0.72)) / (mouthRy * 0.16);
      if (dx * dx + dy * dy < 1) setLin(x, y, teeth[0], teeth[1], teeth[2]);
    }
  }

  // ---------- 舌体 ----------
  const tongueCx = W * (0.5 + rng.gaussian(0, 0.012));
  const tongueCy = H * (0.55 + rng.gaussian(0, 0.012));
  const tongueRx = W * (0.26 + rng.range(-0.012, 0.012));
  const tongueRy = H * (0.30 + rng.range(-0.012, 0.012));

  const bodyRgb = labToRgb(jitterPrototype(TONGUE_COLOR_PROTOTYPES[opts.tongueColor].lab, rng, 1.8));
  const bodyLin = rgbLin(bodyRgb);

  // 齿痕：左右边缘的凹陷（沿边缘若干个半圆凹口）
  const dentCount = opts.teethMarks ? 3 + Math.floor(rng.next() * 3) : 0;
  const dents: { cy: number; r: number; side: number }[] = [];
  for (let i = 0; i < dentCount; i++) {
    dents.push({
      cy: tongueCy + (rng.range(-0.45, 0.45)) * tongueRy,
      r: tongueRx * rng.range(0.1, 0.17),
      side: i % 2 === 0 ? -1 : 1,
    });
  }

  const tongueMask = new Uint8Array(W * H);
  const tongueEdge = new Float32Array(W * H);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const dx = (x - tongueCx) / tongueRx;
      const dy = (y - tongueCy) / tongueRy;
      const e = dx * dx + dy * dy;
      if (e > 1) continue;
      // 齿痕凹陷：在凹口圆内剔除
      let inDent = false;
      for (const d of dents) {
        const ddx = x - (tongueCx + d.side * tongueRx * 0.98);
        const ddy = y - d.cy;
        if (ddx * ddx + ddy * ddy < d.r * d.r && d.side * (x - tongueCx) > 0) {
          inDent = true;
          break;
        }
      }
      if (inDent) continue;
      tongueMask[y * W + x] = 1;
      tongueEdge[y * W + x] = Math.max(0, 1 - e);
      // 舌面颜色：中心略亮、边缘略暗，加低频纹理
      const shade = 0.92 + 0.1 * (1 - e) + rng.gaussian(0, 0.012);
      setLin(x, y, bodyLin[0] * shade, bodyLin[1] * shade, bodyLin[2] * shade);
    }
  }

  // ---------- 舌苔 ----------
  const coatRgb = labToRgb(jitterPrototype(COATING_PROTOTYPES[opts.coating === 'greasyYellow' ? 'greasyYellow' : opts.coating === 'thickWhite' ? 'thickWhite' : 'thinWhite'].lab, rng, 1.4));
  const coatLin = rgbLin(coatRgb);
  const targetCoverage = COATING_TRUTH_COVERAGE[opts.coating];
  // 苔集中在舌中后部，用若干团块生成，团块总面积匹配覆盖率
  const tongueArea = tongueMask.reduce((s, v) => s + v, 0);
  const coatMask = new Uint8Array(W * H);
  const blobs = 6 + Math.floor(rng.next() * 5);
  let placed = 0;
  for (let b = 0; b < blobs && placed < tongueArea * targetCoverage; b++) {
    const bcx = tongueCx + rng.gaussian(0, tongueRx * 0.28);
    const bcy = tongueCy - tongueRy * 0.18 + rng.gaussian(0, tongueRy * 0.3);
    const brx = tongueRx * rng.range(0.18, 0.42);
    const bry = tongueRy * rng.range(0.14, 0.34);
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const idx = y * W + x;
        if (!tongueMask[idx] || coatMask[idx]) continue;
        const d = ((x - bcx) / brx) ** 2 + ((y - bcy) / bry) ** 2;
        if (d < 1 && rng.next() > 0.08) {
          coatMask[idx] = 1;
          placed++;
        }
      }
    }
  }
  for (let i = 0; i < W * H; i++) {
    if (!coatMask[i]) continue;
    const x = i % W;
    const y = (i / W) | 0;
    const mix = opts.coating === 'thinWhite' ? 0.55 : opts.coating === 'thickWhite' ? 0.82 : 0.8;
    setLin(x, y,
      lin[i * 3] * (1 - mix) + coatLin[0] * mix,
      lin[i * 3 + 1] * (1 - mix) + coatLin[1] * mix,
      lin[i * 3 + 2] * (1 - mix) + coatLin[2] * mix);
  }

  // ---------- 裂纹：舌面暗线（非苔区） ----------
  if (opts.cracks) {
    const crackCount = 1 + Math.floor(rng.next() * 3);
    const dark = rgbLin({ r: 96, g: 44, b: 44 });
    for (let c = 0; c < crackCount; c++) {
      const x0 = tongueCx + rng.gaussian(0, tongueRx * 0.2);
      const y0 = tongueCy + rng.gaussian(0, tongueRy * 0.2);
      const len = tongueRy * rng.range(0.25, 0.55);
      const angle = rng.range(-0.5, 0.5) + (rng.next() < 0.5 ? Math.PI / 2 : 0);
      const width = rng.range(1.2, 2.4);
      const steps = Math.ceil(len);
      for (let s = 0; s < steps; s++) {
        const t = s / steps - 0.5;
        const wobble = rng.gaussian(0, 1.5);
        const px = x0 + Math.cos(angle) * t * len + Math.cos(angle + Math.PI / 2) * wobble;
        const py = y0 + Math.sin(angle) * t * len + Math.sin(angle + Math.PI / 2) * wobble;
        for (let oy = -2; oy <= 2; oy++) {
          for (let ox = -2; ox <= 2; ox++) {
            const x = Math.round(px + ox);
            const y = Math.round(py + oy);
            const idx = y * W + x;
            if (x < 0 || y < 0 || x >= W || y >= H || !tongueMask[idx] || coatMask[idx]) continue;
            if (Math.hypot(ox, oy) <= width) {
              setLin(x, y, dark[0], dark[1], dark[2], 0.75);
            }
          }
        }
      }
    }
  }

  // ---------- 津液反光点 ----------
  const specCount = 3 + Math.floor(rng.next() * 5);
  for (let s = 0; s < specCount; s++) {
    let sx = 0;
    let sy = 0;
    let tries = 0;
    do {
      sx = tongueCx + rng.gaussian(0, tongueRx * 0.5);
      sy = tongueCy + rng.gaussian(0, tongueRy * 0.5);
      tries++;
    } while (tongueMask[Math.round(sy) * W + Math.round(sx)] === 0 && tries < 20);
    const sr = rng.range(4, 11);
    fillEllipse(lin, W, H, sx, sy, sr * rng.range(1, 1.8), sr, [0.98, 0.98, 0.96]);
  }

  // ---------- 色卡（左上角，6x3 网格，带白色卡基、边框与色块间隙） ----------
  if (opts.withChart !== false) {
    const cardW = W * 0.3;
    const cardH = cardW * (COLOR_CARD.rows / COLOR_CARD.cols) * 1.08;
    const cardX = W * 0.04;
    const cardY = H * 0.05;
    // 卡基
    fillRectLin(lin, W, H, cardX - 7, cardY - 7, cardW + 14, cardH + 14, rgbLin({ r: 232, g: 232, b: 229 }));
    const padX = cardW * 0.05;
    const padY = cardH * 0.07;
    const gap = cardW * 0.012;
    const cellW = (cardW - padX * 2 - gap * (COLOR_CARD.cols - 1)) / COLOR_CARD.cols;
    const cellH = (cardH - padY * 2 - gap * (COLOR_CARD.rows - 1)) / COLOR_CARD.rows;
    for (const p of COLOR_CARD.patches) {
      const px = cardX + padX + p.col * (cellW + gap);
      const py = cardY + padY + p.row * (cellH + gap);
      const c = rgbLin(p.ref);
      fillRectLin(lin, W, H, px + 1, py + 1, cellW - 2, cellH - 2, c);
    }
  }

  // ---------- 2. 施加光源（线性空间） ----------
  const ill = ILLUMINANTS[opts.illuminant];
  const noiseSigma = opts.noise ?? 0.012;
  for (let i = 0; i < lin.length; i += 3) {
    let r = lin[i] * ill.gain[0] * ill.exposure + ill.ambient[0];
    let g = lin[i + 1] * ill.gain[1] * ill.exposure + ill.ambient[1];
    let b = lin[i + 2] * ill.gain[2] * ill.exposure + ill.ambient[2];
    r = Math.max(0, r + rng.gaussian(0, noiseSigma));
    g = Math.max(0, g + rng.gaussian(0, noiseSigma));
    b = Math.max(0, b + rng.gaussian(0, noiseSigma));
    lin[i] = r;
    lin[i + 1] = g;
    lin[i + 2] = b;
  }

  // ---------- 3. 编码 sRGB 并写入 canvas ----------
  const img = ctx.createImageData(W, H);
  for (let i = 0, j = 0; i < lin.length; i += 3, j += 4) {
    img.data[j] = linearToSrgb(lin[i]);
    img.data[j + 1] = linearToSrgb(lin[i + 1]);
    img.data[j + 2] = linearToSrgb(lin[i + 2]);
    img.data[j + 3] = 255;
  }
  ctx.putImageData(img, 0, 0);

  const truth: SampleGroundTruth = {
    id: `s_${opts.tongueColor}_${opts.coating}_${opts.illuminant}_${opts.seed}`,
    illuminant: opts.illuminant,
    tongueColor: opts.tongueColor,
    coating: opts.coating,
    hasTeethMarks: opts.teethMarks,
    hasCracks: opts.cracks,
    seed: opts.seed,
  };
  return { canvas, truth };
}

function jitterPrototype(base: { L: number; a: number; b: number }, rng: Rng, sd: number): { L: number; a: number; b: number } {
  return {
    L: base.L + rng.gaussian(0, sd),
    a: base.a + rng.gaussian(0, sd * 0.8),
    b: base.b + rng.gaussian(0, sd * 0.8),
  };
}

function fillEllipse(
  lin: Float32Array,
  W: number,
  H: number,
  cx: number,
  cy: number,
  rx: number,
  ry: number,
  c: [number, number, number],
): void {
  const x0 = Math.max(0, Math.floor(cx - rx));
  const x1 = Math.min(W - 1, Math.ceil(cx + rx));
  const y0 = Math.max(0, Math.floor(cy - ry));
  const y1 = Math.min(H - 1, Math.ceil(cy + ry));
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      const e = ((x - cx) / rx) ** 2 + ((y - cy) / ry) ** 2;
      if (e <= 1) {
        const i = (y * W + x) * 3;
        lin[i] = c[0];
        lin[i + 1] = c[1];
        lin[i + 2] = c[2];
      }
    }
  }
}

function fillEllipseRing(
  lin: Float32Array,
  W: number,
  H: number,
  cx: number,
  cy: number,
  rxOut: number,
  ryOut: number,
  rxIn: number,
  ryIn: number,
  c: [number, number, number],
): void {
  const x0 = Math.max(0, Math.floor(cx - rxOut));
  const x1 = Math.min(W - 1, Math.ceil(cx + rxOut));
  const y0 = Math.max(0, Math.floor(cy - ryOut));
  const y1 = Math.min(H - 1, Math.ceil(cy + ryOut));
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      const eo = ((x - cx) / rxOut) ** 2 + ((y - cy) / ryOut) ** 2;
      const ei = ((x - cx) / rxIn) ** 2 + ((y - cy) / ryIn) ** 2;
      if (eo <= 1 && ei >= 1) {
        const i = (y * W + x) * 3;
        lin[i] = c[0];
        lin[i + 1] = c[1];
        lin[i + 2] = c[2];
      }
    }
  }
}

function fillRectLin(
  lin: Float32Array,
  W: number,
  H: number,
  x: number,
  y: number,
  w: number,
  h: number,
  c: [number, number, number],
): void {
  const x0 = Math.max(0, Math.floor(x));
  const y0 = Math.max(0, Math.floor(y));
  const x1 = Math.min(W - 1, Math.floor(x + w));
  const y1 = Math.min(H - 1, Math.floor(y + h));
  for (let yy = y0; yy <= y1; yy++) {
    for (let xx = x0; xx <= x1; xx++) {
      const i = (yy * W + xx) * 3;
      lin[i] = c[0];
      lin[i + 1] = c[1];
      lin[i + 2] = c[2];
    }
  }
}

/** 生成完整评测集：N 个虚拟病人 × 3 光源，舌色/苔型轮转覆盖全部类别 */
export function generateEvaluationSet(patientCount: number, size = 512): {
  canvas: HTMLCanvasElement;
  truth: SampleGroundTruth;
  patientIndex: number;
}[] {
  const colors: TongueColorClass[] = ['pale', 'lightRed', 'red', 'deepRed', 'purple'];
  const coats: CoatingClass[] = ['thinWhite', 'thickWhite', 'greasyYellow'];
  const ills: Illuminant[] = ['incandescent', 'fluorescent', 'daylight'];
  const out: { canvas: HTMLCanvasElement; truth: SampleGroundTruth; patientIndex: number }[] = [];
  let seed = 1000;
  for (let p = 0; p < patientCount; p++) {
    const tongueColor = colors[p % colors.length];
    const coating = coats[p % coats.length];
    const teeth = p % 2 === 0;
    const cracks = p % 3 !== 1;
    for (const ill of ills) {
      const s = generateSample({
        width: size,
        height: size,
        illuminant: ill,
        tongueColor,
        coating,
        teethMarks: teeth,
        cracks,
        seed: seed++,
      });
      out.push({ canvas: s.canvas, truth: s.truth, patientIndex: p });
    }
  }
  return out;
}
