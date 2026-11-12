// Service worker: orchestrates a scroll-and-stitch full-page capture. The
// toolbar popup asks it to start and shows the progress bar; this worker
// drives the injected content script, captures one PNG per viewport tile
// (throttled to Chrome's quota), stitches them on an OffscreenCanvas, and
// opens the editor tab with the result. Progress is streamed to the popup so
// the indicator lives in browser chrome and never touches the page.

importScripts('png.js', 'capture-store.js');

const CAPTURE_MIN_INTERVAL_MS = 600; // Chrome allows ~2 captureVisibleTab/sec
const MAX_CANVAS_AREA = 268435456;   // Chrome canvas area cap (px^2)
// Chrome's limit on either side of a canvas. Past it a canvas is created but
// holds nothing ("The size of the OffscreenCanvas is zero"), so the capture
// is painted into a stack of canvases (bands), each within both limits.
const MAX_CANVAS_SIDE = 65535;
const MAX_PAGE_HEIGHT = 100000;      // CSS px, as in content.js: infinite-scroll safeguard
// The largest image Chrome will decode (2^31 bytes of RGBA): a capture past
// it couldn't be shown on the result page or opened in a Chrome tab. At
// 1388 CSS px wide and 2x that is about 96,700 CSS px of page. It also
// bounds the stitcher's memory, which holds the raw pixels: 2.9 GB at the
// worker's peak for 2776 x 200000 px, measured.
const MAX_IMAGE_BYTES = 2 ** 31 - 1;

let capturing = false;
let lastCaptureTs = 0;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Push a progress update to the popup. Ignore "no receiver" errors — the
// popup may be closed, in which case the capture still completes fine.
function notify(update) {
  chrome.runtime.sendMessage({ type: 'capture-progress', ...update }).catch(() => {});
}

function sendToTab(tabId, msg) {
  return new Promise((resolve, reject) => {
    chrome.tabs.sendMessage(tabId, msg, (resp) => {
      const err = chrome.runtime.lastError;
      if (err) return reject(new Error(err.message));
      resolve(resp);
    });
  });
}

// Wait until Chrome's quota allows the next shot.
async function captureReady() {
  const wait = CAPTURE_MIN_INTERVAL_MS - (Date.now() - lastCaptureTs);
  if (wait > 0) await sleep(wait);
}

async function throttledCapture(windowId) {
  await captureReady();
  const dataUrl = await chrome.tabs.captureVisibleTab(windowId, { format: 'png' });
  lastCaptureTs = Date.now();
  return dataUrl;
}

function setBadge(text, color) {
  chrome.action.setBadgeText({ text });
  if (color) chrome.action.setBadgeBackgroundColor({ color });
}

function clearBadgeLater(ms) {
  setTimeout(() => setBadge('', null), ms);
}

function isCapturable(url) {
  return /^https?:\/\//i.test(url || '') || /^file:\/\//i.test(url || '');
}

async function dataUrlToBitmap(dataUrl) {
  const blob = await (await fetch(dataUrl)).blob();
  return createImageBitmap(blob);
}

// The page can move while it is being shot: a carousel resizes, a header
// shrinks, an embed loads late. So the page isn't cut into a tile plan fixed
// up front. Each tile re-shoots the bottom of the one before, is placed by
// how far the content there moved (measured in the page) and checked by
// matching those overlap rows against what is already on the canvas, and
// only rows not yet painted are drawn. The loop runs until the page's real
// bottom, wherever that ends up.
const OVERLAP = 96;      // CSS px each tile re-shoots of the one before
const MIN_OVERLAP = 24;  // if the page moved and left less than this, shoot again
const MAX_RETAKES = 2;   // per tile
const MATCH_ROWS = 80;   // canvas rows compared with each new tile
const MATCH_OK = 6;      // mean |Δluma| under this counts as the same pixels
const GRID_PX = 4;       // CSS px per column of the matching grid
const GROWTH_TILES = 2;  // room for the page to grow during the capture, in screens

// Two kinds of evidence say where a tile belongs: position (where the page
// scrolled to, corrected by how far the content at the seam measurably
// moved) and pixels (where the tile's overlap matches the canvas). Pixels
// are trusted only when the rows matched are distinctive (textured, and
// matching clearly better there than anywhere else in the tile) and the
// match is within reach of where position says the tile is: on the
// regression set the page moved a tile by at most 266px between two shots.
// A match a whole screen away (Cooper Hewitt: a shot whose bottom rows
// matched the first tile's own bottom rows, 772px up) isn't the page
// moving, it's a shot gone wrong, and position wins.
const MATCH_REACH = 0.5;  // of a screen
// When the page itself says nothing moved (the content noted at the seam
// is where it was, and the page is as tall as at the last shot), a match
// may only fine-tune the placement. Pixels that match farther off are
// something drawn at a new offset in each shot, not content that moved: on
// milanodentalstudio.com a section's photo background matched 231px up and
// the heading over it was painted over, and the capture came out 231px
// short. The largest fine-tuning on the regression set is 5px.
const FIRM_REACH = 8;     // CSS px
// When the overlap doesn't match and the page can't say how far it moved,
// the tile is shot again from half a screen higher, in case the content
// moved up past the shot's top. On a page where that keeps finding nothing
// (parallax images at a new offset in every shot, agcsf.com), it only
// doubles the shots, so it stops after this many misses in a row.
const MAX_LIFT_MISSES = 2;
// Every extra shot (a retake, a lift, a reshoot) must leave enough of the
// shot budget to reach the bottom of the page one plain tile at a time, so
// running out of budget costs certainty at some seams, never content.
const SHOTS_PER_TILE = 2;
const SPARE_SHOTS = 10;
const STALE_WAIT_MS = 250;  // before shooting again a frame that didn't change
// After the page's clock is held, work already under way (a slide moving,
// a fade) gets this long to finish before it is held too (see pageClock).
const HOLD_GRACE_MS = 800;
// What the page starts after the hold, answering the capture's scrolling (a
// reveal and its staggered delays), runs this long before it is held.
const HOLD_AFTER_MS = 3000;

// Two tiles placed right show the same pixels where they overlap. Where they
// don't, in part of the width, the page changed between the two shots: a tab
// or slide that turned on a timer, a fade that moved on, an image that
// finished loading. The tile above is then shot again right before this one,
// so the two agree in time. Bounded, since some things never hold still (a
// canvas animation), and what is left is reported.
const AGREE_CELL = 24;     // |Δluma| at which a grid cell counts as changed
const AGREE_SHARE = 0.03;  // share of a column block's cells that may change
// A tile half a pixel off the grid (the clamped bottom one) renders text a
// little differently from either neighbouring row, up to 5% of a block's
// cells on the regression set, so it gets more room.
const AGREE_SHARE_FRACTIONAL = 0.08;
const AGREE_BLOCKS = 16;
const RESHOOTS_PER_SEAM = 1;
const MAX_RESHOOTS = 3;

// Luma of a bitmap on a coarse grid: one row per CSS px and one column per
// GRID_PX, plenty to tell where two tiles line up and cheap to compare.
function lumaGrid(bmp, w, h) {
  const c = new OffscreenCanvas(w, h);
  const x = c.getContext('2d', { willReadFrequently: true });
  x.drawImage(bmp, 0, 0, w, h);
  const d = x.getImageData(0, 0, w, h).data;
  const out = new Uint8Array(w * h);
  for (let i = 0, j = 0; i < out.length; i++, j += 4) out[i] = (d[j] * 77 + d[j + 1] * 150 + d[j + 2] * 29) >> 8;
  return out;
}

function rowStd(g, w, y) {
  let s = 0, s2 = 0;
  for (let x = y * w, e = x + w; x < e; x++) { s += g[x]; s2 += g[x] * g[x]; }
  const m = s / w;
  return Math.sqrt(Math.max(0, s2 / w - m * m));
}

// Column blocks of the strip worth matching on: mostly clear of overlays
// the page hid since the last shot, and not one flat colour, which matches
// anywhere and says nothing. `use` marks the strip's cells to compare.
function texturedBlocks(sig, w, stripTop, K, edges, use) {
  const out = [];
  for (let b = 0; b + 1 < edges.length; b++) {
    let s = 0, s2 = 0, n = 0;
    for (let j = 0; j < K; j++) {
      for (let x = edges[b]; x < edges[b + 1]; x++) {
        if (!use[j * w + x]) continue;
        const v = sig[(stripTop + j) * w + x];
        s += v; s2 += v * v; n++;
      }
    }
    if (n < K * (edges[b + 1] - edges[b]) / 2) continue;
    const m = s / n;
    if (Math.sqrt(Math.max(0, s2 / n - m * m)) > 12) out.push({ b, n });
  }
  return out;
}

// For every row r of the new tile, how well the canvas strip starting at
// stripTop matches the tile from r down. Compared per column block and
// scored on the better half of the blocks, so something that differs
// between the two shots in part of the width (a sticky sidebar, an image
// that finished loading) doesn't hide an otherwise clean match.
function overlapScores(sig, w, stripTop, K, blocks, edges, use, tile, tileH) {
  const keep = Math.max(2, Math.ceil(blocks.length / 2));
  const scores = new Float32Array(tileH - K + 1);
  const per = new Float64Array(blocks.length);
  for (let r = 0; r <= tileH - K; r++) {
    per.fill(0);
    for (let j = 0; j < K; j++) {
      const a = (stripTop + j) * w, t = (r + j) * w, u = j * w;
      for (let k = 0; k < blocks.length; k++) {
        const b = blocks[k].b;
        let s = 0;
        for (let x = edges[b]; x < edges[b + 1]; x++) if (use[u + x]) s += Math.abs(sig[a + x] - tile[t + x]);
        per[k] += s;
      }
    }
    const sorted = Array.from(per, (s, k) => s / blocks[k].n).sort((p, q) => p - q);
    let sum = 0;
    for (let k = 0; k < keep; k++) sum += sorted[k];
    scores[r] = sum / keep;
  }
  return scores;
}

