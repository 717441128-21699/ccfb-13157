import type { Patient, ExamRecord } from '../../types';
import { h, clear, toast, fmtDate, pct } from '../dom';
import { getPatient, getRecordsByPatient, deleteRecord } from '../../core/storage';
import { TONGUE_LABELS, COATING_LABELS } from '../../core/classify';
import { ILLUMINANTS } from '../../core/references';
import { renderResultPanel } from '../components/resultPanel';

export async function renderFollowUp(root: HTMLElement, patientId: string): Promise<void> {
  clear(root);
  const patient = await getPatient(patientId);
  if (!patient) {
    root.append(h('div', { class: 'panel empty' }, '病人不存在'));
    return;
  }
  const records = await getRecordsByPatient(patientId);

  const head = h('section', { class: 'panel' },
    h('h2', {}, `${patient.name} · 随访记录（${records.length} 次）`),
    h('div', { class: 'muted' },
      `${patient.gender || '性别未填'} ${patient.age === '' ? '' : patient.age + ' 岁'}`,
      patient.note ? ` ｜ ${patient.note}` : ''),
  );
  root.append(head);

  if (records.length === 0) {
    root.append(h('div', { class: 'panel empty' }, '暂无随访记录，请到「拍照分析」为该病人拍照并存档'));
    return;
  }

  // 趋势对比表（时间正序）
  const asc = records.slice().reverse();
  const table = h('section', { class: 'panel' },
    h('h2', {}, '历次舌象趋势对比'),
    h('table', { class: 'eval-table' },
      h('thead', {}, h('tr', {},
        h('th', {}, '时间'), h('th', {}, '光源'), h('th', {}, '舌色'),
        h('th', {}, 'L*'), h('th', {}, 'a*'), h('th', {}, 'b*'),
        h('th', {}, '舌苔'), h('th', {}, '苔覆盖'), h('th', {}, '反光占比'),
        h('th', {}, '齿痕/裂纹'), h('th', {}, '操作'),
      )),
      h('tbody', {}, ...asc.map((r, idx) => {
        const prev = idx > 0 ? asc[idx - 1] : null;
        const dL = prev ? r.result.bodyLab.L - prev.result.bodyLab.L : 0;
        const da = prev ? r.result.bodyLab.a - prev.result.bodyLab.a : 0;
        const db = prev ? r.result.bodyLab.b - prev.result.bodyLab.b : 0;
        const diff = (v: number): string => {
          if (!prev) return '';
          const cls = Math.abs(v) < 0.6 ? '' : v > 0 ? 'diff-up' : 'diff-down';
          return `<span class="${cls}"> (${v > 0 ? '+' : ''}${v.toFixed(1)})</span>`;
        };
        const tr = h('tr', {},
          h('td', {}, fmtDate(r.createdAt)),
          h('td', {}, r.illuminant ? h('span', { class: 'badge light' }, ILLUMINANTS[r.illuminant as keyof typeof ILLUMINANTS]?.label ?? r.illuminant) : '—'),
          h('td', {}, h('span', { class: 'badge color' }, TONGUE_LABELS[r.result.tongueColor])),
          h('td', { class: 'num' }, r.result.bodyLab.L.toFixed(1), h('span', { innerHTML: diff(dL) } as Partial<HTMLElement>)),
          h('td', { class: 'num' }, r.result.bodyLab.a.toFixed(1), h('span', { innerHTML: diff(da) } as Partial<HTMLElement>)),
          h('td', { class: 'num' }, r.result.bodyLab.b.toFixed(1), h('span', { innerHTML: diff(db) } as Partial<HTMLElement>)),
          h('td', {}, h('span', { class: 'badge coat' }, COATING_LABELS[r.result.coating])),
          h('td', { class: 'num' }, pct(r.result.coatingCoverage)),
          h('td', { class: 'num' }, pct(r.result.specularRatio)),
          h('td', { class: 'num' }, `${r.result.teethMarks.length} / ${r.result.cracks.length}`),
          h('td', {},
            h('button', {
              class: 'small ghost',
              onclick: (): void => {
                const existing = document.getElementById(`detail_${r.id}`);
                if (existing) { existing.remove(); return; }
                const d = h('tr', { id: `detail_${r.id}` }, h('td', { colSpan: '11' }, renderResultPanel(r.result), noteBlock(r)));
                tr.after(d);
              },
            }, '详情'),
            ' ',
            h('button', {
              class: 'small danger',
              onclick: async (): Promise<void> => {
                if (!confirm('确认删除该次随访记录？')) return;
                await deleteRecord(r.id);
                toast('已删除');
                renderFollowUp(root, patientId);
              },
            }, '删除'),
          ),
        );
        return tr;
      })),
    ),
  );
  root.append(table);

  // 时间线
  const timeline = h('section', { class: 'panel' },
    h('h2', {}, '随访时间线'),
    ...asc.map((r) =>
      h('div', { class: 'timeline-item' },
        h('div', { style: 'font-weight:600' },
          fmtDate(r.createdAt),
          ' ',
          h('span', { class: 'badge color' }, TONGUE_LABELS[r.result.tongueColor]),
          ' ',
          h('span', { class: 'badge coat' }, COATING_LABELS[r.result.coating]),
          r.illuminant ? h('span', { class: 'badge light', style: 'margin-left:6px' }, ILLUMINANTS[r.illuminant as keyof typeof ILLUMINANTS]?.label ?? '') : '',
        ),
        r.result.overlayUrl ? h('img', { src: r.result.overlayUrl, style: 'max-width:280px;margin-top:8px;border-radius:8px' }) : '',
        h('div', { class: 'muted', style: 'margin-top:6px' },
          `校色残差 ${r.result.calibration?.residual.toFixed(4) ?? '—'} ｜ 耗时 ${r.result.elapsedMs.toFixed(0)}ms`,
          r.followUpNote ? ` ｜ 备注：${r.followUpNote}` : ''),
      ),
    ),
  );
  root.append(timeline);
}

function noteBlock(r: ExamRecord): HTMLElement {
  return h('div', { class: 'muted', style: 'margin-top:10px' },
    r.followUpNote ? `随访备注：${r.followUpNote}` : '（无备注）',
  );
}
