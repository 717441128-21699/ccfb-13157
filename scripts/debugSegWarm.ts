// 暖光深绛分割诊断
import { generateSample } from '../src/core/sampleGenerator';
import { GpuEngine } from '../src/gl/GpuEngine';

export async function debugSegWarm(): Promise<void> {
  const sample = generateSample({
    width: 512, height: 512, illuminant: 'incandescent', tongueColor: 'deepRed',
    coating: 'thinWhite', teethMarks: false, cracks: true, seed: 7009,
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
  // 中心椭圆内的像素，按 pTongue 分桶
  const buckets = { 'pT<0.1': 0, '0.1-0.3': 0, '0.3-0.45': 0, '>0.45': 0 };
  const lowPT: number[] = [];
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = y * w + x;
    const nx = x / w, ny = y / h;
    const e = ((nx - 0.5) / 0.34) ** 2 + ((ny - 0.55) / 0.38) ** 2;
    if (e > 1) continue;
    const pT = probBuf[i * 4];
    if (pT < 0.1) { buckets['pT<0.1']++; lowPT.push(i); }
    else if (pT < 0.3) buckets['0.1-0.3']++;
    else if (pT < 0.45) buckets['0.3-0.45']++;
    else buckets['>0.45']++;
  }
  console.log('pTongue buckets in ellipse:', JSON.stringify(buckets));
  // 低 pT 像素的 Lab 样本
  const sample2 = lowPT.filter((_, k) => k % 40 === 0).slice(0, 8).map((i) =>
    `L${labBuf[i * 4].toFixed(0)} a${labBuf[i * 4 + 1].toFixed(0)} b${labBuf[i * 4 + 2].toFixed(0)}`);
  console.log('low-pT Lab samples:', sample2.join(' | '));
}
