// 厚白苔 Lab 分区诊断
import { generateSample } from '../src/core/sampleGenerator';
import { TongueAnalyzer } from '../src/core/analyzer';
import { GpuEngine } from '../src/gl/GpuEngine';

export async function debugThick(): Promise<void> {
  const sample = generateSample({
    width: 512, height: 512, illuminant: 'daylight', tongueColor: 'red',
    coating: 'thickWhite', teethMarks: false, cracks: false, seed: 7021,
  });
  const bmp = await createImageBitmap(sample.canvas);

  const engine = new GpuEngine(document.createElement('canvas'));
  const src = engine.uploadImage(bmp);
  const w = src.w, h = src.h;
  const cal = engine.createTexture(w, h, 'rgba16f', 'srgb');
  engine.run(GpuEngine.FS_PASSTHROUGH, [cal], { uInput: src });
  const lab = engine.createTexture(w, h, 'rgba16f', 'lab');
  engine.run(GpuEngine.FS_LAB, [lab], { uInput: cal });
  const prob = engine.createTexture(w, h, 'rgba16f', 'unit');
  engine.run(GpuEngine.FS_PROB, [prob], { uInput: cal, uCenter: [0.5, 0.55], uAxis: [0.34, 0.38], uTexel: [1 / w, 1 / h] });
  const labBuf = engine.readPixels(lab) as Float32Array;
  const probBuf = engine.readPixels(prob) as Float32Array;
  let n = 0;
  const sum = { pT: 0, pC: 0, L: 0, a: 0 };
  let highLall = 0;
  let highLpT = 0;
  for (let i = 0; i < w * h; i++) {
    const L = labBuf[i * 4];
    const pT = probBuf[i * 4];
    if (L > 58) {
      highLall++;
      if (pT > 0.2) highLpT++;
    }
    if (L > 58 && pT > 0.2) {
      n++;
      sum.pT += pT;
      sum.pC += probBuf[i * 4 + 1];
      sum.L += L;
      sum.a += labBuf[i * 4 + 1];
    }
  }
  console.log('all high-L(>58) px:', highLall, 'of which pTongue>0.2:', highLpT);
  console.log('high-L tongue-like px:', n, n ? { pT: (sum.pT / n).toFixed(3), pC: (sum.pC / n).toFixed(3), L: (sum.L / n).toFixed(1), a: (sum.a / n).toFixed(1) } : null);

  const analyzer = new TongueAnalyzer(document.createElement('canvas'));
  const r = await analyzer.analyze(bmp, { maxEdge: 640, withOverlay: false });
  console.log('coverage', r.coatingCoverage.toFixed(3), 'roughness', r.coatingRoughness.toFixed(2), 'yellow', r.coatingYellowness.toFixed(2));
  console.log('bodyLab', JSON.stringify(r.bodyLab));
}
