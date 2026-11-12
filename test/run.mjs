#!/usr/bin/env node
// Capture regression harness. Drives the real extension in Chromium over the
// regression set (test/sites.mjs) or any URL list and checks each stitched
// capture for defects. See test/README.md.
//
//   node test/run.mjs                      # working tree, all regression sites
//   node test/run.mjs --site instant.ai    # one site (repeatable / comma list)
//   node test/run.mjs --ref b2d7f6e        # an older commit of the extension
//   node test/run.mjs --url https://x.com  # any page, generic detectors only
//   node test/run.mjs --urls list.txt      # one URL per line, generic only
//   node test/run.mjs --fixtures           # the synthetic pages in test/fixtures
//   --overlay dir                          # extension files from dir replace the copied ones
//   --headed  --jobs 2  --label name  --timeout 240  --out dir  --keep-png all|failing|none
//
//   node test/run.mjs summary <run dir...>            # a sweep's summary
//   node test/run.mjs compare <dirs A> <dirs B>       # two sweeps site by site
//   node test/run.mjs score --verdicts v.tsv <dir...> # detector precision/recall

import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { buildExtension, describeRef, REPO } from './lib/extension.mjs';
import { captureSite, VIEWPORT, DPR } from './lib/capture.mjs';
import * as detectors from './lib/detectors.mjs';
import { recordCapture, fileFor, verdictOf } from './lib/analyze.mjs';
import { writeReport } from './lib/report.mjs';
import { loadRuns, expandDirs, summarize, formatSummary, compare, formatCompare } from './lib/sweep.mjs';
import { SITES } from './sites.mjs';
import { FIXTURES, fixtureHost } from './fixtures/fixtures.mjs';

const SELF = fileURLToPath(import.meta.url);
const FIXTURE_DIR = path.join(path.dirname(SELF), 'fixtures');

// Children run in their own process groups (so a hung one can be killed
// with its browser); if the run itself is stopped, take them down too.
const children = new Set();
for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
  process.on(sig, () => {
    for (const pid of children) { try { process.kill(-pid, 'SIGKILL'); } catch {} }
    process.exit(130);
  });
}
const sub = process.argv[2];

if (sub === 'summary') {
  const dirs = expandDirs(process.argv.slice(3));
  if (!dirs.length) { console.error('usage: run.mjs summary <run dir...>'); process.exit(2); }
  console.log(formatSummary(summarize(loadRuns(dirs))));
} else if (sub === 'compare') {
  const [a, b] = process.argv.slice(3);
  if (!a || !b) { console.error('usage: run.mjs compare <dir[,dir...]> <dir[,dir...]>  (a folder of run folders counts as all of them)'); process.exit(2); }
  console.log(formatCompare(compare(loadRuns(expandDirs([a])), loadRuns(expandDirs([b])))));
} else if (sub === 'score') {
  const { scoreMain } = await import('./lib/score.mjs');
  process.exitCode = await scoreMain(process.argv.slice(3));
} else if (sub === '--child') {
  await child(JSON.parse(process.argv[3]));
} else {
  await main(process.argv.slice(2));
}

function parseArgs(argv) {
  const a = { sites: [], urls: [], ref: null, headed: false, jobs: 1, label: '', timeout: null, out: null, keepPng: null, honest: true, captureBlocked: false, retryErrors: false, fixtures: false, overlay: null };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i], v = () => argv[++i];
    if (k === '--site') a.sites.push(...v().split(','));
    else if (k === '--fixtures') a.fixtures = true;
    else if (k === '--overlay') a.overlay = v();
    else if (k === '--ref') a.ref = v();
    else if (k === '--url') a.urls.push(v());
    else if (k === '--urls') a.urls.push(...fs.readFileSync(v(), 'utf8').split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('#')));
    else if (k === '--headed') a.headed = true;
    else if (k === '--jobs') a.jobs = Math.max(1, +v());
    else if (k === '--label') a.label = v();
    else if (k === '--timeout') a.timeout = +v();
    else if (k === '--out') a.out = v();
    else if (k === '--keep-png') { a.keepPng = v(); if (!['all', 'failing', 'none'].includes(a.keepPng)) { console.error('--keep-png all|failing|none'); process.exit(2); } }
    else if (k === '--headless-ua') a.honest = false;
    else if (k === '--capture-blocked') a.captureBlocked = true;
    else if (k === '--retry-errors') a.retryErrors = true;
    else { console.error(`unknown argument ${k}`); process.exit(2); }
  }
  return a;
}

