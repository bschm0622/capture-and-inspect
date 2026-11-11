#!/usr/bin/env node
// Drives the result page (result.html) after a real capture of a fixture,
// the way a person would: the capture shows, a crop across the place where
// two of the stitcher's canvases meet, Download (whole, cropped, as JPG),
// and Copy. Every image the page hands over is compared pixel for pixel with
// the PNG the extension stored.
//
//   node test/result-page.mjs [fixture]     default tall-40k; also body-lock (one canvas), tall-64k
//   --out dir                                where downloads and a screenshot go
//
// Exit code 1 if any step fails.

import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { buildExtension } from './lib/extension.mjs';
import { launch } from './lib/capture.mjs';

const args = process.argv.slice(2);
const name = args.find((a) => !a.startsWith('--') && args[args.indexOf(a) - 1] !== '--out') || 'tall-40k';
const outDir = args.includes('--out') ? path.resolve(args[args.indexOf('--out') + 1]) : fs.mkdtempSync(path.join(os.tmpdir(), 'result-page-'));
fs.mkdirSync(outDir, { recursive: true });
const FIXTURES = path.join(path.dirname(new URL(import.meta.url).pathname), 'fixtures');

let failures = 0;
const step = (ok, what, detail = '') => {
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${what}${detail ? `: ${detail}` : ''}`);
};

const server = http.createServer((req, res) => {
  const f = path.join(FIXTURES, path.basename(new URL(req.url, 'http://x').pathname));
  if (!fs.existsSync(f)) { res.writeHead(404); res.end(); return; }
  res.writeHead(200, { 'content-type': f.endsWith('.js') ? 'text/javascript' : 'text/html' });
  fs.createReadStream(f).pipe(res);
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const url = `http://127.0.0.1:${server.address().port}/${name}.html`;

const ext = buildExtension(null);
const { context, sw, userDataDir } = await launch(ext.dir, { headless: !args.includes('--headed') });
try {
  const page = context.pages()[0] || await context.newPage();
  await page.goto(url);
  await page.waitForTimeout(1000);
  await page.bringToFront();
  const extId = sw.url().split('/')[2];
  const resultUrl = `chrome-extension://${extId}/result.html`;
  const opened = context.waitForEvent('page', { predicate: (p) => p.url().startsWith(resultUrl), timeout: 900000 });
  const t0 = Date.now();
  const r = await sw.evaluate(async (u) => {
    const tab = (await chrome.tabs.query({})).find((t) => t.url === u);
    const r = await self.__runCapture(tab);
    return { error: r.error, width: r.width, height: r.height, size: r.size, warnings: r.warnings };
  }, url);
  if (r.error) throw new Error(r.error);
  console.log(`captured ${r.width}x${r.height}, ${(r.size / 1e6).toFixed(1)} MB, in ${Math.round((Date.now() - t0) / 1000)}s`);

  // The stored PNG, decoded here for reference.
  const stored = await (async () => {
    const parts = [];
    for (let i = 0; i < r.size; i += 8 << 20) {
      const b64 = await sw.evaluate(async ([a, b]) => {
        const u = new Uint8Array(await (await CaptureStore.get()).slice(a, b).arrayBuffer());
        let s = '';
        for (let i = 0; i < u.length; i += 0x8000) s += String.fromCharCode.apply(null, u.subarray(i, i + 0x8000));
        return btoa(s);
      }, [i, i + (8 << 20)]);
      parts.push(Buffer.from(b64, 'base64'));
    }
    return Buffer.concat(parts);
  })();
  const W = r.width, H = r.height;
  // RGBA rows [y, y + n) of the stored PNG, full width or [x, x + w).
  const ref = (y, n, x = 0, w = W) => sharp(stored, { limitInputPixels: false }).ensureAlpha().extract({ left: x, top: y, width: w, height: n }).raw().toBuffer();
  const same = (a, b) => {
    if (a.length !== b.length) return `length ${a.length} vs ${b.length}`;
    let d = 0;
    for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) d++;
    return d === 0 ? true : `${d} bytes differ`;
  };

  // 1. The capture shows.
  let rp = await opened;
  await rp.waitForLoadState('domcontentloaded');
  const t1 = Date.now();
  await rp.waitForFunction(() => document.querySelector('#status').hidden && pieces.length > 0 &&
    pieces.reduce((s, p) => s + p.height, 0) === naturalH && pieces.every((p) => p.img.complete), null, { timeout: 600000 });
  const view = await rp.evaluate(() => ({
    dims: document.querySelector('#dims').textContent, pieces: pieces.map((p) => [p.top, p.height, p.img.naturalWidth, p.img.naturalHeight]),
    notice: document.querySelector('#notice').hidden ? null : document.querySelector('#notice').innerText,
    shownHeight: document.querySelector('#pieces').getBoundingClientRect().height, shownWidth: document.querySelector('#pieces').getBoundingClientRect().width
  }));
  console.log(`  preview ready in ${Math.round((Date.now() - t1) / 1000)}s: ${view.pieces.length} piece(s)`);
  step(view.dims === `${W} × ${H}px`, 'dimensions shown', view.dims);
  step(view.pieces.every(([, h, nw, nh]) => nw === W && nh === h), 'every piece decoded at its size', JSON.stringify(view.pieces));
  step(Math.abs(view.shownHeight - H * view.shownWidth / W) < 2, 'whole height laid out', `${Math.round(view.shownHeight)}px shown for ${H} rows at ${Math.round(view.shownWidth)}px wide`);
  const hasWarn = (r.warnings || []).length > 0;
  step(hasWarn === !!view.notice, 'notice shown exactly when the capture has warnings', view.notice || 'none');
  if (view.notice) step(!/[a-z]+-[a-z]+|tile|px\)/.test(view.notice.replace(/\d[\d,]*px/g, '')), 'notice in plain words', view.notice);

  // 2. The pixels shown are the file's, across every piece and canvas edge.
  const rows = [0, H - 1];
  for (let e = 16384; e < H; e += 16384) rows.push(e - 1, e);
  for (let e = 65535; e < H; e += 65535) rows.push(e - 1, e);
  let rowBad = [];
  for (const y of [...new Set(rows)].sort((a, b) => a - b)) {
    const got = Buffer.from(await rp.evaluate((y) => {
      const c = new OffscreenCanvas(naturalW, 1);
      drawRegion(c.getContext('2d'), { x: 0, y, w: naturalW, h: 1 }, 0, 1);
      return Array.from(c.getContext('2d').getImageData(0, 0, naturalW, 1).data);
    }, y));
    const s = same(got, await ref(y, 1));
    if (s !== true) rowBad.push(`${y}: ${s}`);
  }
  step(rowBad.length === 0, `shown rows equal the file at piece and canvas edges (${rows.length} rows)`, rowBad.join('; '));
  await rp.screenshot({ path: path.join(outDir, `${name}-result-top.png`) });

  // 3. Select across the canvas edge (or the middle, for one canvas) with
  // the mouse, Crop, and check what is shown.
  const mid = H > 65535 ? 65535 : Math.floor(H / 2);
  const box = await rp.evaluate((mid) => {
    const s = displayScale();
    const o = document.querySelector('#overlay').getBoundingClientRect();
    window.scrollTo(0, o.top + scrollY + (mid - 700) * s - 300); // below the sticky toolbar
    const o2 = document.querySelector('#overlay').getBoundingClientRect();
    return { x0: o2.left + 100 * s, y0: o2.top + (mid - 700) * s, x1: o2.left + 2000 * s, y1: o2.top + (mid + 700) * s };
  }, mid);
  await rp.mouse.move(box.x0, box.y0);
  await rp.mouse.down();
  await rp.mouse.move(box.x1, box.y1, { steps: 8 });
  await rp.mouse.up();
  const region = await rp.evaluate(() => sel && wholeRegion(sel));
  step(!!region && region.y < mid && region.y + region.h > mid, 'selection spans the edge', JSON.stringify(region));
  await rp.click('#crop');
  await rp.waitForFunction((h) => naturalH === h && pieces.every((p) => p.img.complete) && document.querySelector('#status').hidden, region.h, { timeout: 120000 });
  const croppedDims = await rp.evaluate(() => document.querySelector('#dims').textContent);
  step(croppedDims === `${region.w} × ${region.h}px`, 'crop shown', croppedDims);

  // 4. Copy: the crop fits the clipboard.
  await rp.click('#copy');
  await rp.waitForFunction(() => document.querySelector('#toast').classList.contains('show'));
  const copied = await rp.evaluate(() => document.querySelector('#toast').textContent);
  step(/Copied/.test(copied), 'copy of the crop', copied);

  // 5. Download the crop (PNG) and compare with the file.
  await rp.selectOption('#format', 'png');
  const dl = rp.waitForEvent('download');
  await rp.click('#download');
  const cropFile = path.join(outDir, `${name}-crop.png`);
  await (await dl).saveAs(cropFile);
  {
    const got = await sharp(cropFile).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    const want = await ref(region.y, region.h, region.x, region.w);
    const s = same(got.data, want);
    const size = got.info.width === region.w && got.info.height === region.h;
    if (H > 65535) step(s === true && size, 'downloaded crop equals the file across the edge', `${got.info.width}x${got.info.height}; ${s}`);
    else {
      // One piece crops as it always has: the selection's fractional edges
      // are resampled, so the pixels are close, not equal.
      let d = 0;
      for (let i = 0; i < want.length; i++) d += Math.abs(got.data[i] - want[i]);
      d /= want.length;
      step(size && d < 12, 'downloaded crop is the selection (resampled as before)', `${got.info.width}x${got.info.height}; mean |Δ| ${d.toFixed(2)}`);
    }
  }
  await rp.waitForEvent('close', { timeout: 5000 }).catch(() => {});

  // 6. A fresh tab: Copy of the whole capture, and Download of the whole.
  rp = await context.newPage();
  await rp.goto(resultUrl);
  await rp.waitForFunction(() => document.querySelector('#status').hidden && pieces.length > 0 && pieces.every((p) => p.img.complete), null, { timeout: 600000 });
  if (H > 65535) {
    await rp.click('#copy');
    await rp.waitForFunction(() => document.querySelector('#toast').classList.contains('show'));
    const msg = await rp.evaluate(() => [document.querySelector('#toast').textContent, document.querySelector('#toast').classList.contains('error')]);
    step(/too tall to copy/i.test(msg[0]) && /download/i.test(msg[0]) && msg[1], 'copy of the whole tall capture refused in plain words', msg[0]);
    step(!rp.isClosed(), 'tab still alive after copy');
  }
  await rp.selectOption('#format', 'png');
  const dl2 = rp.waitForEvent('download');
  await rp.click('#download');
  const d2 = await dl2;
  const wholeFile = path.join(outDir, `${name}-whole.png`);
  await d2.saveAs(wholeFile);
  step(d2.suggestedFilename().endsWith('.png') && fs.readFileSync(wholeFile).equals(stored), 'downloaded whole PNG is the stored file, byte for byte', `${d2.suggestedFilename()}, ${fs.statSync(wholeFile).size} bytes`);

  // 7. JPG of the whole: one canvas holds it as JPG; a taller one is saved
  // as PNG and says so.
  rp = await context.newPage();
  await rp.goto(resultUrl);
  await rp.waitForFunction(() => document.querySelector('#status').hidden && pieces.length > 0 && pieces.every((p) => p.img.complete), null, { timeout: 600000 });
  await rp.selectOption('#format', 'jpg');
  const dl3 = rp.waitForEvent('download', { timeout: 600000 });
  await rp.click('#download');
  const d3 = await dl3;
  const msg3 = await rp.evaluate(() => document.querySelector('#toast').textContent).catch(() => '(tab closed)');
  const jpgFile = path.join(outDir, `${name}-as-jpg.${d3.suggestedFilename().split('.').pop()}`);
  await d3.saveAs(jpgFile);
  const m3 = await sharp(jpgFile, { limitInputPixels: false }).metadata();
  if (H > 65535) {
    const got = await sharp(jpgFile, { limitInputPixels: false }).ensureAlpha().raw().toBuffer();
    const s = same(got, await sharp(stored, { limitInputPixels: false }).ensureAlpha().raw().toBuffer());
    step(m3.format === 'png' && d3.suggestedFilename().endsWith('.png') && /PNG/.test(msg3) && s === true, 'JPG of a tall capture saved as PNG, said so, pixels equal', `${d3.suggestedFilename()} ${m3.format} ${m3.width}x${m3.height}; "${msg3}"; ${s}`);
  } else {
    step(m3.format === 'jpeg' && m3.height === H, 'JPG download', `${d3.suggestedFilename()} ${m3.format} ${m3.width}x${m3.height}`);
  }
} catch (e) {
  step(false, 'run', e.stack || e.message);
} finally {
  await context.close().catch(() => {});
  fs.rmSync(userDataDir, { recursive: true, force: true });
  fs.rmSync(ext.dir, { recursive: true, force: true });
  server.close();
}
console.log(`\n${failures ? `${failures} step(s) failed` : 'all steps passed'}; files in ${outDir}`);
process.exitCode = failures ? 1 : 0;
