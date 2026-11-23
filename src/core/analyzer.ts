import type {
  AnalysisResult,
  Calibration,
  ChartDetection,
  Illuminant,
  RGB,
  Lab,
} from '../types';
import { GpuEngine, type GpuTexture } from '../gl/GpuEngine';
import {
  detectColorChart,
  makeThumbnail,
  solveCalibration,
  inferIlluminant,
} from './chartDetector';
import {
  connectedComponents,
  largestComponentMask,
  detectDents,
  medianLab,
  meanRgb,
  type Component,
} from './imaging';
import { classifyTongueColor, classifyCoating, toTeethMarks, toCracks } from './classify';
import { linearToSrgb } from './color';

export interface AnalyzeOptions {
  /** 处理长边上限（控制耗时），默认 768 */
  maxEdge?: number;
  illuminantHint?: Illuminant;
  /** 是否生成可视化 dataURL（评测时可关） */
  withOverlay?: boolean;
}

export class TongueAnalyzer {
  private engine: GpuEngine;

  constructor(canvas: HTMLCanvasElement) {
    this.engine = new GpuEngine(canvas);
  }

  get gl(): WebGL2RenderingContext {
    return this.engine.gl;
  }

  get isFloat(): boolean {
    return this.engine.supportsFloat;
  }