// Where the new tile belongs, given where the page says (predicted). Keeps
// the prediction when the overlap confirms it or has too little texture to
// say; moves the tile when the overlap clearly matches somewhere else
// within `reach` CSS px of the prediction, and nowhere else in the tile
// nearly as well. A clean match farther away is reported (`far`) but not
// followed.
// `hidden` lists canvas rects (CSS px) of overlays the last shot showed and
// this one doesn't; they're left out of the comparison.
function placeTile(sig, w, seam, predicted, tile, tileH, hidden, reach) {
  const s = Math.floor(seam);
  const K = Math.min(s, MATCH_ROWS, Math.max(MIN_OVERLAP, Math.round(seam - predicted)));
  if (K < MIN_OVERLAP) return { top: predicted, match: 'none' };
  const stripTop = s - K;
  const use = new Uint8Array(K * w).fill(1);
  for (const h of hidden) {
    const x0 = Math.max(0, Math.floor(h.left / GRID_PX)), x1 = Math.min(w, Math.ceil(h.right / GRID_PX));
    for (let j = Math.max(0, Math.floor(h.top) - stripTop); j < Math.min(K, Math.ceil(h.bottom) - stripTop); j++) {
      use.fill(0, j * w + x0, j * w + Math.max(x0, x1));
    }
  }
  const edges = Array.from({ length: 9 }, (_, b) => Math.floor(w * b / 8));
  const blocks = texturedBlocks(sig, w, stripTop, K, edges, use);
  if (blocks.length < 2) return { top: predicted, match: 'flat' };
  const scores = overlapScores(sig, w, stripTop, K, blocks, edges, use, tile, tileH);
  const r0 = Math.round(stripTop - predicted);
  // Best match within reach of the prediction, and best anywhere.
  let best = -1, any = 0;
  for (let r = 0; r < scores.length; r++) {
    if (scores[r] < scores[any]) any = r;
    if (Math.abs(r - r0) <= reach && (best < 0 || scores[r] < scores[best])) best = r;
  }
  const at0 = r0 >= 0 && r0 < scores.length ? scores[r0] : Infinity;
  const round = (v) => Math.round(v * 10) / 10;
  const far = Math.abs(any - r0) > reach && scores[any] < MATCH_OK ? { far: stripTop - any, farScore: round(scores[any]) } : {};
  if (best < 0) return { top: predicted, match: 'mismatch', score: round(at0), blocks: blocks.length, ...far };
  // Distinctive: nothing more than 4 rows off, in reach or not, matches
  // nearly as well.
  let second = Infinity;
  for (let r = 0; r < scores.length; r++) if (Math.abs(r - best) > 4) second = Math.min(second, scores[r]);
  if (at0 < MATCH_OK && at0 <= scores[best] + 1.5) return { top: predicted, match: 'ok', score: round(at0) };
  if (scores[best] < MATCH_OK && second > Math.max(2 * scores[best], scores[best] + 3)) {
    return { top: stripTop - best, match: 'moved', score: round(scores[best]), predicted, blocks: blocks.length };
  }
  return { top: predicted, match: 'mismatch', score: round(at0), best: round(scores[best]), blocks: blocks.length, ...far };
}

// A shot that shows the same screen as the one before it, although the
// page scrolled at least `MIN_OVERLAP` px in between, is a stale frame:
// Chrome handed back what it had painted before the scroll. Needs texture
// to say: two shots of a plain section look the same wherever they are.
function sameFrame(a, b, w, h) {
  let diff = 0, textured = 0;
  for (let y = 0; y < h; y++) {
    const o = y * w;
    for (let x = o; x < o + w; x++) diff += Math.abs(a[x] - b[x]);
    if (rowStd(a, w, y) > 12) textured++;
  }
  return textured >= h * 0.1 && diff / (w * h) < 1;
}

// How many column blocks of a tile placed at `top` differ from what the
// canvas already shows over their overlap, and the largest share of changed
// cells in any block, leaving out overlays the page hid since the last
// shot. Null when they barely overlap.
// The bottom tile can sit half a pixel off the grid (the page's last scroll
// position is fractional), so a cell only counts as changed when it differs
// from the tile's rows on both sides.
function disagreement(sig, w, seam, top, tile, tileH, hidden) {
  const t0 = Math.floor(top), t1 = Math.ceil(top);
  const y0 = Math.max(0, t1), y1 = Math.min(Math.floor(seam), t0 + tileH);
  if (y1 - y0 < 8) return null;
  const use = new Uint8Array((y1 - y0) * w).fill(1);
  for (const h of hidden) {
    const x0 = Math.max(0, Math.floor(h.left / GRID_PX)), x1 = Math.min(w, Math.ceil(h.right / GRID_PX));
    for (let y = Math.max(y0, Math.floor(h.top)); y < Math.min(y1, Math.ceil(h.bottom)); y++) {
      use.fill(0, (y - y0) * w + x0, (y - y0) * w + Math.max(x0, x1));
    }
  }
  let blocks = 0, worst = 0;
  for (let b = 0; b < AGREE_BLOCKS; b++) {
    const xa = Math.floor(w * b / AGREE_BLOCKS), xb = Math.floor(w * (b + 1) / AGREE_BLOCKS);
    let n = 0, d = 0;
    for (let y = y0; y < y1; y++) {
      const a = y * w, t = (y - t0) * w, s = (y - t1) * w, u = (y - y0) * w;
      for (let x = xa; x < xb; x++) {
        if (!use[u + x]) continue;
        n++;
        if (Math.min(Math.abs(sig[a + x] - tile[t + x]), Math.abs(sig[a + x] - tile[s + x])) > AGREE_CELL) d++;
      }
    }
    if (n < 40) continue;
    if (d / n > (t0 === t1 ? AGREE_SHARE : AGREE_SHARE_FRACTIONAL)) blocks++;
    worst = Math.max(worst, d / n);
  }
  return { y0, y1, blocks, worst: Math.round(worst * 1000) / 1000 };
}

// Frames from other sites: shots taken again, at most this many, until two
// in a row show the frame's box the same (within the luma grid's noise).
const FRAME_SETTLE_SHOTS = 6;
const FRAME_MIN_MS = 2000;
function boxSame(a, b, w, h, r) {
  const y0 = Math.max(0, Math.floor(r.top)), y1 = Math.min(h, Math.ceil(r.bottom));
  const x0 = Math.max(0, Math.floor(r.left / GRID_PX)), x1 = Math.min(w, Math.ceil(r.right / GRID_PX));
  let n = 0, changed = 0;
  for (let y = y0; y < y1; y++) {
    for (let x = y * w + x0, e = y * w + x1; x < e; x++) {
      n++;
      if (Math.abs(a[x] - b[x]) > AGREE_CELL) changed++;
    }
  }
  return n === 0 || changed / n < 0.002;
}

