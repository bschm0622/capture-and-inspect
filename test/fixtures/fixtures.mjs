// Synthetic local pages that drive paths of the stitcher no live site in the
// regression set reaches: pages taller than a canvas can be (painted into
// several canvases, bands, and written by the extension's own PNG writer),
// the page height cap, a canvas that has to grow, a stale frame, a shot budget that
// runs low with rows left unpainted, and a modal's fixed-body scroll lock.
// `node test/run.mjs --fixtures` serves this folder on 127.0.0.1 and
// captures each page through the real extension; the generic detectors run
// too. Each page is a stack of 200px bands of known colours (bands.js), so a
// check can say exactly which content is out of place.

import sharp from 'sharp';
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

// Where the stitcher's canvases meet in the capture (device rows): each is
// as tall as Chrome allows a canvas at this width (background.js bands).
const bandEdges = (img) => {
  const rows = Math.min(65535, Math.floor(268435456 / img.devWidth));
  const out = [];
  for (let y = rows; y < img.devHeight; y += rows) out.push(y);
  return out;
};

// The extension's height cap for this width: MAX_PAGE_HEIGHT, or less when
// the image would pass 2^31 bytes of RGBA (background.js).
const heightCap = (img) => Math.min(100000, Math.floor((2 ** 31 - 1) / 4 / img.devWidth / img.dpr));

// Every device row of the capture, at full resolution, shows its band's
// colour in the plain strip at the right (within 3 levels). Catches a row
// lost, doubled or shifted anywhere, a band edge included, to the pixel.
async function rowsExact(img, until = img.devHeight) {
  const left = Math.round(1260 * img.dpr), width = Math.round(120 * img.dpr);
  const { data, info } = await sharp(img.png, { limitInputPixels: false })
    .extract({ left, top: 0, width, height: until }).raw().toBuffer({ resolveWithObject: true });
  const ch = info.channels;
  const bad = [];
  for (let y = 0; y < until; y++) {
    const want = bandColour(Math.floor(y / img.dpr / BAND));
    const s = [0, 0, 0];
    for (let x = 0; x < width; x++) for (let k = 0; k < 3; k++) s[k] += data[(y * width + x) * ch + k];
    if (Math.max(...s.map((v, k) => Math.abs(v / width - want[k]))) > 3) bad.push(y);
  }
  const flags = [];
  for (const y of bad) {
    const f = flags[flags.length - 1], c = Math.floor(y / img.dpr);
    if (f && c <= f.y1) f.y1 = c + 1; else flags.push({ y0: c, y1: c + 1, note: 'rows show the wrong band colour' });
  }
  return result(bad.length === 0, bad.length, `${until - bad.length} of ${until} device rows show their band's colour`, flags.slice(0, 20));
}

// The capture around each place where two of the stitcher's canvases meet
// equals the browser's own screenshot of the page there (taken after the
// capture, page restored), row for row over the full width: text, edges and
// all. Each band edge must fall inside a reference screenshot.
async function edgesMatchPage(img, cap) {
  const edges = bandEdges(img);
  const shots = cap.refShots || [];
  const covered = edges.filter((e) => shots.some((s) => e > s.scrollY * img.dpr + 8 && e < (s.scrollY + 868) * img.dpr - 8));
  let worst = 0, badRows = 0, rows = 0;
  const flags = [];
  for (const s of shots) {
    const ref = await sharp(s.png).removeAlpha().raw().toBuffer({ resolveWithObject: true });
    const top = Math.round(s.scrollY * img.dpr);
    const h = Math.min(ref.info.height, img.devHeight - top);
    if (h <= 0) continue;
    const got = await sharp(img.png, { limitInputPixels: false }).extract({ left: 0, top, width: img.devWidth, height: h })
      .removeAlpha().raw().toBuffer();
    const W = img.devWidth;
    for (let y = 0; y < h; y++) {
      let d = 0;
      for (let i = y * W * 3, e = i + W * 3; i < e; i++) d += Math.abs(got[i] - ref.data[i]);
      d /= W * 3;
      rows++;
      worst = Math.max(worst, d);
      if (d > 0.5) {
        badRows++;
        const c = Math.floor((top + y) / img.dpr), f = flags[flags.length - 1];
        if (f && c <= f.y1) f.y1 = c + 1; else flags.push({ y0: c, y1: c + 1, note: 'differs from the browser\'s own screenshot of the page here' });
      }
    }
  }
  const ok = edges.length > 0 && covered.length === edges.length && badRows === 0;
  return result(ok, badRows, `${edges.length} canvas edge(s) at device rows ${edges.join(', ') || 'none'}, ${covered.length} inside a reference shot; ${rows} rows compared, ${badRows} differ (worst mean |Δ| ${worst.toFixed(2)})`, flags.slice(0, 20));
}