  async analyze(source: ImageBitmap | HTMLCanvasElement, opts: AnalyzeOptions = {}): Promise<AnalysisResult> {
    const t0 = performance.now();
    const maxEdge = opts.maxEdge ?? 768;
    const withOverlay = opts.withOverlay ?? true;

    // 1) 归一化处理尺寸
    const img = await normalizeSize(source, maxEdge);
    const w = img.width;
    const h = img.height;
    const E = this.engine;
    const allocs: GpuTexture[] = [];
    const track = <T extends GpuTexture>(t: T): T => {
      allocs.push(t);
      return t;
    };

    try {
      // 2) 色卡检测（CPU 缩略图）
      const thumb = makeThumbnail(img);
      const chart: ChartDetection = detectColorChart(thumb);
      const calibration: Calibration | null = chart.found ? solveCalibration(chart) : null;

      // 3) GPU 校色
      const srcTex = E.uploadImage(img);
      const calibrated = track(E.createTexture(w, h, 'rgba16f', 'srgb'));
      if (calibration) {
        E.run(GpuEngine.FS_CALIBRATE, [calibrated], {
          uInput: srcTex,
          uMatrix: calibration.matrix,
          uExposure: calibration.exposure,
        });
      } else {
        E.run(GpuEngine.FS_PASSTHROUGH, [calibrated], { uInput: srcTex });
      }

      // 4) 概率图（0~1）与 Lab（量程编码）拆成两遍单目标渲染，规避部分驱动 MRT location1 不写入
      const prob = track(E.createTexture(w, h, this.isFloat ? 'rgba16f' : 'rgba8', 'unit'));
      const labTex = track(E.createTexture(w, h, this.isFloat ? 'rgba16f' : 'rgba8', 'lab'));
      E.run(GpuEngine.FS_PROB, [prob], {
        uInput: calibrated,
        uCenter: [0.5, 0.55],
        uAxis: [0.34, 0.38],
        uTexel: [1 / w, 1 / h],
      });
      E.run(GpuEngine.FS_LAB, [labTex], { uInput: calibrated });

      // 5) 舌体掩码：阈值 -> 闭运算 -> 最大连通域（CPU）
      const tongueTex = track(E.createTexture(w, h, 'r8'));
      const workTex = track(E.createTexture(w, h, 'r8'));
      E.run(GpuEngine.FS_THRESHOLD, [tongueTex], { uInput: prob, uThreshold: 0.3, uChannel: 0 });
      morphClose(E, tongueTex, workTex, w, h, 3);
      let tongueCpu = E.readPixels(tongueTex) as Uint8Array;
      const largest = largestComponentMask(tongueCpu, w, h);
      tongueCpu = largest.mask;
      // 保存补全前的原始舌体组件，供齿痕检测（椭圆补全的边缘是人造的）
      const rawTongueComp: Component | null = largest.comp;

      // 分割回退：舌区占比异常小（正常约 0.28，失败时 <0.12）时，
      // 用中心椭圆先验补全被红度门限漏掉的暗舌面（荧光/暖光下的深绛）。
      const areaRatio0 = tongueCpu.reduce((s, v) => s + (v ? 255 : 0), 0) / (255 * w * h);
      let ellipseFilled = false;
      if (areaRatio0 < 0.12) {
        ellipseFilled = true;
        const cx = w * 0.5;
        const cy = h * 0.55;
        const rx = w * 0.27;
        const ry = h * 0.31;
        for (let y = 0; y < h; y++) {
          for (let x = 0; x < w; x++) {
            const e = ((x - cx) / rx) ** 2 + ((y - cy) / ry) ** 2;
            if (e <= 1) tongueCpu[y * w + x] = 255;
          }
        }
      }
      E.uploadMask(tongueTex, tongueCpu);
      const tongueComp: Component | null = largest.comp;

      // 6) 舌苔掩码：阈值 -> 与舌区相交 -> 开运算去散点
      const coatTex = track(E.createTexture(w, h, 'r8'));
      E.run(GpuEngine.FS_THRESHOLD, [coatTex], { uInput: prob, uThreshold: 0.4, uChannel: 1 });
      let coatCpu = E.readPixels(coatTex) as Uint8Array;
      for (let i = 0; i < w * h; i++) coatCpu[i] = tongueCpu[i] && coatCpu[i] ? 255 : 0;
      E.uploadMask(coatTex, coatCpu);
      morphOpen(E, coatTex, workTex, w, h, 1);
      coatCpu = E.readPixels(coatTex) as Uint8Array;
      for (let i = 0; i < w * h; i++) coatCpu[i] = tongueCpu[i] && coatCpu[i] ? 255 : 0;

      // 6b) 舌苔增强特征：粗糙度、黄度（供薄/厚/腻细分）
      const coatFeatTex = track(E.createTexture(w, h, this.isFloat ? 'rgba16f' : 'rgba8', 'unit'));
      E.run(GpuEngine.FS_COAT, [coatFeatTex], {
        uLab: labTex,
        uTongue: tongueTex,
        uTexel: [1 / w, 1 / h],
      });
      const coatFeat = E.readPixels(coatFeatTex) as Float32Array | Uint8Array;

      // 7) 反光掩码（舌区内）
      const specTex = track(E.createTexture(w, h, 'r8'));
      E.run(GpuEngine.FS_THRESHOLD, [specTex], { uInput: prob, uThreshold: 0.5, uChannel: 2 });
      let specCpu = E.readPixels(specTex) as Uint8Array;
      for (let i = 0; i < w * h; i++) specCpu[i] = tongueCpu[i] && specCpu[i] ? 255 : 0;
      E.uploadMask(specTex, specCpu);

      // 8) 打包掩码并做反光 Lab 修复（两次邻域扩散）
      const packed = track(E.createTexture(w, h, 'rgba8'));
      // 裂纹位先用 0：占位纹理复用 specTex 之外的 workTex（清空）
      const zeroTex = track(E.createTexture(w, h, 'r8'));
      const zeroData = new Uint8Array(w * h);
      E.uploadMask(zeroTex, zeroData);
      E.run(GpuEngine.FS_PACK, [packed], {
        uTongue: tongueTex,
        uCoat: coatTex,
        uSpec: specTex,
        uCrack: zeroTex,
      });
      const labFixed = track(E.createTexture(w, h, this.isFloat ? 'rgba16f' : 'rgba8', 'lab'));
      E.run(GpuEngine.FS_INPAINT, [labFixed], {
        uLab: labTex,
        uMask: packed,
        uTexel: [1 / w, 1 / h],
      });
      const labFixed2 = track(E.createTexture(w, h, this.isFloat ? 'rgba16f' : 'rgba8', 'lab'));
      E.run(GpuEngine.FS_INPAINT, [labFixed2], {
        uLab: labFixed,
        uMask: packed,
        uTexel: [1 / w, 1 / h],
      });

      // 9) 裂纹检测 + 闭运算连接断线（使用独立临时纹理，避免与舌/苔阶段的 workTex 状态耦合）
      const crackTex = track(E.createTexture(w, h, 'r8'));
      E.run(GpuEngine.FS_CRACK, [crackTex], {
        uLab: labFixed2,
        uMask: packed,
        uTexel: [1 / w, 1 / h],
      });
      const crackWork = track(E.createTexture(w, h, 'r8'));
      morphClose(E, crackTex, crackWork, w, h, 2);
      const crackCpu = E.readPixels(crackTex) as Uint8Array;

      // 10) 回读 Lab 与校色 sRGB 做统计
      const labBuf = E.readPixels(labFixed2);
      const calRgbBuf = E.readPixels(calibrated) as Uint8Array;
      // 软覆盖度：舌区内苔概率（prob G 通道）的连续平均，比硬掩码更鲁棒
      const probCpu = E.readPixels(prob) as Float32Array | Uint8Array;

      const tonguePixels: number[] = [];
      const bodyPixels: number[] = [];
      const coatPixels: number[] = [];
      let specCount = 0;
      let softCoatSum = 0;
      for (let i = 0; i < w * h; i++) {
        if (!tongueCpu[i]) continue;
        tonguePixels.push(i);
        const softCoat = this.isFloat
          ? (probCpu as Float32Array)[i * 4 + 1]
          : (probCpu as Uint8Array)[i * 4 + 1] / 255;
        softCoatSum += softCoat;
        if (specCpu[i]) specCount++;
        if (!coatCpu[i] && !specCpu[i]) bodyPixels.push(i);
        if (coatCpu[i] && !specCpu[i]) coatPixels.push(i);
      }

      const tongueArea = tonguePixels.length;
      const tongueAreaRatio = tongueArea / (w * h);
      const specularRatio = specCount / Math.max(1, tongueArea);
      // 软覆盖度为主（连续），硬掩码覆盖率作辅助
      const softCoverage = softCoatSum / Math.max(1, tongueArea);
      const hardCoverage = coatPixels.length / Math.max(1, tongueArea);
      const coatingCoverage = softCoverage * 0.7 + hardCoverage * 0.3;

      // 舌质核心像素：取红度 a* 最高的前 35% 像素。
      // 苔/反光/边缘会拉低整体红度，而舌色本质（尤其深绛）体现在最红的核心区，
      // 这样跨光源统计更稳定、不被苔覆盖比例干扰。
      const bodyA = bodyPixels.map((p) =>
        this.isFloat ? (labBuf as Float32Array)[p * 4 + 1] : ((labBuf as Uint8Array)[p * 4 + 1] / 255) * 120 - 60,
      );
      const order = bodyA.map((a, idx) => ({ a, idx })).sort((x, y) => y.a - x.a);
      const keepN = Math.max(1, Math.ceil(order.length * 0.35));
      const corePixels = order.slice(0, keepN).map((o) => bodyPixels[o.idx]);

      const bodyLabRaw = medianLab(corePixels, labBuf, this.isFloat);
      const bodyLab: Lab = { L: bodyLabRaw.L, a: bodyLabRaw.a, b: bodyLabRaw.b };
      const colorResult = classifyTongueColor(bodyLab);
      const bodyMedian = labToSrgbRgb(bodyLab);

      const coatLabRaw = medianLab(
        coatPixels.length ? coatPixels : bodyPixels.slice(0, Math.max(1, bodyPixels.length)),
        labBuf,
        this.isFloat,
      );
      const coatLab: Lab = { L: coatLabRaw.L, a: coatLabRaw.a, b: coatLabRaw.b };

      // 苔区粗糙度与黄度（来自 FS_COAT 归一化输出，G=roughness/20, B=(b*+20)/80）
      let roughSum = 0;
      let yellowSum = 0;
      const featPixels = coatPixels.length ? coatPixels : tonguePixels;
      for (const p of featPixels) {
        const i = p * 4;
        if (this.isFloat) {
          roughSum += (coatFeat as Float32Array)[i + 1] * 20;
          yellowSum += (coatFeat as Float32Array)[i + 2] * 80 - 20;
        } else {
          roughSum += ((coatFeat as Uint8Array)[i + 1] / 255) * 20;
          yellowSum += ((coatFeat as Uint8Array)[i + 2] / 255) * 80 - 20;
        }
      }
      const coatingRoughness = roughSum / Math.max(1, featPixels.length);
      const coatingYellowness = yellowSum / Math.max(1, featPixels.length);

      const coatResult = classifyCoating(coatingCoverage, coatLab, coatingRoughness, coatingYellowness);
      const coatingMean: RGB = meanRgb(
        coatPixels.length ? coatPixels : tonguePixels.slice(0, Math.max(1, tonguePixels.length)),
        calRgbBuf,
      );

      // 11) 齿痕、裂纹（齿痕在补全前的原始舌体组件上检测）
      const dents = rawTongueComp ? detectDents(rawTongueComp, w, h) : [];
      const teethMarks = toTeethMarks(dents, w, h);
      const crackComps = connectedComponents(crackCpu, w, h).filter((c) => c.pixels.length >= 8);
      const cracks = toCracks(crackComps, w, h);

      // 12) 可视化
      let overlayUrl: string | undefined;
      let maskUrl: string | undefined;
      let calibratedUrl: string | undefined;
      if (withOverlay) {
        calibratedUrl = textureToDataUrl(E, calibrated, w, h);
        maskUrl = buildMaskDataUrl(w, h, tongueCpu, coatCpu, specCpu, crackCpu);
        overlayUrl = buildOverlayDataUrl(calRgbBuf, w, h, tongueCpu, coatCpu, specCpu, crackCpu, teethMarks);
      }

      const elapsedMs = performance.now() - t0;
      E.destroyTexture(srcTex);

      return {
        version: 1,
        elapsedMs,
        imageWidth: w,
        imageHeight: h,
        illuminantHint:
        opts.illuminantHint ?? (inferIlluminant(calibration) || undefined),
        chart,
        calibration,
        tongueAreaRatio,
        specularRatio,
        tongueColor: colorResult.cls,
        tongueColorDistances: colorResult.distances,
        bodyMedian,
        bodyLab,
        coating: coatResult.cls,
        coatingCoverage,
        coatingRoughness,
        coatingYellowness,
        coatingMean,
        teethMarks,
        cracks,
        overlayUrl,
        calibratedUrl,
        maskUrl,
      };
    } finally {
      for (const t of allocs) E.destroyTexture(t);
    }
  }
}