async function stitchTiles(tab, info) {
  const { viewportHeight: vh, pageWidth, dpr } = info;
  const warnings = [];
  const placements = [];
  // Always full resolution: the device's own pixels, never scaled down.
  const scale = dpr;
  const width = Math.round(pageWidth * scale);
  // How much of the page one image may hold (CSS px), and how far the tiles
  // may scroll to fill it.
  const cap = Math.min(MAX_PAGE_HEIGHT, Math.floor(MAX_IMAGE_BYTES / 4 / width / scale));
  const capOut = Math.round(cap * scale);
  const capScroll = Math.max(0, cap - vh);
  const rawHeight = Math.max(info.rawPageHeight || 0, info.pageHeight);
  const pageHeight = Math.min(rawHeight, cap);
  let capWarned = false;
  const warnCap = (y1) => {
    if (capWarned) return;
    capWarned = true;
    warnings.push({ kind: 'truncated', reason: 'too-tall', y0: cap, y1: Math.max(cap, y1), note: `page not fully captured: it is ${y1}px tall; only the first ${cap}px are captured` });
  };
  if (rawHeight > cap) warnCap(rawHeight);
  // What the page side changed so it could be shown at all (a pinned
  // section laid out as its stages).
  warnings.push(...(info.notes || []));

  // The capture is painted into bands: canvases stacked top to bottom, each
  // as tall as a canvas may be at this width (one band for any page up to
  // about 32,700 CSS px at 2x). They leave room for the page to grow during
  // the capture; rows it doesn't use are cut off at the end.
  const bandRows = Math.max(1, Math.min(MAX_CANVAS_SIDE, Math.floor(MAX_CANVAS_AREA / width)));
  const bands = []; // { canvas, ctx, top } (top in output px)
  const allocated = () => (bands.length ? bands[bands.length - 1].top + bands[bands.length - 1].canvas.height : 0);
  // Bands to cover output rows [0, rows). The last band, if short, is made
  // taller first (only its own rows are copied), then new bands are added.
  const allocate = (rows) => {
    const last = bands[bands.length - 1];
    if (last && last.canvas.height < bandRows && allocated() < rows) {
      const c = new OffscreenCanvas(width, Math.min(bandRows, rows - last.top));
      const x = c.getContext('2d');
      x.drawImage(last.canvas, 0, 0);
      last.canvas = c; last.ctx = x;
      // (For the test harness: where this canvas sits in the capture.)
      c.bandTop = last.top;
    }
    while (allocated() < rows) {
      const top = allocated();
      const c = new OffscreenCanvas(width, Math.min(bandRows, rows - top));
      c.bandTop = top;
      bands.push({ canvas: c, ctx: c.getContext('2d'), top });
    }
  };
  let room = Math.min(pageHeight + GROWTH_TILES * vh, cap);
  allocate(Math.round(room * scale));
  // The same capture as a luma grid, for matching each tile's overlap.
  const gw = Math.max(8, Math.round(pageWidth / GRID_PX));
  let gh = Math.ceil(room);
  let grid = new Uint8Array(gw * gh);

  // The page grew past the room left for it: add room, as far as the cap
  // allows. False when there is no more.
  const grow = (bottom) => {
    const want = Math.min(Math.ceil(bottom + GROWTH_TILES * vh), cap);
    if (want <= room) return false;
    allocate(Math.round(want * scale));
    const g = new Uint8Array(gw * Math.ceil(want));
    g.set(grid);
    grid = g; room = want; gh = Math.ceil(want);
    return true;
  };

  const step = vh - OVERLAP;
  let total = 1 + Math.ceil(Math.max(0, pageHeight - vh) / step);
  // Grows with the page, which can only grow as far as the canvas can.
  const shotBudget = () => total * SHOTS_PER_TILE + SPARE_SHOTS;
  const reach = Math.round(vh * MATCH_REACH);
  let cursor = 0;  // canvas rows painted so far, top down (output px)
  let offset = 0;  // capture y minus page y of the content at the seam (CSS px)
  // (From the page's real height: past the cap, `pageHeight` is the cap,
  // and every tile's height would look like a change from it.)
  let minH = rawHeight, maxH = rawHeight;
  // The offset was last set from the scroll position alone (the page
  // couldn't say how far its content moved): a guess, until a pixel match
  // confirms it. www.icaboston.org's header script scrolls the page 139px
  // past where it was asked without moving any content; read as content
  // that moved, that put every later tile 139px too high, and since the
  // page then said nothing moved, the overlap match that saw it could
  // correct no more than FIRM_REACH.
  let guessed = false;
  let shots = 0, retakes = 0;
  let lift = 0;    // extra CSS px to shoot higher on a retake after a failed match
  let liftMisses = 0; // lifted shots in a row whose overlap matched nowhere either
  let prevTop = 0; // where the last tile drawn sits in the capture (CSS px)
  let hidden = []; // overlays it showed that the page has hidden since, in capture px
  const holes = [];
  let last = null; // the last tile drawn: where it was shot and which rows it painted
  let prevShot = null; // the last frame shot in order: its luma grid and scroll position
  let reshoots = 0, seamReshoots = 0;
  let skipped = 0; // extra shots the budget didn't allow
  // Canvases the page draws itself (WebGL effects, animations) look
  // different in every shot, so one cut by a seam shows two moments; so do
  // frames from other sites, videos that kept playing and whatever else the
  // page changes on a clock that couldn't be held (content.js liveRegions).
  // The last tile drawn's such regions, in capture px: the next tile is shot from
  // the top of one the seam would cut, if it fits on a screen, and draws it
  // whole. They're left out of overlap matching, which they'd only confuse.
  let live = [];
  const liveSeen = new Map(); // canvas id -> where it sits in the capture
  const paintStarts = [];     // capture px where each tile's painted rows start
  const changedAt = [];       // seams (CSS px) where two tiles disagreed or didn't match: the page changed between them
  const settledFrames = new Set(); // ids of frames from other sites seen holding still
  const brokenSeen = new Set();

  // Whether `n` more shots for this tile leave enough of the budget to
  // reach the bottom of the page one plain tile at a time. Asked only when
  // the shots are otherwise wanted, so a no counts as one skipped.
  const affords = (n, res) => {
    const below = res.actualY >= res.maxScroll - 1 ? 0 : Math.ceil((res.maxScroll - res.actualY) / step);
    if (shots + n + below <= shotBudget()) return true;
    skipped++;
    return false;
  };

  // Draw rows [from, to) of the capture (output px) from a tile placed at
  // `top`, and copy them into the matching grid. A tile that straddles two
  // bands is drawn in two parts, each band the rows it holds.
  const paint = (bmp, tileGrid, tileH, top, from, to) => {
    const topOut = Math.round(top * scale);
    for (const b of bands) {
      const a = Math.max(from, b.top), z = Math.min(to, b.top + b.canvas.height);
      if (z <= a) continue;
      const sy = (a - topOut) * dpr / scale;
      const sh = (z - a) * dpr / scale;
      b.ctx.drawImage(bmp, 0, sy, bmp.width, sh, 0, a - b.top, Math.round(bmp.width * scale / dpr), z - a);
    }
    const t0 = Math.round(top);
    for (let c = Math.ceil(from / scale); c < Math.min(gh, Math.ceil(to / scale)); c++) {
      const t = c - t0;
      if (t >= 0 && t < tileH) grid.set(tileGrid.subarray(t * gw, (t + 1) * gw), c * gw);
    }
  };

  let lastRes = null;
  for (let i = 0; ;) {
    if (shots++ >= shotBudget()) {
      const y = Math.round(cursor / scale);
      const end = lastRes ? lastRes.pageHeight : pageHeight;
      warnings.push({ kind: 'truncated', y0: y, y1: Math.max(y, end), note: `page not fully captured: stopped after ${shots - 1} shots with the page still moving; ${Math.max(0, end - y)}px below ${y}px missing` });
      break;
    }
    const seam = cursor / scale;
    let wantY = i === 0 ? 0 : Math.max(0, Math.round(seam - OVERLAP - offset - lift));
    if (i > 0 && !lift && last) {
      const cut = live.filter((r) => !(liveSeen.get(r.id) || {}).follows && r.top < seam - 4 && r.bottom > seam + 4 && r.bottom - r.top <= vh && r.top > prevTop);
      if (cut.length) {
        const from = Math.min(...cut.map((r) => r.top - Math.min(8, vh - (r.bottom - r.top))));
        wantY = Math.max(last.actualY + 1, Math.min(wantY, Math.round(from - offset)));
      }
    }
    const res = await sendToTab(tab.id, { cmd: 'tile', y: Math.min(wantY, capScroll), index: i, total });
    if (!res || !res.ok) throw new Error(res && res.error || 'tile failed');
    // The height cap holds for the tiles too: past it the page counts as
    // ended. (Without this the loop followed the page's real bottom past the
    // cap until the canvas was full.)
    if (res.maxScroll > capScroll) { warnCap(res.pageHeight); res.maxScroll = capScroll; }
    // The page's own account of whether it moved since the last shot: the
    // drift is measured from the anchors that shot noted.
    const unmoved = !guessed && res.drift != null && lastRes != null && Math.abs(res.pageHeight - lastRes.pageHeight) < 1;
    lastRes = res;
    minH = Math.min(minH, res.pageHeight);
    maxH = Math.max(maxH, res.pageHeight);
    for (const c of res.covered || []) {
      hidden.push({ top: prevTop + c.top, bottom: prevTop + c.bottom, left: c.left, right: c.right });
    }
    const atBottom = res.actualY >= res.maxScroll - 1;

    // Follow the content at the seam. Without a measurement, fall back to
    // the scroll position: when a header shrinks once the page scrolls,
    // Chrome moves the scroll to keep the same content in view.
    if (res.drift != null) offset -= res.drift;
    else if (res.actualY !== wantY && !atBottom) { offset += wantY - res.actualY; guessed = true; }
    let top = res.actualY + offset;

    // The content moved up past the seam since the last tile, so this shot
    // would leave a gap. Shoot again from higher up.
    if (i > 0 && top > seam - MIN_OVERLAP && retakes < MAX_RETAKES && affords(1, res)) {
      retakes++;
      placements.push({ index: i, y: wantY, actualY: res.actualY, drift: res.drift, top, retake: true });
      continue;
    }

    // A canvas this shot would cut that the last one didn't show (the page
    // switches its effect on once the section is in view): shoot again from
    // its top, if it fits on a screen.
    const appeared = i === 0 ? [] : (res.live || [])
      .map((r) => ({ id: r.id, top: top + r.top, bottom: top + r.bottom, left: r.left, right: r.right }))
      .filter((r) => r.top < top && r.top < seam - 4 && r.bottom > seam + 4 && r.bottom - r.top <= vh && r.top > prevTop &&
        !live.some((l) => l.id === r.id) && !(liveSeen.get(r.id) || {}).follows);
    if (appeared.length && !lift && retakes < MAX_RETAKES && affords(1, res)) {
      retakes++;
      live.push(...appeared);
      placements.push({ index: i, y: wantY, actualY: res.actualY, drift: res.drift, top, retake: true, canvas: true });
      continue;
    }

    setBadge(`${i + 1}/${total}`, '#555');
    notify({ phase: 'tile', index: i, total });

    let bmp = await dataUrlToBitmap(await throttledCapture(tab.windowId));
    const tileH = Math.round(bmp.height / dpr);
    let tileGrid = lumaGrid(bmp, gw, tileH);
    // A frame from another site paints on its own time (a Google map draws
    // blurry tiles first and its controls last), out of the page's reach.
    // The first time one is on screen, shoot again until two shots in a
    // row show its box the same, a few times at most.
    // A frame that has only just come on screen may not have started
    // painting at all (a placeholder looks as still as a finished map), so
    // the earlier shot of the agreeing two must also come FRAME_MIN_MS after
    // it came on screen.
    const fresh = (res.live || []).filter((r) => r.kind === 'frame' && !settledFrames.has(r.id));
    if (fresh.length) {
      const shownAt = Date.now() - Math.min(...fresh.map((r) => r.shownMs || 0));
      let same = false, shotAt = lastCaptureTs;
      for (let k = 0; k < FRAME_SETTLE_SHOTS && !same; k++) {
        const b2 = await dataUrlToBitmap(await throttledCapture(tab.windowId));
        const g2 = lumaGrid(b2, gw, tileH);
        same = shotAt - shownAt >= FRAME_MIN_MS && fresh.every((r) => boxSame(tileGrid, g2, gw, tileH, r));
        shotAt = lastCaptureTs;
        bmp.close();
        bmp = b2;
        tileGrid = g2;
      }
      fresh.forEach((r) => settledFrames.add(r.id));
      if (!same) {
        for (const r of fresh) warnings.push({ kind: 'frame-unsettled', y0: Math.round(top + r.top), y1: Math.round(top + r.bottom), note: `a frame from another site (y ${Math.round(top + r.top)}-${Math.round(top + r.bottom)}) was still changing after ${FRAME_SETTLE_SHOTS + 1} shots; it is shown as the last one saw it` });
      }
    }
    for (const b of res.broken || []) {
      if (brokenSeen.has(`${b.y0} ${b.y1}`)) continue;
      brokenSeen.add(`${b.y0} ${b.y1}`);
      warnings.push({ kind: 'image-failed', y0: b.y0, y1: b.y1, note: `an image (y ${b.y0}-${b.y1}) failed to load, and again when asked for once more; its place is empty` });
    }

    // The page scrolled but the shot didn't change: shoot it again.
    let stale = false;
    if (prevShot && Math.abs(res.actualY - prevShot.actualY) >= MIN_OVERLAP && prevShot.h === tileH &&
        sameFrame(tileGrid, prevShot.grid, gw, tileH)) {
      if (retakes < MAX_RETAKES && affords(1, res)) {
        retakes++;
        placements.push({ index: i, y: wantY, actualY: res.actualY, drift: res.drift, top, stale: true, retake: true });
        bmp.close();
        await sleep(STALE_WAIT_MS);
        continue;
      }
      stale = true;
    }
    prevShot = { grid: tileGrid, actualY: res.actualY, h: tileH };

    let match = null, agree = null;
    if (i > 0) {
      // What this shot says can't be held still is left out as well as what
      // the last one said: a slider first seen moving now differs from the
      // tile above for that reason alone, and would make the overlap look
      // like a mismatch (blossompdx.com's gallery, cut after retakes ran out).
      const unheld = hidden.concat((res.live || []).map((r) => ({ top: top + r.top, bottom: top + r.bottom, left: r.left, right: r.right })));
      match = placeTile(grid, gw, seam, top, tileGrid, tileH, unheld, unmoved ? FIRM_REACH : reach);
      if (lift && match.match === 'mismatch') liftMisses++;
      else if (!lift && match.match !== 'mismatch' && match.match !== 'flat' && match.match !== 'none') liftMisses = 0;
      if (match.match === 'ok' || match.match === 'moved') guessed = false;
      if (match.match === 'moved') {
        top = match.top;
        offset = top - res.actualY;
      } else if (match.match === 'mismatch' && res.drift == null && !lift && liftMisses < MAX_LIFT_MISSES && affords(1, res)) {
        // Nothing to go on: the page couldn't say how far it moved and the
        // overlap isn't anywhere in this shot. If the content moved up past
        // the shot's top, a shot from half a screen higher still holds it.
        lift = Math.round(step / 2);
        placements.push({ index: i, y: wantY, actualY: res.actualY, drift: res.drift, top, match, retake: true });
        bmp.close();
        continue;
      } else if (match.match !== 'mismatch' || res.drift != null) {
        // (After a mismatch the tile stays where position puts it: the
        // measured drift when the page gave one, which a mismatch doesn't
        // overrule, since it is usually something that changed between the
        // two shots, like an image that finished loading, and shooting the
        // tile above again can settle it; else the scroll position.)
        agree = disagreement(grid, gw, seam, top, tileGrid, tileH, unheld);
        // (And with them, only as evidence for the report below: did what
        // couldn't be held change between the two shots?)
        const all = disagreement(grid, gw, seam, top, tileGrid, tileH, hidden);
        if (all && all.blocks > 0) changedAt.push(seam);
      }
    }

    // The page changed between this shot and the one above. Shoot that one
    // again, then this one, back to back. The repeat keeps the page's
    // anchors from this shot, so this one is still measured from here.
    if ((agree && agree.blocks > 0) || (match && match.match === 'mismatch')) changedAt.push(seam);
    // The page also says so itself: something it changed in answer to this
    // tile's scroll (a reveal, a decoration that dropped in) reaches into
    // rows the tile above painted (background.js pageClock, `dirty`). Too
    // small a change to tell from the pixels, it is still a cut.
    const off = top - res.actualY;
    // Only when the tile above holds all of the change that was shot: one
    // reaching higher was painted by older tiles too, which a new shot of
    // the tile above would leave behind (hitt.com's project cards, which
    // change as the page scrolls, came out cut where they had been whole).
    const dirtyAbove = i > 0 && last && (res.dirty || []).some(([a, b]) =>
      a + off < seam - 1 && a + off >= last.from / scale - 1);
    if (((agree && agree.blocks > 0) || dirtyAbove) && last && seamReshoots < RESHOOTS_PER_SEAM && reshoots < MAX_RESHOOTS && affords(2, res)) {
      seamReshoots++;
      reshoots++;
      placements.push({ index: i, y: wantY, actualY: res.actualY, drift: res.drift, top, match, agree, retake: true });
      bmp.close();
      // Wait out the capture quota first, so the shot follows right after
      // the page has hidden its overlays and put its videos back on their
      // frozen frame, with no time for the page to start them again.
      await captureReady();
      shots++;
      // (Reached from above, the way it was the first time: some pages
      // set things by the direction the page last scrolled, r-o.com's
      // footer crane leaning with it.)
      const again = await sendToTab(tab.id, { cmd: 'tile', y: last.actualY, index: last.index, total, keepAnchors: true, from: Math.max(0, last.actualY - step) });
      if (!again || !again.ok) throw new Error(again && again.error || 'tile failed');
      if (Math.abs(again.actualY - last.actualY) < 1) {
        const b2 = await dataUrlToBitmap(await throttledCapture(tab.windowId));
        const h2 = Math.round(b2.height / dpr);
        paint(b2, lumaGrid(b2, gw, h2), h2, last.top, last.from, cursor);
        b2.close();
        placements.push({ index: last.index, y: last.actualY, actualY: again.actualY, top: last.top, reshot: true });
      }
      prevShot = null;
      continue;
    }
    if (agree && agree.blocks > 0) {
      warnings.push({ kind: 'tiles-disagree', y0: agree.y0, y1: agree.y1, note: `tile ${i + 1} differs from the tile above where they overlap (${agree.blocks} of ${AGREE_BLOCKS} column blocks): the page changed between the shots` });
    }
    if (stale || (match && match.match === 'mismatch')) {
      const why = stale
        ? 'the shot showed the same screen as the one before it'
        : `its overlap doesn't match the tile above${match.far != null ? `, except ${Math.round(Math.abs(match.far - top))}px away, too far to believe` : ''}`;
      warnings.push({ kind: 'position-only', y0: Math.round(top), y1: Math.round(seam), note: `placed by position only at y ${Math.round(top)}: tile ${i + 1} (${why}) is placed by ${res.drift != null ? 'how far the page content measurably moved' : 'scroll position'}` });
    }

    // captureVisibleTab returns device pixels (vh*dpr tall). Draw only the
    // rows below what is already painted, rescaled to our output scale.
    const topOut = Math.round(top * scale);
    const tileOut = Math.round(bmp.height * scale / dpr);
    if (topOut + tileOut > allocated()) grow(Math.min(topOut + tileOut, capOut) / scale);
    // This tile reaches the cap: the capture stops with it.
    const outOfRoom = topOut + tileOut > capOut;
    // A canvas this shot holds whole that the seam would cut is drawn
    // from this shot alone, from its top down.
    const shown = (res.live || []).map((r) => ({ id: r.id, kind: r.kind, top: top + r.top, bottom: top + r.bottom, left: r.left, right: r.right, whole: r.top >= 0 && r.bottom <= tileH }));
    // A canvas the page keeps moving along with the screen (Squarespace
    // draws all of a page's image effects on one) isn't anywhere in
    // particular, so it can't be taken whole; it's reported as such.
    for (const r of shown) {
      const s = liveSeen.get(r.id);
      if (!s) liveSeen.set(r.id, { y0: r.top, y1: r.bottom, at: r.top, follows: false, kind: r.kind });
      else {
        s.follows = s.follows || Math.abs(r.top - s.at) > 8;
        s.y0 = Math.min(s.y0, r.top);
        s.y1 = Math.max(s.y1, r.bottom);
      }
    }
    for (const r of shown) r.whole = r.whole && !liveSeen.get(r.id).follows;
    // (And one the tile above saw live and cut, which this tile was shot
    // from the top of and holds whole, though it no longer reports it: a
    // video the page side has since put on its still. saybriefly.com's demo
    // video, playing again when the tile above was shot, was cut where the
    // still began.)
    const carried = live.filter((r) => r.top < seam && r.bottom > seam && r.top >= top && r.bottom <= top + tileH &&
      !shown.some((s) => s.id === r.id) && !(liveSeen.get(r.id) || {}).follows);
    const redraw = shown.filter((r) => r.whole && r.top < seam && r.bottom > seam).concat(carried).map((r) => Math.round(r.top * scale));
    let from = Math.max(Math.min(cursor, ...redraw), topOut, 0);
    // But not from inside one the tile above already held whole: two such
    // boxes can overlap (saybriefly.com's stacked demo cards share 56px),
    // and starting there would cut the upper one instead. Start below it.
    for (let moved = true, k = 0; moved && k < 8; k++) {
      moved = false;
      for (const r of live) {
        const t = Math.round(r.top * scale), b = Math.round(r.bottom * scale);
        if (r.whole && from > t && from < b && b <= cursor) { from = b; moved = true; }
      }
    }
    const to = Math.min(topOut + tileOut, allocated());
    if (from > cursor) holes.push([cursor, from]);
    if (to > from) {
      paint(bmp, tileGrid, tileH, top, from, to);
      paintStarts.push(from / scale);
      cursor = to;
    }
    bmp.close();
    placements.push({ index: i, y: wantY, actualY: res.actualY, drift: res.drift, top, match, agree, ...(stale ? { stale } : {}) });
    last = { index: i, actualY: res.actualY, top, from: Math.min(from, cursor) };

    i++;
    retakes = 0;
    seamReshoots = 0;
    lift = 0;
    prevTop = top;
    live = shown;
    hidden = shown.map(({ top: t, bottom, left, right }) => ({ top: t, bottom, left, right }));
    total = Math.max(total, i + (atBottom ? 0 : Math.ceil((res.maxScroll - res.actualY) / step)));
    if (outOfRoom) {
      if (res.pageHeight > cap) warnCap(res.pageHeight);
      break;
    }
    if (atBottom) break;
  }

  // What couldn't be held still, so say how each one is shown. A canvas
  // always gets a word. The rest (a frame from another site, a video, an
  // element the page kept changing) only when a tile edge cut it and two
  // tiles disagreed (or their overlap didn't match at all) at a seam inside
  // it, which is the evidence it changed:
  // a player that took the pause command, or a slider that stood still
  // while it was shot, came out of one moment.
  const said = new Set();
  const NAMES = {
    canvas: 'a canvas the page draws itself',
    video: 'a video that kept playing',
    frame: 'a frame from another site (a video player, a map)',
    moving: 'something the page kept changing on its own (a slider on a timer, an animation)'
  };
  for (const { y0, y1, follows, kind } of liveSeen.values()) {
    const a = Math.round(y0), b = Math.round(y1);
    if (said.has(`${a} ${b}`)) continue;
    const edges = paintStarts.filter((s) => s > y0 + 2 && s < y1 - 2).map(Math.round);
    if (kind && kind !== 'canvas' && !(edges.length && changedAt.some((y) => y > y0 && y < y1))) continue;
    said.add(`${a} ${b}`);
    const what = NAMES[kind] || NAMES.canvas;
    warnings.push({ kind: 'live-effect', y0: a, y1: b,
      note: follows
        ? `${what} moves along with the screen over the page (y ${a}-${b}); it can't be held still, so what it shows in each tile is from a different moment${edges.length ? `, and tile edges at y ${edges.join(', ')} may show a step` : ''}`
        : edges.length
        ? `${what} (y ${a}-${b}) can't be held still, and no one shot could hold it whole: tile edges at y ${edges.join(', ')} cut it, so its parts come from different moments`
        : `${what} (y ${a}-${b}) can't be held still; it is shown whole as one shot saw it` });
  }

  // Rows that no tile reached are reported, not hidden.
  for (const [a, b] of holes) {
    warnings.push({ kind: 'unpainted', y0: Math.round(a / scale), y1: Math.round(b / scale), note: `${Math.round((b - a) / scale)}px never painted: the page moved and the retakes didn't catch up` });
  }
  if (skipped) {
    warnings.push({ kind: 'budget', y0: 0, y1: Math.round(cursor / scale), note: `shot budget ran low: ${skipped} retake(s) or reshoot(s) skipped so the capture could reach the bottom of the page` });
  }
  if (maxH - minH > vh) {
    warnings.push({ kind: 'page-height-changed', y0: minH, y1: maxH, note: `page height ranged from ${minH}px to ${maxH}px while it was captured` });
  }

  // Rows below the last tile (room the page didn't grow into) are left out
  // of the image. Rows above it that no tile painted are transparent, and
  // reported above as `unpainted`.
  const image = { bands, width, height: Math.max(1, cursor), holes: holes.length > 0 };
  return { image, tileCount: placements.filter((p) => !p.retake).length, warnings, placements };
}