// One site in its own process: a page that hangs the browser or the
// renderer can be killed with everything it started, and the run goes on.
async function child({ site, extDir, outDir, timeout, headed, keepPng, honest, captureBlocked, regression, fixtures }) {
  const full = fixtures ? FIXTURES.find((f) => fixtureHost(f.name) === site.host)
    : regression ? SITES.find((s) => s.host === site.host) : null;
  // (A fixture's URL is only known once its server is up.)
  const s = full ? { ...full, host: site.host, url: site.url } : site;
  let cap = await captureSite(extDir, s, { headless: !headed, timeoutMs: timeout * 1000, honest, captureBlocked });
  // Turned away: try once with the other user agent. Some walls refuse
  // Chromium's "HeadlessChrome", others a Chrome user agent from a browser
  // whose client hints say Chromium; the record keeps the one that got in.
  if (cap.blocked && cap.blocked.blocked) {
    const again = await captureSite(extDir, s, { headless: !headed, timeoutMs: timeout * 1000, honest: !honest, captureBlocked });
    const tried = [{ ua: honest ? 'desktop' : 'headless', blocked: cap.blocked.reason }];
    if (again.ok && !(again.blocked && again.blocked.blocked)) cap = again;
    else tried.push({ ua: honest ? 'headless' : 'desktop', blocked: again.blocked ? again.blocked.reason : again.error });
    cap.uaTried = tried;
  }
  cap.ua = cap.uaTried && cap.uaTried.length === 1 ? (honest ? 'headless' : 'desktop') : (honest ? 'desktop' : 'headless');
  let rec;
  try {
    rec = await recordCapture(s, cap, outDir, detectors, { keepPng });
  } catch (e) {
    rec = { host: s.host, url: s.url, pass: false, verdict: 'error', error: `harness: ${e.message}`, checks: {}, durationMs: cap.durationMs };
  }
  fs.writeFileSync(path.join(outDir, 'sites', `${fileFor(s.host)}.json`), JSON.stringify(rec));
}

function runChild(payload, hardMs) {
  return new Promise((resolve) => {
    const p = spawn(process.execPath, [SELF, '--child', JSON.stringify(payload)], { stdio: ['ignore', 'inherit', 'pipe'], detached: true });
    children.add(p.pid);
    p.on('exit', () => children.delete(p.pid));
    let err = '';
    p.stderr.on('data', (d) => { err = (err + d).slice(-2000); });
    const t = setTimeout(() => { try { process.kill(-p.pid, 'SIGKILL'); } catch {} resolve({ killed: true, err }); }, hardMs);
    p.on('exit', (code, signal) => { clearTimeout(t); resolve({ code, signal, err }); });
  });
}