// ---------------- 辅助 ----------------

async function normalizeSize(source: ImageBitmap | HTMLCanvasElement, maxEdge: number): Promise<ImageBitmap> {
  const w0 = source.width;
  const h0 = source.height;
  const longEdge = Math.max(w0, h0);
  if (longEdge <= maxEdge && source instanceof ImageBitmap) return source;
  const scale = Math.min(1, maxEdge / longEdge);
  const w = Math.round(w0 * scale);
  const h = Math.round(h0 * scale);
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  c.getContext('2d')!.drawImage(source, 0, 0, w, h);
  return createImageBitmap(c);
}

/** 可分离形态学乒乓：严格保证采样纹理与渲染目标不同，避免帧缓冲反馈环 */
function morphPass(E: GpuEngine, src: GpuTexture, tmp: GpuTexture, w: number, h: number, op: 0 | 1, radius: number): GpuTexture {
  // 水平：src -> tmp
  E.run(GpuEngine.FS_MORPH, [tmp], { uInput: src, uDir: [1 / w, 0], uRadius: radius, uOp: op });
  // 垂直：tmp -> src
  E.run(GpuEngine.FS_MORPH, [src], { uInput: tmp, uDir: [0, 1 / h], uRadius: radius, uOp: op });
  return src;
}

function morphClose(E: GpuEngine, src: GpuTexture, tmp: GpuTexture, w: number, h: number, radius: number): GpuTexture {
  // 膨胀：src -> tmp -> src
  E.run(GpuEngine.FS_MORPH, [tmp], { uInput: src, uDir: [1 / w, 0], uRadius: radius, uOp: 1 });
  E.run(GpuEngine.FS_MORPH, [src], { uInput: tmp, uDir: [0, 1 / h], uRadius: radius, uOp: 1 });
  // 腐蚀：src -> tmp -> src
  E.run(GpuEngine.FS_MORPH, [tmp], { uInput: src, uDir: [1 / w, 0], uRadius: radius, uOp: 0 });
  E.run(GpuEngine.FS_MORPH, [src], { uInput: tmp, uDir: [0, 1 / h], uRadius: radius, uOp: 0 });
  return src;
}

