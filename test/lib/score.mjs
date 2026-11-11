// Scorecard: how well the detectors' flags agree with a person's review of
// the same captures.
//
//   node test/run.mjs score --verdicts truth.tsv [--detectors stored|current|<git ref>] [--json out.json] <run dir...>
//
// The verdicts file is tab-separated with a header row and columns host,
// verdict (ok, minor, defect, blocked, environment) and optionally ranges:
// where the defects are, in CSS px of the capture, `;`-separated, each a
// range `y0-y1` or a single y (a seam) taken as y ± 40. Other columns are
// ignored.
//
// --detectors stored (default) scores the checks as the run recorded them.
// `current` re-runs the working tree's detectors on every site whose PNG
// was kept; a git ref re-runs that commit's (test/lib from it, into a temp
// folder). Sites without a PNG are left out of a rescore and counted.
//
// A flag is real when it is on a site judged defect or minor and overlaps
// one of its ranges (±60 px), or the site lists no ranges. A flag on a site
// judged ok, or off every range of a defective one, is false. Flags on
// blocked or environment pages are counted apart. Each range is one known
// defect; a detector catches it when one of its flags overlaps it.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { loadRuns, expandDirs } from './sweep.mjs';
import { rescore } from './analyze.mjs';
import { REPO } from './extension.mjs';

const TOL = 60;

export function readVerdicts(file) {
  const [head, ...rows] = fs.readFileSync(file, 'utf8').trim().split('\n').map((l) => l.split('\t'));
  const col = (n) => head.findIndex((h) => h.trim().toLowerCase() === n);
  const ih = col('host'), iv = col('verdict'), ir = col('ranges');
  if (ih < 0 || iv < 0) throw new Error(`${file}: needs host and verdict columns`);
  const out = new Map();
  for (const r of rows) {
    const v = (r[iv] || '').trim().toLowerCase();
    const verdict = v === 'env' ? 'environment' : v;
    const ranges = ir >= 0 && r[ir] ? r[ir].split(';').map((s) => s.trim()).filter(Boolean).map((s) => {
      const m = s.match(/^(\d+)(?:-(\d+))?$/);
      if (!m) throw new Error(`${file}: bad range "${s}" for ${r[ih]}`);
      return m[2] ? { y0: +m[1], y1: +m[2] } : { y0: +m[1] - 40, y1: +m[1] + 40 };
    }) : [];
    out.set(r[ih].trim(), { verdict, ranges });
  }
  return out;
}

async function loadDetectors(which) {
  if (which === 'current') return import('./detectors.mjs');
  // Another commit's detectors: its test/lib, written out whole so its own
  // relative imports resolve.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'detectors-'));
  const files = execFileSync('git', ['ls-tree', '--name-only', which, 'test/lib/'], { cwd: REPO }).toString().trim().split('\n');
  for (const f of files) fs.writeFileSync(path.join(dir, path.basename(f)), execFileSync('git', ['show', `${which}:${f}`], { cwd: REPO, maxBuffer: 16 << 20 }));
  // Its node_modules: the harness's own.
  fs.symlinkSync(path.join(REPO, 'node_modules'), path.join(dir, 'node_modules'));
  return import(path.join(dir, 'detectors.mjs'));
}

const overlaps = (f, r) => f.y0 <= r.y1 + TOL && f.y1 >= r.y0 - TOL;

export async function scorecard(dirs, truth, which = 'stored') {
  const recs = loadRuns(dirs);
  const detectors = which === 'stored' ? null : await loadDetectors(which);
  const D = {}; // per detector
  const sites = { scored: 0, noPng: [], notInTruth: [], noRecord: [] };
  const blocked = { truthBlocked: 0, saidBlocked: 0, both: 0, wrong: [], missed: [] };
  const issues = []; // { host, range, caughtBy: Set }
  const okScored = [], badScored = [];
  const falseFlags = [], realFlags = [];
  const det = (n) => D[n] ||= { flags: 0, real: 0, falseOk: 0, falseOff: 0, other: 0, okSites: new Set(), defectSites: new Set(), caught: 0 };

  for (const [host, t] of truth) {
    const rec = recs.get(host);
    if (!rec) { sites.noRecord.push(host); continue; }
    // Blocked pages, as the harness judged them.
    const said = rec.verdict === 'blocked';
    if (t.verdict === 'blocked') blocked.truthBlocked++;
    if (said) blocked.saidBlocked++;
    if (said && t.verdict === 'blocked') blocked.both++;
    else if (said) blocked.wrong.push(`${host} (${rec.blocked})`);
    else if (t.verdict === 'blocked') blocked.missed.push(host);
    if (said || rec.verdict === 'error') continue;

    let checks = rec.checks || {};
    if (detectors) {
      const c = await rescore(rec, rec.dir, detectors);
      if (!c) { sites.noPng.push(host); continue; }
      checks = c;
    }
    sites.scored++;
    const isBad = t.verdict === 'defect' || t.verdict === 'minor';
    if (t.verdict === 'ok') okScored.push(host);
    if (isBad) badScored.push(host);
    const siteIssues = isBad ? (t.ranges.length ? t.ranges : [{ y0: -1e9, y1: 1e9, whole: true }]).map((r) => ({ host, range: r, caughtBy: new Set() })) : [];
    issues.push(...siteIssues);
    for (const [name, c] of Object.entries(checks)) {
      if (c.kind && c.kind !== 'generic') continue;
      if (c.pass) { det(name); continue; }
      const flags = (c.flags && c.flags.length) ? c.flags : [{ y0: 0, y1: 1e9, note: c.detail }];
      const d = det(name);
      for (const f of flags) {
        d.flags++;
        if (t.verdict === 'blocked' || t.verdict === 'environment') { d.other++; continue; }
        if (t.verdict === 'ok') { d.falseOk++; d.okSites.add(host); falseFlags.push({ host, name, ...f, why: 'site judged ok' }); continue; }
        const hit = siteIssues.filter((i) => overlaps(f, i.range));
        if (hit.length) { d.real++; d.defectSites.add(host); realFlags.push({ host, name, ...f }); for (const i of hit) i.caughtBy.add(name); }
        else { d.falseOff++; falseFlags.push({ host, name, ...f, why: 'off every known defect on the site' }); }
      }
    }
  }
  for (const i of issues) for (const n of i.caughtBy) D[n].caught++;
  for (const host of recs.keys()) if (!truth.has(host)) sites.notInTruth.push(host);
  return { which, sites, blocked, D, issues, okScored, badScored, falseFlags, realFlags };
}

