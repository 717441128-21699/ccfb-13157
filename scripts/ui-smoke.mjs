// UI 全流程冒烟测试：建档 -> 生成样本 -> 分析 -> 存档 -> 随访对比 -> 演示页
import puppeteer from 'puppeteer-core';
import { createServer } from 'vite';
import { existsSync } from 'node:fs';

const PORT = 5192;
function findBrowser() {
  return [
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  ].find((p) => existsSync(p));
}

const server = await createServer({ server: { port: PORT, host: '127.0.0.1' }, configFile: false, logLevel: 'error' });
await server.listen();
const browser = await puppeteer.launch({
  executablePath: findBrowser(),
  headless: true,
  args: ['--no-sandbox', '--disable-gpu', '--enable-unsafe-swiftshader', '--use-gl=angle', '--use-angle=swiftshader', '--ignore-gpu-blocklist'],
});
const page = await browser.newPage();
await page.setViewport({ width: 1366, height: 900 });
const errors = [];
page.on('pageerror', (e) => errors.push(String(e)));
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });

const assert = (cond, msg) => {
  if (!cond) { console.error('❌ 断言失败:', msg); process.exitCode = 1; }
  else console.log('✅', msg);
};

try {
  await page.goto(`http://127.0.0.1:${PORT}/index.html`, { waitUntil: 'networkidle0' });

  // 1) 默认进入病人档案页
  assert((await page.$('table')) !== null || (await page.$('.empty')) !== null, '病人档案页加载');

  // 2) 建档
  await page.type('input[placeholder="姓名"]', '测试患者');
  await page.select('select', '男');
  await page.type('input[type="number"]', '42');
  await page.click('button.primary');
  await page.waitForSelector('table tbody tr');
  const firstName = await page.$eval('table tbody tr:first-child td:first-child', (el) => el.textContent);
  assert(firstName === '测试患者', '新病人出现在列表');

  // 3) 进入随访页（空状态）
  await page.click('table tbody tr:first-child button.small.primary');
  await page.waitForSelector('.panel');
  const followText = await page.$eval('main', (el) => el.textContent || '');
  assert(followText.includes('随访记录'), '随访页打开');

  // 4) 去拍照分析页（带 patient 参数）
  await page.goto(`http://127.0.0.1:${PORT}/index.html#/capture?patient=${await page.evaluate(() => indexedDB.databases ? '' : '')}`, { waitUntil: 'networkidle0' });
  // 直接通过页面内逻辑生成样本并分析，再写入档案
  const saved = await page.evaluate(async () => {
    const [{ TongueAnalyzer }, { generateSample }, { putRecord, uid, getAllPatients }] = await Promise.all([
      import('/src/core/analyzer.ts'),
      import('/src/core/sampleGenerator.ts'),
      import('/src/core/storage.ts'),
    ]);
    const analyzer = new TongueAnalyzer(document.createElement('canvas'));
    const patients = await getAllPatients();
    const sample = generateSample({
      width: 512, height: 512, illuminant: 'daylight', tongueColor: 'red',
      coating: 'thinWhite', teethMarks: true, cracks: false, seed: 8888,
    });
    const bmp = await createImageBitmap(sample.canvas);
    const result = await analyzer.analyze(bmp, { maxEdge: 640, withOverlay: true });
    await putRecord({
      id: uid('rec'), patientId: patients[0].id, createdAt: Date.now(),
      imageName: 'synthetic.png', illuminant: 'daylight', result, followUpNote: 'UI 冒烟测试',
    });
    return { chart: result.chart.found, color: result.tongueColor, hasOverlay: !!result.overlayUrl };
  });
  assert(saved.chart, '样本分析检测到色卡');
  assert(saved.color === 'red', '舌色正确判定为 red');
  assert(saved.hasOverlay, '生成可视化叠加图');

  // 5) 回到随访页确认记录已存档
  await page.goBack();
  await page.reload({ waitUntil: 'networkidle0' });
  await page.waitForSelector('.timeline-item, table');
  const afterSave = await page.$eval('main', (el) => el.textContent || '');
  assert(afterSave.includes('红') || afterSave.includes('timeline'), '随访记录已存档并渲染');

  // 6) 演示/评测页
  await page.goto(`http://127.0.0.1:${PORT}/index.html#/demo`, { waitUntil: 'networkidle0' });
  await page.waitForSelector('.panel');
  const demoText = await page.$eval('main', (el) => el.textContent || '');
  assert(demoText.includes('合成样本') && demoText.includes('批量验收评测'), '样本与评测页加载');

  // 7) 数据导出
  const exported = await page.evaluate(async () => {
    const { exportAll } = await import('/src/core/storage.ts');
    const data = await exportAll();
    return { patients: data.patients.length, records: data.records.length };
  });
  assert(exported.patients >= 1 && exported.records >= 1, `数据导出含 ${exported.patients} 病人 / ${exported.records} 记录`);

  // 过滤 favicon 404（已修复，不应再出现）
  const realErrors = errors.filter((e) => !e.includes('favicon'));
  assert(realErrors.length === 0, `无页面错误（实际 ${realErrors.length} 条：${realErrors.slice(0, 3).join(' | ')}）`);

  console.log('\nUI 冒烟测试完成');
} finally {
  await browser.close();
  await server.close();
}