// The stitched bands as one PNG Blob. A capture that fits one band is
// encoded by the canvas, as before: Chrome's encoder is 3-4x faster than
// the PNG writer (2.0 s against 7.6 s for 2776 x 39190 px), though its
// files are 25-30% bigger. Taller captures go through the PNG writer, a
// strip at a time. Either way the bands are released once encoded.
async function encodeCapture(image) {
  const { bands, width, height } = image;
  try {
    if (bands.length === 1 || height <= bands[0].canvas.height) {
      // Cut off the rows below the last tile.
      let out = bands[0].canvas;
      if (height < out.height) {
        out = new OffscreenCanvas(width, height);
        out.getContext('2d').drawImage(bands[0].canvas, 0, 0);
      }
      return await out.convertToBlob({ type: 'image/png' });
    }
    const STRIP = 256;
    async function* strips() {
      for (const b of bands) {
        const end = Math.min(b.canvas.height, height - b.top);
        for (let y = 0; y < end; y += STRIP) {
          const n = Math.min(STRIP, end - y);
          yield { data: b.ctx.getImageData(0, y, width, n).data, rows: n };
        }
        // Done with this band: let its memory go before the next is read.
        const last = b.top + end >= height;
        b.canvas.width = b.canvas.height = 1;
        if (last) break;
      }
    }
    // RGB unless some rows were never painted: those stay transparent, as
    // on a one-band capture, so they show as holes rather than black.
    let shown = -1;
    return await Png.encode({
      width, height, alpha: image.holes, strips: strips(),
      onProgress: (f) => {
        const pct = Math.floor(f * 100);
        if (pct !== shown) { shown = pct; notify({ phase: 'encode', fraction: f }); }
      }
    });
  } finally {
    for (const b of bands) b.canvas.width = b.canvas.height = 1;
  }
}

