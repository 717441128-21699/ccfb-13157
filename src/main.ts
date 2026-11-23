import './ui/app.css';
import { h, clear } from './ui/dom';
import { renderPatients } from './ui/views/patients';
import { renderCapture } from './ui/views/capture';
import { renderFollowUp } from './ui/views/followUp';
import { renderDemo } from './ui/views/demo';
import { TongueAnalyzer } from './core/analyzer';
import { getPatient } from './core/storage';

const ROUTES = [
  { hash: '#/patients', label: '病人档案' },
  { hash: '#/capture', label: '拍照校色分析' },
  { hash: '#/followup', label: '随访记录' },
  { hash: '#/demo', label: '样本与评测' },
];

async function boot(): Promise<void> {
  const glCanvas = document.createElement('canvas');
  let analyzer: TongueAnalyzer;
  try {
    analyzer = new TongueAnalyzer(glCanvas);
  } catch (err) {
    document.body.append(h('div', { class: 'panel', style: 'margin:30px' }, 'WebGL2 初始化失败：' + (err as Error).message));
    return;
  }

  const nav = h('nav', ...ROUTES.map((r) =>
    h('a', { href: r.hash, dataset: { route: r.hash } }, r.label),
  ));
  const topbar = h('header', { class: 'topbar' },
    h('div', { class: 'brand' }, '中医舌诊数据留档系统'),
    nav,
  );
  const main = h('main');
  document.body.append(topbar, main, glCanvas);
  glCanvas.style.display = 'none';

  const setActive = (hash: string): void => {
    nav.querySelectorAll('a').forEach((a) => {
      a.classList.toggle('active', (a as HTMLElement).dataset.route === hash);
    });
  };

  const route = async (): Promise<void> => {
    const hash = location.hash || '#/patients';
    const base = hash.split('?')[0];
    setActive(base);
    clear(main);
    try {
      if (base === '#/patients') {
        await renderPatients(main, (id) => {
          location.hash = `#/followup?patient=${id}`;
        });
      } else if (base === '#/capture') {
        const q = new URLSearchParams(hash.split('?')[1] || '');
        const pid = q.get('patient');
        const patient = pid ? await getPatient(pid) : undefined;
        await renderCapture(main, analyzer, patient);
      } else if (base === '#/followup') {
        const q = new URLSearchParams(hash.split('?')[1] || '');
        const pid = q.get('patient');
        if (pid) {
          await renderFollowUp(main, pid);
        } else {
          main.append(h('div', { class: 'panel empty' }, '请从「病人档案」选择一位病人查看随访'));
        }
      } else if (base === '#/demo') {
        renderDemo(main, analyzer);
      } else {
        location.hash = '#/patients';
      }
    } catch (err) {
      main.append(h('div', { class: 'panel' }, '页面出错：' + (err as Error).message));
      console.error(err);
    }
    window.scrollTo(0, 0);
  };

  window.addEventListener('hashchange', route);
  await route();
}

void boot();
