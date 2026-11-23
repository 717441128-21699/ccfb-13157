// 单个漏检案例深度诊断
import { generateSample } from '../src/core/sampleGenerator';
import { makeThumbnail, detectColorChart, solveCalibration } from '../src/core/chartDetector';
import { connectedComponents } from '../src/core/imaging';
import { rgbDeltaE } from '../src/core/color';

export async function debugOneMiss(): Promise<void> {
  // 对应 deepRed daylight thinWhite 漏检
  const sample = generateSample({
    width: 512, height: 512, illuminant: 'daylight', tongueColor: 'deepRed',
    coating: 'thinWhite', teethMarks: false, cracks: true, seed: 7011,
  });
  const bmp = await createImageBitmap(sample.canvas);
  const thumb = makeThumbnail(bmp);
  const { data, width: w, height: h } = thumb.data;
  // 复现卡基检测
  let lumaSum = 0;
  const luma = new Float32Array(w * h);
  for (let i = 0, p = 0; i < w * h; i++, p += 4) {
    luma[i] = 0.2126 * data[p] + 0.7152 * data[p + 1] + 0.0722 * data[p + 2];
    lumaSum += luma[i];
  }
  const lumaMean = lumaSum / (w * h);
  const mask = new Uint8Array(w * h);
  for (let i = 0, p = 0; i < w * h; i++, p += 4) {
    const minCh = Math.min(data[p], data[p + 1], data[p + 2]);
    if (luma[i] > lumaMean * 1.25 && minCh > 120) mask[i] = 255;
  }
  const comps = connectedComponents(mask, w, h);
  console.log('lumaMean', lumaMean.toFixed(0), 'all comps in ROI:');
  for (const c of comps.filter((c) => c.cx < w * 0.4 && c.cy < h * 0.38).slice(0, 4)) {
    const bw = c.maxX - c.minX, bh = c.maxY - c.minY;
    console.log('  bbox', JSON.stringify([c.minX, c.minY, c.maxX, c.maxY]), 'aspect', (bw / bh).toFixed(2), 'fill', (c.pixels.length / (bw * bh)).toFixed(2), 'n', c.pixels.length);
  }
  const chart = detectColorChart(thumb);
  console.log('found:', chart.found, 'confidence:', chart.confidence);
  if (chart.patches) {
    let total = 0;
    for (const p of chart.patches) {
      if (!p.measured) continue;
      const de = rgbDeltaE({ r: p.measured.r * 255, g: p.measured.g * 255, b: p.measured.b * 255 }, p.ref);
      total += de;
      console.log(`r${p.row}c${p.col} dE=${de.toFixed(1)}`,
        'measured=', JSON.stringify({ r: Math.round(p.measured.r * 255), g: Math.round(p.measured.g * 255), b: Math.round(p.measured.b * 255) }),
        'ref=', JSON.stringify(p.ref));
    }
    console.log('mean dE:', (total / chart.patches.length).toFixed(2));
  }
  const cal = solveCalibration({ ...chart, found: true });
  console.log('residual:', cal?.residual, 'cct:', cal?.estCCT);

  // 手工用 bbox 计算期望网格点并对比检测到的 patches
  const bx0 = 8, by0 = 11, bx1 = 114, by1 = 73;
  const gw = (bx1 - bx0) * 0.9, gh = (by1 - by0) * 0.86;
  const gx0 = (bx0 + bx1) / 2 - gw / 2;
  const gy0 = (by0 + by1) / 2 - gh / 2;
  const cw = gw / 6, ch = gh / 3;
  console.log('manual first cell center (r0c0):', (gx0 + cw / 2).toFixed(1), (gy0 + ch / 2).toFixed(1));
  console.log('detected r0c0 pos:', chart.patches?.[0].nx && (chart.patches[0].nx! * w).toFixed(1), chart.patches?.[0].ny && (chart.patches[0].ny! * h).toFixed(1));
  // 采样手工中心点的实际颜色
  const idx = (y: number, x: number) => (Math.round(y) * w + Math.round(x)) * 4;
  const mx = gx0 + cw / 2, my = gy0 + ch / 2;
  const pi = idx(my, mx);
  console.log('manual r0c0 pixel RGB:', data[pi], data[pi + 1], data[pi + 2], 'expect darkSkin 115,82,68');
}