async function runCapture(tab) {
  if (capturing) return { error: 'A capture is already running.' };
  if (!tab || !isCapturable(tab.url)) {
    setBadge('!', '#c0392b');
    clearBadgeLater(2500);
    notify({ phase: 'error', error: "This page can't be captured (try a normal http/https page)." });
    return { error: 'not-capturable' };
  }

  capturing = true;
  setBadge('…', '#555');
  notify({ phase: 'prepare' });

  const clock = (cmd) => chrome.scripting.executeScript({
    target: { tabId: tab.id },
    world: 'MAIN',
    func: pageClock,
    args: [cmd, HOLD_GRACE_MS, HOLD_AFTER_MS]
  }).then((r) => r && r[0] && r[0].result).catch(() => null);

  try {
    // Follow the page's timers from before the wake-up, so the sliders the
    // woken scripts start can be held once the page is prepared.
    await clock('watch');
    // Inject the page-side worker (activeTab grant covers this tab) and let
    // it wake the page first: scripts held back until the first mouse move
    // start carousels and scroll animations the steps below must see.
    await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      files: ['content.js']
    });
    await sendToTab(tab.id, { cmd: 'wake' }).catch(() => {});

    // Switch off GSAP ScrollTrigger before measuring the page. Pinned
    // scroll-storytelling sections add screens of scroll distance, so tiling
    // through them repeats the same section. Runs in the page's own world
    // because ScrollTrigger lives on the page's window, not the extension's.
    await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      world: 'MAIN',
      func: unpinScrollAnimations
    }).catch(() => {});

    // Stop auto-advancing carousels. A hero slideshow that changes slide
    // while the tiles are being shot (the Children's Museum turns every 7s)
    // shows one slide above the seam and another below it.
    await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      world: 'MAIN',
      func: stopCarousels
    }).catch(() => {});

    const info = await sendToTab(tab.id, { cmd: 'prepare' });
    if (!info || !info.ok) throw new Error(info && info.error || 'prepare failed');

    // The page is prepared: stop its clock for the tiles. Carousels the
    // pre-scroll brought to life (a slider set up when it scrolls into
    // view) are stopped through their library as well, and the page side
    // pauses what the browser animates. The grace lets a slide or fade
    // already under way finish before the first shot.
    await clock('hold');
    await chrome.scripting.executeScript({ target: { tabId: tab.id }, world: 'MAIN', func: stopCarousels }).catch(() => {});
    await sendToTab(tab.id, { cmd: 'hold' }).catch(() => {});
    await sleep(HOLD_GRACE_MS);

    const t0 = Date.now();
    const { image, tileCount, warnings, placements } = await stitchTiles(tab, info);
    const t1 = Date.now();

    await sendToTab(tab.id, { cmd: 'finish' }).catch(() => {});
    await clock('release');

    const t2 = Date.now();
    const outBlob = await encodeCapture(image);
    const t3 = Date.now();

    let host = 'page';
    try { host = new URL(tab.url).hostname; } catch (_) {}
    // Local date, not UTC: an evening capture shouldn't be named for tomorrow.
    const now = new Date();
    const date = [now.getFullYear(), now.getMonth() + 1, now.getDate()]
      .map((n) => String(n).padStart(2, '0'))
      .join('-');
    const baseName = `${host}_${date}`;

    // Hand the stitched image to the editor tab, which handles crop, format
    // choice, copy-to-clipboard, and download. The PNG goes into the
    // extension's IndexedDB as a Blob (Chrome keeps it on disk; a data URL
    // in storage would not survive a file of several hundred MB), and its
    // description into storage.
    await CaptureStore.put(outBlob);
    const timings = { tilesMs: t1 - t0, encodeMs: t3 - t2, storeMs: Date.now() - t3, bands: image.bands.length };
    await chrome.storage.local.set({
      capture: {
        baseName,
        width: image.width,
        height: image.height,
        size: outBlob.size,
        sourceUrl: tab.url,
        warnings
      }
    });
    notify({ phase: 'done', filename: `${baseName}.png` });
    setBadge('✓', '#27ae60');
    clearBadgeLater(2000);
    await chrome.tabs.create({ url: chrome.runtime.getURL('result.html') });

    return { filename: `${baseName}.png`, size: outBlob.size, width: image.width, height: image.height, timings, tileCount, warnings, placements };
  } catch (err) {
    console.error('[CleanShot]', err);
    // Best-effort page restore even on failure.
    try { await sendToTab(tab.id, { cmd: 'finish' }); } catch (_) {}
    await clock('release');
    setBadge('!', '#c0392b');
    clearBadgeLater(3000);
    notify({ phase: 'error', error: String(err && err.message || err) });
    return { error: String(err && err.message || err) };
  } finally {
    capturing = false;
  }
}

// Expose for automated testing (harness calls this from the SW context).
self.__runCapture = runCapture;

// The popup triggers capture (the action opens the popup, which grants
// activeTab for the current tab). onClicked won't fire while a popup is set,
// but keep it as a fallback if the popup is ever removed.
async function resolveTab(tabId) {
  return tabId != null
    ? await chrome.tabs.get(tabId).catch(() => null)
    : (await chrome.tabs.query({ active: true, currentWindow: true }))[0];
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg) return;

  if (msg.type === 'startCapture') {
    (async () => sendResponse(await runCapture(await resolveTab(msg.tabId))))();
    return true; // async response
  }

  if (msg.type === 'startInspect' || msg.type === 'startPalette') {
    const file = msg.type === 'startPalette' ? 'palette.js' : 'inspect.js';
    (async () => {
      const tab = await resolveTab(msg.tabId);
      if (!tab || !isCapturable(tab.url)) { sendResponse({ error: 'not-capturable' }); return; }
      try {
        await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: [file] });
        sendResponse({ ok: true });
      } catch (e) { sendResponse({ error: String(e.message || e) }); }
    })();
    return true;
  }

  // Inspector asks for a shot of the visible viewport to crop the element from.
  if (msg.type === 'captureViewport') {
    (async () => {
      try {
        const winId = sender.tab ? sender.tab.windowId : undefined;
        sendResponse(await chrome.tabs.captureVisibleTab(winId, { format: 'png' }));
      } catch (e) { sendResponse(null); }
    })();
    return true;
  }
});

