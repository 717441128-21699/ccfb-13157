// 色卡漏检诊断：遍历全部光源/舌色组合，报告白卡基组件候选
import { generateSample } from '../src/core/sampleGenerator';
import { makeThumbnail } from '../src/core/chartDetector';
import { connectedComponents } from '../src/core/imaging';

export async function debugChartMisses(): Promise<void> {
  const ills = ['incandescent', 'fluorescent', 'daylight'] as const;
  const colors = ['pale', 'lightRed', 'red', 'deepRed', 'purple'] as const;
  let seed = 7000;
  for (const color of colors) {
    for (const ill of ills) {
      const sample = generateSample({
        width: 512, height: 512, illuminant: ill, tongueColor: color,
        coating: 'thickWhite', teethMarks: true, cracks: false, seed: seed++,
      });
      const bmp = await createImageBitmap(sample.canvas);
      const thumb = makeThumbnail(bmp);
      const { data, width: w, height: h } = thumb.data;
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
      const comps = connectedComponents(mask, w, h).filter((c) => c.cx < w * 0.4 && c.cy < h * 0.38);
      const info = comps.slice(0, 3).map((c) => {
        const bw = c.maxX - c.minX, bh = c.maxY - c.minY;
        return { n: c.pixels.length, aspect: (bw / Math.max(1, bh)).toFixed(2), fill: (c.pixels.length / (bw * bh)).toFixed(2), cx: c.cx.toFixed(0), cy: c.cy.toFixed(0) };
      });
      console.log(color.padEnd(9), ill.padEnd(13), 'lumaMean', lumaMean.toFixed(0), 'cands', JSON.stringify(info));
      bmp.close();
    }
  }
}
