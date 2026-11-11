// Turns one capture into its record (what results.json holds per site) and
// runs the checks on it. The same code re-runs the checks on a stored
// record and its PNG (`rescore`), so detectors can be changed and judged
// against earlier runs without capturing again.

import fs from 'node:fs';
import path from 'node:path';
import { loadCapture, preview } from './image.mjs';
import { VIEWPORT, DPR } from './capture.mjs';

export const fileFor = (host) => host.replace(/[^\w.-]/g, '_');

// Output px per CSS px of the capture: the device scale, unless the
// extension had to scale a page too tall for one image down.
export function captureScale(cap) {
  const w = cap.canvas && cap.canvas.width, css = cap.prepare && cap.prepare.pageWidth;
  return w && css ? w / css : DPR;
}

// pass | fail | blocked | error
export function verdictOf(rec) {
  if (rec.error) return 'error';
  if (rec.blocked) return 'blocked';
  return Object.values(rec.checks || {}).every((c) => c.pass) ? 'pass' : 'fail';
}

// The capture-time facts a detector needs, as a `cap` object, from a stored
// record. Records from before the harness stored the tile draws get them
// rebuilt from the tile tops (each tile paints from the bottom of the one
// above, or its own top if lower).
export function capFromRecord(rec) {
  const vh = rec.prepare ? rec.prepare.viewportHeight : VIEWPORT.height;
  let draws = rec.draws, canvas = rec.canvas;
  if (!draws && rec.tileTops && rec.capture) {
    const tops = rec.tileTops;
    canvas = { width: rec.capture.devWidth, height: rec.capture.devHeight };
    draws = tops.map((y, i) => {
      const drawY = i ? Math.max(tops[i - 1] + vh, y) : 0;
      const bottom = Math.min(y + vh, rec.capture.cssHeight);
      return { sy: (drawY - y) * DPR, sh: Math.max(1, bottom - drawY) * DPR, dy: drawY * DPR, dh: Math.max(1, bottom - drawY) * DPR };
    });
  }
  return {
    prepare: rec.prepare, draws, canvas,
    factsBefore: rec.pageFacts && rec.pageFacts.before, factsAfter: rec.pageFacts && rec.pageFacts.after,
    tiles: rec.tileLog || [], placements: rec.placements || null, warnings: rec.warnings || null,
    dom: rec.dom || null, gate: rec.gate || null, http: rec.http || null
  };
}

// Runs every generic detector, plus the site's own checks when it has any
// and the first screen is at hand.
export async function runChecks(rec, img, cap, detectors, { site = null, shot = null } = {}) {
  const checks = {};
  // (async from the page checks on; plain object from older detectors)
  for (const [name, r] of Object.entries(await detectors.runGeneric(img, cap))) checks[name] = { kind: 'generic', ...r };
  // A fixture built to break the capture on purpose expects some generic
  // checks to fail; its own checks judge whether the extension said so.
  for (const name of (site && site.expectGenericFail) || []) {
    const c = checks[name];
    if (c) checks[name] = { ...c, pass: true, expected: true, detail: `expected to fail on this page (${c.pass ? 'did not' : 'did'}): ${c.detail}` };
  }
  if (site && site.checks) {
    const tiles = detectors.tileRects(cap);
    const vh = cap.prepare ? cap.prepare.viewportHeight : VIEWPORT.height;
    for (const [name, fn] of Object.entries(site.checks)) {
      try {
        if (cap.siteFacts && cap.siteFacts.error) throw new Error(`collect failed: ${cap.siteFacts.error}`);
        checks[name] = { kind: 'site', ...fn({ img, cap, tiles, vh, shot, facts: cap.siteFacts || {} }) };
      } catch (e) {
        checks[name] = { kind: 'site', pass: false, value: null, detail: `check error: ${e.message}`, flags: [] };
      }
    }
  }
  return checks;
}