chrome.action.onClicked.addListener((tab) => { runCapture(tab); });

// Injected into the page (MAIN world), so it must be self-contained. Kills
// every ScrollTrigger, which removes pin spacers and puts pinned sections
// back in normal flow, then leaves each animation at whichever end shows
// its targets more: the finished state for an entrance, the start for an
// exit. mattinglygc.com's hero column fades out as the page scrolls away
// (`to {opacity: 0}`), and jumped to its end it vanished from the capture.
// With nothing to choose between them (a slide, a scrubbed parallax), the
// finished state. Smooth-scroll libraries go too, since they fight the
// tile-by-tile scrolling. The page stays this way until it reloads.
function unpinScrollAnimations() {
  const ST = window.ScrollTrigger ||
    (window.gsap && window.gsap.core && window.gsap.core.globals().ScrollTrigger);
  if (ST) {
    const gsap = window.gsap;
    const targetsOf = (a) => {
      try {
        if (a.targets) return a.targets();
        return a.getChildren(true, true, false).flatMap((c) => (c.targets ? c.targets() : []));
      } catch (e) { return []; }
    };
    const shown = (els) => els.reduce((s, el) => {
      const v = gsap && gsap.getProperty ? Number(gsap.getProperty(el, 'opacity')) : Number(getComputedStyle(el).opacity);
      return s + (Number.isFinite(v) ? v : 1);
    }, 0);
    const triggers = ST.getAll();
    const animations = triggers.map((t) => t.animation).filter(Boolean);
    const ends = animations.map((a) => {
      try {
        const els = targetsOf(a).filter((el) => el instanceof Element);
        const was = a.progress();
        a.progress(0);
        const atStart = shown(els);
        a.progress(1);
        const atEnd = shown(els);
        a.progress(was);
        return atStart > atEnd + 0.01 ? 0 : 1;
      } catch (e) { return 1; }
    });
    triggers.forEach((t) => t.kill(true, true));
    animations.forEach((a, i) => { try { a.progress(ends[i]); } catch (e) {} });
  }
  for (const s of [window.lenis, window.__lenis, window.locomotiveScroll]) {
    if (s && typeof s.destroy === 'function') s.destroy();
  }
  window.scrollTo(0, 0);
  return ST ? ST.getAll().length : -1;
}

function stopCarousels() {
  let stopped = 0;
  const attempt = (fn) => { try { if (fn() !== false) stopped++; } catch (e) {} };

  if (window.UIkit) {
    document.querySelectorAll('[uk-slideshow], [data-uk-slideshow], [uk-slider], [data-uk-slider]').forEach((el) => {
      const c = UIkit.getComponent(el, 'slideshow') || UIkit.getComponent(el, 'slider');
      if (!c) return;
      attempt(() => {
        c.autoplay = false;
        if (c.$props) c.$props.autoplay = false;
        c.stopAutoplay();
      });
    });
  }

  // The rest are found by the instance their library leaves on the element,
  // not by class name, which themes change: Premier Roofing's Swiper is an
  // Avada `awb-swiper` with no `.swiper` class anywhere. Glide, Embla, Keen
  // and Splide keep their instances to themselves; only a pause button (below)
  // reaches those.
  const $ = window.jQuery;
  const BSCarousel = window.bootstrap && window.bootstrap.Carousel;
  const Flickity = window.Flickity;
  // Pages often start a slider again when it scrolls into view (17A's "What
  // we do" calls slickPlay from an IntersectionObserver), so slick's own
  // start is switched off on the instance as well, for as long as the page
  // stays loaded.
  document.querySelectorAll('*').forEach((el) => {
    if (el.swiper && el.swiper.autoplay) attempt(() => el.swiper.autoplay.stop());
    if (el.slick && typeof el.slick.slickPause === 'function') {
      attempt(() => {
        el.slick.slickPause();
        el.slick.slickPlay = () => {};
        el.slick.autoPlay = () => {};
      });
    }
    if (el.splide && el.splide.Components && el.splide.Components.Autoplay) attempt(() => el.splide.Components.Autoplay.pause());
    if (Flickity && Flickity.data) {
      const f = Flickity.data(el);
      if (f) attempt(() => f.stopPlayer());
    }
    if (BSCarousel && BSCarousel.getInstance) {
      const c = BSCarousel.getInstance(el);
      if (c) attempt(() => c.pause());
    }
    // (hasData first: asking jQuery for data on an element creates a store.)
    if ($ && $.hasData && $.hasData(el)) {
      if ($.data(el, 'owl.carousel')) attempt(() => $(el).trigger('stop.owl.autoplay'));
      if ($.data(el, 'bs.carousel')) attempt(() => $(el).carousel('pause'));
    }
  });

  // And by class, for older slick and Owl builds that leave no instance.
  if ($ && $.fn) {
    if ($.fn.slick) attempt(() => $('.slick-initialized').slick('slickPause'));
    if ($.fn.owlCarousel) attempt(() => $('.owl-carousel').trigger('stop.owl.autoplay'));
  }

  // Anything else: press a visible pause button that belongs to a carousel.
  const carousel = '[aria-roledescription="carousel"], [class*="slide" i], [class*="carousel" i], [class*="swiper" i], [class*="splide" i], [class*="glide" i]';
  document.querySelectorAll('button, [role="button"]').forEach((btn) => {
    const label = `${btn.getAttribute('aria-label') || ''} ${btn.getAttribute('title') || ''} ${btn.textContent || ''}`.trim();
    if (!/^(pause|stop)\b/i.test(label) || !btn.closest(carousel)) return;
    const r = btn.getBoundingClientRect();
    if (r.width === 0 || r.height === 0) return;
    attempt(() => { btn.click(); btn.blur(); });
  });

  return stopped;
}


