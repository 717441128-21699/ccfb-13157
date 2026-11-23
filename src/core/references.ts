import type { RGB, Illuminant, TongueColorClass, CoatingClass, Lab } from '../types';
import { rgbToLab, labToRgb } from './color';

/**
 * 参考色卡：取标准 24 色卡（X-Rite ColorChecker 风格）中的 18 个色块，
 * 6 列 x 3 行布局。参考值为 D65 下标准 sRGB 值。
 * 现场拍照时病人旁举此卡，检测后逐块采样做最小二乘校色。
 */
export interface ReferenceCard {
  rows: number;
  cols: number;
  patches: { row: number; col: number; ref: RGB; name: string }[];
}

export const COLOR_CARD: ReferenceCard = (() => {
  const defs: [string, RGB][] = [
    // 第 1 行：中性灰阶 + 肤色系
    ['darkSkin', { r: 115, g: 82, b: 68 }],
    ['lightSkin', { r: 241, g: 195, b: 164 }],
    ['blueSky', { r: 98, g: 122, b: 157 }],
    ['leafGreen', { r: 87, g: 108, b: 67 }],
    ['blueFlower', { r: 133, g: 128, b: 177 }],
    ['bluishGreen', { r: 103, g: 189, b: 170 }],
    // 第 2 行：高饱和原色
    ['orange', { r: 255, g: 138, b: 60 }],
    ['purplishBlue', { r: 80, g: 91, b: 166 }],
    ['moderateRed', { r: 193, g: 80, b: 89 }],
    ['purple', { r: 94, g: 60, b: 108 }],
    ['yellowGreen', { r: 157, g: 188, b: 64 }],
    ['orangeYellow', { r: 224, g: 160, b: 70 }],
    // 第 3 行：蓝/品红/黑 + 灰阶
    ['blue', { r: 56, g: 61, b: 150 }],
    ['green', { r: 70, g: 148, b: 73 }],
    ['red', { r: 175, g: 54, b: 60 }],
    ['yellow', { r: 231, g: 185, b: 50 }],
    ['magenta', { r: 187, g: 85, b: 150 }],
    ['white', { r: 243, g: 243, b: 242 }],
  ];
  const patches = defs.map(([name, ref], idx) => ({
    row: Math.floor(idx / 6),
    col: idx % 6,
    ref,
    name,
  }));
  return { rows: 3, cols: 6, patches };
})();

/**
 * 三种拍摄光源的粗略光谱响应（作用于线性 RGB 的对角增益）与加性环境光。
 * 数值依据典型光源色温的黑体/日光相对功率折换到 sRGB 三通道，
 * 用于合成样本生成，也用于无卡时的光源提示。
 */
export interface IlluminantSpec {
  id: Illuminant;
  label: string;
  cct: number; // 相关色温 K
  /** 通道增益（线性空间，归一化使 G≈1） */
  gain: [number, number, number];
  /** 环境散射光（线性 sRGB，暗电流+杂光） */
  ambient: [number, number, number];
  /** 相对曝光量（光源亮度差异） */
  exposure: number;
}

export const ILLUMINANTS: Record<Illuminant, IlluminantSpec> = {
  // 白炽灯 ~2700K：红强蓝弱，整体偏暖偏黄
  incandescent: {
    id: 'incandescent',
    label: '白炽灯',
    cct: 2700,
    gain: [1.28, 1.0, 0.55],
    ambient: [0.012, 0.008, 0.004],
    exposure: 0.92,
  },
  // 日光灯（荧光灯）~4500K：略带绿峰
  fluorescent: {
    id: 'fluorescent',
    label: '日光灯',
    cct: 4500,
    gain: [1.05, 1.0, 0.88],
    ambient: [0.01, 0.012, 0.01],
    exposure: 1.0,
  },
  // 阴天窗边 ~6500K：接近 D65，略冷
  daylight: {
    id: 'daylight',
    label: '阴天窗边',
    cct: 6500,
    gain: [0.95, 1.0, 1.12],
    ambient: [0.015, 0.016, 0.018],
    exposure: 1.08,
  },
};

/**
 * 中医舌色五类原型（校色后 D65 下的 Lab 基准）。
 * 依据《中医诊断学》常见舌色范围与临床色测量文献中的典型区间取中位值，
 * 并在合成数据上做过闭环校验。系统按最近邻 Lab 距离分类。
 */
export const TONGUE_COLOR_PROTOTYPES: Record<TongueColorClass, { label: string; lab: Lab }> = {
  // 淡白：亮度高、红度低
  pale: { label: '淡白', lab: { L: 71.5, a: 14.5, b: 12.5 } },
  // 淡红：平和的粉红
  lightRed: { label: '淡红', lab: { L: 62.0, a: 23.5, b: 15.5 } },
  // 红：红度明显升高、亮度略降
  red: { label: '红', lab: { L: 52.0, a: 35.0, b: 17.0 } },
  // 绛：深红，亮度低、红度高
  deepRed: { label: '绛', lab: { L: 41.0, a: 39.0, b: 16.0 } },
  // 紫：红中带蓝，b 偏低、a 仍高
  purple: { label: '紫', lab: { L: 44.0, a: 28.0, b: 6.5 } },
};

export const TONGUE_COLOR_ORDER: TongueColorClass[] = [
  'pale',
  'lightRed',
  'red',
  'deepRed',
  'purple',
];

/**
 * 舌苔三类原型（Lab）与覆盖率阈值。
 * 薄白：面积小、近白；厚白：面积大、白而浊；黄腻：面积大且 b 升高（黄）、亮度不均（腻）。
 */
export const COATING_PROTOTYPES: Record<CoatingClass, { label: string; lab: Lab }> = {
  thinWhite: { label: '薄白', lab: { L: 78.0, a: 8.0, b: 13.0 } },
  thickWhite: { label: '厚白', lab: { L: 80.0, a: 5.5, b: 10.5 } },
  greasyYellow: { label: '黄腻', lab: { L: 70.0, a: 9.0, b: 27.0 } },
};

export const COATING_ORDER: CoatingClass[] = ['thinWhite', 'thickWhite', 'greasyYellow'];

/** 舌苔覆盖率判定阈值（占舌体面积） */
export const COATING_COVERAGE_THRESHOLD = 0.3;

/** 舌苔粗糙度阈值（局部 L 标准差，超过判厚/腻） */
export const COATING_ROUGH_THRESHOLD = 3.2;

/** 黄苔 b 通道阈值（Lab b 高于此值判黄） */
export const COATING_YELLOW_B = 19.0;

/** 所有原型的 sRGB 形式（便于 UI 取色） */
export function prototypeRgb(lab: Lab): RGB {
  return labToRgb(lab);
}

export function tonguePrototypeLab(c: TongueColorClass): Lab {
  return TONGUE_COLOR_PROTOTYPES[c].lab;
}

export function coatingPrototypeLab(c: CoatingClass): Lab {
  return COATING_PROTOTYPES[c].lab;
}

/** 工具：把参考色块的 sRGB 预算成 Lab（常量预热） */
export function referenceLabs(): { name: string; lab: Lab; ref: RGB }[] {
  return COLOR_CARD.patches.map((p) => ({ name: p.name, ref: p.ref, lab: rgbToLab(p.ref) }));
}
