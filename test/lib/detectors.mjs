// Generic capture-defect detectors. Each works on the analysis grid from
// image.mjs (one row per CSS px) plus the tile geometry recorded during the
// capture, and returns { pass, value, detail, flags: [{ y0, y1, note }] }
// with y in CSS px of the capture. Thresholds were tuned on the regression
// set's real captures; see test/README.md for what each one can't see.

import { cols, rowDiff, rowStdIn, median } from './image.mjs';
import { textSameColour, contentIn, usableDom } from './page-checks.mjs';

export const T = {
  // blank band
  flatStd: 3,          // a row whose luma std is under this is "flat"
  flatDrift: 4,        // ...and stays within this of the run's colour
  blankMinFrac: 0.45,  // band at least this × viewport height is flagged (no page facts)
  blankWithContent: 150, // CSS px: a flat run this tall over content the page has
  blankClaimedMax: 0.1,  // a tall run with no more than this share inside the page's boxes is spacing
  // repeated overlay
  textured: 12,        // row luma std above this counts as content
  matchDiff: 2,        // mean |Δluma| under this = rows are the same pixels
  repeatMin: 24,       // CSS px of matched content rows to flag
  repeatOffRow: 12,    // ...of which at least this many unlike their commonest row
  repeatBlocks: 8,
  // seam
  seamBlocks: 8,
  seamNotFlat: 4,      // block row luma std; flatter blocks are skipped
  seamJump: 12,        // jump at the boundary, mean |Δluma|, absolute floor
  seamRatio: 4,        // ...at least this × the typical jump around it
  seamSharp: 2,        // ...and this × the larger jump one row either side
  seamCoverage: 0.15,  // ...in at least this share of the block's columns
  seamMinBlocks: 2,
  // seam, with the harness's own evidence from the two shots
  ovDisagree: 6,       // mean |Δluma| between the shots over the 6 rows above the seam
  ovStep: 8,           // the capture's jump exceeds the later shot's own by this
  ovMinBlocks: 2,      // column blocks (~350 CSS px): one block alone was a live map tile twice in three
  // truncation
  truncSlack: 16       // CSS px the capture may fall short of the page
};

// Tile rectangles in CSS px of the capture, from the recorded drawImage calls.
// `y` and `h` are where the whole shot (one screen) sits in the capture;
// `drawY` is where its painted part starts. They differ when the extension
// draws only the part of a tile below what an earlier tile already painted.
export function tileRects(cap) {
  const scale = cap.canvas.width / (cap.prepare ? cap.prepare.pageWidth : cap.canvas.width / 2);
  const out = [];
  for (const d of cap.draws) {
    const k = d.dh / d.sh; // output px per source px
    const t = { y: Math.round((d.dy - d.sy * k) / scale), h: Math.round((d.sy + d.sh) * k / scale), drawY: Math.round(d.dy / scale) };
    if (d.ov) t.ov = d.ov;
    // A tile shot again (when two tiles disagreed) repaints rows already
    // painted, and replaces the tile that painted them.
    while (out.length && out[out.length - 1].drawY >= t.drawY) out.pop();
    out.push(t);
  }
  return out;
}

// Rows where one tile's pixels start (every tile but the first): the row
// where pixels from two different shots meet.
export function boundaries(tiles, H) {
  const out = [];
  for (let i = 1; i < tiles.length; i++) {
    const y = tiles[i].drawY ?? tiles[i].y;
    if (y > 0 && y < H) out.push(y);
  }
  return out;
}

