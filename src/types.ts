// 全局共享类型定义

/** 舌色五分类（中医舌诊常用类别） */
export type TongueColorClass = 'pale' | 'lightRed' | 'red' | 'deepRed' | 'purple';
/** pale=淡白 lightRed=淡红 red=红 deepRed=绛(深红) purple=紫 */

/** 舌苔分类 */
export type CoatingClass = 'thinWhite' | 'thickWhite' | 'greasyYellow';
/** thinWhite=薄白 thickWhite=厚白 greasyYellow=黄腻 */

/** 拍摄光源类型（用于合成样本与元数据） */
export type Illuminant = 'incandescent' | 'fluorescent' | 'daylight';
/** incandescent=白炽灯 fluorescent=日光灯 daylight=阴天/窗边自然光 */

export interface RGB {
  r: number;
  g: number;
  b: number;
}

export interface Lab {
  L: number;
  a: number;
  b: number;
}

/** 色卡单个色块（sRGB 0~255 参考值 + 网格位置） */
export interface ColorPatch {
  row: number;
  col: number;
  ref: RGB;
  /** 检测到的图像内坐标（归一化 0~1） */
  nx?: number;
  ny?: number;
  /** 检测到的图像内采样均值（原始未校色 sRGB 0~1） */
  measured?: RGB;
}

/** 色卡检测结果 */
export interface ChartDetection {
  found: boolean;
  /** 四角归一化坐标：左上、右上、右下、左下 */
  corners?: { x: number; y: number }[];
  patches?: ColorPatch[];
  /** 置信度 0~1 */
  confidence: number;
}

/** 3x3 线性校色矩阵（作用于线性 RGB），外加曝光增益 */
export interface Calibration {
  matrix: number[]; // 长度 9，行主序
  exposure: number; // 标量增益
  /** 校色残差（线性空间 RMSE，0~1 量纲），越小越好 */
  residual: number;
  /** 估计出的光源色温（开尔文，粗略） */
  estCCT: number;
  /** 由白块颜色直接判定的光源类型 */
  illuminant: Illuminant;
}

/** 齿痕标注 */
export interface TeethMark {
  x: number; // 归一化坐标
  y: number;
  depth: number; // 0~1 相对凹陷深度
}

/** 裂纹标注 */
export interface Crack {
  x: number;
  y: number;
  length: number; // 像素
  angleDeg: number;
}

/** 单张舌象分析结果（可留档） */
export interface AnalysisResult {
  version: number;
  /** 处理耗时（毫秒） */
  elapsedMs: number;
  imageWidth: number;
  imageHeight: number;
  illuminantHint?: Illuminant;

  chart: ChartDetection;
  calibration: Calibration | null;

  /** 舌体占整图面积比例 */
  tongueAreaRatio: number;
  /** 反光（津液高光）占舌面比例 */
  specularRatio: number;

  tongueColor: TongueColorClass;
  /** 与五个类别的 Lab 距离（越近置信越高） */
  tongueColorDistances: Record<TongueColorClass, number>;
  /** 舌质中位颜色（校色后 sRGB 0~255） */
  bodyMedian: RGB;
  bodyLab: Lab;

  coating: CoatingClass;
  /** 舌苔覆盖率 0~1 */
  coatingCoverage: number;
  /** 苔区粗糙度（局部 L 标准差，厚/腻苔更高） */
  coatingRoughness: number;
  /** 苔区平均黄度 b* */
  coatingYellowness: number;
  coatingMean: RGB;

  teethMarks: TeethMark[];
  cracks: Crack[];

  /** 各阶段可视化叠加图（dataURL，PNG） */
  overlayUrl?: string;
  calibratedUrl?: string;
  maskUrl?: string;
}

/** 病人档案 */
export interface Patient {
  id: string;
  name: string;
  gender: '男' | '女' | '';
  age: number | '';
  note: string;
  createdAt: number;
}

/** 随访/检查记录 */
export interface ExamRecord {
  id: string;
  patientId: string;
  createdAt: number;
  imageName: string;
  illuminant: Illuminant | '';
  result: AnalysisResult;
  followUpNote: string;
}

/** 合成样本的真值 */
export interface SampleGroundTruth {
  id: string;
  illuminant: Illuminant;
  tongueColor: TongueColorClass;
  coating: CoatingClass;
  hasTeethMarks: boolean;
  hasCracks: boolean;
  seed: number;
}
