// Reading run folders, and the two views of a sweep: its summary and a
// site-by-site comparison of two sweeps.
//
// A run folder keeps one record per site in sites/<host>.json, written as
// soon as the site is done (that is what makes a sweep resumable), and
// results.json with all of them once the run ends. Older folders have only
// results.json; both are read.

import fs from 'node:fs';
import path from 'node:path';
import { verdictOf } from './analyze.mjs';

// Records from one or more run folders, by host; a later folder's record
// for a host replaces an earlier one's. Each record gets `dir`.
export function loadRuns(dirs) {
  const byHost = new Map();
  for (const dir of dirs) {
    const sitesDir = path.join(dir, 'sites');
    let recs = [];
    if (fs.existsSync(sitesDir)) {
      recs = fs.readdirSync(sitesDir).filter((f) => f.endsWith('.json'))
        .map((f) => { try { return JSON.parse(fs.readFileSync(path.join(sitesDir, f), 'utf8')); } catch { return null; } })
        .filter(Boolean);
    } else if (fs.existsSync(path.join(dir, 'results.json'))) {
      recs = JSON.parse(fs.readFileSync(path.join(dir, 'results.json'), 'utf8')).sites.filter(Boolean);
    }
    for (const r of recs) {
      r.dir = dir;
      if (!r.verdict) r.verdict = verdictOf(r);
      byHost.set(r.host, r);
    }
  }
  return byHost;
}

// Folder arguments may be comma lists, and a folder may hold run folders
// (a sweep run in batches), in which case every one inside counts.
export function expandDirs(args) {
  const out = [];
  for (const a of args.flatMap((x) => x.split(','))) {
    if (!a) continue;
    if (fs.existsSync(path.join(a, 'results.json')) || fs.existsSync(path.join(a, 'sites'))) out.push(a);
    else if (fs.existsSync(a) && fs.statSync(a).isDirectory()) {
      for (const d of fs.readdirSync(a).sort()) {
        const p = path.join(a, d);
        if (fs.existsSync(path.join(p, 'results.json')) || fs.existsSync(path.join(p, 'sites'))) out.push(p);
      }
    }
  }
  return out;
}

const failing = (r) => Object.entries(r.checks || {}).filter(([, c]) => !c.pass).map(([n]) => n);
const secs = (ms) => ms == null ? '-' : `${Math.round(ms / 1000)}s`;
const pad = (s, n) => String(s).padEnd(n);

export function summarize(byHost) {
  const recs = [...byHost.values()];
  const counts = { pass: 0, fail: 0, blocked: 0, error: 0 };
  for (const r of recs) counts[r.verdict] = (counts[r.verdict] || 0) + 1;
  const byCheck = {};
  for (const r of recs) {
    if (r.verdict === 'blocked' || r.verdict === 'error') continue;
    for (const [n, c] of Object.entries(r.checks || {})) {
      if (c.pass) continue;
      const e = byCheck[n] ||= { sites: [], flags: 0 };
      e.sites.push(r.host);
      e.flags += (c.flags || []).length || 1;
    }
  }
  const warnings = {};
  for (const r of recs) {
    for (const w of r.warnings || []) {
      const e = warnings[w.kind] ||= { sites: new Set(), count: 0 };
      e.sites.add(r.host); e.count++;
    }
  }
  const timed = recs.filter((r) => r.durationMs != null);
  const total = timed.reduce((s, r) => s + r.durationMs, 0);
  const sorted = [...timed].sort((a, b) => b.durationMs - a.durationMs);
  const median = (a) => a.length ? a[a.length >> 1] : null;
  return {
    sites: recs.length, counts,
    checks: Object.fromEntries(Object.entries(byCheck).sort((a, b) => b[1].sites.length - a[1].sites.length)),
    warnings: Object.fromEntries(Object.entries(warnings).map(([k, v]) => [k, { sites: [...v.sites], count: v.count }])),
    time: {
      totalMs: total, medianMs: median(timed.map((r) => r.durationMs).sort((a, b) => a - b)),
      medianCaptureMs: median(timed.filter((r) => r.captureMs != null).map((r) => r.captureMs).sort((a, b) => a - b)),
      slowest: sorted.slice(0, 10).map((r) => ({ host: r.host, durationMs: r.durationMs, captureMs: r.captureMs ?? null, tiles: r.tileCount ?? null }))
    },
    blocked: recs.filter((r) => r.verdict === 'blocked').map((r) => ({ host: r.host, reason: r.blocked })),
    errors: recs.filter((r) => r.verdict === 'error').map((r) => ({ host: r.host, error: r.error })),
    failing: recs.filter((r) => r.verdict === 'fail').map((r) => ({ host: r.host, checks: failing(r) }))
  };
}