const pct = (a, b) => b ? `${Math.round(100 * a / b)}%` : '-';
const pad = (s, n) => String(s).padEnd(n);

export function formatScorecard(s) {
  const L = [];
  const nIssues = s.issues.length;
  L.push(`Detectors: ${s.which}. Scored ${s.sites.scored} sites: ${s.badScored.length} judged defect/minor (${nIssues} known defects), ${s.okScored.length} judged ok.`);
  if (s.sites.noPng.length) L.push(`Left out, no PNG to rescore: ${s.sites.noPng.length} sites.`);
  if (s.sites.noRecord.length) L.push(`In the verdicts but not in these runs: ${s.sites.noRecord.length} sites.`);
  L.push('');
  L.push(`${pad('detector', 18)} ${pad('flags', 6)} ${pad('real', 5)} ${pad('false', 6)} ${pad('(on ok', 7)} ${pad('off-range)', 11)} ${pad('blocked/env', 12)} ${pad('precision', 10)} ${pad('caught', 8)} ${pad('recall', 7)} ok sites flagged`);
  const rows = Object.entries(s.D).sort((a, b) => b[1].flags - a[1].flags);
  for (const [n, d] of rows) {
    const fal = d.falseOk + d.falseOff;
    L.push(`${pad(n, 18)} ${pad(d.flags, 6)} ${pad(d.real, 5)} ${pad(fal, 6)} ${pad(d.falseOk, 7)} ${pad(d.falseOff, 11)} ${pad(d.other, 12)} ${pad(pct(d.real, d.real + fal), 10)} ${pad(`${d.caught}/${nIssues}`, 8)} ${pad(pct(d.caught, nIssues), 7)} ${d.okSites.size}/${s.okScored.length}`);
  }
  const all = rows.reduce((a, [, d]) => ({ flags: a.flags + d.flags, real: a.real + d.real, fal: a.fal + d.falseOk + d.falseOff, other: a.other + d.other }), { flags: 0, real: 0, fal: 0, other: 0 });
  const caught = s.issues.filter((i) => i.caughtBy.size).length;
  const okFlagged = new Set(rows.flatMap(([, d]) => [...d.okSites])).size;
  const badCaught = new Set(s.issues.filter((i) => i.caughtBy.size).map((i) => i.host)).size;
  L.push(`${pad('all', 18)} ${pad(all.flags, 6)} ${pad(all.real, 5)} ${pad(all.fal, 6)} ${pad('', 7)} ${pad('', 11)} ${pad(all.other, 12)} ${pad(pct(all.real, all.real + all.fal), 10)} ${pad(`${caught}/${nIssues}`, 8)} ${pad(pct(caught, nIssues), 7)} ${okFlagged}/${s.okScored.length}`);
  L.push('', `Defective sites with at least one real flag: ${badCaught}/${s.badScored.length}. Sites judged ok with any flag: ${okFlagged}/${s.okScored.length}.`);
  const b = s.blocked;
  L.push(`Blocked pages: ${b.truthBlocked} judged blocked, harness said blocked on ${b.saidBlocked}; agreed on ${b.both}.${b.missed.length ? ` Missed: ${b.missed.join(', ')}.` : ''}${b.wrong.length ? ` Said blocked but judged otherwise: ${b.wrong.join(', ')}.` : ''}`);
  const missed = s.issues.filter((i) => !i.caughtBy.size);
  if (missed.length) {
    L.push('', `Known defects no detector caught (${missed.length}):`);
    for (const i of missed) L.push(`  ${pad(i.host, 40)} ${i.range.whole ? 'site' : `${i.range.y0}-${i.range.y1}`}`);
  }
  if (s.falseFlags.length) {
    L.push('', `False flags (${s.falseFlags.length}):`);
    for (const f of s.falseFlags) L.push(`  ${pad(f.host, 40)} ${pad(f.name, 17)} ${f.y0}-${f.y1} ${String(f.note || '').slice(0, 90)}`);
  }
  return L.join('\n');
}

export async function scoreMain(argv) {
  let verdicts = null, which = 'stored', json = null;
  const dirs = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--verdicts') verdicts = argv[++i];
    else if (argv[i] === '--detectors') which = argv[++i];
    else if (argv[i] === '--json') json = argv[++i];
    else dirs.push(argv[i]);
  }
  if (!verdicts || !dirs.length) { console.error('usage: run.mjs score --verdicts file.tsv [--detectors stored|current|<git ref>] [--json out.json] <run dir...>'); return 2; }
  const s = await scorecard(expandDirs(dirs), readVerdicts(verdicts), which);
  console.log(formatScorecard(s));
  if (json) fs.writeFileSync(json, JSON.stringify(s, (k, v) => (v instanceof Set ? [...v] : v), 2));
  return 0;
}
