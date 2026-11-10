// Small helpers that site checks use to look at one region of a capture.

import { cols, rowDiff, rowStdIn } from './image.mjs';
import { T } from './detectors.mjs';

// Share of rows in a region that are one flat colour across its columns.
export function flatShare(img, { y0, y1, x = 0, w = null }) {
  const [x0, x1] = cols(img, x, w);
  const a = Math.max(0, Math.round(y0)), b = Math.min(img.H, Math.round(y1));
  if (b <= a) return null;
  let flat = 0;
  for (let y = a; y < b; y++) if (rowStdIn(img, y, x0, x1) < T.flatStd) flat++;
  return flat / (b - a);
}

// Where else in [s0, s1) the strip of the capture at rect appears. Returns
// the y of every match (the strip itself included), after merging matches
// a few px apart. A match is a mean |Δluma| under `tol` over the strip's
// textured rows.
export function findStrip(img, rect, s0, s1, tol = 3) {
  const [x0, x1] = cols(img, rect.left, rect.w);
  const t0 = Math.round(rect.top), h = Math.round(rect.h);
  const rows = [];
  for (let i = 0; i < h; i++) if (t0 + i < img.H && rowStdIn(img, t0 + i, x0, x1) > T.textured) rows.push(i);
  if (rows.length < 8) return { rows: rows.length, matches: [] };
  const step = Math.max(1, Math.floor(rows.length / 24));
  const probe = rows.filter((_, i) => i % step === 0);
  const hits = [];
  for (let y = Math.max(0, s0); y + h < Math.min(img.H, s1); y++) {
    let s = 0, ok = true;
    for (const i of probe) {
      s += rowDiff(img, t0 + i, y + i, x0, x1);
      if (s / probe.length > tol * 4) { ok = false; break; }
    }
    if (ok && s / probe.length < tol) hits.push(y);
  }
  const matches = [];
  for (const y of hits) if (!matches.length || y - matches[matches.length - 1] > 8) matches.push(y);
  return { rows: rows.length, matches };
}

// A tile placed too low (the page grew above it between shots) repeats the
// rows just above its top edge just below it: rows B..B+L equal rows
// B-d..B-d+L for some d. Looks at every boundary for a run of at least
// `minRows` textured rows that matches that way, and drops a match that
// holds nearly as well a few px off d (stripes, dot patterns, tiled
// textures), like the repeated-overlay detector does.
export function seamRepeats(img, boundaryRows, { maxD = 868, band = 160, minRows = 24 } = {}) {
  const flags = [];
  const diff = (B, d, rows) => rows.reduce((s, o) => s + rowDiff(img, B + o, B - d + o), 0) / rows.length;
  for (const B of boundaryRows) {
    const rows = [];
    for (let o = 0; o < band && B + o < img.H; o++) if (img.rowStd[B + o] > T.textured) rows.push(o);
    if (rows.length < minRows) continue;
    for (let d = 8; d <= Math.min(maxD, B); d++) {
      const own = rows.filter((o) => o < d);
      if (own.length < minRows) continue;
      // Cheap rejection on a few rows before the full comparison.
      if (own.slice(0, 4).some((o) => rowDiff(img, B + o, B - d + o) >= T.matchDiff * 3)) continue;
      const at0 = diff(B, d, own);
      if (at0 >= T.matchDiff) continue;
      const off = Math.min(...[-12, -6, 6, 12].filter((s) => d + s > 0 && d + s <= B).map((s) => diff(B, d + s, own)));
      if (off > 1 + 2 * at0) { flags.push({ y0: B, y1: B + Math.min(d, band), note: `rows below the tile edge at ${B}px repeat the ${d}px above it` }); break; }
    }
  }
  return flags;
}

export const result =(pass, value, detail, flags = []) => ({ pass, value, detail, flags });