export function formatSummary(s) {
  const L = [];
  L.push(`${s.sites} sites: ${s.counts.pass} pass, ${s.counts.fail} fail, ${s.counts.blocked} blocked, ${s.counts.error} error`);
  L.push('', 'Flags by check (sites / flagged ranges):');
  if (!Object.keys(s.checks).length) L.push('  none');
  for (const [n, e] of Object.entries(s.checks)) L.push(`  ${pad(n, 28)} ${pad(e.sites.length, 4)} ${pad(e.flags, 5)} ${e.sites.slice(0, 8).join(', ')}${e.sites.length > 8 ? ', ...' : ''}`);
  L.push('', 'Extension warnings (sites / count):');
  if (!Object.keys(s.warnings).length) L.push('  none');
  for (const [k, e] of Object.entries(s.warnings)) L.push(`  ${pad(k, 28)} ${pad(e.sites.length, 4)} ${pad(e.count, 5)} ${e.sites.slice(0, 8).join(', ')}${e.sites.length > 8 ? ', ...' : ''}`);
  L.push('', `Time: ${secs(s.time.totalMs)} in all; median ${secs(s.time.medianMs)} a site, of which capture ${secs(s.time.medianCaptureMs)}. Slowest:`);
  for (const t of s.time.slowest) L.push(`  ${pad(t.host, 40)} ${pad(secs(t.durationMs), 6)} capture ${pad(secs(t.captureMs), 6)} ${t.tiles ?? '-'} tiles`);
  if (s.blocked.length) { L.push('', 'Blocked:'); for (const b of s.blocked) L.push(`  ${pad(b.host, 40)} ${b.reason}`); }
  if (s.errors.length) { L.push('', 'Errors:'); for (const e of s.errors) L.push(`  ${pad(e.host, 40)} ${e.error}`); }
  if (s.failing.length) { L.push('', 'Failing:'); for (const f of s.failing) L.push(`  ${pad(f.host, 40)} ${f.checks.join(', ')}`); }
  return L.join('\n');
}

// Site by site, A then B. Only hosts in both are compared; the rest are
// listed.
export function compare(A, B) {
  const both = [...A.keys()].filter((h) => B.has(h)).sort();
  const rows = { newFail: [], fixed: [], stillFail: [], newBlocked: [], unblocked: [], newError: [], errorGone: [], same: 0 };
  const dur = [];
  for (const h of both) {
    const a = A.get(h), b = B.get(h);
    const fa = failing(a), fb = failing(b);
    const row = { host: h, a: a.verdict, b: b.verdict, added: fb.filter((n) => !fa.includes(n)), removed: fa.filter((n) => !fb.includes(n)), still: fb.filter((n) => fa.includes(n)) };
    if (a.durationMs != null && b.durationMs != null) dur.push(b.durationMs - a.durationMs);
    if (a.verdict === b.verdict && !row.added.length && !row.removed.length) { if (a.verdict === 'fail') rows.stillFail.push(row); else rows.same++; continue; }
    if (b.verdict === 'blocked' && a.verdict !== 'blocked') rows.newBlocked.push(row);
    else if (a.verdict === 'blocked' && b.verdict !== 'blocked') rows.unblocked.push(row);
    else if (b.verdict === 'error' && a.verdict !== 'error') rows.newError.push(row);
    else if (a.verdict === 'error' && b.verdict !== 'error') rows.errorGone.push(row);
    else if (b.verdict === 'pass') rows.fixed.push(row);
    else if (a.verdict === 'pass') rows.newFail.push(row);
    else rows.stillFail.push(row);
  }
  dur.sort((x, y) => x - y);
  return {
    both: both.length, onlyA: [...A.keys()].filter((h) => !B.has(h)), onlyB: [...B.keys()].filter((h) => !A.has(h)),
    countsA: summarize(new Map(both.map((h) => [h, A.get(h)]))).counts, countsB: summarize(new Map(both.map((h) => [h, B.get(h)]))).counts,
    medianDurationChangeMs: dur.length ? dur[dur.length >> 1] : null, ...rows
  };
}

export function formatCompare(c) {
  const L = [];
  const cnt = (k) => `${k.pass} pass, ${k.fail} fail, ${k.blocked} blocked, ${k.error} error`;
  L.push(`${c.both} sites in both. A: ${cnt(c.countsA)}. B: ${cnt(c.countsB)}.`);
  if (c.medianDurationChangeMs != null) L.push(`Median time per site changed by ${c.medianDurationChangeMs >= 0 ? '+' : ''}${Math.round(c.medianDurationChangeMs / 1000)}s.`);
  const sect = (title, rows, f) => { if (!rows.length) return; L.push('', `${title} (${rows.length}):`); for (const r of rows) L.push(`  ${pad(r.host, 40)} ${f(r)}`); };
  sect('New failures', c.newFail, (r) => r.added.join(', '));
  sect('Fixed', c.fixed, (r) => `no longer: ${r.removed.join(', ')}`);
  sect('Still failing', c.stillFail, (r) => [r.still.length ? r.still.join(', ') : '', r.added.length ? `+${r.added.join(', +')}` : '', r.removed.length ? `-${r.removed.join(', -')}` : ''].filter(Boolean).join('  '));
  sect('Newly blocked', c.newBlocked, (r) => `was ${r.a}`);
  sect('No longer blocked', c.unblocked, (r) => `now ${r.b}${r.added.length ? `: ${r.added.join(', ')}` : ''}`);
  sect('New errors', c.newError, (r) => `was ${r.a}`);
  sect('Errors gone', c.errorGone, (r) => `now ${r.b}`);
  L.push('', `Unchanged: ${c.same} sites with the same verdict and no check flipped.`);
  const few = (a) => `${a.slice(0, 8).join(', ')}${a.length > 8 ? `, and ${a.length - 8} more` : ''}`;
  if (c.onlyA.length) L.push(`Only in A (${c.onlyA.length}): ${few(c.onlyA)}`);
  if (c.onlyB.length) L.push(`Only in B (${c.onlyB.length}): ${few(c.onlyB)}`);
  return L.join('\n');
}
