import type { CoatingClass, Illuminant, TongueColorClass } from '../../types';
import { h, clear, toast, pct } from '../dom';
import { TongueAnalyzer } from '../../core/analyzer';
import { demoSingle, runEvaluation, type EvalSummary } from '../../core/evaluation';
import { TONGUE_LABELS, COATING_LABELS } from '../../core/classify';
import { TONGUE_COLOR_ORDER, COATING_ORDER, ILLUMINANTS } from '../../core/references';
import { renderResultPanel } from '../components/resultPanel';

const LIGHTS: Illuminant[] = ['incandescent', 'fluorescent', 'daylight'];

export function renderDemo(root: HTMLElement, analyzer: TongueAnalyzer): void {
  clear(root);

  // ---- 单例演示 ----
  const colorSel = h('select', {}, ...TONGUE_COLOR_ORDER.map((c) => h('option', { value: c }, TONGUE_LABELS[c]))) as HTMLSelectElement;
  colorSel.value = 'lightRed';
  const coatSel = h('select', {}, ...COATING_ORDER.map((c) => h('option', { value: c }, COATING_LABELS[c]))) as HTMLSelectElement;
  coatSel.value = 'thinWhite';
  const lightSel = h('select', {}, ...LIGHTS.map((l) => h('option', { value: l }, ILLUMINANTS[l].label))) as HTMLSelectElement;
  const teethChk = h('input', { type: 'checkbox' }) as HTMLInputElement;
  teethChk.checked = true;
  const crackChk = h('input', { type: 'checkbox' }) as HTMLInputElement;
  crackChk.checked = true;
  const seedInput = h('input', { type: 'number', value: '1234', min: '1' }) as HTMLInputElement;

  const singleOut = h('div');

  const runSingle = async (): Promise<void> => {
    singleOut.replaceChildren(h('div', { class: 'panel' }, h('span', { class: 'spinner' }), '生成样本并分析…'));
    const { canvas, result, truth } = await demoSingle(
      analyzer,
      colorSel.value as TongueColorClass,
      coatSel.value as CoatingClass,
      lightSel.value as Illuminant,
      teethChk.checked,
      crackChk.checked,
      Number(seedInput.value) || 1,
    );
    clear(singleOut);
    const okColor = result.tongueColor === truth.tongueColor;
    const okCoat = result.coating === truth.coating;
    singleOut.append(
      h('section', { class: 'panel' },
        h('h2', {}, '样本真值 vs 系统判定'),
        h('div', { class: 'metric-grid' },
          metric('舌色真值', TONGUE_LABELS[truth.tongueColor]),
          metric('舌色判定', TONGUE_LABELS[result.tongueColor], undefined, okColor ? 'ok' : 'bad'),
          metric('舌苔真值', COATING_LABELS[truth.coating]),
          metric('舌苔判定', COATING_LABELS[result.coating], undefined, okCoat ? 'ok' : 'bad'),
          metric('光源真值', ILLUMINANTS[truth.illuminant].label),
          metric('光源判断', result.illuminantHint ? ILLUMINANTS[result.illuminantHint as Illuminant].label : '—'),
        ),
        h('div', { class: 'img-grid', style: 'margin-top:14px' },
          h('figure', { class: 'img-frame' }, h('img', { src: canvas.toDataURL() }), h('figcaption', {}, '合成原图（带光源偏差与色卡）')),
          result.calibratedUrl ? h('figure', { class: 'img-frame' }, h('img', { src: result.calibratedUrl }), h('figcaption', {}, '校色后')) : '',
          result.overlayUrl ? h('figure', { class: 'img-frame' }, h('img', { src: result.overlayUrl }), h('figcaption', {}, '标注叠加')) : '',
        ),
      ),
      renderResultPanel(result),
    );
  };

  const singlePanel = h('section', { class: 'panel' },
    h('h2', {}, '合成样本演示（不同光源 / 舌象）'),
    h('div', { class: 'row' },
      h('div', { class: 'col' }, h('label', { class: 'field' }, h('span', {}, '舌色真值'), colorSel)),
      h('div', { class: 'col' }, h('label', { class: 'field' }, h('span', {}, '舌苔真值'), coatSel)),
      h('div', { class: 'col' }, h('label', { class: 'field' }, h('span', {}, '光源'), lightSel)),
    ),
    h('div', { class: 'row' },
      h('div', { class: 'col' }, h('label', { class: 'field' }, h('span', {}, '随机种子'), seedInput)),
      h('div', { class: 'col' }, h('label', { class: 'field' }, h('span', {}, '齿痕'), teethChk)),
      h('div', { class: 'col' }, h('label', { class: 'field' }, h('span', {}, '裂纹'), crackChk)),
    ),
    h('button', { class: 'primary', onclick: runSingle }, '生成并分析'),
  );

  // ---- 批量评测 ----
  const batchOut = h('div');
  const patientCountInput = h('input', { type: 'number', value: '15', min: '3', max: '40' }) as HTMLInputElement;
  const runBatch = async (): Promise<void> => {
    const n = Math.max(3, Number(patientCountInput.value) || 15);
    batchOut.replaceChildren(h('div', { class: 'panel' }, h('span', { class: 'spinner' }), `正在评测 ${n} 位病人 × 3 光源 = ${n * 3} 张…`));
    // 分帧让出主线程以便渲染进度
    await new Promise((r) => setTimeout(r, 30));
    const summary = await runEvaluation(analyzer, {
      patients: n,
      onProgress: (done, total) => {
        const el = batchOut.querySelector('.progress-label');
        if (el) el.textContent = `${done} / ${total}`;
      },
    });
    clear(batchOut);
    batchOut.append(renderSummary(summary));
    toast('批量评测完成');
  };

  const batchPanel = h('section', { class: 'panel' },
    h('h2', {}, '批量验收评测'),
    h('div', { class: 'toolbar' },
      h('label', { class: 'field', style: 'width:140px;margin:0' }, h('span', {}, '虚拟病人数'), patientCountInput),
      h('button', { class: 'primary', onclick: runBatch }, '开始批量评测'),
      h('span', { class: 'muted progress-label' }, ''),
    ),
    h('div', { class: 'muted' }, '每位病人在白炽灯、日光灯、阴天窗边各拍一张；舌色/苔型轮转覆盖全部 5 类舌色与 3 类苔。'),
  );

  root.append(singlePanel, singleOut, batchPanel, batchOut);
}

