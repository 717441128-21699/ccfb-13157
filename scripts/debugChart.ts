// 色卡检测与舌色统计调试（浏览器内运行）
import { generateSample } from '../src/core/sampleGenerator';
import { makeThumbnail, detectColorChart, solveCalibration } from '../src/core/chartDetector';
import { COLOR_CARD, ILLUMINANTS } from '../src/core/references';
import { connectedComponents } from '../src/core/imaging';
import { srgbToLinear } from '../src/core/color';

export async function debugCase(seed = 7000): Promise<void> {
  const sample = generateSample({
    width: 512,
    height: 512,
    illuminant: 'incandescent',
    tongueColor: 'lightRed',
    coating: 'thinWhite',
    teethMarks: true,
    cracks: true,
    seed,
  });
  const bmp = await createImageBitmap(sample.canvas);
  const thumb = makeThumbnail(bmp);
  const { data, width: w, height: h } = thumb.data;
  console.log('thumb size', w, h);

  const satMask = new Uint8Array(w * h);
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const i = (y * w + x) * 4;
      const r = data[i];
      const g = data[i + 1];
      const b = data[i + 2];
      const max = Math.max(r, g, b);
      const min = Math.min(r, g, b);
      const sat = max === 0 ? 0 : (max - min) / max;
      if (sat > 0.32 && max > 70 && max < 250) satMask[y * w + x] = 255;
    }
  }
  const comps = connectedComponents(satMask, w, h);
  console.log('sat components:', comps.length);
  console.log('areas JSON:', JSON.stringify(comps.slice(0, 25).map((c) => ({
    area: c.pixels.length,
    bbox: [c.minX, c.minY, c.maxX, c.maxY],
    cx: Math.round(c.cx),
    cy: Math.round(c.cy),
    aspect: Math.round(((c.maxX - c.minX) / Math.max(1, c.maxY - c.minY)) * 100) / 100,
  }))));
  console.log('thumb area fraction thresholds:', (w * h) * 0.0004, (w * h) * 0.06);

  const comps0 = connectedComponents(satMask, w, h);
  const roiBlobs = comps0.filter((c) => c.pixels.length >= w * h * 0.0006 && c.pixels.length <= w * h * 0.02 && c.cx < w * 0.46 && c.cy < h * 0.42);
  const bbox = roiBlobs.reduce((acc, c) => ({
    minX: Math.min(acc.minX, c.minX), maxX: Math.max(acc.maxX, c.maxX),
    minY: Math.min(acc.minY, c.minY), maxY: Math.max(acc.maxY, c.maxY),
  }), { minX: 9999, maxX: -1, minY: 9999, maxY: -1 });
  console.log('roi blob count:', roiBlobs.length, 'bbox:', JSON.stringify(bbox),
    'stepX~', (bbox.maxX - bbox.minX) / 5, 'stepY~', (bbox.maxY - bbox.minY) / 2);

  // 白色卡基掩码诊断
  const whiteMask = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = (y * w + x) * 4;
    const r = data[i], g = data[i + 1], b = data[i + 2];
    const mx = Math.max(r, g, b), mn = Math.min(r, g, b);
    const sat = mx === 0 ? 0 : (mx - mn) / mx;
    if (mn > 165 && sat < 0.16) whiteMask[y * w + x] = 255;
  }
  const whiteComps = connectedComponents(whiteMask, w, h);
  console.log('white comps:', whiteComps.length, JSON.stringify(whiteComps.slice(0, 6).map((c) => ({
    area: c.pixels.length, bbox: [c.minX, c.minY, c.maxX, c.maxY], cx: Math.round(c.cx), cy: Math.round(c.cy),
    aspect: Math.round((c.maxX - c.minX) / Math.max(1, c.maxY - c.minY) * 100) / 100,
    fill: Math.round(c.pixels.length / Math.max(1, (c.maxX - c.minX) * (c.maxY - c.minY)) * 100) / 100,
  }))));
  // 卡基区域实际像素颜色采样
  const px = (x: number, y: number): number[] => {
    const i = (Math.round(y) * w + Math.round(x)) * 4;
    return [data[i], data[i + 1], data[i + 2]];
  };
  console.log('card base pixel samples:', JSON.stringify([px(14, 14), px(60, 14), px(110, 14), px(14, 70), px(110, 70)]));
  // 亮度卡基诊断（与检测器同判据）
  let lumaSum = 0;
  const luma = new Float32Array(w * h);
  for (let i = 0, p = 0; i < w * h; i++, p += 4) {
    luma[i] = 0.2126 * data[p] + 0.7152 * data[p + 1] + 0.0722 * data[p + 2];
    lumaSum += luma[i];
  }
  const lumaMean = lumaSum / (w * h);
  const baseMask2 = new Uint8Array(w * h);
  for (let i = 0, p = 0; i < w * h; i++, p += 4) {
    const minCh = Math.min(data[p], data[p + 1], data[p + 2]);
    if (luma[i] > lumaMean * 1.25 && minCh > 120) baseMask2[i] = 255;
  }
  const baseComps = connectedComponents(baseMask2, w, h);
  console.log('lumaMean:', lumaMean.toFixed(1), 'base comps:', baseComps.length, JSON.stringify(baseComps.slice(0, 6).map((c) => ({
    area: c.pixels.length, bbox: [c.minX, c.minY, c.maxX, c.maxY], cx: Math.round(c.cx), cy: Math.round(c.cy),
    aspect: Math.round((c.maxX - c.minX) / Math.max(1, c.maxY - c.minY) * 100) / 100,
    fill: Math.round(c.pixels.length / Math.max(1, (c.maxX - c.minX) * (c.maxY - c.minY)) * 100) / 100,
  }))));
  console.log('expected card geometry: cardW=', 512 * 0.3, 'at thumb scale', 512 * 0.3 * (320 / 512));
  const chart = detectColorChart(thumb);
  console.log('chart found:', chart.found, 'confidence:', chart.confidence);
  if (chart.patches) {
    const valid = chart.patches.filter((p) => p.measured);
    console.log('valid patches:', valid.length, '/', COLOR_CARD.patches.length);
    for (const p of chart.patches.slice(0, 8)) {
      console.log(
        `cell r${p.row}c${p.col} ref=`, JSON.stringify(p.ref),
        'measured=', p.measured ? JSON.stringify({ r: Math.round(p.measured.r * 255), g: Math.round(p.measured.g * 255), b: Math.round(p.measured.b * 255) }) : null,
      );
    }
  }
  const cal = solveCalibration(chart);
  console.log('calibration:', cal ? JSON.stringify({ exposure: cal.exposure, residual: cal.residual, estCCT: cal.estCCT, matrix: cal.matrix.map((x) => Number(x.toFixed(3))) }) : null);
  void ILLUMINANTS;
  void srgbToLinear;
}