function morphOpen(E: GpuEngine, src: GpuTexture, tmp: GpuTexture, w: number, h: number, radius: number): GpuTexture {
  E.run(GpuEngine.FS_MORPH, [tmp], { uInput: src, uDir: [1 / w, 0], uRadius: radius, uOp: 0 });
  E.run(GpuEngine.FS_MORPH, [src], { uInput: tmp, uDir: [0, 1 / h], uRadius: radius, uOp: 0 });
  E.run(GpuEngine.FS_MORPH, [tmp], { uInput: src, uDir: [1 / w, 0], uRadius: radius, uOp: 1 });
  E.run(GpuEngine.FS_MORPH, [src], { uInput: tmp, uDir: [0, 1 / h], uRadius: radius, uOp: 1 });
  return src;
}

function labToSrgbRgb(lab: Lab): RGB {
  const d = 6 / 29;
  const fy = (lab.L + 16) / 116;
  const fx = lab.a / 500 + fy;
  const fz = fy - lab.b / 200;
  const finv = (t: number): number => (t > d ? t ** 3 : 3 * d * d * (t - 4 / 29));
  const X = 0.95047 * finv(fx);
  const Y = finv(fy);
  const Z = 1.08883 * finv(fz);
  const r = 3.2404542 * X - 1.5371385 * Y - 0.4985314 * Z;
  const g = -0.969266 * X + 1.8760108 * Y + 0.041556 * Z;
  const b = 0.0556434 * X - 0.2040259 * Y + 1.0572252 * Z;
  return { r: linearToSrgb(r), g: linearToSrgb(g), b: linearToSrgb(b) };
}