function metric(key: string, value: string, sub?: string, badge?: 'ok' | 'bad'): HTMLElement {
  return h('div', { class: 'metric' },
    h('div', { class: 'k' }, key),
    h('div', { class: 'v' }, badge ? h('span', { class: `badge ${badge}` }, value) : value),
    sub ? h('div', { class: 'muted', style: 'font-size:12px' }, sub) : '',
  );
}

function renderSummary(s: EvalSummary): HTMLElement {
  const requirement = (ok: boolean): string => (ok ? 'badge ok' : 'badge bad');
  const consistencyOk = s.lightConsistency >= 0.999;
  const agreementOk = s.colorAccuracy >= 0.85;
  const speedOk = s.p95ElapsedMs <= 1000;

  const confusionRows = TONGUE_COLOR_ORDER.map((truth) =>
    h('tr', {},
      h('td', {}, TONGUE_LABELS[truth]),
      ...TONGUE_COLOR_ORDER.map((pred) => h('td', { class: 'num' }, String(s.colorConfusion[truth][pred]))),
    ),
  );

  return h('section', { class: 'panel' },
    h('h2', {}, '评测报告'),
    h('table', { class: 'eval-table' },
      h('thead', {}, h('tr', {}, h('th', {}, '验收指标'), h('th', {}, '实测值'), h('th', {}, '要求'), h('th', {}, '结论'))),
      h('tbody', {},
        h('tr', {}, h('td', {}, '样本总数'), h('td', { class: 'num' }, String(s.total)), h('td', {}, '—'), h('td', {}, '')),
        h('tr', {}, h('td', {}, '色卡识别率'), h('td', { class: 'num' }, pct(s.chartFoundRate)), h('td', {}, '可靠校色前提'), h('td', {}, h('span', { class: requirement(s.chartFoundRate >= 0.95) }, s.chartFoundRate >= 0.95 ? '达标' : '待改进'))),
        h('tr', {}, h('td', {}, '三光源舌色类别一致性'), h('td', { class: 'num' }, pct(s.lightConsistency)), h('td', {}, '100% 一致'), h('td', {}, h('span', { class: requirement(consistencyOk) }, consistencyOk ? '达标' : '未达标'))),
        h('tr', {}, h('td', {}, '舌色与主任医师共识吻合率'), h('td', { class: 'num' }, pct(s.colorAccuracy)), h('td', {}, '≥ 85%'), h('td', {}, h('span', { class: requirement(agreementOk) }, agreementOk ? '达标' : '未达标'))),
        h('tr', {}, h('td', {}, '舌苔分类准确率'), h('td', { class: 'num' }, pct(s.coatingAccuracy)), h('td', {}, '参考'), h('td', {}, h('span', { class: requirement(s.coatingAccuracy >= 0.8) }, s.coatingAccuracy >= 0.8 ? '达标' : '待改进'))),
        h('tr', {}, h('td', {}, '光源类型识别准确率'), h('td', { class: 'num' }, pct(s.illuminantAccuracy)), h('td', {}, '参考'), h('td', {}, '')),
        h('tr', {}, h('td', {}, '齿痕灵敏度/特异度'), h('td', { class: 'num' }, `${pct(s.teethSensitivity)} / ${pct(s.teethSpecificity)}`), h('td', {}, '参考'), h('td', {}, '')),
        h('tr', {}, h('td', {}, '裂纹灵敏度/特异度'), h('td', { class: 'num' }, `${pct(s.cracksSensitivity)} / ${pct(s.cracksSpecificity)}`), h('td', {}, '参考'), h('td', {}, '')),
        h('tr', {}, h('td', {}, '平均耗时'), h('td', { class: 'num' }, `${s.meanElapsedMs.toFixed(0)} ms`), h('td', {}, '—'), h('td', {}, '')),
        h('tr', {}, h('td', {}, 'P95 / 最大耗时'), h('td', { class: 'num' }, `${s.p95ElapsedMs.toFixed(0)} / ${s.maxElapsedMs.toFixed(0)} ms`), h('td', {}, '单张 ≤ 1000 ms'), h('td', {}, h('span', { class: requirement(speedOk) }, speedOk ? '达标' : '未达标'))),
        h('tr', {}, h('td', {}, '平均校色残差'), h('td', { class: 'num' }, s.meanResidual.toFixed(4)), h('td', {}, '越小越好'), h('td', {}, '')),
      ),
    ),
    h('h3', { style: 'margin:18px 0 8px;font-size:14px' }, '舌色混淆矩阵（行=真值，列=判定）'),
    h('table', { class: 'eval-table' },
      h('thead', {}, h('tr', {}, h('th', {}, '真值＼判定'), ...TONGUE_COLOR_ORDER.map((c) => h('th', {}, TONGUE_LABELS[c])))),
      h('tbody', {}, ...confusionRows),
    ),
    h('h3', { style: 'margin:18px 0 8px;font-size:14px' }, '逐病人三光源判定'),
    h('table', { class: 'eval-table' },
      h('thead', {}, h('tr', {}, h('th', {}, '病人'), h('th', {}, '白炽灯'), h('th', {}, '日光灯'), h('th', {}, '阴天窗边'), h('th', {}, '一致'))),
      h('tbody', {}, ...s.perPatient.map((p) =>
        h('tr', {},
          h('td', {}, `#${p.patientIndex + 1}`),
          ...p.colors.map((c) => h('td', {}, TONGUE_LABELS[c])),
          h('td', {}, h('span', { class: p.consistent ? 'badge ok' : 'badge bad' }, p.consistent ? '一致' : '不一致')),
        ),
      )),
    ),
  );
}