// (a) Blank band: a run of rows that are each one flat colour, the same
// colour all the way down. Pixels alone can't tell deliberate space from a
// section that didn't paint, so with the page's account of what is there
// it is judged by that (below); without it, by height: taller than about
// half a screen. The very bottom of the page is excluded: empty space below
// a footer is common and harmless.
export function blankBands(img, { vh, region = null, minFrac = T.blankMinFrac, dom = null } = {}) {
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
  const notBottom = (r) => !(region == null && r.y1 >= img.H - 2);
  // A run at least minH tall fails on height alone. With the page's account
  // of what is there, a shorter one (down to T.blankWithContent) fails too
  // when the page has text, images or embeds in it that didn't paint. The
  // account never clears a tall run: content a script never put in the page
  // (a reviews widget, a gallery) leaves the page empty there too, so it
  // can't tell that from deliberate space.
  const withDom = dom && !usableDom(img, dom);
  const flags = [];
  let spacing = 0;
  for (const r of runs) {
    const h = r.y1 - r.y0;
    if (!notBottom(r) || h < (withDom ? Math.min(T.blankWithContent, minH) : minH)) continue;
    const col = `flat rgb(${r.color.map(Math.round).join(',')}) ${h}px`;
    const c = withDom ? contentIn(dom, r.y0, r.y1) : null;
    const has = c && (c.chars >= 10 || c.images || c.embeds);
    if (has) flags.push({ y0: r.y0, y1: r.y1, note: `${col} where the page has ${[c.lines ? `${c.lines} text line(s)` : '', c.images ? `${c.images} image(s)` : '', c.embeds ? `${c.embeds} embed(s)` : ''].filter(Boolean).join(', ')}` });
    else if (h >= minH) {
      // A tall run over rows no box on the page claims (the space between
      // sections, their padding and margins) is the page's own spacing.
      // Over a claimed box with nothing showing (a widget's empty frame,
      // content still hidden for an entrance) it is something that didn't
      // paint. Records from before the harness kept the claims can't tell.
      const share = withDom && dom.claimed ? claimedShare(dom.claimed, r.y0, r.y1) : null;
      if (share != null && share <= T.blankClaimedMax) spacing++;
      else flags.push({ y0: r.y0, y1: r.y1, note: `${col}${share != null ? `; ${Math.round(share * 100)}% of it inside boxes the page has there` : ''}` });
    }
  }
  return { pass: flags.length === 0, value: longest, detail: `longest flat run ${longest}px (limit ${minH}px${withDom ? `, ${T.blankWithContent}px over content the page has` : ''})${spacing ? `; ${spacing} tall run(s) cleared: space between the page's boxes` : ''}`, flags };
}

// Share of rows [y0, y1) inside the page's claimed runs (capture.mjs).
function claimedShare(claimed, y0, y1) {
  let n = 0;
  for (const [a, b] of claimed) {
    if (a >= y1) break;
    n += Math.max(0, Math.min(b, y1) - Math.max(a, y0));
  }
  return n / Math.max(1, y1 - y0);
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
//
// A match only means something if the matched rows change down the strip.
// Rows whose only texture is vertical edges (a card's side against a dark
// gutter, a coloured bar beside a panel, a column of dots) are one row
// profile repeated: they match every other row of the same column, so two
// such stretches one tile step apart match without anything having
// followed the scroll. Between the lines of a text block those rows come
// in short runs, and the gaps in the text let them join into a strip long
// enough to flag, while the shifted comparison below lands on text rows and
// can't tell. The evidence a real overlay leaves is the opposite: its
// varied rows (text, an outline, a picture) match too. So a run needs
// T.repeatOffRow matched rows that differ from its commonest row (beyond
// |Δluma| 2). Over every capture kept in test/out on 2026-11-11,
// the false repeats had 2-6 such rows (a6c3f84 sweep: dark footer and card
// grids, green service cards, coloured cards on a dotted ground; and two
// card edges on older runs), every real one 14 or more (chat bubbles,
// newsletter popup, sticky headings and nav, the Field Museum's header).
function offRow(img, ys, x0, x1) {
  let best = 0;
  for (const r of ys) {
    let n = 0;
    for (const y of ys) if (rowDiff(img, r, y, x0, x1) <= T.matchDiff) n++;
    if (n > best) best = n;
  }
  return ys.length - best;
}

export function repeatedOverlays(img, tiles, { zone = null, region = null, blocks = T.repeatBlocks, fixedBoxes = null } = {}) {
  const raw = [];
  let uniform = 0;
  const [rx0, rx1] = region && region.x != null ? cols(img, region.x, region.w) : [0, img.W];
  for (let k = 0; k + 1 < tiles.length; k++) {
    const a = tiles[k].y, b = tiles[k + 1].y, d = b - a;
    if (d <= 0) continue;
    const h = Math.min(tiles[k].h, tiles[k + 1].h, img.H - b - 2);
    const oMax = zone ? Math.min(h, zone) : h;
    // Only rows the later tile painted: where tiles overlap, the rows above
    // its painted part came from the earlier tile, and comparing those
    // would compare a tile with itself.
    const oMin = tiles[k + 1].drawY != null ? Math.max(0, tiles[k + 1].drawY - b) : 0;
    for (let bi = 0; bi < blocks; bi++) {
      const x0 = rx0 + Math.floor((rx1 - rx0) * bi / blocks), x1 = rx0 + Math.floor((rx1 - rx0) * (bi + 1) / blocks);
      let run = null;
      const close = () => {
        if (run && run.rows.length >= T.repeatMin) {
          const inner = run.rows.filter((o) => b + o + 12 < img.H && a + o - 12 >= 0);
          const at0 = Math.min(...JITTER.map((j) => runDiff(img, a, b, inner, j, x0, x1)));
          const off = Math.min(...SHIFTS.map((sh) => runDiff(img, a, b, inner, sh, x0, x1)));
          if (inner.length >= T.repeatMin && off > 1 + 2 * at0) {
            const other = offRow(img, run.rows.map((o) => b + o), x0, x1);
            if (other < T.repeatOffRow) uniform++;
            else raw.push({ k, d, bi, y0: b + run.o0, y1: b + run.o1, n: run.rows.length, at0, off });
          }
        }
        run = null;
      };
      for (let o = oMin; o < oMax; o++) {
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
  // With the page's account of what is fixed to the window (before and
  // after the capture), a repeat only counts where something is: a fixed
  // or sticky box covering the strip's place in the window. A repeat with
  // nothing there is a background that repeats at the tile step (a
  // window-fixed photo, a tiled texture) or a detail that recurs by chance.
  let cleared = 0;
  const kept = fixedBoxes == null ? flags : flags.filter((f) => {
    const scale = img.cssWidth / img.W;
    const bs = [...f.blocks];
    const x0 = (rx0 + Math.floor((rx1 - rx0) * Math.min(...bs) / blocks)) * scale;
    const x1 = (rx0 + Math.floor((rx1 - rx0) * (Math.max(...bs) + 1) / blocks)) * scale;
    const o0 = f.y0 - tiles[f.k + 1].y, o1 = f.y1 - tiles[f.k + 1].y;
    const hit = fixedBoxes.some(([bx, by, bw, bh]) => {
      const iw = Math.min(x1, bx + bw) - Math.max(x0, bx), ih = Math.min(o1, by + bh) - Math.max(o0, by);
      return iw > 0 && ih > 0 && iw * ih >= 0.25 * Math.min((x1 - x0) * (o1 - o0), bw * bh);
    });
    if (!hit) cleared++;
    return hit;
  });
  const total = kept.reduce((s, f) => s + (f.y1 - f.y0), 0);
  return {
    pass: kept.length === 0, value: total,
    detail: `${kept.length} strip(s), ${total}px in all, repeated at the tile step${cleared ? `; ${cleared} more cleared: nothing fixed to the window there` : ''}${uniform ? `; ${uniform} block match(es) dropped: mostly one row repeated` : ''}`,
    flags: kept.map((f) => ({ y0: f.y0, y1: f.y1, note: `${f.y1 - f.y0}px strip (${f.blocks.size}/${blocks} column blocks) identical to ${f.d}px above, tiles ${f.k + 1}/${f.k + 2}` }))
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


// The seam evidence the harness kept for a tile (capture.mjs): rows just
// above where it starts painting, as already on the canvas (`prev`, the
// tile above) and as this tile shot them (`own`, plus a few rows below).
// Per column range: `dis`, how much the two shots of the same page rows
// differ; `cap`, the jump the capture shows at the seam; `own`, the jump
// this tile itself shows there. Null without evidence.
const OV_COLS = 347;
const decoded = new WeakMap();
export function seamEvidence(tile, x0, x1, W) {
  const ov = tile && tile.ov;
  if (!ov) return null;
  // Decoded once per tile, kept off the record (which is written as JSON).
  let dec = decoded.get(ov);
  if (!dec) decoded.set(ov, dec = { prev: Buffer.from(ov.prev, 'base64'), own: Buffer.from(ov.own, 'base64') });
  const { n } = ov, { prev, own } = dec;
  const c0 = Math.floor(x0 * OV_COLS / W), c1 = Math.max(c0 + 1, Math.floor(x1 * OV_COLS / W));
  let dis = 0, cap = 0, mine = 0;
  const rows = Math.min(6, n);
  for (let r = n - rows; r < n; r++) for (let c = c0; c < c1; c++) dis += Math.abs(prev[r * OV_COLS + c] - own[r * OV_COLS + c]);
  for (let c = c0; c < c1; c++) {
    cap += Math.abs(prev[(n - 1) * OV_COLS + c] - own[n * OV_COLS + c]);
    mine += Math.abs(own[(n - 1) * OV_COLS + c] - own[n * OV_COLS + c]);
  }
  const k = c1 - c0;
  return { dis: dis / (k * rows), cap: cap / k, own: mine / k };
}

// Whether the extension itself found this tile's overlap matching the tile
// above (placements, from 15e3544 on): its pixel match came out 'ok', or
// (from c539d2d on) no column block disagreed. Null when it didn't say.
function placementAgrees(p) {
  if (!p) return null;
  if (p.agree) return p.agree.blocks === 0;
  if (p.match && p.match.match === 'ok') return true;
  if (p.match && (p.match.match === 'mismatch' || p.match.match === 'moved')) return false;
  return null;
}

export function seams(img, tiles, { region = null, minBlocks = T.seamMinBlocks, placements = null } = {}) {
  const flags = [];
  let worst = 0, cleared = 0;
  const [rx0, rx1] = region && region.x != null ? cols(img, region.x, region.w) : [0, img.W];
  const nb = region && region.x != null ? Math.max(1, Math.round(T.seamBlocks * (rx1 - rx0) / img.W)) : T.seamBlocks;
  const placed = placements ? placements.filter((p) => !p.retake && !p.reshot) : null;
  for (let ti = 1; ti < tiles.length; ti++) {
    const B = tiles[ti].drawY ?? tiles[ti].y;
    if (B <= 0 || B >= img.H) continue;
    if (B < 32 || B > img.H - 32) continue;
    if (region && (B < region.y0 || B >= region.y1)) continue;
    // Best evidence: the two shots of the rows above the seam. A break the
    // later shot shows itself, over rows both shots agree on, is an edge in
    // the page (a section starting there), not a seam. A seam is a jump the
    // capture shows and the later shot doesn't, where the shots disagree.
    if (tiles[ti].ov) {
      const hits = [];
      for (let k = 0; k < nb; k++) {
        const x0 = rx0 + Math.floor((rx1 - rx0) * k / nb), x1 = rx0 + Math.floor((rx1 - rx0) * (k + 1) / nb);
        const e = seamEvidence(tiles[ti], x0, x1, img.W);
        const step = e.cap - e.own;
        if (e.cap >= T.seamJump) worst = Math.max(worst, step);
        if (e.dis >= T.ovDisagree && e.cap >= T.seamJump && step >= T.ovStep) hits.push({ k, jump: Math.round(e.cap), own: Math.round(e.own), dis: Math.round(e.dis) });
      }
      if (hits.length >= T.ovMinBlocks) {
        const h = hits.reduce((m, x) => (x.jump > m.jump ? x : m));
        flags.push({ y0: B - 8, y1: B + 8, note: `break at ${B}px in ${hits.length}/${nb} column blocks where the two shots disagree (jump ${h.jump}; the later shot alone ${h.own}; shots differ by ${h.dis})` });
      }
      continue;
    }
    // Without it, the extension's own overlap match: a seam where it found
    // the overlap matching is an edge in the page.
    if (placed && placementAgrees(placed[ti]) === true) { cleared++; continue; }
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
  return { pass: flags.length === 0, value: +worst.toFixed(1), detail: `${flags.length} seam(s); strongest boundary score ${worst.toFixed(1)}${cleared ? `; ${cleared} boundary break(s) cleared by the extension's overlap match` : ''}`, flags };
}

// (d) Truncation: the capture is much shorter than the page's real
// scrollable height (measured before the capture, including an inner
// scrolling container when the document itself doesn't scroll).
export function truncation(img, cap, { slack = T.truncSlack } = {}) {
  // Every height the page had while it was captured: before, after, and at
  // each tile. A page that shrank during the capture (pin spacers removed,
  // a section collapsed) is held to its smallest height.
  const hs = [cap.factsBefore && cap.factsBefore.scrollable, cap.factsAfter && cap.factsAfter.scrollable, ...(cap.tiles || []).map((t) => t.pageHeight)]
    .filter((h) => h > 0);
  const real = cap.factsBefore.scrollable;
  // The extension's height cap (background.js): 100000 CSS px, or less where
  // the image would pass 2^31 bytes of RGBA (about 96,700 px at 2776 px
  // wide). Commits before the bands capped at 60000.
  const capPx = Math.min(100000, Math.floor((2 ** 31 - 1) / 4 / img.devWidth / img.dpr));
  const least = Math.min(capPx, ...hs);
  const short = least - img.H;
  const pass = short <= slack;
  return {
    pass, value: short,
    detail: `capture ${img.H}px; page ${real}px scrollable, never under ${least}px during the capture (${short > 0 ? `${short}px short` : 'not short'}; fail beyond ${slack}px)`,
    flags: pass ? [] : [{ y0: Math.max(0, img.H - 4), y1: img.H, note: `capture ends at ${img.H}px; page was never shorter than ${least}px` }]
  };
}

// (e) Unpainted rows: rows of the capture that are fully transparent, so no
// tile was ever drawn there. A screenshot is always opaque, so any such row
// is a hole, including a run at the very bottom.
export function unpaintedRows(img) {
  const flags = [];
  let start = -1;
  for (let y = 0; y <= img.H; y++) {
    const hole = y < img.H && img.unpainted[y];
    if (hole && start < 0) start = y;
    if (!hole && start >= 0) { flags.push({ y0: start, y1: y, note: `${y - start}px never painted` }); start = -1; }
  }
  const total = flags.reduce((s, f) => s + (f.y1 - f.y0), 0);
  return { pass: total === 0, value: total, detail: `${total} transparent row(s) in ${flags.length} run(s)`, flags };
}

export async function runGeneric(img, cap) {
  const tiles = tileRects(cap);
  const vh = cap.prepare ? cap.prepare.viewportHeight : 868;
  const dom = cap.dom && !cap.dom.error ? cap.dom : null;
  // Everything the page had fixed to the window, before and after.
  const fixedBoxes = dom ? [...(dom.fixed || []), ...((cap.gate && cap.gate.fixed) || [])].map((f) => f.box) : null;
  return {
    'blank-band': blankBands(img, { vh, dom }),
    'repeated-overlay': repeatedOverlays(img, tiles, { fixedBoxes }),
    'seam': seams(img, tiles, { placements: cap.placements }),
    'truncation': truncation(img, cap),
    'unpainted-rows': unpaintedRows(img),
    'text-same-colour': await textSameColour(img, cap)
  };
}