function textureToDataUrl(E: GpuEngine, tex: GpuTexture, w: number, h: number): string {
  const buf = E.readPixels(tex) as Uint8Array;
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const ctx = c.getContext('2d')!;
  const img = ctx.createImageData(w, h);
  img.data.set(buf.subarray(0, w * h * 4));
  ctx.putImageData(img, 0, 0);
  return c.toDataURL('image/png');
}

function buildMaskDataUrl(
  w: number,
  h: number,
  tongue: Uint8Array,
  coat: Uint8Array,
  spec: Uint8Array,
  crack: Uint8Array,
): string {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const ctx = c.getContext('2d')!;
  const img = ctx.createImageData(w, h);
  for (let i = 0; i < w * h; i++) {
    const j = i * 4;
    img.data[j] = tongue[i] ? 200 : 30;
    img.data[j + 1] = tongue[i] ? (coat[i] ? 220 : 60) : 30;
    img.data[j + 2] = tongue[i] ? (spec[i] ? 255 : 80) : 40;
    if (crack[i]) {
      img.data[j] = 255;
      img.data[j + 1] = 255;
      img.data[j + 2] = 0;
    }
    img.data[j + 3] = 255;
  }
  ctx.putImageData(img, 0, 0);
  return c.toDataURL('image/png');
}

function buildOverlayDataUrl(
  rgbBuf: Uint8Array,
  w: number,
  h: number,
  tongue: Uint8Array,
  coat: Uint8Array,
  spec: Uint8Array,
  crack: Uint8Array,
  teeth: { x: number; y: number; depth: number }[],
): string {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const ctx = c.getContext('2d')!;
  const img = ctx.createImageData(w, h);
  img.data.set(rgbBuf.subarray(0, w * h * 4));
  ctx.putImageData(img, 0, 0);

  const tint = (mask: Uint8Array, color: string, alpha: number): void => {
    ctx.fillStyle = color;
    ctx.globalAlpha = alpha;
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        if (mask[y * w + x]) ctx.fillRect(x, y, 1, 1);
      }
    }
    ctx.globalAlpha = 1;
  };
  tint(tongue, 'rgb(80,160,255)', 0.12);
  tint(coat, 'rgb(255,255,120)', 0.35);
  tint(spec, 'rgb(255,255,255)', 0.55);
  tint(crack, 'rgb(255,60,60)', 0.7);

  ctx.strokeStyle = 'rgb(255,140,0)';
  ctx.lineWidth = 2;
  for (const t of teeth) {
    ctx.beginPath();
    ctx.arc(t.x * w, t.y * h, 6 + t.depth * 14, 0, Math.PI * 2);
    ctx.stroke();
  }
  return c.toDataURL('image/png');
}