const warned = (cap, kind) => (cap.warnings || []).filter((w) => w.kind === kind);

// Rows of the capture where at least `min` grid columns show `rgb` (within
// 24 levels a channel), merged into runs. The fixtures paint their floating
// parts in colours no band ever has (bands keep each channel within 30-229).
function rowsWith(img, rgb, { min = 6, y0 = 0, y1 = img.H } = {}) {
  const runs = [];
  for (let y = y0; y < Math.min(y1, img.H); y++) {
    let n = 0;
    for (let x = 0; x < img.W; x++) {
      const j = (y * img.W + x) * 3;
      if (Math.abs(img.rgb[j] - rgb[0]) <= 24 && Math.abs(img.rgb[j + 1] - rgb[1]) <= 24 && Math.abs(img.rgb[j + 2] - rgb[2]) <= 24) n++;
    }
    if (n < min) continue;
    const r = runs[runs.length - 1];
    if (r && y <= r.y1 + 1) r.y1 = y + 1; else runs.push({ y0: y, y1: y + 1 });
  }
  return runs;
}

// One moment of something that changes on its own: every row of CSS rows
// [y0, y1) shows the same colour in the plain strip at the right as the
// region's first row (within 16 levels a channel), and that colour is no
// band's. A tile edge through two moments shows as rows of another colour.
function oneMoment(img, y0, y1) {
  const first = meanRgb(img, y0, y0 + 1);
  const off = [];
  for (let y = y0; y < Math.min(y1, img.H); y++) {
    const c = meanRgb(img, y, y + 1);
    if (Math.max(...c.map((v, k) => Math.abs(v - first[k]))) > 16) {
      const f = off[off.length - 1];
      if (f && y <= f.y1) f.y1 = y + 1; else off.push({ y0: y, y1: y + 1, note: `rgb(${c.map(Math.round).join(',')}) here, rgb(${first.map(Math.round).join(',')}) at y ${y0}` });
    }
  }
  return result(off.length === 0, off.length, off.length ? `${off.length} run(s) of rows show another moment than the region's top` : `rows ${y0}-${y1} show one moment, rgb(${first.map(Math.round).join(',')})`, off.slice(0, 10));
}
// Mean colour of the capture over CSS x [x, x + w) and rows [y0, y1).
function meanBox(img, x, w, y0, y1) {
  const [x0, x1] = cols(img, x, w);
  const s = [0, 0, 0];
  let n = 0;
  for (let y = y0; y < Math.min(y1, img.H); y++) for (let c = x0; c < x1; c++) {
    const j = (y * img.W + c) * 3;
    s[0] += img.rgb[j]; s[1] += img.rgb[j + 1]; s[2] += img.rgb[j + 2]; n++;
  }
  return n ? s.map((v) => v / n) : [NaN, NaN, NaN];
}
// Mean difference (0-255) between two boxes of the capture at full
// resolution, CSS x `xa` and `xb`, rows [y, y + h), `w` wide.
async function boxDiff(img, xa, xb, w, y, h) {
  const box = (x) => sharp(img.png, { limitInputPixels: false }).removeAlpha()
    .extract({ left: Math.round(x * img.dpr), top: Math.round(y * img.dpr), width: Math.round(w * img.dpr), height: Math.round(h * img.dpr) })
    .raw().toBuffer();
  const [a, b] = await Promise.all([box(xa), box(xb)]);
  let s = 0;
  for (let i = 0; i < a.length; i++) s += Math.abs(a[i] - b[i]);
  return s / a.length;
}
const near = (got, want, slack = 40) => got.every((v, k) => Math.abs(v - want[k]) <= slack);
const rgbText = (c) => `rgb(${c.map(Math.round).join(',')})`;

