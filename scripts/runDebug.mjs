import puppeteer from 'puppeteer-core';
import { createServer } from 'vite';
import { existsSync } from 'node:fs';

const PORT = 5191;
function findBrowser() {
  const c = [
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  ];
  return c.find((p) => existsSync(p));
}

const server = await createServer({ server: { port: PORT, host: '127.0.0.1' }, configFile: false, logLevel: 'error' });
await server.listen();
const browser = await puppeteer.launch({
  executablePath: findBrowser(),
  headless: true,
  args: ['--no-sandbox', '--disable-gpu', '--enable-unsafe-swiftshader', '--use-gl=angle', '--use-angle=swiftshader', '--ignore-gpu-blocklist'],
});
const page = await browser.newPage();
page.on('console', (m) => console.log('[browser]', m.text()));
page.on('pageerror', (e) => console.log('[pageerror]', e));
await page.goto(`http://127.0.0.1:${PORT}/index.html`, { waitUntil: 'domcontentloaded' });
const mode = process.env.DEBUG === 'warm2' ? 'warm2' : process.env.DEBUG === 'warm' ? 'warm' : process.env.DEBUG === 'thick' ? 'thick' : process.env.DEBUG === 'one' ? 'one' : process.env.DEBUG === 'segment' ? 'segment' : process.env.DEBUG === 'coat' ? 'coat' : process.env.DEBUG === 'misses' ? 'misses' : 'chart';
await page.evaluate(async (m) => {
  if (m === 'warm') {
    const mod = await import('/scripts/debugSegWarm.ts');
    await mod.debugSegWarm();
  } else if (m === 'warm2') {
    const mod = await import('/scripts/debugSegWarm2.ts');
    await mod.debugSegWarm2();
  } else if (m === 'thick') {
    const mod = await import('/scripts/debugThick.ts');
    await mod.debugThick();
  } else if (m === 'one') {
    const mod = await import('/scripts/debugOneMiss.ts');
    await mod.debugOneMiss();
  } else if (m === 'segment') {
    const mod = await import('/scripts/debugSegment.ts');
    await mod.debugSegment();
  } else if (m === 'coat') {
    const mod = await import('/scripts/debugCoat.ts');
    await mod.debugCoat();
  } else if (m === 'misses') {
    const mod = await import('/scripts/debugChartMisses.ts');
    await mod.debugChartMisses();
  } else {
    const mod = await import('/scripts/debugChart.ts');
    await mod.debugCase(7000);
  }
}, mode);
await browser.close();
await server.close();