// The fixture pages, served on 127.0.0.1 for as long as the run lasts.
// Plain files only, from test/fixtures.
async function serveFixtures() {
  const http = await import('node:http');
  const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml' };
  const server = http.createServer((req, res) => {
    const name = path.basename(decodeURIComponent(new URL(req.url, 'http://x').pathname));
    const file = path.join(FIXTURE_DIR, name);
    if (!name || !fs.existsSync(file) || !types[path.extname(name)]) { res.writeHead(404); res.end('not found'); return; }
    res.writeHead(200, { 'content-type': types[path.extname(name)], 'cache-control': 'no-store' });
    fs.createReadStream(file).pipe(res);
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return server;
}

async function main(argv) {
  const args = parseArgs(argv);
  const regression = !args.urls.length && !args.fixtures;
  // The tall fixtures take 50+ tiles; a live page rarely needs 4 minutes.
  if (args.timeout == null) args.timeout = args.fixtures ? 600 : 240;
  let sites, server = null;
  if (args.fixtures) {
    server = await serveFixtures();
    const port = server.address().port;
    sites = FIXTURES
      .filter((f) => !args.sites.length || args.sites.some((q) => f.name.includes(q)))
      .map((f) => ({ host: fixtureHost(f.name), url: `http://127.0.0.1:${port}/${f.file}` }));
  } else if (args.urls.length) {
    sites = args.urls.map((u) => ({ host: new URL(u).host, url: u }));
  } else {
    sites = args.sites.length
      ? SITES.filter((s) => args.sites.some((q) => s.host === q || s.host === `www.${q}` || s.host.includes(q)))
      : SITES;
  }
  if (!sites.length) { console.error('no matching sites'); process.exit(2); }
  const keepPng = args.keepPng || (regression || args.fixtures ? 'all' : 'failing');

  const startedAt = new Date();
  const stamp = startedAt.toISOString().replace(/[:]/g, '-').replace(/\..+/, '');
  const tag = args.label || [args.fixtures ? 'fixtures' : '', args.ref ? args.ref.replace(/[^\w.-]/g, '_') : 'worktree'].filter(Boolean).join('-');
  const outDir = args.out ? path.resolve(args.out) : path.join(REPO, 'test', 'out', `${stamp}-${tag}`);
  fs.mkdirSync(path.join(outDir, 'sites'), { recursive: true });

  const overlay = args.overlay ? path.resolve(args.overlay) : null;
  const extension = describeRef(args.ref, overlay);
  // A folder that already has a run: resume it, with the same extension.
  const metaFile = path.join(outDir, 'run.json');
  if (fs.existsSync(metaFile)) {
    const prev = JSON.parse(fs.readFileSync(metaFile, 'utf8'));
    if (prev.ref !== args.ref) { console.error(`${outDir} was run with --ref ${prev.ref}; resume it with the same ref`); process.exit(2); }
    if ((prev.overlay || null) !== overlay) { console.error(`${outDir} was run with --overlay ${prev.overlay || '(none)'}; resume it with the same overlay`); process.exit(2); }
  } else {
    fs.writeFileSync(metaFile, JSON.stringify({ startedAt: startedAt.toISOString(), extension, ref: args.ref, overlay, keepPng, honestUA: args.honest }, null, 2));
  }
  const done = loadRuns([outDir]);
  const todo = sites.filter((s) => {
    const r = done.get(s.host);
    if (!r) return true;
    return r.verdict === 'error' && (args.retryErrors || !r.retried);
  });

  const ext = buildExtension(args.ref, overlay);
  console.log(`extension: ${extension}\nloaded from ${ext.dir}\nout: ${outDir}`);
  if (todo.length < sites.length) console.log(`resuming: ${sites.length - todo.length} of ${sites.length} sites already done`);
  console.log('');

  const hardMs = (args.timeout + 240) * 1000; // capture timeout + navigation and analysis
  const queue = todo.slice();
  await Promise.all(Array.from({ length: Math.min(args.jobs, queue.length) }, async () => {
    while (queue.length) {
      const site = queue.shift();
      const recFile = path.join(outDir, 'sites', `${fileFor(site.host)}.json`);
      const prev = done.get(site.host);
      if (fs.existsSync(recFile)) fs.rmSync(recFile);
      const t0 = Date.now();
      const r = await runChild({ site: { host: site.host, url: site.url }, extDir: ext.dir, outDir, timeout: args.timeout, headed: args.headed, keepPng, honest: args.honest, captureBlocked: args.captureBlocked, regression, fixtures: args.fixtures }, hardMs);
      let rec;
      if (fs.existsSync(recFile)) rec = JSON.parse(fs.readFileSync(recFile, 'utf8'));
      else {
        const why = r.killed ? `harness: no result after ${Math.round((Date.now() - t0) / 1000)}s; killed` : `harness: process exited (${r.signal || r.code}) without a result: ${(r.err || '').trim().split('\n').pop()}`;
        rec = { host: site.host, url: site.url, pass: false, verdict: 'error', error: why, checks: {}, durationMs: Date.now() - t0 };
      }
      if (rec.verdict === 'error' && prev && prev.verdict === 'error') rec.retried = true;
      fs.writeFileSync(recFile, JSON.stringify(rec));
      const failingChecks = Object.entries(rec.checks || {}).filter(([, c]) => !c.pass).map(([n]) => n);
      const what = rec.verdict === 'error' ? `error: ${rec.error}` : rec.verdict === 'blocked' ? `blocked: ${rec.blocked}` : failingChecks.length ? `failing: ${failingChecks.join(', ')}` : '';
      console.log(`${rec.verdict.toUpperCase().padEnd(7)} ${site.host.padEnd(30)} ${what} (${Math.round((rec.durationMs || 0) / 1000)}s)`);
      for (const w of rec.warnings || []) console.log(`        warning ${w.kind} y ${w.y0}-${w.y1}: ${w.note}`);
    }
  }));
  fs.rm(ext.dir, { recursive: true, force: true }, () => {});
  if (server) server.close();

  // The whole run: every site asked for, in order, from the records on disk.
  const all = loadRuns([outDir]);
  const results = sites.map((s) => all.get(s.host)).filter(Boolean).map(({ dir, ...r }) => r);
  const meta = JSON.parse(fs.readFileSync(metaFile, 'utf8'));
  const run = {
    startedAt: meta.startedAt, durationMs: Date.now() - Date.parse(meta.startedAt), extension, ref: args.ref,
    mode: args.headed ? 'headed' : 'headless (new)', browserVersion: results.find((r) => r.browserVersion)?.browserVersion || '?',
    viewport: { ...VIEWPORT, dpr: DPR }, sites: results
  };
  fs.writeFileSync(path.join(outDir, 'results.json'), JSON.stringify(run, null, 2));
  writeReport(outDir, run);
  const summary = summarize(new Map(results.map((r) => [r.host, r])));
  fs.writeFileSync(path.join(outDir, 'summary.json'), JSON.stringify(summary, null, 2));
  const text = formatSummary(summary);
  fs.writeFileSync(path.join(outDir, 'summary.txt'), text + '\n');
  console.log(`\n${text}\n\nreport: ${path.join(outDir, 'report.html')}`);

  // Failures and errors fail the run. A blocked site fails it only in the
  // regression set, where it means a check could not run; in a sweep it is
  // listed and left out.
  const bad = results.filter((r) => r.verdict === 'fail' || r.verdict === 'error' || ((regression || args.fixtures) && r.verdict === 'blocked')).length;
  process.exitCode = bad || results.length < sites.length ? 1 : 0;
}
