// 舌苔掩码专项调试
import { TongueAnalyzer } from '../src/core/analyzer';
import { generateSample } from '../src/core/sampleGenerator';
import { GpuEngine } from '../src/gl/GpuEngine';

export async function debugCoat(): Promise<void> {
  const sample = generateSample({
    width: 512,
    height: 512,
    illuminant: 'incandescent',
    tongueColor: 'deepRed',
    coating: 'thinWhite',
    teethMarks: false,
    cracks: true,
    seed: 7009,
  });
  const bmp = await createImageBitmap(sample.canvas);
  const analyzer = new TongueAnalyzer(document.createElement('canvas'));
  const E = analyzer.gl;
  void E;

  // 手动复现掩码管线，检查每步
  const engine = new GpuEngine(document.createElement('canvas'));
  const src = engine.uploadImage(bmp);
  const w = src.w;
  const h = src.h;
  const calibrated = engine.createTexture(w, h, 'rgba16f');
  engine.run(GpuEngine.FS_PASSTHROUGH, [calibrated], { uInput: src });
  const prob = engine.createTexture(w, h, 'rgba16f');
  engine.run(GpuEngine.FS_PROB, [prob], { uInput: calibrated, uCenter: [0.5, 0.55], uAxis: [0.34, 0.38] });
  const probBuf = engine.readPixels(prob) as Float32Array;
  // 直接检查编码前的原始字节：用 RGBA8 中转纹理
  const probe8 = engine.createTexture(w, h, 'rgba8');
  engine.run(GpuEngine.FS_PASSTHROUGH, [probe8], { uInput: prob });
  const gl = engine.gl;
  engine.readPixels; // 触发绑定
  const raw = new Uint8Array(w * h * 4);
  // 手动绑定 probe8 回读
  {
    const fb = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, probe8.tex, 0);
    gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, raw);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  }
  let tonguePx = 0;
  let coatPxRaw = 0;
  const coatRawVals: number[] = [];
  for (let i = 0; i < w * h; i++) {
    const pT = raw[i * 4] / 255;
    const pC = raw[i * 4 + 1] / 255;
    if (pT > 0.45) {
      tonguePx++;
      if (pC > 0.4) coatPxRaw++;
      coatRawVals.push(pC);
    }
  }
  coatRawVals.sort((a, b) => a - b);
  console.log('RAW tongue px:', tonguePx, 'raw coat px(>0.4):', coatPxRaw);
  // 测量 Lab 纹理在舌区各位置的实际值，定位舌苔的 Lab 区间
  const labTex = engine.createTexture(w, h, 'rgba16f');
  engine.run(GpuEngine.FS_LAB, [labTex], { uInput: calibrated });
  const lab8 = engine.createTexture(w, h, 'rgba8');
  engine.run(GpuEngine.FS_PASSTHROUGH, [lab8], { uInput: labTex });
  const labRaw = new Uint8Array(w * h * 4);
  {
    const fb = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, lab8.tex, 0);
    gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, labRaw);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  }
  // 在舌区内按亮度分桶统计 Lab
  const buckets: Record<string, { n: number; L: number; a: number; b: number }> = {};
  for (let i = 0; i < w * h; i++) {
    const pT = raw[i * 4] / 255;
    if (pT < 0.5) continue;
    const L = labRaw[i * 4] / 255 * 100;
    const a = labRaw[i * 4 + 1] / 255 * 120 - 60;
    const b = labRaw[i * 4 + 2] / 255 * 120 - 60;
    const key = L > 66 ? 'L>66' : L > 58 ? '58<L<=66' : L > 50 ? '50<L<=58' : 'L<=50';
    buckets[key] ??= { n: 0, L: 0, a: 0, b: 0 };
    const bk = buckets[key];
    bk.n++;
    bk.L += L;
    bk.a += a;
    bk.b += b;
  }
  for (const [k, v] of Object.entries(buckets)) {
    console.log(k, 'n=', v.n, 'meanLab=', (v.L / v.n).toFixed(1), (v.a / v.n).toFixed(1), (v.b / v.n).toFixed(1));
  }

  // 统计舌区内各通道概率分布
  let tongueHi = 0;
  let coatHi = 0;
  let specHi = 0;
  let total = 0;
  const coatSamples: number[] = [];
  for (let i = 0; i < w * h; i++) {
    const pT = probBuf[i * 4];
    const pC = probBuf[i * 4 + 1];
    const pS = probBuf[i * 4 + 2];
    if (pT > 0.45) {
      total++;
      if (pC > 0.5) coatHi++;
      if (pS > 0.5) specHi++;
      if (pT > 0.7) tongueHi++;
      coatSamples.push(pC);
    }
  }
  coatSamples.sort((a, b) => a - b);
  console.log('tongue px:', total, 'tongueHi(>0.7):', tongueHi);
  console.log('coat px (>0.5):', coatHi, 'spec px:', specHi);
  console.log('coat prob quantiles:', JSON.stringify({
    min: coatSamples[0]?.toFixed(3),
    p25: coatSamples[Math.floor(coatSamples.length * 0.25)]?.toFixed(3),
    median: coatSamples[Math.floor(coatSamples.length * 0.5)]?.toFixed(3),
    p75: coatSamples[Math.floor(coatSamples.length * 0.75)]?.toFixed(3),
    max: coatSamples[coatSamples.length - 1]?.toFixed(3),
  }));

  const r = await analyzer.analyze(bmp, { maxEdge: 640, withOverlay: false });
  console.log('FINAL coatCoverage:', r.coatingCoverage, 'coating:', r.coating);
  console.log('FINAL teeth:', r.teethMarks.length, 'cracks:', r.cracks.length);
}
