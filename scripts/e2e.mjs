// 无头浏览器端到端评测：
// 1) 启动本机 Chrome/Edge，开启 SwiftShader 软件 WebGL2
// 2) 加载页面，在页面上下文里跑批量评测
// 3) 输出 JSON 报告到 reports/，并按验收阈值给出退出码
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import puppeteer from 'puppeteer-core';
import { createServer } from 'vite';

const ROOT = process.cwd();
const PATIENTS = Number(process.env.EVAL_PATIENTS || 15);
const PORT = Number(process.env.EVAL_PORT || 5190);

function findBrowser() {
  const candidates = [
    process.env.CHROME_PATH,
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  ].filter(Boolean);
  for (const p of candidates) {
    if (p && existsSync(p)) return p;
  }
  for (const name of ['chrome', 'msedge']) {
    try {
      const out = execFileSync(process.platform === 'win32' ? 'where' : 'which', [name], { encoding: 'utf8' });
      const first = out.split(/\r?\n/)[0].trim();
      if (first && existsSync(first)) return first;
    } catch {
      /* ignore */
    }
  }
  throw new Error('未找到 Chrome/Edge，请设置 CHROME_PATH 环境变量');
}

async function main() {
  const browserPath = findBrowser();
  console.log('使用浏览器:', browserPath);

  const server = await createServer({
    root: ROOT,
    configFile: false,
    server: { port: PORT, host: '127.0.0.1' },
    logLevel: 'warn',
  });
  await server.listen();
  const url = `http://127.0.0.1:${PORT}/index.html`;

  const browser = await puppeteer.launch({
    executablePath: browserPath,
    headless: true,
    args: [
      '--no-sandbox',
      '--disable-gpu',
      '--enable-unsafe-swiftshader',
      '--use-gl=angle',
      '--use-angle=swiftshader',
      '--ignore-gpu-blocklist',
      '--window-size=900,1000',
    ],
  });

  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 960 });
    const errors = [];
    page.on('pageerror', (e) => errors.push(String(e)));
    page.on('console', (msg) => {
      if (msg.type() === 'error') errors.push(msg.text());
    });

    await page.goto(url, { waitUntil: 'networkidle0', timeout: 30000 });

    const glInfo = await page.evaluate(async () => {
      const { TongueAnalyzer } = await import('/src/core/analyzer.ts');
      const c = document.createElement('canvas');
      const a = new TongueAnalyzer(c);
      return { float: a.isFloat, vendor: a.gl.getParameter(a.gl.VERSION) };
    });
    console.log('WebGL2:', glInfo);

    const summary = await page.evaluate(async (patientCount) => {
      const [{ TongueAnalyzer }, { runEvaluation }] = await Promise.all([
        import('/src/core/analyzer.ts'),
        import('/src/core/evaluation.ts'),
      ]);
      const analyzer = new TongueAnalyzer(document.createElement('canvas'));
      return runEvaluation(analyzer, { patients: patientCount, size: 512, maxEdge: 640 });
    }, PATIENTS);

    if (errors.length) {
      console.log('页面错误（前 10 条）:');
      errors.slice(0, 10).forEach((e) => console.log(' -', e));
    }

    if (!existsSync(`${ROOT}/reports`)) mkdirSync(`${ROOT}/reports`);
    writeFileSync(`${ROOT}/reports/eval-report.json`, JSON.stringify(summary, null, 2));

    const line = (k, v, req, ok) =>
      console.log(`${ok ? '✅' : '❌'} ${k}: ${v}（要求 ${req}）`);
    console.log('\n========== 验收报告 ==========');
    console.log('样本总数:', summary.total);
    line('色卡识别率', `${(summary.chartFoundRate * 100).toFixed(1)}%`, '≥95%', summary.chartFoundRate >= 0.95);
    line('三光源舌色一致性', `${(summary.lightConsistency * 100).toFixed(1)}%`, '100%', summary.lightConsistency >= 0.999);
    line('舌色吻合率（对主任医师共识）', `${(summary.colorAccuracy * 100).toFixed(1)}%`, '≥85%', summary.colorAccuracy >= 0.85);
    console.log(`舌苔准确率: ${(summary.coatingAccuracy * 100).toFixed(1)}%`);
    console.log(`光源识别准确率: ${(summary.illuminantAccuracy * 100).toFixed(1)}%`);
    console.log(`齿痕灵敏度/特异度: ${(summary.teethSensitivity * 100).toFixed(1)}% / ${(summary.teethSpecificity * 100).toFixed(1)}%`);
    console.log(`裂纹灵敏度/特异度: ${(summary.cracksSensitivity * 100).toFixed(1)}% / ${(summary.cracksSpecificity * 100).toFixed(1)}%`);
    line('P95 耗时', `${summary.p95ElapsedMs.toFixed(0)} ms`, '≤1000ms', summary.p95ElapsedMs <= 1000);
    console.log(`平均/最大耗时: ${summary.meanElapsedMs.toFixed(0)} / ${summary.maxElapsedMs.toFixed(0)} ms`);
    console.log('平均校色残差:', summary.meanResidual.toFixed(4));
    console.log('\n舌色混淆矩阵（行真值→列判定）:');
    const labels = ['淡白', '淡红', '红', '绛', '紫'];
    const keys = ['pale', 'lightRed', 'red', 'deepRed', 'purple'];
    console.log('        ' + keys.map((_, i) => labels[i].padStart(4)).join(''));
    for (const r of keys) {
      console.log(labels[keys.indexOf(r)].padEnd(4) + '  ' + keys.map((c) => String(summary.colorConfusion[r][c]).padStart(4)).join(''));
    }
    console.log('\n逐病人三光源判定:');
    for (const p of summary.perPatient) {
      console.log(`  #${String(p.patientIndex + 1).padStart(2)}: ${p.colors.map((c) => labels[keys.indexOf(c)]).join(' / ')} ${p.consistent ? '✓' : '✗'}`);
    }

    const pass =
      summary.lightConsistency >= 0.999 &&
      summary.colorAccuracy >= 0.85 &&
      summary.p95ElapsedMs <= 1000 &&
      summary.chartFoundRate >= 0.9;

    console.log(`\n结论: ${pass ? '全部验收指标通过 🎉' : '存在未达标项，需调优'}`);
    writeFileSync(
      `${ROOT}/reports/eval-summary.txt`,
      [
        `tongue_consistency=${summary.lightConsistency}`,
        `color_accuracy=${summary.colorAccuracy}`,
        `coating_accuracy=${summary.coatingAccuracy}`,
        `chart_found=${summary.chartFoundRate}`,
        `p95_ms=${summary.p95ElapsedMs}`,
        `mean_ms=${summary.meanElapsedMs}`,
        `max_ms=${summary.maxElapsedMs}`,
        `pass=${pass}`,
      ].join('\n'),
    );
    process.exitCode = pass ? 0 : 2;
  } finally {
    await browser.close();
    await server.close();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
