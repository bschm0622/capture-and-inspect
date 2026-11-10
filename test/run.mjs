#!/usr/bin/env node
// Capture regression harness. Drives the real extension in Chromium over the
// regression set (test/sites.mjs) and checks each stitched capture for
// defects. See test/README.md.
//
//   node test/run.mjs                      # working tree, all sites
//   node test/run.mjs --site instant.ai    # one site (repeatable / comma list)
//   node test/run.mjs --ref b2d7f6e        # an older commit of the extension
//   node test/run.mjs --url https://x.com  # any page, generic detectors only
//   node test/run.mjs --urls list.txt      # one URL per line, generic only
//   --headed  --jobs 2  --label name  --timeout 240

import fs from 'node:fs';
import path from 'node:path';
import { buildExtension, describeRef, REPO } from './lib/extension.mjs';
import { captureSite, VIEWPORT, DPR } from './lib/capture.mjs';
import { loadCapture, preview } from './lib/image.mjs';
import { runGeneric, tileRects } from './lib/detectors.mjs';
import { writeReport } from './lib/report.mjs';
import { SITES } from './sites.mjs';

function parseArgs(argv) {
  const a = { sites: [], urls: [], ref: null, headed: false, jobs: 1, label: '', timeout: 240 };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i], v = () => argv[++i];
    if (k === '--site') a.sites.push(...v().split(','));
    else if (k === '--ref') a.ref = v();
    else if (k === '--url') a.urls.push(v());
    else if (k === '--urls') a.urls.push(...fs.readFileSync(v(), 'utf8').split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('#')));
    else if (k === '--headed') a.headed = true;
    else if (k === '--jobs') a.jobs = Math.max(1, +v());
    else if (k === '--label') a.label = v();
    else if (k === '--timeout') a.timeout = +v();
    else { console.error(`unknown argument ${k}`); process.exit(2); }
  }
  return a;
}

const args = parseArgs(process.argv.slice(2));
let sites;
if (args.urls.length) {
  sites = args.urls.map((u) => ({ host: new URL(u).host, url: u }));
} else {
  sites = args.sites.length
    ? SITES.filter((s) => args.sites.some((q) => s.host === q || s.host === `www.${q}` || s.host.includes(q)))
    : SITES;
}
if (!sites.length) { console.error('no matching sites'); process.exit(2); }

const startedAt = new Date();
const stamp = startedAt.toISOString().replace(/[:]/g, '-').replace(/\..+/, '');
const tag = args.label || (args.ref ? args.ref.replace(/[^\w.-]/g, '_') : 'worktree');
const outDir = path.join(REPO, 'test', 'out', `${stamp}-${tag}`);
fs.mkdirSync(outDir, { recursive: true });

const ext = buildExtension(args.ref);
const extension = describeRef(args.ref);
console.log(`extension: ${extension}\nloaded from ${ext.dir}\nout: ${outDir}\n`);

async function checkSite(site) {
  const cap = await captureSite(ext.dir, site, { headless: !args.headed, timeoutMs: args.timeout * 1000 });
  const rec = {
    host: site.host, url: site.url, pass: false, durationMs: cap.durationMs,
    // From the start: page loaded, and capture returned (load + prepare + tiles).
    phases: cap.phases || null,
    tileCount: cap.tileCount ?? null, error: cap.error || null, navRetry: cap.navRetry || null,
    checks: {}, browserVersion: cap.browserVersion
  };
  if (!cap.ok) return rec;
  const file = site.host.replace(/[^\w.-]/g, '_');
  fs.writeFileSync(path.join(outDir, `${file}.png`), cap.png);
  fs.writeFileSync(path.join(outDir, `${file}.preview.jpg`), await preview(cap.png, 260));
  rec.png = `${file}.png`;
  rec.preview = `${file}.preview.jpg`;
  if (cap.shot) {
    fs.writeFileSync(path.join(outDir, `${file}.first-screen.jpg`), await preview(cap.shot, 1388));
    rec.firstScreen = `${file}.first-screen.jpg`;
  }

  const img = await loadCapture(cap.png, DPR);
  const tiles = tileRects(cap);
  rec.capture = { devWidth: img.devWidth, devHeight: img.devHeight, cssWidth: img.cssWidth, cssHeight: img.H };
  rec.tileTops = tiles.map((t) => t.y);
  // What the content script reported for each tile: where it was asked to
  // scroll, where it landed and how tall the page was at that moment.
  rec.prepare = cap.prepare || null;
  rec.tileLog = (cap.tiles || []).map(({ ok, ...t }) => t);
  // The extension's own report on the capture (null before it had one), and
  // where it placed each shot.
  rec.warnings = cap.warnings ?? null;
  rec.placements = cap.placements ?? null;
  rec.pageFacts = { before: cap.factsBefore, after: cap.factsAfter };
  rec.siteFacts = cap.siteFacts || null;

  for (const [name, r] of Object.entries(runGeneric(img, cap))) rec.checks[name] = { kind: 'generic', ...r };
  const vh = cap.prepare ? cap.prepare.viewportHeight : VIEWPORT.height;
  const shot = cap.shot ? await loadCapture(cap.shot, DPR) : null;
  for (const [name, fn] of Object.entries(site.checks || {})) {
    try {
      if (cap.siteFacts && cap.siteFacts.error) throw new Error(`collect failed: ${cap.siteFacts.error}`);
      rec.checks[name] = { kind: 'site', ...fn({ img, cap, tiles, vh, shot, facts: cap.siteFacts || {} }) };
    } catch (e) {
      rec.checks[name] = { kind: 'site', pass: false, value: null, detail: `check error: ${e.message}`, flags: [] };
    }
  }
  rec.pass = Object.values(rec.checks).every((c) => c.pass);
  return rec;
}

const results = new Array(sites.length);
const queue = sites.map((s, i) => [s, i]);
await Promise.all(Array.from({ length: Math.min(args.jobs, sites.length) }, async () => {
  while (queue.length) {
    const [site, i] = queue.shift();
    let rec;
    try { rec = await checkSite(site); } catch (e) { rec = { host: site.host, url: site.url, pass: false, error: `harness: ${e.message}`, checks: {} }; }
    results[i] = rec;
    const failing = Object.entries(rec.checks).filter(([, c]) => !c.pass).map(([n]) => n);
    console.log(`${rec.pass ? 'PASS' : 'FAIL'} ${site.host.padEnd(30)} ${rec.error ? `error: ${rec.error}` : failing.length ? `failing: ${failing.join(', ')}` : ''} (${Math.round((rec.durationMs || 0) / 1000)}s)`);
    for (const w of rec.warnings || []) console.log(`     warning ${w.kind} y ${w.y0}-${w.y1}: ${w.note}`);
  }
}));

const run = {
  startedAt: startedAt.toISOString(), durationMs: Date.now() - startedAt, extension, ref: args.ref,
  mode: args.headed ? 'headed' : 'headless (new)', browserVersion: results.find((r) => r.browserVersion)?.browserVersion || '?',
  viewport: { ...VIEWPORT, dpr: DPR }, sites: results
};
fs.writeFileSync(path.join(outDir, 'results.json'), JSON.stringify(run, null, 2));
writeReport(outDir, run);
fs.rm(ext.dir, { recursive: true, force: true }, () => {});

const failed = results.filter((r) => !r.pass).length;
console.log(`\n${failed ? `${failed}/${results.length} sites failed` : 'all sites passed'} in ${Math.round(run.durationMs / 1000)}s\nreport: ${path.join(outDir, 'report.html')}`);
process.exitCode = failed ? 1 : 0;