// Injected into the page (MAIN world), so it must be self-contained. The
// page's own clock: timers and animation frames that turn sliders, run
// marquees, count numbers up and draw canvas animations. A seam between two
// shots of one of those shows two different moments.
//
// 'watch' goes in before the page is woken, and only wraps the page's
// setTimeout, setInterval and requestAnimationFrame so that every one
// registered from then on (scripts the wake-up lets go of start their
// sliders then) can be held later. It changes nothing yet.
// 'hold' comes once the page is prepared (the pre-scroll, the lazy content
// and the stage visits need the clock running) and stops time-driven work.
// Of what was already going at the hold: a timer of a second or more (an
// autoplay step, a popup on a timer) that comes due is kept back, an
// interval of a second or more skips its ticks, and anything that keeps
// itself going (a frame loop, a chain of timeouts, a fast interval) is kept
// back once it has run HOLD_GRACE_MS past the hold, which lets a slide or
// fade already under way finish. What starts after the hold is the page
// answering the capture's own scrolling (a section revealed as it comes into
// view, with its staggered delays; arcodb.com's FAQ never appeared when
// those were held), so it runs for HOLD_AFTER_MS from its own start before
// it is kept back too. A slider's next step is asked for from inside its
// last one, so it belongs to the old chain and stays held.
// 'release' puts the page's functions back and runs what was held, so the
// page carries on as if it had only been paused.
//
// Two things the wrappers can't reach are handled by what they change
// instead of by their timers:
// - Timers the page registered at load, before 'watch' (www.novellahomes.com
//   turns its 1000px hero every 8s from one; Squarespace galleries and
//   taylorsway.com's slider the same way), and work the page starts again
//   after the hold in answer to the capture's scrolling (saybriefly.com
//   restarts its hero animation on the first scroll). Once a part of the
//   page has been shot, it must look the same in every later shot, or a
//   tile edge through it shows two moments. So from the first shot on, a
//   change the page makes to an element already shot (its class, style or
//   other attributes, its text, and from the page's own timers and frames
//   its children) is put back as it was, at once: a MutationObserver's
//   callback runs before the browser paints, so the change never shows.
//   What the capture itself needs is let through: changes made in answer
//   to an image (or other resource) loading or to a transition ending, a
//   direct answer to the capture's scroll (a reveal), image sources, and
//   the capture's own marks. The page keeps its own idea of where it is
//   and carries on from there after 'release'.
// - Canvases (and paused videos) taller than a screen: their pixels are out
//   of the DOM's reach. 'stills' (asked for by the page side before each
//   shot) copies each one on screen into a plain 2D canvas that takes its
//   place for the rest of the capture, so every tile shows the same frame.
//   A WebGL canvas without preserveDrawingBuffer is empty outside the frame
//   that drew it, so it is copied in a frame callback that runs right after
//   the page's own (the frames the hold kept back are let run once for it).
//   A canvas that can't be read (drawn from another site without CORS still
//   copies, since only reading pixels back is refused; one moved to a
//   worker by transferControlToOffscreen can come out empty) is left live,
//   and the worker shoots it whole where it can.
function pageClock(cmd, graceMs, afterMs) {
  const KEY = '__cleanShotClock';
  const LONG_MS = 1000;
  let S = window[KEY];
  const now = () => performance.now();
  if (cmd === 'watch') {
    if (S) return 'watching';
    S = {
      holding: false, holdAt: 0, grace: 1000, after: 3000, heldTimeouts: new Map(), heldFrames: new Map(), skipped: 0, ctx: null,
      lastScroll: -1e9, lastLoad: -1e9, lastSettle: -1e9, mo: null, reverted: 0, fights: new WeakMap(),
      stills: [], stilled: new WeakSet(), dirty: [], provisional: new WeakMap()
    };
    Object.defineProperty(window, KEY, { value: S, configurable: true, enumerable: false, writable: true });
    const o = S.orig = {
      setTimeout: window.setTimeout, setInterval: window.setInterval, clearTimeout: window.clearTimeout,
      requestAnimationFrame: window.requestAnimationFrame, cancelAnimationFrame: window.cancelAnimationFrame
    };
    // What set off the work being done now: the capture's scroll (a scroll
    // event, then the observers and handlers it wakes, come within a few
    // frames), a resource that finished loading, or a transition or
    // animation that ended. Nothing: the page's own clock.
    // (Only the browser's own events: the stills below send the page a
    // scroll event of their own.)
    const mark = (k) => (e) => { if (e.isTrusted) S[k] = now(); };
    S.listeners = [['scroll', mark('lastScroll')], ['load', mark('lastLoad')], ['error', mark('lastLoad')],
      ['transitionend', mark('lastSettle')], ['animationend', mark('lastSettle')]];
    for (const [type, f] of S.listeners) window.addEventListener(type, f, { capture: true, passive: true });
    const cause = () => {
      const t = now();
      return t - S.lastLoad < 30 ? 'load' : t - S.lastSettle < 30 ? 'settle' : t - S.lastScroll < 60 ? 'scroll' : null;
    };
    // Each callback carries the time its chain started, and what started
    // it: a timer or frame asked for from inside another one continues that
    // one's chain.
    const chain = () => (S.ctx ? S.ctx : { start: now(), cause: cause() });
    const run = (c, cb, self, args) => {
      const prev = S.ctx;
      S.ctx = c;
      try { return cb.apply(self, args); } finally {
        // (The observer's records are taken here, while it is still known
        // which chain made the changes.)
        if (S.mo && !prev) { try { S.freeze(S.mo.takeRecords(), c); } catch (e) {} }
        S.ctx = prev;
      }
    };
    // Whether a callback of chain `c` (asked for `delay` ms ahead) is held now.
    const held = (c, delay) => {
      if (!S.holding) return false;
      if (c.start < S.holdAt) return delay >= LONG_MS || now() - S.holdAt >= S.grace;
      return now() - c.start >= S.after;
    };
    window.setTimeout = function (cb, ms, ...args) {
      if (typeof cb !== 'function') return o.setTimeout.call(window, cb, ms, ...args);
      const c = chain();
      const delay = Number(ms) || 0;
      let id;
      const fire = function () {
        if (held(c, delay)) {
          S.heldTimeouts.set(id, () => run(c, cb, window, args));
          return;
        }
        return run(c, cb, this, args);
      };
      id = o.setTimeout.call(window, fire, ms);
      return id;
    };
    window.setInterval = function (cb, ms, ...args) {
      if (typeof cb !== 'function') return o.setInterval.call(window, cb, ms, ...args);
      const c = { start: now(), cause: cause() };
      const delay = Number(ms) || 0;
      return o.setInterval.call(window, function () {
        if (held(c, delay)) { S.skipped++; return; }
        return run(c, cb, this, args);
      }, ms);
    };
    window.clearTimeout = function (id) {
      S.heldTimeouts.delete(id);
      return o.clearTimeout.call(window, id);
    };
    window.requestAnimationFrame = function (cb) {
      if (typeof cb !== 'function') return o.requestAnimationFrame.call(window, cb);
      const c = chain();
      let id;
      id = o.requestAnimationFrame.call(window, function (t) {
        if (held(c, 0)) {
          S.heldFrames.set(id, (t2) => run(c, cb, window, [t2]));
          return;
        }
        c.frames = (c.frames || 0) + 1;
        return run(c, cb, this, [t]);
      });
      return id;
    };
    window.cancelAnimationFrame = function (id) {
      S.heldFrames.delete(id);
      return o.cancelAnimationFrame.call(window, id);
    };

    // Changes to what has been shot, put back (see above). `c` is the chain
    // that made them, or null for work the wrappers don't see.
    const LOADING = /^(src|srcset|sizes|poster|loading|decoding|fetchpriority|href|xlink:href)$|^data-cleanshot|^data-(.*-)?(src|srcset|bg|background|lazy[\w-]*|ll-status|was-processed)$/i;
    const MEDIA = /^(IFRAME|VIDEO|AUDIO|SOURCE|IMG|PICTURE|OBJECT|EMBED)$/;
    const SKIP_NODES = /^(SCRIPT|STYLE|LINK|META|NOSCRIPT|IFRAME|TEMPLATE|BASE|TITLE)$/;
    // The capture's own style writes: !important declarations and its
    // --cleanshot variables.
    const pageStyle = (s) => (s || '').split(';').map((d) => d.trim())
      .filter((d) => d && !/!\s*important$/i.test(d) && !d.startsWith('--cleanshot')).join(';');
    // A page that answers every revert with the same change again (its own
    // observer, a framework re-rendering) would spin forever: an element
    // reverted more than this many times in a second is let go.
    // Whether two inline styles differ only in where the element is placed.
    const PLACE = /^(-webkit-)?(transform|translate|rotate|scale|clip-path|background-position|object-position|transform-origin|will-change)$/;
    const decls = (v) => new Map(pageStyle(v).split(';').map((d) => {
      const i = d.indexOf(':');
      return i < 0 ? null : [d.slice(0, i).trim().toLowerCase(), d.slice(i + 1).trim()];
    }).filter(Boolean));
    const onlyPlacement = (a, b) => {
      const x = decls(a), z = decls(b);
      let changed = 0;
      for (const k of new Set([...x.keys(), ...z.keys()])) {
        if (x.get(k) === z.get(k)) continue;
        if (!PLACE.test(k)) return false;
        changed++;
      }
      return changed > 0;
    };
    const FIGHT = 150;
    const PROVISIONAL_MS = 1500;
    const fighting = (t) => {
      const f = S.fights.get(t) || { n: 0, at: now() };
      if (now() - f.at > 1000) { f.n = 0; f.at = now(); }
      f.n++;
      S.fights.set(t, f);
      return f.n > FIGHT;
    };
    S.freeze = (records, c) => {
      if (!records.length || !S.holding || now() - S.holdAt < S.grace) return;
      const bottom = Number(document.documentElement.getAttribute('data-cleanshot-shot')) || 0;
      if (!bottom) return;
      const why = c ? c.cause : cause();
      if (why === 'load' || why === 'settle') return;
      const y = window.scrollY;
      // A direct answer to the capture's scroll is let through (a reveal,
      // a decoration that drops in), but where it touches what was shot
      // the page side is told, and the worker shoots the tile above again.
      // So is a timer the page set in that answer (a debounce that clears a
      // 'scrolling' class) and the first frame of an animation it started.
      // The animation's later frames are put back where they touch what was
      // shot: saybriefly.com plays its hero again on every scroll.
      if (why === 'scroll' && !(c && c.frames >= 2)) {
        const back = [];
        for (const m of records) {
          // (Only what can change how it looks; and not the inline style of
          // an element the capture holds through its stylesheet, whose
          // writes then show nothing: hitt.com's project cards move with the
          // scroll, held still, and their every write would have cost a
          // shot of the tile above for nothing.)
          if (m.type === 'attributes') {
            if (!/^(class|style|hidden|d|transform|fill|opacity)$/.test(m.attributeName)) continue;
            if (m.attributeName === 'style' && m.target.matches('[data-cleanshot-hold], [data-cleanshot-fade]')) continue;
          }
          const els = m.type === 'childList' ? [...m.addedNodes].filter((n) => n.nodeType === 1) : [m.target.nodeType === 1 ? m.target : m.target.parentElement];
          for (let e of els) {
            if (!e || e === document.body || e === document.documentElement) continue;
            while (e.ownerSVGElement) e = e.ownerSVGElement;
            // (What floats over the page, a header that changes as the page
            // scrolls, is the page side's to place, not part of a tile.)
            if (pinned(e)) continue;
            const r = e.getBoundingClientRect();
            if (r.height > 0 && r.width > 0 && r.top + y < bottom && r.bottom + y > 0 && r.height < 4 * innerHeight) {
              // Only where it is placed changed, inline (a transform, a
              // background position): that is the scroll moving something
              // already shot, a parallax or a sway the pre-scroll's short
              // stops missed (r-o.com's footer crane, one run in two), not a
              // reveal. Kept as shot.
              if (m.type === 'attributes' && m.attributeName === 'style' && onlyPlacement(m.oldValue, m.target.getAttribute('style'))) {
                back.push(m);
                continue;
              }
              S.dirty.push([Math.floor(r.top + y), Math.ceil(r.bottom + y)]);
              if (S.dirty.length > 200) S.dirty.shift();
              // What it was before, in case the page goes on to animate it:
              // see the put-back below.
              if (m.type === 'attributes') {
                if (!S.provisional.has(m.target)) S.provisional.set(m.target, new Map());
                const p = S.provisional.get(m.target);
                if (!p.has(m.attributeName)) p.set(m.attributeName, { old: m.oldValue, at: now() });
              }
            }
          }
        }
        for (let i = back.length - 1; i >= 0; i--) {
          const m = back[i];
          if (fighting(m.target)) continue;
          if (m.oldValue == null) m.target.removeAttribute('style');
          else m.target.setAttribute('style', m.oldValue);
        }
        if (back.length) { S.reverted++; S.mo.takeRecords(); }
        return;
      }
      const memo = new Map();
      // Shot already: above the bottom of the last screen shot. The inside
      // of an SVG goes by the SVG; a box with no size (a slide hidden by
      // display: none) by its nearest parent that has one.
      const shot = (n) => {
        let e = n.nodeType === 1 ? n : n.parentElement;
        if (!e) return false;
        while (e.ownerSVGElement) e = e.ownerSVGElement;
        if (memo.has(e)) return memo.get(e);
        let a = e, r = a.getBoundingClientRect();
        for (let k = 0; r.width === 0 && r.height === 0 && a.parentElement && k < 4; k++) { a = a.parentElement; r = a.getBoundingClientRect(); }
        // (What floats over the page is the page side's to hide and show.)
        const v = r.height > 0 && r.top + y < bottom && r.bottom + y > 0 && !pinned(a);
        memo.set(e, v);
        return v;
      };
      let done = false;
      const restored = new Map();
      for (let i = records.length - 1; i >= 0; i--) {
        const m = records[i], t = m.target;
        if (t === document.documentElement || t === document.body || (document.head && document.head.contains(t))) continue;
        if (t.nodeType === 1 && t.closest('[data-cleanshot-still]')) continue;
        if (m.type === 'attributes') {
          const name = m.attributeName;
          if (LOADING.test(name) || MEDIA.test(t.nodeName)) continue;
          const cur = t.getAttribute(name);
          if (cur === m.oldValue || (name === 'style' && pageStyle(cur) === pageStyle(m.oldValue))) continue;
          if (!shot(t) || fighting(t)) continue;
          // A change let through as an answer to the scroll that the page
          // then keeps animating is a passing effect, not a new state: a
          // sway with the scroll's speed (r-o.com's footer crane leans one
          // way scrolling down and the other scrolling up, and the tile
          // above was shot again after a scroll up), an animation started
          // again. It goes back to how it was before that scroll, as the
          // tile above shot it. (Within PROVISIONAL_MS of the scroll only;
          // a reveal that stays put is left.)
          const prov = S.provisional.get(t) && S.provisional.get(t).get(name);
          let old = m.oldValue;
          // (Records are taken newest first: once put back that far, the
          // older ones of the same batch are not to undo it.)
          if (restored.get(t) && restored.get(t).has(name)) continue;
          if (prov) {
            S.provisional.get(t).delete(name);
            if (now() - prov.at < PROVISIONAL_MS) {
              old = prov.old;
              if (!restored.has(t)) restored.set(t, new Set());
              restored.get(t).add(name);
            }
          }
          if (old == null) t.removeAttribute(name);
          else t.setAttribute(name, old);
          done = true;
        } else if (m.type === 'characterData') {
          if (t.data === m.oldValue || !shot(t) || fighting(t)) continue;
          t.data = m.oldValue;
          done = true;
        } else if (m.type === 'childList' && c) {
          // Only from the page's own timers and frames: children that
          // arrive otherwise are mostly content loading (a widget filling in).
          const nodes = [...m.addedNodes, ...m.removedNodes];
          if (!nodes.length || nodes.some((n) => n.nodeType === 1 && (SKIP_NODES.test(n.nodeName) || n.hasAttribute('data-cleanshot-still')))) continue;
          if (!shot(t) || fighting(t)) continue;
          for (const n of m.addedNodes) if (n.parentNode === t) t.removeChild(n);
          const before = m.nextSibling && m.nextSibling.parentNode === t ? m.nextSibling
            : m.previousSibling && m.previousSibling.parentNode === t ? m.previousSibling.nextSibling : null;
          for (const n of m.removedNodes) if (!n.parentNode) t.insertBefore(n, before);
          done = true;
        }
      }
      if (done) {
        S.reverted++;
        // (The reverts' own records.)
        S.mo.takeRecords();
      }
    };

    // Stills: the page side asks with a 'cleanshot-stills' event before each
    // shot and waits for 'cleanshot-stills-done'.
    const stillProps = ['position', 'top', 'right', 'bottom', 'left', 'width', 'height', 'box-sizing',
      'margin-top', 'margin-right', 'margin-bottom', 'margin-left', 'padding-top', 'padding-right', 'padding-bottom', 'padding-left',
      'border-top', 'border-right', 'border-bottom', 'border-left', 'border-radius', 'display', 'vertical-align', 'float',
      'transform', 'transform-origin', 'z-index', 'object-fit', 'object-position', 'opacity', 'filter', 'mix-blend-mode',
      'clip-path', 'flex-grow', 'flex-shrink', 'flex-basis', 'align-self', 'order', 'grid-row', 'grid-column', 'min-width', 'min-height', 'max-width', 'max-height'];
    const pinned = (el) => {
      for (let a = el; a && a !== document.body; a = a.parentElement) {
        if (/^(fixed|sticky)$/.test(getComputedStyle(a).position)) return true;
      }
      return false;
    };
    const blank = (c) => {
      try {
        const t = document.createElement('canvas');
        t.width = t.height = 16;
        const x = t.getContext('2d', { willReadFrequently: true });
        x.drawImage(c, 0, 0, 16, 16);
        const d = x.getImageData(0, 0, 16, 16).data;
        for (let i = 3; i < d.length; i += 4) if (d[i]) return false;
        return true;
      } catch (e) { return false; } // tainted: shown all the same
    };
    // A copy of `src` (a canvas, a video or an image) in a canvas that
    // takes `el`'s place, styled to the same box.
    const stand = (el, src, w, h) => {
      const c = document.createElement('canvas');
      c.width = Math.max(1, w);
      c.height = Math.max(1, h);
      try { c.getContext('2d').drawImage(src, 0, 0, c.width, c.height); } catch (e) { return null; }
      return c;
    };
    const place = (el, c) => {
      const cs = getComputedStyle(el);
      if (el.getAttribute('class')) c.setAttribute('class', el.getAttribute('class'));
      c.setAttribute('data-cleanshot-still', '');
      c.setAttribute('aria-hidden', 'true');
      for (const p of stillProps) c.style.setProperty(p, cs.getPropertyValue(p), 'important');
      if (cs.display === 'none') c.style.setProperty('display', 'block', 'important');
      const style = el.getAttribute('style');
      el.after(c);
      el.setAttribute('data-cleanshot-stilled', '');
      el.style.setProperty('display', 'none', 'important');
      S.stills.push({ el, c, style });
      S.stilled.add(el);
    };
    const loadImage = (url) => new Promise((resolve) => {
      const im = new Image();
      im.onload = () => resolve(im);
      im.onerror = () => resolve(null);
      o.setTimeout.call(window, () => resolve(null), 2000);
      im.src = url;
    });
    S.makeStills = async () => {
      const vh = innerHeight, vw = document.documentElement.clientWidth;
      const list = [...document.querySelectorAll('canvas:not([data-cleanshot-still]), video')].filter((el) => {
        if (S.stilled.has(el) || !el.isConnected) return false;
        const r = el.getBoundingClientRect();
        if (r.width < 100 || r.height < 60 || r.bottom <= 0 || r.top >= vh || r.right <= 0 || r.left >= vw) return false;
        if (!el.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true }) || pinned(el)) return false;
        return el.tagName === 'CANVAS' || (el.paused && (el.readyState >= 2 || el.poster));
      });
      let made = 0;
      const later = [];
      for (const el of list) {
        if (el.tagName === 'VIDEO') {
          // A poster is what the page chose to stand for the video; else
          // the frame the page side put it on.
          const im = el.poster ? await loadImage(el.poster) : null;
          const c = im ? stand(el, im, im.naturalWidth, im.naturalHeight)
            : el.readyState >= 2 ? stand(el, el, el.videoWidth, el.videoHeight) : null;
          if (c) { place(el, c); made++; }
          continue;
        }
        const c = stand(el, el, el.width, el.height);
        if (c && !blank(c)) { place(el, c); made++; } else later.push(el);
      }
      // Empty outside the frame that drew it (WebGL): copy right after the
      // page's next frame, with what the hold kept back let run once. A
      // canvas the page draws only when the page scrolls (Squarespace's
      // image effects) is told it scrolled, where it already is.
      if (later.length) {
        const copies = await new Promise((resolve) => {
          const frames = [...S.heldFrames.values()];
          S.heldFrames.clear();
          try { document.dispatchEvent(new Event('scroll', { bubbles: true })); } catch (e) {}
          frames.forEach((f) => o.requestAnimationFrame.call(window, f));
          o.requestAnimationFrame.call(window, () => resolve(later.map((el) => stand(el, el, el.width, el.height))));
          o.setTimeout.call(window, () => resolve([]), 1000);
        });
        later.forEach((el, k) => {
          const c = copies[k];
          if (c && !blank(c)) { place(el, c); made++; }
        });
      }
      return { made, failed: later.filter((el) => !S.stilled.has(el)).length };
    };
    S.onStills = () => {
      S.makeStills().catch(() => ({ made: 0, failed: -1 })).then((r) => {
        // (And the page rows the page changed in answer to the scroll since
        // the last ask, merged.)
        if (S.mo) { try { S.freeze(S.mo.takeRecords(), null); } catch (e) {} }
        const runs = [];
        for (const [a, b] of S.dirty.sort((p, q) => p[0] - q[0])) {
          const last = runs[runs.length - 1];
          if (last && a <= last[1]) last[1] = Math.max(last[1], b); else runs.push([a, b]);
        }
        S.dirty = [];
        r.dirty = runs;
        document.dispatchEvent(new CustomEvent('cleanshot-stills-done', { detail: JSON.stringify(r) }));
      });
    };
    document.addEventListener('cleanshot-stills', S.onStills);
    return 'watching';
  }
  if (!S) return 'not watching';
  if (cmd === 'hold') {
    S.grace = graceMs || 1000;
    S.after = afterMs || 3000;
    S.holdAt = now();
    S.holding = true;
    if (!S.mo) {
      S.mo = new MutationObserver((list) => { try { S.freeze(list, null); } catch (e) {} });
      S.mo.observe(document.documentElement, { subtree: true, childList: true, attributes: true, attributeOldValue: true, characterData: true, characterDataOldValue: true });
    }
    return 'holding';
  }
  if (cmd === 'release') {
    const o = S.orig;
    S.holding = false;
    if (S.mo) S.mo.disconnect();
    S.mo = null;
    for (const [type, f] of S.listeners) window.removeEventListener(type, f, { capture: true });
    document.removeEventListener('cleanshot-stills', S.onStills);
    for (const { el, c, style } of S.stills.reverse()) {
      c.remove();
      el.removeAttribute('data-cleanshot-stilled');
      if (style == null) el.removeAttribute('style');
      else el.setAttribute('style', style);
    }
    for (const k of Object.keys(o)) window[k] = o[k];
    const timeouts = [...S.heldTimeouts.values()], frames = [...S.heldFrames.values()];
    S.heldTimeouts.clear();
    S.heldFrames.clear();
    timeouts.forEach((f) => o.setTimeout.call(window, f, 0));
    frames.forEach((f) => o.requestAnimationFrame.call(window, f));
    delete window[KEY];
    return { timeouts: timeouts.length, frames: frames.length, skipped: S.skipped, reverted: S.reverted, stills: S.stills.length };
  }
}
