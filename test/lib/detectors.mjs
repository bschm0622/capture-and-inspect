// Generic capture-defect detectors. Each works on the analysis grid from
// image.mjs (one row per CSS px) plus the tile geometry recorded during the
// capture, and returns { pass, value, detail, flags: [{ y0, y1, note }] }
// with y in CSS px of the capture. Thresholds were tuned on the regression
// set's real captures; see test/README.md for what each one can't see.

import { cols, rowDiff, rowStdIn, median } from './image.mjs';

export const T = {
  // blank band
  flatStd: 3,          // a row whose luma std is under this is "flat"
  flatDrift: 4,        // ...and stays within this of the run's colour
  blankMinFrac: 0.45,  // band at least this × viewport height is flagged
  // repeated overlay
  textured: 12,        // row luma std above this counts as content
  matchDiff: 2,        // mean |Δluma| under this = rows are the same pixels
  repeatMin: 24,       // CSS px of matched content rows to flag
  repeatBlocks: 8,
  // seam
  seamBlocks: 8,
  seamNotFlat: 4,      // block row luma std; flatter blocks are skipped
  seamJump: 12,        // jump at the boundary, mean |Δluma|, absolute floor
  seamRatio: 4,        // ...at least this × the typical jump around it
  seamSharp: 2,        // ...and this × the larger jump one row either side
  seamCoverage: 0.15,  // ...in at least this share of the block's columns
  seamMinBlocks: 2,
  // truncation
  truncRatio: 0.7
};

// Tile rectangles in CSS px of the capture, from the recorded drawImage calls.
export function tileRects(cap) {
  const scale = cap.canvas.width / (cap.prepare ? cap.prepare.pageWidth : cap.canvas.width / 2);
  return cap.draws.map((d) => ({ y: Math.round(d.dy / scale), h: Math.round(d.dh / scale) }));
}

// Rows where one tile's pixels start (every tile but the first). Each tile
// overwrites the one before, so the boundary is the later tile's top edge.
export function boundaries(tiles, H) {
  const out = [];
  for (let i = 1; i < tiles.length; i++) if (tiles[i].y > 0 && tiles[i].y < H) out.push(tiles[i].y);
  return out;
}

// (a) Blank band: a run of rows that are each one flat colour, the same
// colour all the way down, taller than half a screen. A real design can
// have that much empty space; a capture defect (a section whose image was
// hidden, a marquee scrolled out of view) usually does. The very bottom of
// the page is excluded: empty space below a footer is common and harmless.
export function blankBands(img, { vh, region = null, minFrac = T.blankMinFrac } = {}) {
  const [y0, y1] = region ? [Math.max(0, region.y0), Math.min(img.H, region.y1)] : [0, img.H];
  const [x0, x1] = region && region.x != null ? cols(img, region.x, region.w) : [0, img.W];
  const minH = Math.round(vh * minFrac);
  const runs = [];
  let start = -1, ref = null;
  const color = (y) => [img.rowMean[y * 3], img.rowMean[y * 3 + 1], img.rowMean[y * 3 + 2]];
  const flush = (end) => { if (start >= 0 && end - start >= 1) runs.push({ y0: start, y1: end, color: ref }); start = -1; };
  for (let y = y0; y < y1; y++) {
    const flat = rowStdIn(img, y, x0, x1) < T.flatStd;
    if (!flat) { flush(y); continue; }
    const c = color(y);
    if (start >= 0 && Math.max(...c.map((v, i) => Math.abs(v - ref[i]))) > T.flatDrift) flush(y);
    if (start < 0) { start = y; ref = c; }
  }
  flush(y1);
  const longest = runs.reduce((m, r) => Math.max(m, r.y1 - r.y0), 0);
  const flags = runs
    .filter((r) => r.y1 - r.y0 >= minH && !(region == null && r.y1 >= img.H - 2))
    .map((r) => ({ y0: r.y0, y1: r.y1, note: `flat rgb(${r.color.map(Math.round).join(',')}) ${r.y1 - r.y0}px` }));
  return { pass: flags.length === 0, value: longest, detail: `longest flat run ${longest}px (limit ${minH}px)`, flags };
}

// (b) Repeated overlay: the same textured strip at the same place in two
// consecutive tiles, i.e. exactly one tile step apart in the capture. That
// is what a header, popup or sticky heading that followed the scroll leaves
// behind. A matched strip that would match nearly as well a few px off the
// tile step is dropped: that is a periodic pattern (dots, stripes, a tiled
// texture) or plain text-on-flat rows, not an overlay.
// Overlays can land a pixel or two off the exact step (fractional scroll
// positions), so matches may float by JITTER; the periodic test looks
// further off than that.
const JITTER = [-2, -1, 0, 1, 2];
const SHIFTS = [-12, -9, -6, -4, 4, 6, 9, 12];
function runDiff(img, ya, yb, rows, shift, x0, x1) {
  let s = 0;
  for (const o of rows) s += rowDiff(img, ya + o, yb + o + shift, x0, x1);
  return s / rows.length;
}