export const FIXTURES = [
  {
    name: 'tall-40k', file: 'tall-40k.html', refShots: [32768],
    checks: {
      // 40000 CSS px at device scale 2 is 80000 px: past the 65535 px a
      // canvas side may be, so two canvases and the extension's PNG writer.
      // The capture must still come back, whole and full resolution.
      'bands-in-place': ({ img }) => bandsInPlace(img),
      'full-height': ({ img }) => result(Math.abs(img.H - 40000) <= 2 && img.devWidth === 2776, img.H, `capture ${img.devWidth}x${img.devHeight} for a 40000px page`),
      'rows-exact': ({ img }) => rowsExact(img),
      'edges-match-page': ({ img, cap }) => edgesMatchPage(img, cap)
    }
  },
  {
    name: 'tall-64k', file: 'tall-64k.html', refShots: [32768, 63500],
    checks: {
      // Past the old 60000 px cap, under the new one: captured whole.
      'bands-in-place': ({ img }) => bandsInPlace(img),
      'full-height': ({ img }) => result(Math.abs(img.H - 64000) <= 2 && img.devWidth === 2776, img.H, `capture ${img.devWidth}x${img.devHeight} for a 64000px page`),
      'rows-exact': ({ img }) => rowsExact(img),
      'edges-match-page': ({ img, cap }) => edgesMatchPage(img, cap),
      // No warnings a whole, still page doesn't earn.
      'no-false-warnings': ({ cap }) => {
        const w = (cap.warnings || []).filter((x) => x.kind === 'truncated' || x.kind === 'page-height-changed');
        return result(w.length === 0, w.length, w.length ? w.map((x) => x.note).join('; ') : 'no truncated or page-height-changed warning');
      }
    }
  },
  {
    name: 'tall-100k', file: 'tall-100k.html', refShots: [32768, 65536],
    checks: {
      'bands-in-place': ({ img }) => bandsInPlace(img),
      'rows-exact': ({ img }) => rowsExact(img),
      'edges-match-page': ({ img, cap }) => edgesMatchPage(img, cap),
      // Past the height cap: the extension captures up to it, says so once,
      // and nothing else about the page's height.
      'capped-and-said': ({ img, cap }) => {
        const c = heightCap(img);
        const w = warned(cap, 'truncated');
        const changed = warned(cap, 'page-height-changed');
        const ok = Math.abs(img.H - c) <= 2 && w.length === 1 && w[0].reason === 'too-tall' && changed.length === 0;
        return result(ok, img.H, `capture ${img.H}px (cap ${c}); ${w.length} truncated warning(s)${w.length ? `: ${w[0].note}` : ''}; ${changed.length} page-height-changed`);
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
  },
  {
    name: 'restyle', file: 'restyle.html', settleMs: 500,
    checks: {
      'bands-in-place': ({ img }) => bandsInPlace(img),
      // The chat bubble (magenta) rewrites its whole style attribute every
      // 150ms; it must be hidden in every tile all the same.
      'bubble-hidden': ({ img }) => {
        const runs = rowsWith(img, [255, 0, 255]);
        return result(runs.length === 0, runs.length, `${runs.length} place(s) in the capture show the chat bubble`,
          runs.map((r) => ({ ...r, note: 'chat bubble in the capture' })));
      }
    }
  },
  {
    name: 'slider-timer', file: 'slider-timer.html', settleMs: 500,
    checks: {
      'bands-in-place': ({ img }) => bandsInPlace(img, { first: 6, top: 1200 }),
      // A slider turned by a timer from page load, cut by a tile edge.
      'hero-one-slide': ({ img }) => oneMoment(img, 2, 1198)
    }
  },
  {
    name: 'webgl-tall', file: 'webgl-tall.html', settleMs: 500,
    checks: {
      'bands-in-place': ({ img }) => bandsInPlace(img, { first: 6, top: 1200 }),
      // A WebGL canvas drawn every frame, cut by a tile edge.
      'canvas-one-frame': ({ img }) => oneMoment(img, 1, 1199)
    }
  },
  {
    name: 'restart-anim', file: 'restart-anim.html', settleMs: 500,
    checks: {
      'bands-in-place': ({ img }) => bandsInPlace(img, { first: 6, top: 1100 }),
      // An animation the page starts again on the capture's scroll.
      'animation-one-frame': ({ img }) => oneMoment(img, 2, 1098)
    }
  },
  {
    name: 'flaky-image', file: 'flaky-image.html', settleMs: 500,
    checks: {
      'bands-in-place': ({ img }) => bandsInPlace(img, { until: 1000 }),
      // The image whose first request failed is in the capture (orange).
      'image-shown': ({ img }) => {
        const bad = [];
        for (let y = 1005; y < 1595; y++) {
          const c = meanRgb(img, y, y + 1);
          if (Math.max(Math.abs(c[0] - 240), Math.abs(c[1] - 120), Math.abs(c[2])) > 16) bad.push(y);
        }
        return result(bad.length === 0, bad.length, `${590 - bad.length} of 590 rows of the image show it`, bad.length ? [{ y0: bad[0], y1: bad[bad.length - 1] + 1, note: 'image missing' }] : []);
      }
    }
  },
  {
    name: 'frame-slow', file: 'frame-slow.html', settleMs: 500,
    checks: {
      'bands-in-place': ({ img }) => bandsInPlace(img, { until: 1600 }),
      // The frame from another site, shot once it had painted (green, not
      // its grey placeholder).
      'frame-painted': ({ img }) => {
        const bad = [];
        for (let y = 1705; y < 2095; y++) {
          const c = meanRgb(img, y, y + 1);
          if (Math.max(Math.abs(c[0]), Math.abs(c[1] - 200), Math.abs(c[2] - 90)) > 16) bad.push(y);
        }
        return result(bad.length === 0, bad.length, `${390 - bad.length} of 390 rows of the frame show it painted`, bad.length ? [{ y0: bad[0], y1: bad[bad.length - 1] + 1, note: 'frame not painted' }] : []);
      }
    }
  },
  {
    name: 'late-header', file: 'late-header.html', settleMs: 500,
    checks: {
      'bands-in-place': ({ img }) => bandsInPlace(img, { top: 120 }),
      // The header (dark blue) turns fixed once the page scrolls; it must be
      // at the top of the capture, even when the first tile is shot again
      // after it turned fixed, and nowhere else.
      'header-once-at-top': ({ img, cap }) => {
        const runs = rowsWith(img, [20, 40, 160], { min: 60 });
        const top = runs.find((r) => r.y0 <= 2 && r.y1 >= 110);
        const elsewhere = runs.filter((r) => r !== top);
        const reshot = (cap.placements || []).some((p) => p.reshot && p.index === 0);
        return result(!!top && !elsewhere.length && reshot, runs.length,
          `${top ? 'header at the top' : 'no header at the top'}; ${elsewhere.length} other place(s) show it; first tile ${reshot ? 'shot again' : 'not shot again (the path this fixture is for did not run)'}`,
          [...(top ? [] : [{ y0: 0, y1: 120, note: 'header missing from the top' }]), ...elsewhere.map((r) => ({ ...r, note: 'header repeated' }))]);
      }
    }
  },
  {
    name: 'late-float', file: 'late-float.html', settleMs: 500,
    checks: {
      'bands-in-place': ({ img }) => bandsInPlace(img),
      // Two back-to-top buttons (magenta) the page adds only once it has
      // scrolled: a zero-height sticky box at the end of the content and a
      // fixed button. Neither may show anywhere in the capture.
      'late-buttons-hidden': ({ img }) => {
        const runs = rowsWith(img, [255, 0, 255], { min: 4 });
        return result(runs.length === 0, runs.length, `${runs.length} place(s) in the capture show a back-to-top button`,
          runs.map((r) => ({ ...r, note: 'back-to-top button in the capture' })));
      },
      // A closed drawer parked off the left edge: its shadow (green) must
      // not show at the edge of the first screen.
      'offscreen-drawer-hidden': ({ img }) => {
        const runs = rowsWith(img, [0, 255, 0], { min: 4 });
        return result(runs.length === 0, runs.length, `${runs.length} place(s) in the capture show the off-screen drawer's shadow`,
          runs.map((r) => ({ ...r, note: 'drawer shadow in the capture' })));
      }
    }
  },
  {
    name: 'widget-layer', file: 'widget-layer.html', settleMs: 500,
    checks: {
      'bands-in-place': ({ img }) => bandsInPlace(img, { top: 100 }),
      // Chat launchers (magenta) held in see-through full-window layers,
      // one there at load and one added on scroll: neither may show.
      'launchers-hidden': ({ img }) => {
        const runs = rowsWith(img, [255, 0, 255], { min: 4 });
        return result(runs.length === 0, runs.length, `${runs.length} place(s) in the capture show a chat launcher`,
          runs.map((r) => ({ ...r, note: 'chat launcher in the capture' })));
      },
      // The header (cyan) held in a layer of the same kind: at the top of
      // the capture, and nowhere else.
      'header-once-at-top': ({ img }) => {
        const runs = rowsWith(img, [0, 200, 200], { min: 30 });
        const top = runs.find((r) => r.y0 <= 4 && r.y1 >= 90);
        const rest = runs.filter((r) => r !== top);
        return result(!!top && rest.length === 0, rest.length,
          `${top ? 'header at the top' : 'no header at the top'}; ${rest.length} other place(s) show it`,
          [...(top ? [] : [{ y0: 0, y1: 100, note: 'header missing' }]), ...rest.map((r) => ({ ...r, note: 'header repeated' }))]);
      }
    }
  },
  {
    name: 'header-swap', file: 'header-swap.html', settleMs: 500,
    checks: {
      'bands-in-place': ({ img }) => bandsInPlace(img, { top: 120 }),
      // At the top, the header as it is at scroll 0: the wordmark (cyan)
      // and not the compact logo (orange) that replaces it once the page
      // scrolls.
      'header-as-at-scroll-0': ({ img }) => {
        const word = rowsWith(img, [0, 200, 200], { min: 30 });
        const top = word.find((r) => r.y0 <= 32 && r.y1 >= 88);
        const g = rowsWith(img, [255, 128, 0], { min: 4 });
        return result(!!top && g.length === 0, g.length,
          `${top ? 'wordmark at the top' : 'no wordmark at the top'}; ${g.length} place(s) show the scrolled-state logo`,
          [...(top ? [] : [{ y0: 0, y1: 120, note: 'wordmark missing' }]), ...g.map((r) => ({ ...r, note: 'scrolled-state logo in the capture' }))]);
      }
    }
  },
  {
    name: 'sticky-swap', file: 'sticky-swap.html', settleMs: 500,
    checks: {
      'bands-in-place': ({ img }) => bandsInPlace(img, { until: 2000 }),
      // Beside the middle of each of the four items (y 2000 + 500k + 250),
      // the panel column shows that item's picture.
      'picture-beside-each-item': ({ img }) => {
        const want = [[255, 0, 0], [0, 0, 255], [255, 0, 255], [0, 255, 0]];
        const flags = [];
        want.forEach((c, k) => {
          const y = 2000 + 500 * k + 250;
          const got = meanBox(img, 900, 200, y - 20, y + 20);
          if (!near(got, c)) flags.push({ y0: y - 250, y1: y + 250, note: `item ${k + 1}: the panel column shows ${rgbText(got)}, not its picture ${rgbText(c)}` });
        });
        return result(flags.length === 0, flags.length, `${4 - flags.length} of 4 items have their own picture beside them`, flags);
      }
    }
  },
  {
    name: 'slow-fade', file: 'slow-fade.html', settleMs: 500,
    checks: {
      'bands-in-place': ({ img }) => bandsInPlace(img, { until: 2200 }),
      // The heading block the page fades in late, shot half faded in one
      // tile and opaque in the next: black in the capture, top to bottom.
      'fade-opaque-whole': ({ img }) => {
        const bad = [];
        for (let y = 2288; y < 2380; y++) {
          const c = meanBox(img, 200, 800, y, y + 1);
          if (Math.max(...c) > 40) bad.push(y);
        }
        return result(bad.length === 0, bad.length, `${92 - bad.length} of 92 rows of the block are opaque`,
          bad.length ? [{ y0: bad[0], y1: bad[bad.length - 1] + 1, note: 'block faded or missing' }] : []);
      }
    }
  },
  {
    name: 'lazy-clone', file: 'lazy-clone.html', settleMs: 500,
    checks: {
      'bands-in-place': ({ img }) => bandsInPlace(img, { until: 1600 }),
      // Each of the three slides on screen shows its star image (magenta),
      // the carousel's loop copy included.
      'stars-in-every-slide': ({ img }) => {
        const flags = [];
        [60, 460, 860].forEach((x, k) => {
          const got = meanBox(img, x + 40, 200, 1740, 1765);
          if (!near(got, [255, 0, 255])) flags.push({ y0: 1728, y1: 1776, note: `slide ${k + 1}: ${rgbText(got)} where its stars should be` });
        });
        return result(flags.length === 0, flags.length, `${3 - flags.length} of 3 slides show their stars`, flags);
      }
    }
  },
  {
    name: 'count-up', file: 'count-up.html', settleMs: 500,
    checks: {
      'bands-in-place': ({ img }) => bandsInPlace(img, { until: 2000 }),
      // Each number that counts up shows its final value: its box looks
      // like the final value written out beside it.
      'numbers-at-final-value': async ({ img }) => {
        const rows = [['timeouts', 2030], ['frames', 2150], ['interval', 2270], ['rested', 3830]];
        const flags = [];
        for (const [what, y] of rows) {
          const d = await boxDiff(img, 40, 680, 320, y, 70);
          if (d > 2) flags.push({ y0: y, y1: y + 70, note: `the number counted by ${what} differs from its final value (mean difference ${d.toFixed(1)})` });
        }
        return result(flags.length === 0, flags.length, `${rows.length - flags.length} of ${rows.length} numbers at their final value`, flags);
      }
    }
  }
];

export const fixtureHost = (name) => `fixture-${name}`;
