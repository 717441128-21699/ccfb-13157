import type { Patient } from '../../types';
import { h, clear, toast, fmtDate } from '../dom';
import { getAllPatients, putPatient, deletePatient, uid } from '../../core/storage';

export async function renderPatients(root: HTMLElement, onOpen: (id: string) => void): Promise<void> {
  clear(root);
  const patients = await getAllPatients();

  const nameInput = h('input', { placeholder: '姓名', maxlength: 20 }) as HTMLInputElement;
  const genderSel = h('select', {},
    h('option', { value: '' }, '性别'),
    h('option', { value: '男' }, '男'),
    h('option', { value: '女' }, '女'),
  ) as HTMLSelectElement;
  const ageInput = h('input', { placeholder: '年龄', type: 'number', min: '0', max: '130' }) as HTMLInputElement;
  const noteInput = h('textarea', { placeholder: '病史/备注（可选）', rows: 2 }) as HTMLTextAreaElement;

  const formPanel = h('section', { class: 'panel' },
    h('h2', {}, '新建病人档案'),
    h('div', { class: 'row' },
      h('div', { class: 'col' },
        h('label', { class: 'field' }, h('span', {}, '姓名'), nameInput),
        h('label', { class: 'field' }, h('span', {}, '性别'), genderSel),
        h('label', { class: 'field' }, h('span', {}, '年龄'), ageInput),
      ),
      h('div', { class: 'col' },
        h('label', { class: 'field' }, h('span', {}, '备注'), noteInput),
        h('button', {
          class: 'primary',
          onclick: async (): Promise<void> => {
            if (!nameInput.value.trim()) {
              toast('请填写病人姓名');
              return;
            }
            const p: Patient = {
              id: uid('pat'),
              name: nameInput.value.trim(),
              gender: genderSel.value as Patient['gender'],
              age: ageInput.value ? Number(ageInput.value) : '',
              note: noteInput.value.trim(),
              createdAt: Date.now(),
            };
            await putPatient(p);
            toast('档案已建立');
            renderPatients(root, onOpen);
          },
        }, '＋ 建立档案'),
      ),
    ),
  );

  const listPanel = h('section', { class: 'panel' },
    h('h2', {}, `病人列表（${patients.length}）`),
    patients.length === 0
      ? h('div', { class: 'empty' }, '暂无档案，请先在上方建立')
      : h('table', {},
        h('thead', {}, h('tr', {},
          h('th', {}, '姓名'), h('th', {}, '性别'), h('th', {}, '年龄'),
          h('th', {}, '建立时间'), h('th', {}, '备注'), h('th', {}, '操作'),
        )),
        h('tbody', {}, ...patients.map((p) =>
          h('tr', {},
            h('td', {}, p.name),
            h('td', {}, p.gender || '—'),
            h('td', {}, p.age === '' ? '—' : String(p.age)),
            h('td', {}, fmtDate(p.createdAt)),
            h('td', { class: 'muted' }, p.note || '—'),
            h('td', {},
              h('button', {
                class: 'small primary',
                onclick: (): void => onOpen(p.id),
              }, '随访记录'),
              ' ',
              h('button', {
                class: 'small danger',
                onclick: async (): Promise<void> => {
                  if (!confirm(`确认删除病人「${p.name}」及其全部随访记录？`)) return;
                  await deletePatient(p.id);
                  toast('已删除');
                  renderPatients(root, onOpen);
                },
              }, '删除'),
            ),
          ),
        )),
      ),
  );

  root.append(formPanel, listPanel);
}