// Builds the record for a fresh capture, writes its files into outDir and
// returns it. keepPng: 'all' | 'failing' | 'none' (failing keeps the PNG of
// any site that didn't pass).
export async function recordCapture(site, cap, outDir, detectors, { keepPng = 'all' } = {}) {
  const rec = {
    host: site.host, url: site.url, verdict: null, pass: false, durationMs: cap.durationMs,
    // From the start: page loaded, and capture returned (load + prepare + tiles).
    phases: cap.phases || null,
    tileCount: cap.tileCount ?? null, error: cap.error || null, navRetry: cap.navRetry || null,
    http: cap.http || null, gate: cap.gate || null,
    // Which user agent got the page ('desktop' or 'headless'), and the
    // ones that were turned away first.
    ua: cap.ua || null, uaTried: cap.uaTried || null,
    blocked: cap.blocked && cap.blocked.blocked ? cap.blocked.reason : null,
    checks: {}, browserVersion: cap.browserVersion
  };
  const file = fileFor(site.host);
  if (cap.shot) {
    fs.writeFileSync(path.join(outDir, `${file}.first-screen.jpg`), await preview(cap.shot, 1388));
    rec.firstScreen = `${file}.first-screen.jpg`;
  }
  if (!cap.ok || rec.blocked && !cap.png) { rec.verdict = verdictOf(rec); return rec; }

  fs.writeFileSync(path.join(outDir, `${file}.preview.jpg`), await preview(cap.png, 260));
  rec.preview = `${file}.preview.jpg`;
  const img = await loadCapture(cap.png, captureScale(cap));
  const tiles = detectors.tileRects(cap);
  rec.capture = { devWidth: img.devWidth, devHeight: img.devHeight, cssWidth: img.cssWidth, cssHeight: img.H };
  rec.tileTops = tiles.map((t) => t.y);
  // What the content script reported for each tile: where it was asked to
  // scroll, where it landed and how tall the page was at that moment.
  rec.prepare = cap.prepare || null;
  // How the extension woke the page (null before it did) and how long the
  // capture itself took, page load left out.
  rec.wake = cap.wake ?? null;
  rec.pageTime = cap.pageTime ?? null;
  rec.captureMs = cap.phases.captured != null ? cap.phases.captured - cap.phases.loaded : null;
  rec.tileLog = (cap.tiles || []).map(({ ok, ...t }) => t);
  // The extension's own report on the capture (null before it had one), and
  // where it placed each shot.
  rec.warnings = cap.warnings ?? null;
  rec.placements = cap.placements ?? null;
  rec.pageFacts = { before: cap.factsBefore, after: cap.factsAfter };
  rec.siteFacts = cap.siteFacts || null;
  // Raw tile draws (with the seam evidence rows) and the page's own account
  // of what is on it, so the checks can be re-run later from this record.
  rec.canvas = cap.canvas;
  rec.draws = cap.draws;
  rec.dom = cap.dom || null;

  const shot = cap.shot ? await loadCapture(cap.shot, DPR) : null;
  try {
    rec.checks = await runChecks(rec, img, cap, detectors, { site, shot });
  } catch (e) {
    // A detector bug must not lose the capture: it fails the site and the
    // PNG is kept for a rescore.
    rec.checks = { harness: { kind: 'generic', pass: false, value: null, detail: `detector error: ${e.stack || e.message}`, flags: [] } };
  }
  rec.verdict = verdictOf(rec);
  rec.pass = rec.verdict === 'pass';
  if (keepPng === 'all' || (keepPng === 'failing' && rec.verdict !== 'pass')) {
    fs.writeFileSync(path.join(outDir, `${file}.png`), cap.png);
    rec.png = `${file}.png`;
  }
  return rec;
}

// Re-runs the generic detectors on a stored record whose PNG was kept.
// Returns null when there is no PNG to look at.
export async function rescore(rec, dir, detectors) {
  if (!rec.png || !fs.existsSync(path.join(dir, rec.png))) return null;
  const cap = capFromRecord(rec);
  const img = await loadCapture(fs.readFileSync(path.join(dir, rec.png)), captureScale(cap));
  return runChecks(rec, img, cap, detectors);
}
