import type { AnalysisResult, ExamRecord, Illuminant, Patient } from '../../types';
import { h, clear, toast, fmtDate, pct } from '../dom';
import { TongueAnalyzer } from '../../core/analyzer';
import { putRecord, uid } from '../../core/storage';
import { TONGUE_LABELS, COATING_LABELS } from '../../core/classify';
import { ILLUMINANTS } from '../../core/references';
import { renderResultPanel } from '../components/resultPanel';

export async function renderCapture(root: HTMLElement, analyzer: TongueAnalyzer, patient?: Patient): Promise<void> {
  clear(root);

  const illSel = h('select', {},
    h('option', { value: '' }, '光源（可选，自动判断）'),
    ...(Object.keys(ILLUMINANTS) as Illuminant[]).map((k) =>
      h('option', { value: k }, `${ILLUMINANTS[k].label}（约 ${ILLUMINANTS[k].cct}K）`)),
  ) as HTMLSelectElement;

  const noteInput = h('textarea', { rows: 2, placeholder: '本次随访备注（症状、用药等）' }) as HTMLTextAreaElement;
  const previewBox = h('div', { class: 'img-grid' });
  const resultBox = h('div');
  let currentBitmap: ImageBitmap | null = null;
  let currentResult: AnalysisResult | null = null;
  let currentName = '';

  const runAnalysis = async (bitmap: ImageBitmap, name: string): Promise<void> => {
    currentBitmap = bitmap;
    currentName = name;
    resultBox.replaceChildren(h('div', { class: 'panel' }, h('span', { class: 'spinner' }), '正在进行色卡检测、颜色校正与舌象分析…'));
    try {
      const result = await analyzer.analyze(bitmap, {
        maxEdge: 768,
        illuminantHint: (illSel.value || undefined) as Illuminant | undefined,
        withOverlay: true,
      });
      currentResult = result;
      clear(resultBox);
      resultBox.append(renderResultPanel(result));
      renderPreviews(result);
      if (!result.chart.found) {
        toast('未检测到色卡，本次未做颜色校正，结果仅供参考');
      } else {
        toast(`分析完成，耗时 ${result.elapsedMs.toFixed(0)} ms`);
      }
    } catch (err) {
      clear(resultBox);
      resultBox.append(h('div', { class: 'panel' }, '分析失败：' + (err as Error).message));
    }
  };

  const renderPreviews = (result: AnalysisResult): void => {
    clear(previewBox);
    const fig = (src: string, cap: string): HTMLElement =>
      h('figure', { class: 'img-frame' }, h('img', { src, alt: cap }), h('figcaption', {}, cap));
    if (result.calibratedUrl) previewBox.append(fig(result.calibratedUrl, '校色后图像'));
    if (result.overlayUrl) previewBox.append(fig(result.overlayUrl, '舌象标注叠加图'));
    if (result.maskUrl) previewBox.append(fig(result.maskUrl, '分割掩码（舌体/苔/反光/裂纹）'));
  };

  const fileInput = h('input', {
    type: 'file',
    accept: 'image/*',
    style: 'display:none',
    onchange: async (e: Event): Promise<void> => {
      const f = (e.target as HTMLInputElement).files?.[0];
      if (f) await loadFile(f);
    },
  }) as HTMLInputElement;

  const loadFile = async (file: File): Promise<void> => {
    const bmp = await createImageBitmap(file);
    await runAnalysis(bmp, file.name);
  };

  const drop = h('div', {
    class: 'drop-zone',
    onclick: (): void => fileInput.click(),
  }, h('div', { style: 'font-size:15px;font-weight:600;color:var(--fg)' }, '点击选择 或 拖入舌部照片'),
    h('div', { style: 'margin-top:6px' }, '请确认照片左上角包含标准色卡，舌体位于画面中央'));

  drop.addEventListener('dragover', (e) => {
    e.preventDefault();
    drop.classList.add('drag');
  });
  drop.addEventListener('dragleave', () => drop.classList.remove('drag'));
  drop.addEventListener('drop', async (e) => {
    e.preventDefault();
    drop.classList.remove('drag');
    const f = (e as DragEvent).dataTransfer?.files?.[0];
    if (f) await loadFile(f);
  });

  const saveBtn = h('button', {
    class: 'primary',
    disabled: true,
    onclick: async (): Promise<void> => {
      if (!currentResult || !patient) return;
      const rec: ExamRecord = {
        id: uid('rec'),
        patientId: patient.id,
        createdAt: Date.now(),
        imageName: currentName,
        illuminant: (illSel.value || currentResult.illuminantHint || '') as ExamRecord['illuminant'],
        result: currentResult,
        followUpNote: noteInput.value.trim(),
      };
      await putRecord(rec);
      toast('随访记录已保存到档案');
      saveBtn.disabled = true;
    },
  }, '💾 存入档案');
  // 分析完成后启用保存
  const observer = new MutationObserver(() => {
    if (currentResult && patient) saveBtn.disabled = false;
  });
  observer.observe(resultBox, { childList: true });

  root.append(
    h('section', { class: 'panel' },
      h('h2', {}, patient ? `拍照校色 · 当前病人：${patient.name}` : '拍照校色与舌象分析'),
      drop,
      fileInput,
      h('div', { class: 'row', style: 'margin-top:14px' },
        h('div', { class: 'col' }, h('label', { class: 'field' }, h('span', {}, '拍摄光源'), illSel)),
        h('div', { class: 'col' }, h('label', { class: 'field' }, h('span', {}, '随访备注'), noteInput)),
      ),
      h('div', { class: 'toolbar' },
        patient ? saveBtn : h('span', { class: 'muted' }, '提示：从「随访记录」进入时可直接存入对应病人档案'),
      ),
    ),
    h('section', { class: 'panel' }, h('h2', {}, '过程图像'), previewBox),
    resultBox,
  );

  void fmtDate;
  void pct;
  void TONGUE_LABELS;
  void COATING_LABELS;
}
