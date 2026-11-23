// 舌区分割与舌色统计调试
import { TongueAnalyzer } from '../src/core/analyzer';
import { generateSample } from '../src/core/sampleGenerator';
import { TONGUE_COLOR_PROTOTYPES } from '../src/core/references';
import { deltaE } from '../src/core/color';

export async function debugSegment(): Promise<void> {
  const sample = generateSample({
    width: 512,
    height: 512,
    illuminant: 'daylight',
    tongueColor: 'lightRed',
    coating: 'thinWhite',
    teethMarks: true,
    cracks: true,
    seed: 7001,
  });
  const bmp = await createImageBitmap(sample.canvas);
  const analyzer = new TongueAnalyzer(document.createElement('canvas'));
  const r = await analyzer.analyze(bmp, { maxEdge: 640, withOverlay: false });
  console.log('chart found:', r.chart.found, 'residual:', r.calibration?.residual);
  console.log('tongueAreaRatio:', r.tongueAreaRatio.toFixed(4), 'specularRatio:', r.specularRatio.toFixed(4), 'coatCoverage:', r.coatingCoverage.toFixed(4));
  console.log('bodyLab:', JSON.stringify(r.bodyLab), 'median sRGB:', JSON.stringify(r.bodyMedian));
  console.log('predicted tongue color:', r.tongueColor);
  for (const k of Object.keys(TONGUE_COLOR_PROTOTYPES) as (keyof typeof TONGUE_COLOR_PROTOTYPES)[]) {
    console.log(`  dist to ${k}:`, deltaE(r.bodyLab, TONGUE_COLOR_PROTOTYPES[k].lab).toFixed(2));
  }
  console.log('teeth marks:', r.teethMarks.length, 'cracks:', r.cracks.length);
  // 期望的淡红 Lab
  console.log('expected lightRed lab:', JSON.stringify(TONGUE_COLOR_PROTOTYPES.lightRed.lab));

  console.log('float supported:', analyzer.isFloat, 'GL:', analyzer.gl.getParameter(analyzer.gl.VERSION));

  // 独立走一遍最小 Lab 管线，检查每步输出
  const GpuEngineMod = await import('../src/gl/GpuEngine');
  const engine = new GpuEngineMod.GpuEngine(document.createElement('canvas'));
  const gl = engine.gl;
  const t = engine.uploadImage(bmp);
  const w = t.w;
  const h = t.h;
  console.log('src tex format/type:', t.format, t.type, 'size', w, h);
  // 先测试最简单的 passthrough 到单目标
  const single = engine.createTexture(w, h, 'rgba16f');
  engine.run(GpuEngineMod.GpuEngine.FS_PASSTHROUGH, [single], { uInput: t });
  console.log('after passthrough GL error:', gl.getError());
  const singleBuf = engine.readPixels(single) as Float32Array;
  const ci = (Math.floor(h / 2) * w + Math.floor(w / 2)) * 4;
  console.log('passthrough center encoded:', singleBuf[ci].toFixed(3), singleBuf[ci + 1].toFixed(3), singleBuf[ci + 2].toFixed(3));

  const prob = engine.createTexture(w, h, 'rgba16f');
  const lab = engine.createTexture(w, h, 'rgba16f');
  engine.run(GpuEngineMod.GpuEngine.FS_PROB, [prob, lab], {
    uInput: t, uCenter: [0.5, 0.55], uAxis: [0.34, 0.38],
  });
  console.log('after PROB GL error:', gl.getError());
  // 直接检查 FBO 上两个 attachment 的完整性
  console.log('drawBuffers param:', gl.getParameter(gl.DRAW_BUFFER0), gl.getParameter(gl.DRAW_BUFFER1));
  const probBuf = engine.readPixels(prob) as Float32Array;
  const labBuf = engine.readPixels(lab) as Float32Array;
  const idx = (Math.floor(h / 2) * w + Math.floor(w / 2)) * 4;
  console.log('PROB target0 at center:', probBuf[idx].toFixed(3), probBuf[idx + 1].toFixed(3), probBuf[idx + 2].toFixed(3), probBuf[idx + 3].toFixed(3));
  console.log('raw Lab at center:', labBuf[idx].toFixed(2), labBuf[idx + 1].toFixed(2), labBuf[idx + 2].toFixed(2), 'luma', labBuf[idx + 3].toFixed(3));
  // 用一个独立 passthrough 把 lab 复制到新纹理再回读，排除 FBO 残留
  const labCopy = engine.createTexture(w, h, 'rgba16f');
  engine.run(GpuEngineMod.GpuEngine.FS_PASSTHROUGH, [labCopy], { uInput: lab });
  const copyBuf = engine.readPixels(labCopy) as Float32Array;
  console.log('labCopy at center:', copyBuf[idx].toFixed(2), copyBuf[idx + 1].toFixed(2), copyBuf[idx + 2].toFixed(2), copyBuf[idx + 3].toFixed(3));
  let copyNonZero = 0;
  for (let i = 0; i < copyBuf.length; i += 4) if (copyBuf[i] !== 0) copyNonZero++;
  console.log('labCopy nonzero ratio:', copyNonZero / (w * h));
  engine.destroyTexture(labCopy);

  let nonzero = 0;
  let probNonZero = 0;
  for (let i = 0; i < labBuf.length; i += 4) {
    if (labBuf[i] !== 0) nonzero++;
    if (probBuf[i] !== 0 || probBuf[i + 1] !== 0) probNonZero++;
  }
  console.log('Lab nonzero ratio:', nonzero / (w * h), 'prob nonzero ratio:', probNonZero / (w * h));
  engine.destroyTexture(t);
  engine.destroyTexture(prob);
  engine.destroyTexture(lab);
  engine.destroyTexture(single);
}
