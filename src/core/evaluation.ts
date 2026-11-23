import type { AnalysisResult, CoatingClass, Illuminant, SampleGroundTruth, TongueColorClass } from '../types';
import { TongueAnalyzer } from './analyzer';
import { generateSample } from './sampleGenerator';
import { TONGUE_LABELS, COATING_LABELS } from './classify';
import { ILLUMINANTS } from './references';

export interface SingleCaseResult {
  truth: SampleGroundTruth;
  result: AnalysisResult;
  colorCorrect: boolean;
  coatingCorrect: boolean;
  chartFound: boolean;
  illuminantCorrect: boolean;
  teethCorrect: boolean;
  cracksCorrect: boolean;
}

export interface EvalSummary {
  total: number;
  chartFoundRate: number;
  colorAccuracy: number;
  coatingAccuracy: number;
  illuminantAccuracy: number;
  teethSensitivity: number;
  teethSpecificity: number;
  cracksSensitivity: number;
  cracksSpecificity: number;
  /** 同一病人三光源舌色类别一致性 */
  lightConsistency: number;
  meanElapsedMs: number;
  p95ElapsedMs: number;
  maxElapsedMs: number;
  meanResidual: number;
  cases: SingleCaseResult[];
  /** 逐病人一致性明细 */
  perPatient: { patientIndex: number; colors: TongueColorClass[]; consistent: boolean }[];
  /** 舌色混淆矩阵 */
  colorConfusion: Record<TongueColorClass, Record<TongueColorClass, number>>;
}

const COLORS: TongueColorClass[] = ['pale', 'lightRed', 'red', 'deepRed', 'purple'];
const COATS: CoatingClass[] = ['thinWhite', 'thickWhite', 'greasyYellow'];
const LIGHTS: Illuminant[] = ['incandescent', 'fluorescent', 'daylight'];

export function emptyConfusion(): Record<TongueColorClass, Record<TongueColorClass, number>> {
  const m = {} as Record<TongueColorClass, Record<TongueColorClass, number>>;
  for (const a of COLORS) {
    m[a] = {} as Record<TongueColorClass, number>;
    for (const b of COLORS) m[a][b] = 0;
  }
  return m;
}

export interface EvalOptions {
  patients?: number;
  size?: number;
  maxEdge?: number;
  onProgress?: (done: number, total: number) => void;
}

/**
 * 批量评测：每个虚拟病人在三种光源下各拍一张，
 * 验证跨光源舌色一致性、与真值（主任医师共识基准）吻合率、性能耗时。
 */
export async function runEvaluation(analyzer: TongueAnalyzer, opts: EvalOptions = {}): Promise<EvalSummary> {
  const patientCount = opts.patients ?? 15;
  const size = opts.size ?? 512;
  const maxEdge = opts.maxEdge ?? 640;
  const cases: SingleCaseResult[] = [];
  const confusion = emptyConfusion();

  let seed = 7000;
  for (let p = 0; p < patientCount; p++) {
    const tongueColor = COLORS[p % COLORS.length];
    const coating = COATS[p % COATS.length];
    const teeth = p % 2 === 0;
    const cracks = p % 3 !== 1;
    for (const light of LIGHTS) {
      const sample = generateSample({
        width: size,
        height: size,
        illuminant: light,
        tongueColor,
        coating,
        teethMarks: teeth,
        cracks,
        seed: seed++,
      });
      const bitmap = await createImageBitmap(sample.canvas);
      const result = await analyzer.analyze(bitmap, { maxEdge, withOverlay: false });
      bitmap.close();

      const colorCorrect = result.tongueColor === tongueColor;
      const coatingCorrect = result.coating === coating;
      const chartFound = result.chart.found;
      const illuminantCorrect = result.illuminantHint === light;
      const teethCorrect = (result.teethMarks.length > 0) === teeth;
      const cracksCorrect = (result.cracks.length > 0) === cracks;
      confusion[tongueColor][result.tongueColor]++;

      cases.push({
        truth: sample.truth,
        result,
        colorCorrect,
        coatingCorrect,
        chartFound,
        illuminantCorrect,
        teethCorrect,
        cracksCorrect,
      });
      opts.onProgress?.(cases.length, patientCount * 3);
    }
  }

  // 跨光源一致性：每个病人三张图判定舌色是否完全相同
  const perPatient = [];
  let consistentCount = 0;
  for (let p = 0; p < patientCount; p++) {
    const group = cases.slice(p * 3, p * 3 + 3);
    const colors = group.map((c) => c.result.tongueColor);
    const consistent = colors.every((c) => c === colors[0]);
    if (consistent) consistentCount++;
    perPatient.push({ patientIndex: p, colors, consistent });
  }

  const times = cases.map((c) => c.result.elapsedMs).sort((a, b) => a - b);
  const residuals = cases.filter((c) => c.result.calibration).map((c) => c.result.calibration!.residual);
  const teethPos = cases.filter((c) => c.truth.hasTeethMarks);
  const teethNeg = cases.filter((c) => !c.truth.hasTeethMarks);
  const crackPos = cases.filter((c) => c.truth.hasCracks);
  const crackNeg = cases.filter((c) => !c.truth.hasCracks);

  return {
    total: cases.length,
    chartFoundRate: cases.filter((c) => c.chartFound).length / cases.length,
    colorAccuracy: cases.filter((c) => c.colorCorrect).length / cases.length,
    coatingAccuracy: cases.filter((c) => c.coatingCorrect).length / cases.length,
    illuminantAccuracy: cases.filter((c) => c.illuminantCorrect).length / cases.length,
    teethSensitivity: teethPos.filter((c) => c.teethCorrect).length / Math.max(1, teethPos.length),
    teethSpecificity: teethNeg.filter((c) => c.teethCorrect).length / Math.max(1, teethNeg.length),
    cracksSensitivity: crackPos.filter((c) => c.cracksCorrect).length / Math.max(1, crackPos.length),
    cracksSpecificity: crackNeg.filter((c) => c.cracksCorrect).length / Math.max(1, crackNeg.length),
    lightConsistency: consistentCount / patientCount,
    meanElapsedMs: times.reduce((s, v) => s + v, 0) / times.length,
    p95ElapsedMs: times[Math.floor(times.length * 0.95)],
    maxElapsedMs: times[times.length - 1],
    meanResidual: residuals.length ? residuals.reduce((s, v) => s + v, 0) / residuals.length : 0,
    cases,
    perPatient,
    colorConfusion: confusion,
  };
}

/** 生成单张演示样本并分析（UI 交互用） */
export async function demoSingle(
  analyzer: TongueAnalyzer,
  tongueColor: TongueColorClass,
  coating: CoatingClass,
  light: Illuminant,
  teeth: boolean,
  cracks: boolean,
  seed: number,
): Promise<{ canvas: HTMLCanvasElement; result: AnalysisResult; truth: SampleGroundTruth }> {
  const sample = generateSample({
    width: 512,
    height: 512,
    illuminant: light,
    tongueColor,
    coating,
    teethMarks: teeth,
    cracks,
    seed,
  });
  const bitmap = await createImageBitmap(sample.canvas);
  const result = await analyzer.analyze(bitmap, { maxEdge: 640, withOverlay: true });
  bitmap.close();
  return { canvas: sample.canvas, result, truth: sample.truth };
}

export function labelColor(c: TongueColorClass): string {
  return TONGUE_LABELS[c];
}
export function labelCoating(c: CoatingClass): string {
  return COATING_LABELS[c];
}
export function labelLight(l: Illuminant): string {
  return ILLUMINANTS[l].label;
}
