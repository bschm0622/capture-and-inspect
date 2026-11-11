// Checks that compare the capture with the page's own account of what is on
// it (`cap.dom`, read by capture.mjs after the capture: text lines, images,
// embeds, in page CSS px). Pixels alone can't tell a section whose content
// never painted from a section that is meant to be empty; the page can.
//
// The page is measured after the capture, when the extension has restored
// it. If its height changed by more than layoutSlack since, positions may
// not line up with the capture and these checks say so instead of judging.
//
// Two more were tried and dropped (2026-11, ae5e1f3 re-capture of the
// gallery sweep): images the page never loaded with an empty box in the
// capture, and iframes/videos/canvases whose box is empty. On 39 defective
// and 23 ok sites they flagged nothing at all: the content that never loaded
// there (reviews widgets, galleries, video embeds) was never put in the page
// by the scripts that should have, so the page had no image or embed to ask
// about.

import { cols, inkShare } from './image.mjs';

export const P = {
  layoutSlack: 24,     // CSS px the page height may differ from the capture
  // text-same-colour
  coarseInk: 0.03,     // share of a line's grid cells apart from its mode that surely means ink
  inkTol: 32,          // grey levels apart from the box's mode that count as ink
  noInk: 0.002,        // a line with less ink than this share painted nothing
  sameColour: 40,      // grey levels: the flat box is the text's own colour
  mergeGap: 80,        // CSS px between invisible lines merged into one range
  minChars: 40         // characters of invisible text in a range to flag it
};

const usable = (img, dom) => {
  if (!dom || dom.error || !dom.lines) return 'no page facts (commit or run from before they were read)';
  if (Math.abs(dom.height - img.H) > P.layoutSlack) return `page is ${dom.height}px tall now and the capture ${img.H}px: positions may not line up, not judged`;
  return null;
};
const skip = (why) => ({ pass: true, value: null, detail: why, flags: [] });

// Quick look on the analysis grid: whether a box surely has ink.
function coarseInk(img, [x, y, w, h]) {
  const [x0, x1] = cols(img, x, w);
  const a = Math.max(0, Math.round(y)), b = Math.min(img.H, Math.round(y + h));
  const hist = new Uint32Array(256);
  let n = 0;
  for (let yy = a; yy < b; yy++) for (let xx = x0; xx < x1; xx++) { hist[img.luma[yy * img.W + xx]]++; n++; }
  if (!n) return 0;
  let mode = 0;
  for (let v = 1; v < 256; v++) if (hist[v] > hist[mode]) mode = v;
  let apart = 0;
  for (let v = 0; v < 256; v++) if (Math.abs(v - mode) > P.inkTol) apart += hist[v];
  return apart / n;
}

// Text drawn in the colour behind it: a line box of visible text (not
// hidden, not transparent, not clipped, not in a fixed box) that is one
// flat colour in the capture, and that colour is the text's own. That is
// light text whose background (a photo, a dark band) never loaded. A box
// that is flat in some other colour is not judged: the page is measured
// after the capture, and a block that slid in or a section that moved since
// leaves boxes over plain background with the text a little way off.
export async function textSameColour(img, cap) {
  const why = usable(img, cap.dom);
  if (why) return skip(why);
  const bad = [];
  for (const [x, y, w, h, L, chars] of cap.dom.lines) {
    if (y < 0 || y + h > img.H) continue;
    if (coarseInk(img, [x, y, w, h]) >= P.coarseInk) continue;
    const ink = await inkShare(img, { x, y, w, h }, P.inkTol);
    if (!ink || ink.share >= P.noInk || Math.abs(ink.mode - L) > P.sameColour) continue;
    bad.push({ y0: y, y1: y + h, chars });
  }
  bad.sort((a, b) => a.y0 - b.y0);
  const ranges = [];
  for (const b of bad) {
    const r = ranges[ranges.length - 1];
    if (r && b.y0 - r.y1 <= P.mergeGap) { r.y1 = Math.max(r.y1, b.y1); r.chars += b.chars; r.lines++; }
    else ranges.push({ y0: b.y0, y1: b.y1, chars: b.chars, lines: 1 });
  }
  const flags = ranges.filter((r) => r.chars >= P.minChars).map((r) => ({
    y0: r.y0, y1: r.y1,
    note: `${r.lines} line(s), ${r.chars} chars of text drawn in the colour behind it`
  }));
  const chars = bad.reduce((s, b) => s + b.chars, 0);
  return { pass: !flags.length, value: chars, detail: `${bad.length} of ${cap.dom.lines.length} text lines drawn in the colour behind them (${chars} chars)${cap.dom.truncated ? '; page had more lines than were read' : ''}`, flags };
}

// What the page has between y0 and y1 (CSS px): text lines, images and
// embeds at least half inside the range.
export function contentIn(dom, y0, y1) {
  const inside = (y, h) => Math.min(y + h, y1) - Math.max(y, y0) >= h / 2;
  const lines = dom.lines.filter(([, y, , h]) => inside(y, h));
  return {
    lines: lines.length, chars: lines.reduce((s, l) => s + l[5], 0),
    images: dom.images.filter((i) => inside(i.box[1], i.box[3])).length,
    embeds: dom.embeds.filter((e) => inside(e.box[1], e.box[3])).length
  };
}
export const usableDom = usable;
