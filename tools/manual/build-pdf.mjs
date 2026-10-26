// docs/manual/manual.html → docs/manual/ClassroomInterpreter-Manual-ko.pdf (A4, 쪽 번호)
// 사용: node tools/manual/build-pdf.mjs   (그림을 새로 찍으려면 먼저 capture.mjs)
// 필요: Playwright(Chromium), 한글 글꼴 Pretendard
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const SRC = path.join(ROOT, 'docs/manual/manual.html');
const OUT = path.join(ROOT, 'docs/manual/ClassroomInterpreter-Manual-ko.pdf');

const browser = await chromium.launch();
const page = await browser.newPage();
await page.goto(pathToFileURL(SRC).toString(), { waitUntil: 'networkidle' });
await page.evaluate(() => document.fonts.ready);
const missing = await page.evaluate(() => [...document.images].filter((i) => !i.complete || i.naturalWidth === 0).map((i) => i.src));
if (missing.length) throw new Error(`그림을 불러오지 못했습니다: ${missing.join(', ')}`);
await page.pdf({
  path: OUT,
  format: 'A4',
  printBackground: true,
  preferCSSPageSize: true,
  displayHeaderFooter: true,
  headerTemplate: '<span></span>',
  footerTemplate: '<div style="width:100%;font:8px Pretendard,sans-serif;color:#8a90a0;padding:0 15mm;display:flex;justify-content:space-between"><span>교실 통역 사용설명서 · v0.6.2</span><span><span class="pageNumber"></span> / <span class="totalPages"></span></span></div>',
});
await browser.close();
console.log(path.relative(ROOT, OUT));
