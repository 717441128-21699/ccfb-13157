import type { AnalysisResult, Illuminant } from '../../types';
import { h, pct } from '../dom';
import { TONGUE_LABELS, COATING_LABELS } from '../../core/classify';
import { TONGUE_COLOR_ORDER, TONGUE_COLOR_PROTOTYPES, COATING_ORDER, COATING_PROTOTYPES, ILLUMINANTS, prototypeRgb } from '../../core/references';

function swatch(rgb: { r: number; g: number; b: number }): string {
  return `background:rgb(${Math.round(rgb.r)},${Math.round(rgb.g)},${Math.round(rgb.b)})`;
}

export function renderResultPanel(r: AnalysisResult): HTMLElement {
  const chart = r.chart;
  const cal = r.calibration;

  const chartRow = h('div', { class: 'metric-grid' },
    metric('色卡检测', chart.found ? '已识别' : '未识别', chart.found ? `置信度 ${(chart.confidence * 100).toFixed(0)}%，18 色块` : '请确认色卡入镜', chart.found ? 'ok' : 'bad'),
    metric('光源判断', cal ? ILLUMINANTS[(r.illuminantHint || 'daylight') as Illuminant]?.label ?? '—' : '未校正', cal ? `估计色温 ${cal.estCCT}K` : '无卡无法估计'),
    metric('校色残差', cal ? cal.residual.toFixed(4) : '—', cal ? '线性 RGB RMSE，越小越准' : ''),
    metric('处理耗时', `${r.elapsedMs.toFixed(0)} ms`, `${r.imageWidth}×${r.imageHeight}`),
    metric('舌体占比', pct(r.tongueAreaRatio), '占整幅图像'),
    metric('津液反光', pct(r.specularRatio), '已从舌色统计中剔除并修复'),
  );

  const colorMetric = h('div', { class: 'metric' },
    h('div', { class: 'k' }, '舌质颜色（中位 Lab）'),
    h('div', { class: 'v' },
      h('span', { class: 'color-swatch', style: swatch(r.bodyMedian) }),
      TONGUE_LABELS[r.tongueColor],
    ),
    h('div', { class: 'muted', style: 'font-size:12px' },
      `L* ${r.bodyLab.L.toFixed(1)}  a* ${r.bodyLab.a.toFixed(1)}  b* ${r.bodyLab.b.toFixed(1)}`),
  );

  const coatMetric = h('div', { class: 'metric' },
    h('div', { class: 'k' }, '舌苔分类'),
    h('div', { class: 'v' }, h('span', { class: 'badge coat' }, COATING_LABELS[r.coating])),
    h('div', { class: 'muted', style: 'font-size:12px' }, `覆盖率 ${pct(r.coatingCoverage)}`),
  );

  // 舌色到五类原型的 Lab 距离
  const distRows = TONGUE_COLOR_ORDER.map((c) => {
    const d = r.tongueColorDistances[c];
    const isHit = c === r.tongueColor;
    return h('tr', {},
      h('td', {}, h('span', { class: 'color-swatch', style: swatch(prototypeRgb(TONGUE_COLOR_PROTOTYPES[c].lab)) }), TONGUE_LABELS[c]),
      h('td', { class: 'num' }, d.toFixed(2)),
      h('td', {}, isHit ? h('span', { class: 'badge ok' }, '判定') : ''),
    );
  });

  const coatDist = COATING_ORDER.map((c) =>
    h('tr', {}, h('td', {}, h('span', { class: 'color-swatch', style: swatch(prototypeRgb(COATING_PROTOTYPES[c].lab)) }), COATING_LABELS[c])),
  );
  void coatDist;

  const marks = h('div', {},
    h('h3', { style: 'margin:16px 0 8px;font-size:14px' }, '体征标注'),
    h('div', { class: 'row' },
      h('div', { class: 'col' },
        h('div', { class: 'muted', style: 'margin-bottom:6px' }, `舌边齿痕：${r.teethMarks.length ? `${r.teethMarks.length} 处` : '未检出'}`),
        r.teethMarks.length
          ? h('ul', { style: 'margin:0;padding-left:18px' }, ...r.teethMarks.map((t, i) =>
            h('li', {}, `#${i + 1} 位置(${t.x.toFixed(2)}, ${t.y.toFixed(2)}) 凹陷度 ${(t.depth * 100).toFixed(0)}%`)))
          : '',
      ),
      h('div', { class: 'col' },
        h('div', { class: 'muted', style: 'margin-bottom:6px' }, `舌面裂纹：${r.cracks.length ? `${r.cracks.length} 条` : '未检出'}`),
        r.cracks.length
          ? h('ul', { style: 'margin:0;padding-left:18px' }, ...r.cracks.slice(0, 6).map((c, i) =>
            h('li', {}, `#${i + 1} 长度 ${c.length.toFixed(0)}px 走向 ${c.angleDeg}°`)))
          : '',
      ),
    ),
  );

  return h('section', { class: 'panel' },
    h('h2', {}, '分析结果'),
    chartRow,
    h('div', { class: 'metric-grid', style: 'margin-top:12px' }, colorMetric, coatMetric),
    h('h3', { style: 'margin:18px 0 8px;font-size:14px' }, '舌色与五类标准原型的 Lab 色差（ΔE，越小越接近）'),
    h('table', { class: 'eval-table' },
      h('thead', {}, h('tr', {}, h('th', {}, '类别'), h('th', {}, 'ΔE'), h('th', {}, ''))),
      h('tbody', {}, ...distRows),
    ),
    marks,
  );
}

function metric(key: string, value: string, sub: string, badge?: 'ok' | 'bad'): HTMLElement {
  return h('div', { class: 'metric' },
    h('div', { class: 'k' }, key),
    h('div', { class: 'v' }, badge ? h('span', { class: `badge ${badge}` }, value) : value),
    sub ? h('div', { class: 'muted', style: 'font-size:12px' }, sub) : '',
  );
}