// Matching is done per vertical block of the width, so an overlay that
// covers only part of the screen (a popup card, a chat bubble, a sidebar)
// is found even though the rest of its rows differ.
export function repeatedOverlays(img, tiles, { zone = null, region = null, blocks = T.repeatBlocks } = {}) {
  const raw = [];
  const [rx0, rx1] = region && region.x != null ? cols(img, region.x, region.w) : [0, img.W];
  for (let k = 0; k + 1 < tiles.length; k++) {
    const a = tiles[k].y, b = tiles[k + 1].y, d = b - a;
    if (d <= 0) continue;
    const h = Math.min(tiles[k].h, tiles[k + 1].h, img.H - b - 2);
    const oMax = zone ? Math.min(h, zone) : h;
    for (let bi = 0; bi < blocks; bi++) {
      const x0 = rx0 + Math.floor((rx1 - rx0) * bi / blocks), x1 = rx0 + Math.floor((rx1 - rx0) * (bi + 1) / blocks);
      let run = null;
      const close = () => {
        if (run && run.rows.length >= T.repeatMin) {
          const inner = run.rows.filter((o) => b + o + 12 < img.H && a + o - 12 >= 0);
          const at0 = Math.min(...JITTER.map((j) => runDiff(img, a, b, inner, j, x0, x1)));
          const off = Math.min(...SHIFTS.map((sh) => runDiff(img, a, b, inner, sh, x0, x1)));
          if (inner.length >= T.repeatMin && off > 1 + 2 * at0) {
            raw.push({ k, d, bi, y0: b + run.o0, y1: b + run.o1, n: run.rows.length, at0, off });
          }
        }
        run = null;
      };
      for (let o = 0; o < oMax; o++) {
        const ya = a + o, yb = b + o;
        if (region && (yb < region.y0 || yb >= region.y1)) { close(); continue; }
        if (rowStdIn(img, yb, x0, x1) <= T.textured) { if (run && ++run.gap > 12) close(); continue; }
        if (JITTER.some((j) => rowDiff(img, ya, yb + j, x0, x1) < T.matchDiff)) {
          if (!run) run = { o0: o, o1: o + 1, rows: [], gap: 0 };
          run.rows.push(o); run.o1 = o + 1; run.gap = 0;
        } else if (run && ++run.gap > 12) close();
      }
      close();
    }
  }
  // Merge block hits of the same tile pair that overlap vertically.
  const flags = [];
  for (const r of raw.sort((p, q) => p.k - q.k || p.y0 - q.y0)) {
    const f = flags.find((g) => g.k === r.k && r.y0 <= g.y1 && r.y1 >= g.y0);
    if (f) { f.y0 = Math.min(f.y0, r.y0); f.y1 = Math.max(f.y1, r.y1); f.blocks.add(r.bi); f.n = Math.max(f.n, r.n); f.off = Math.min(f.off, r.off); }
    else flags.push({ k: r.k, d: r.d, y0: r.y0, y1: r.y1, blocks: new Set([r.bi]), n: r.n, off: r.off });
  }
  const total = flags.reduce((s, f) => s + (f.y1 - f.y0), 0);
  return {
    pass: flags.length === 0, value: total,
    detail: `${flags.length} strip(s), ${total}px in all, repeated at the tile step`,
    flags: flags.map((f) => ({ y0: f.y0, y1: f.y1, note: `${f.y1 - f.y0}px strip (${f.blocks.size}/${blocks} column blocks) identical to ${f.d}px above, tiles ${f.k + 1}/${f.k + 2}` }))
  };
}

