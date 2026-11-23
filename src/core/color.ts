import type { Lab, RGB } from '../types';

// ---------- sRGB <-> 线性 RGB ----------

export function srgbToLinear(c: number): number {
  const v = c / 255;
  return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
}

export function linearToSrgb(c: number): number {
  const v = c <= 0.0031308 ? c * 12.92 : 1.055 * Math.pow(Math.max(0, c), 1 / 2.4) - 0.055;
  return Math.round(Math.min(255, Math.max(0, v * 255)));
}

/** sRGB(0~255) 三元组 -> 线性 RGB(0~1) */
export function rgbToLinear(rgb: RGB): [number, number, number] {
  return [srgbToLinear(rgb.r), srgbToLinear(rgb.g), srgbToLinear(rgb.b)];
}

// ---------- 线性 RGB <-> CIE XYZ（D65） ----------

// sRGB D65 转换矩阵
const M_RGB2XYZ = [
  0.4124564, 0.3575761, 0.1804375,
  0.2126729, 0.7151522, 0.072175,
  0.0193339, 0.119192, 0.9503041,
];
const M_XYZ2RGB = [
  3.2404542, -1.5371385, -0.4985314,
  -0.969266, 1.8760108, 0.041556,
  0.0556434, -0.2040259, 1.0572252,
];

function matVec(m: number[], x: number, y: number, z: number): [number, number, number] {
  return [
    m[0] * x + m[1] * y + m[2] * z,
    m[3] * x + m[4] * y + m[5] * z,
    m[6] * x + m[7] * y + m[8] * z,
  ];
}

export function linearRgbToXyz(r: number, g: number, b: number): [number, number, number] {
  return matVec(M_RGB2XYZ, r, g, b);
}

export function xyzToLinearRgb(x: number, y: number, z: number): [number, number, number] {
  return matVec(M_XYZ2RGB, x, y, z);
}

// D65 参考白点
const D65 = [0.95047, 1.0, 1.08883];

function labF(t: number): number {
  const d = 6 / 29;
  return t > d * d * d ? Math.cbrt(t) : t / (3 * d * d) + 4 / 29;
}

function labFInv(t: number): number {
  const d = 6 / 29;
  return t > d ? t * t * t : 3 * d * d * (t - 4 / 29);
}

export function xyzToLab(x: number, y: number, z: number): Lab {
  const fx = labF(x / D65[0]);
  const fy = labF(y / D65[1]);
  const fz = labF(z / D65[2]);
  return {
    L: 116 * fy - 16,
    a: 500 * (fx - fy),
    b: 200 * (fy - fz),
  };
}

export function labToXyz(L: number, a: number, b: number): [number, number, number] {
  const fy = (L + 16) / 116;
  const fx = a / 500 + fy;
  const fz = fy - b / 200;
  return [
    D65[0] * labFInv(fx),
    D65[1] * labFInv(fy),
    D65[2] * labFInv(fz),
  ];
}

/** sRGB(0~255) -> CIE Lab(D65) */
export function rgbToLab(rgb: RGB): Lab {
  const [r, g, b] = rgbToLinear(rgb);
  const [x, y, z] = linearRgbToXyz(r, g, b);
  return xyzToLab(x, y, z);
}

export function labToRgb(lab: Lab): RGB {
  const [x, y, z] = labToXyz(lab.L, lab.a, lab.b);
  const [r, g, b] = xyzToLinearRgb(x, y, z);
  return {
    r: linearToSrgb(r),
    g: linearToSrgb(g),
    b: linearToSrgb(b),
  };
}

/** CIE76 色差（Lab 欧氏距离），本系统分类阈值均在该度量下标定 */
export function deltaE(a: Lab, b: Lab): number {
  const dL = a.L - b.L;
  const da = a.a - b.a;
  const db = a.b - b.b;
  return Math.sqrt(dL * dL + da * da + db * db);
}

/** 两个 sRGB 颜色的 Lab 色差 */
export function rgbDeltaE(a: RGB, b: RGB): number {
  return deltaE(rgbToLab(a), rgbToLab(b));
}

/** Lab 空间加权平均（按权重） */
export function weightedMeanLab(samples: { lab: Lab; w: number }[]): Lab {
  let L = 0, a = 0, b = 0, sw = 0;
  for (const s of samples) {
    L += s.lab.L * s.w;
    a += s.lab.a * s.w;
    b += s.lab.b * s.w;
    sw += s.w;
  }
  if (sw === 0) return { L: 0, a: 0, b: 0 };
  return { L: L / sw, a: a / sw, b: b / sw };
}
