// Synthetic local pages that drive paths of the stitcher no live site in the
// regression set reaches: a page taller than a canvas can be, the page
// height cap, a canvas that has to grow, a stale frame, a shot budget that
// runs low with rows left unpainted, and a modal's fixed-body scroll lock.
// `node test/run.mjs --fixtures` serves this folder on 127.0.0.1 and
// captures each page through the real extension; the generic detectors run
// too. Each page is a stack of 200px bands of known colours (bands.js), so a
// check can say exactly which content is out of place.

import { result } from '../lib/regions.mjs';
import { cols } from '../lib/image.mjs';

const BAND = 200;
const bandColour = (i) => [(i * 67 + 40) % 200 + 30, (i * 131 + 90) % 200 + 30, (i * 29 + 150) % 200 + 30];

// Mean colour of the capture over CSS rows [y0, y1) and the band's plain
// strip at the right.
function meanRgb(img, y0, y1) {
  const [x0, x1] = cols(img, 1260, 120);
  const s = [0, 0, 0];
  let n = 0;
  for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) {
    const j = (y * img.W + x) * 3;
    s[0] += img.rgb[j]; s[1] += img.rgb[j + 1]; s[2] += img.rgb[j + 2]; n++;
  }
  return s.map((v) => v / n);
}

// Every band from `first` whose middle is in the capture shows its own
// colour there (rows 60-140 of the band; 12 grey levels of slack). `top` is
// where band `first` starts in the capture.
function bandsInPlace(img, { first = 0, top = 0, until = img.H } = {}) {
  const flags = [];
  let checked = 0;
  for (let i = first; ; i++) {
    const y = top + (i - first) * BAND;
    if (y + 140 > Math.min(img.H, until)) break;
    checked++;
    const got = meanRgb(img, y + 60, y + 140);
    const want = bandColour(i);
    const off = Math.max(...got.map((v, k) => Math.abs(v - want[k])));
    if (off > 12) flags.push({ y0: y, y1: y + BAND, note: `band ${i} shows rgb(${got.map(Math.round).join(',')}), not rgb(${want.join(',')})` });
  }
  const merged = [];
  for (const f of flags) {
    const m = merged[merged.length - 1];
    if (m && f.y0 <= m.y1) { m.y1 = f.y1; m.n++; } else merged.push({ ...f, n: 1 });
  }
  return result(flags.length === 0, flags.length, `${checked - flags.length} of ${checked} bands in place`,
    merged.map((m) => ({ y0: m.y0, y1: m.y1, note: m.n > 1 ? `${m.n} bands out of place from here: ${m.note}` : m.note })));
}

const warned = (cap, kind) => (cap.warnings || []).filter((w) => w.kind === kind);

export const FIXTURES = [
  {
    name: 'tall-40k', file: 'tall-40k.html',
    checks: {
      // 40000 CSS px at device scale 2 is 80000 px: past the 65535 px a
      // canvas side may be. The capture must still come back, whole.
      'bands-in-place': ({ img }) => bandsInPlace(img),
      'full-height': ({ img }) => result(Math.abs(img.H - 40000) <= 2, img.H, `capture ${img.H}px for a 40000px page`)
    }
  },
  {
    name: 'tall-64k', file: 'tall-64k.html',
    checks: {
      'bands-in-place': ({ img }) => bandsInPlace(img),
      // The extension captures the first 60000px and says the rest is cut.
      'capped-and-said': ({ img, cap }) => {
        const w = warned(cap, 'truncated');
        return result(Math.abs(img.H - 60000) <= 2 && w.length > 0, img.H, `capture ${img.H}px (cap 60000); ${w.length ? `warned: ${w[0].note}` : 'no truncated warning'}`);
      }
    }
  },
  {
    name: 'grow', file: 'grow.html', settleMs: 500,
    checks: {
      'bands-in-place': ({ img }) => bandsInPlace(img),
      // The page grows from 2600px to 8600px while the tiles run, past the
      // canvas's growth room; the capture must reach the page's end.
      'reaches-end': ({ img, cap }) => {
        const end = cap.factsAfter ? cap.factsAfter.scrollable : null;
        return result(end != null && img.H >= end - 16, img.H, `capture ${img.H}px; page ${end}px after the capture`);
      }
    }
  },
  {
    name: 'stale', file: 'stale.html', settleMs: 500,
    checks: {
      'bands-in-place': ({ img }) => bandsInPlace(img),
      // Evidence the path ran: a shot judged stale and taken again.
      'stale-seen': ({ cap }) => {
        const n = (cap.placements || []).filter((p) => p.stale).length;
        return result(n > 0, n, `${n} shot(s) judged stale and retaken`);
      }
    }
  },
  {
    name: 'shrink', file: 'shrink.html', settleMs: 500,
    // Rows are left unpainted, and the page's height and the capture's
    // can't agree; that is the point.
    expectGenericFail: ['unpainted-rows', 'truncation', 'blank-band', 'seam', 'repeated-overlay', 'text-same-colour'],
    checks: {
      // Nothing can be right here; every row that no tile painted must be
      // reported by the extension, and running low on shots too.
      'holes-reported': ({ img, cap }) => {
        const holes = [];
        let s = -1;
        for (let y = 0; y <= img.H; y++) {
          const h = y < img.H && img.unpainted[y];
          if (h && s < 0) s = y;
          if (!h && s >= 0) { holes.push([s, y]); s = -1; }
        }
        const said = warned(cap, 'unpainted');
        const unsaid = holes.filter(([a, b]) => !said.some((w) => w.y0 <= a + 2 && w.y1 >= b - 2));
        return result(unsaid.length === 0, holes.length, `${holes.length} hole(s) in the capture, ${said.length} reported, ${unsaid.length} not`,
          unsaid.map(([a, b]) => ({ y0: a, y1: b, note: 'rows never painted, not reported' })));
      },
      'budget-reported': ({ cap }) => {
        const b = warned(cap, 'budget');
        const retakes = (cap.placements || []).filter((p) => p.retake).length;
        return result(b.length > 0, retakes, `${retakes} retake(s); ${b.length ? b[0].note : 'no budget warning'}`);
      }
    }
  },
  {
    name: 'body-lock', file: 'body-lock.html', settleMs: 500,
    checks: {
      // The popup and its scrim hidden, the lock undone, the page whole
      // from its top: band 0 at y 0.
      'bands-in-place': ({ img }) => bandsInPlace(img),
      'full-height': ({ img }) => result(Math.abs(img.H - 5000) <= 2, img.H, `capture ${img.H}px for a 5000px page`)
    }
  }
];

export const fixtureHost = (name) => `fixture-${name}`;