// (c) Seam: at a tile boundary, a break exactly one row thick. The jump
// between the last row of one tile and the first row of the next is far
// bigger than the typical row-to-row jump around it AND than the jumps one
// row either side. The second test is what separates a seam from text or
// photo texture that happens to sit on the boundary: glyphs and grain make
// big jumps over several consecutive rows, a seam makes one. Checked in
// vertical blocks so a seam in part of the width (a video, a carousel)
// still shows, and blocks that are flat on either side are skipped, which
// lets an ordinary edge between a flat section and its neighbour through,
// and a block counts only when most of its columns break (see coverage).
// Share of columns in [x0, x1) where the boundary row breaks sharply from
// the row above, while both are smooth against their own neighbours and
// neither pixel is the block's background colour. Text lying across a
// boundary scores near zero: every glyph edge has background on one side.
// A photo, video frame or overlay that changed between two shots has
// content on both sides and scores high.
function coverage(img, B, x0, x1) {
  const L = (x, y) => img.luma[y * img.W + x];
  const hist = new Array(64).fill(0);
  for (let y = B - 6; y < B + 6; y++) for (let x = x0; x < x1; x++) hist[L(x, y) >> 2]++;
  const bg = hist.indexOf(Math.max(...hist)) * 4 + 2;
  const isBg = (v) => Math.abs(v - bg) <= 6;
  let n = 0;
  for (let x = x0; x < x1; x++) {
    if (isBg(L(x, B)) || isBg(L(x, B - 1))) continue;
    const d = Math.abs(L(x, B) - L(x, B - 1));
    const around = Math.max(Math.abs(L(x, B - 1) - L(x, B - 2)), Math.abs(L(x, B + 1) - L(x, B)));
    if (d >= 8 && d > 2 * around) n++;
  }
  return n / (x1 - x0);
}

export function seams(img, tiles, { region = null, minBlocks = T.seamMinBlocks } = {}) {
  const flags = [];
  let worst = 0;
  const [rx0, rx1] = region && region.x != null ? cols(img, region.x, region.w) : [0, img.W];
  const nb = region && region.x != null ? Math.max(1, Math.round(T.seamBlocks * (rx1 - rx0) / img.W)) : T.seamBlocks;
  for (const B of boundaries(tiles, img.H)) {
    if (B < 32 || B > img.H - 32) continue;
    if (region && (B < region.y0 || B >= region.y1)) continue;
    const hits = [];
    for (let k = 0; k < nb; k++) {
      const x0 = rx0 + Math.floor((rx1 - rx0) * k / nb), x1 = rx0 + Math.floor((rx1 - rx0) * (k + 1) / nb);
      if (rowStdIn(img, B - 1, x0, x1) < T.seamNotFlat || rowStdIn(img, B, x0, x1) < T.seamNotFlat) continue;
      const J = (y) => rowDiff(img, y - 1, y, x0, x1);
      const jump = J(B);
      const next = Math.max(J(B - 1), J(B + 1));
      const around = [];
      for (let dy = 2; dy <= 30; dy++) around.push(J(B - dy), J(B + dy));
      const base = median(around);
      const score = Math.min(jump / (base + 1), jump / (next + 2));
      if (jump >= T.seamJump) worst = Math.max(worst, score);
      if (jump >= T.seamJump && jump >= T.seamRatio * (base + 1) && jump >= T.seamSharp * next + 4 &&
          coverage(img, B, x0, x1) >= T.seamCoverage) {
        hits.push({ k, jump: Math.round(jump), base: +base.toFixed(1), next: +next.toFixed(1) });
      }
    }
    if (hits.length >= minBlocks) {
      const h = hits.reduce((m, x) => (x.jump > m.jump ? x : m));
      flags.push({ y0: B - 8, y1: B + 8, note: `one-row break at ${B}px in ${hits.length}/${nb} column blocks (jump ${h.jump} vs ${h.base} typical, ${h.next} next row)` });
    }
  }
  return { pass: flags.length === 0, value: +worst.toFixed(1), detail: `${flags.length} seam(s); strongest boundary score ${worst.toFixed(1)}`, flags };
}

// (d) Truncation: the capture is much shorter than the page's real
// scrollable height (measured before the capture, including an inner
// scrolling container when the document itself doesn't scroll).
export function truncation(img, facts, { vh, ratio = T.truncRatio } = {}) {
  const real = facts.scrollable;
  const capped = Math.min(real, 60000);
  const r = img.H / capped;
  const pass = !(r < ratio && capped - img.H > vh);
  return {
    pass, value: +r.toFixed(2),
    detail: `capture ${img.H}px of ${real}px scrollable (${Math.round(r * 100)}%)`,
    flags: pass ? [] : [{ y0: img.H - 4, y1: img.H, note: `capture ends at ${img.H}px; page scrolls to ${real}px` }]
  };
}

export function runGeneric(img, cap) {
  const tiles = tileRects(cap);
  const vh = cap.prepare ? cap.prepare.viewportHeight : 868;
  return {
    'blank-band': blankBands(img, { vh }),
    'repeated-overlay': repeatedOverlays(img, tiles),
    'seam': seams(img, tiles),
    'truncation': truncation(img, cap.factsBefore, { vh })
  };
}
