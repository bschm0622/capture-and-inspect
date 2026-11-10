// Service worker: orchestrates a scroll-and-stitch full-page capture. The
// toolbar popup asks it to start and shows the progress bar; this worker
// drives the injected content script, captures one PNG per viewport tile
// (throttled to Chrome's quota), stitches them on an OffscreenCanvas, and
// opens the editor tab with the result. Progress is streamed to the popup so
// the indicator lives in browser chrome and never touches the page.

const CAPTURE_MIN_INTERVAL_MS = 600; // Chrome allows ~2 captureVisibleTab/sec
const MAX_CANVAS_AREA = 268435456;   // Chrome canvas area cap (px^2)

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

async function throttledCapture(windowId) {
  const wait = CAPTURE_MIN_INTERVAL_MS - (Date.now() - lastCaptureTs);
  if (wait > 0) await sleep(wait);
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
// say; moves the tile when the overlap clearly matches somewhere else.
// `hidden` lists canvas rects (CSS px) of overlays the last shot showed and
// this one doesn't; they're left out of the comparison.
function placeTile(sig, w, seam, predicted, tile, tileH, hidden) {
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
  let best = 0;
  for (let r = 1; r < scores.length; r++) if (scores[r] < scores[best]) best = r;
  let second = Infinity;
  for (let r = 0; r < scores.length; r++) if (Math.abs(r - best) > 4) second = Math.min(second, scores[r]);
  const r0 = Math.round(stripTop - predicted);
  const at0 = r0 >= 0 && r0 < scores.length ? scores[r0] : Infinity;
  const round = (v) => Math.round(v * 10) / 10;
  if (at0 < MATCH_OK && at0 <= scores[best] + 1.5) return { top: predicted, match: 'ok', score: round(at0) };
  if (scores[best] < MATCH_OK && second > Math.max(2 * scores[best], scores[best] + 3)) {
    return { top: stripTop - best, match: 'moved', score: round(scores[best]), predicted };
  }
  return { top: predicted, match: 'mismatch', score: round(at0), best: round(scores[best]) };
}

async function stitchTiles(tab, info) {
  const { pageHeight, viewportHeight: vh, pageWidth, dpr } = info;
  const warnings = [];
  const placements = [];
  if (info.rawPageHeight > pageHeight) {
    warnings.push({ kind: 'truncated', y0: pageHeight, y1: info.rawPageHeight, note: `page is ${info.rawPageHeight}px tall; only the first ${pageHeight}px are captured` });
  }

  // Determine output scale, downshifting from dpr if the page is so tall it
  // would blow past the canvas area cap. The canvas leaves room for the page
  // to grow during the capture; rows it doesn't use are cut off at the end.
  const room = pageHeight + GROWTH_TILES * vh;
  let scale = dpr;
  while (scale > 1 && (pageWidth * scale) * (room * scale) > MAX_CANVAS_AREA) {
    scale -= 0.5;
  }
  if (scale < 1) scale = 1;
  const canvas = new OffscreenCanvas(Math.round(pageWidth * scale), Math.round(room * scale));
  const ctx = canvas.getContext('2d');
  // The same canvas as a luma grid, for matching each tile's overlap.
  const gw = Math.max(8, Math.round(pageWidth / GRID_PX));
  const gh = Math.ceil(room);
  const grid = new Uint8Array(gw * gh);

  const step = vh - OVERLAP;
  let total = 1 + Math.ceil(Math.max(0, pageHeight - vh) / step);
  const maxShots = total * 2 + 10;
  let cursor = 0;  // canvas rows painted so far, top down (output px)
  let offset = 0;  // capture y minus page y of the content at the seam (CSS px)
  let minH = pageHeight, maxH = pageHeight;
  let shots = 0, retakes = 0;
  let lift = 0;    // extra CSS px to shoot higher on a retake after a failed match
  let prevTop = 0; // where the last tile drawn sits in the capture (CSS px)
  let hidden = []; // overlays it showed that the page has hidden since, in capture px
  const holes = [];

  for (let i = 0; ;) {
    if (shots++ >= maxShots) {
      warnings.push({ kind: 'truncated', y0: Math.round(cursor / scale), y1: Math.round(cursor / scale), note: `stopped after ${maxShots} shots; the page kept moving` });
      break;
    }
    const seam = cursor / scale;
    const wantY = i === 0 ? 0 : Math.max(0, Math.round(seam - OVERLAP - offset - lift));
    const res = await sendToTab(tab.id, { cmd: 'tile', y: wantY, index: i, total });
    if (!res || !res.ok) throw new Error(res && res.error || 'tile failed');
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
    else if (res.actualY !== wantY && !atBottom) offset += wantY - res.actualY;
    let top = res.actualY + offset;

    // The content moved up past the seam since the last tile, so this shot
    // would leave a gap. Shoot again from higher up.
    if (i > 0 && top > seam - MIN_OVERLAP && retakes < MAX_RETAKES) {
      retakes++;
      placements.push({ index: i, y: wantY, actualY: res.actualY, drift: res.drift, top, retake: true });
      continue;
    }

    setBadge(`${i + 1}/${total}`, '#555');
    notify({ phase: 'tile', index: i, total });

    const bmp = await dataUrlToBitmap(await throttledCapture(tab.windowId));
    const tileH = Math.round(bmp.height / dpr);
    const tileGrid = lumaGrid(bmp, gw, tileH);
    let match = null;
    if (i > 0) {
      match = placeTile(grid, gw, seam, top, tileGrid, tileH, hidden);
      if (match.match === 'moved') {
        top = match.top;
        offset = top - res.actualY;
      } else if (match.match === 'mismatch' && res.drift == null && !lift) {
        // Nothing to go on: the page couldn't say how far it moved and the
        // overlap isn't anywhere in this shot. If the content moved up past
        // the shot's top, a shot from half a screen higher still holds it.
        lift = Math.round(step / 2);
        placements.push({ index: i, y: wantY, actualY: res.actualY, drift: res.drift, top, match, retake: true });
        bmp.close();
        continue;
      } else if (match.match === 'mismatch' && res.drift == null) {
        // (With a measurement from the page, a mismatch is something that
        // changed between the two shots, like an image that finished
        // loading or an overlay hidden after the first tile, and the
        // measurement stands.)
        warnings.push({ kind: 'overlap-mismatch', y0: Math.round(top), y1: Math.round(seam), note: `tile ${i + 1} doesn't match the tile above where it overlaps it; placed by scroll position` });
      }
    }

    // captureVisibleTab returns device pixels (vh*dpr tall). Draw only the
    // rows below what is already painted, rescaled to our output scale.
    const topOut = Math.round(top * scale);
    const tileOut = Math.round(bmp.height * scale / dpr);
    const from = Math.max(cursor, topOut, 0);
    const to = Math.min(topOut + tileOut, canvas.height);
    if (from > cursor) holes.push([cursor, from]);
    if (to > from) {
      const sy = (from - topOut) * dpr / scale;
      const sh = (to - from) * dpr / scale;
      ctx.drawImage(bmp, 0, sy, bmp.width, sh, 0, from, Math.round(bmp.width * scale / dpr), to - from);
      const t0 = Math.round(top);
      for (let c = Math.ceil(from / scale); c < Math.min(gh, Math.ceil(to / scale)); c++) {
        const t = c - t0;
        if (t >= 0 && t < tileH) grid.set(tileGrid.subarray(t * gw, (t + 1) * gw), c * gw);
      }
      cursor = to;
    }
    bmp.close();
    placements.push({ index: i, y: wantY, actualY: res.actualY, drift: res.drift, top, match });

    i++;
    retakes = 0;
    lift = 0;
    prevTop = top;
    hidden = [];
    total = Math.max(total, i + (atBottom ? 0 : Math.ceil((res.maxScroll - res.actualY) / step)));
    if (topOut + tileOut > canvas.height) {
      warnings.push({ kind: 'truncated', y0: Math.round(cursor / scale), y1: Math.round((topOut + tileOut) / scale), note: `the page grew by more than ${GROWTH_TILES} screens while it was captured; the capture stops here` });
      break;
    }
    if (atBottom) break;
  }

  // Rows that no tile reached are reported, not hidden.
  for (const [a, b] of holes) {
    warnings.push({ kind: 'unpainted', y0: Math.round(a / scale), y1: Math.round(b / scale), note: `${Math.round((b - a) / scale)}px never painted: the page moved and the retakes didn't catch up` });
  }
  if (maxH - minH > vh) {
    warnings.push({ kind: 'page-height-changed', y0: minH, y1: maxH, note: `page height ranged from ${minH}px to ${maxH}px while it was captured` });
  }

  // Cut off the rows below the last tile: room the page didn't grow into.
  let out = canvas;
  if (cursor < canvas.height) {
    out = new OffscreenCanvas(canvas.width, Math.max(1, cursor));
    out.getContext('2d').drawImage(canvas, 0, 0);
  }
  return { canvas: out, tileCount: placements.filter((p) => !p.retake).length, warnings, placements };
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

  try {
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

    // Inject the page-side worker (activeTab grant covers this tab).
    await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      files: ['content.js']
    });

    const info = await sendToTab(tab.id, { cmd: 'prepare' });
    if (!info || !info.ok) throw new Error(info && info.error || 'prepare failed');

    const { canvas, tileCount, warnings, placements } = await stitchTiles(tab, info);

    await sendToTab(tab.id, { cmd: 'finish' }).catch(() => {});

    const outBlob = await canvas.convertToBlob({ type: 'image/png' });
    const outUrl = await blobToDataUrl(outBlob);

    let host = 'page';
    try { host = new URL(tab.url).hostname; } catch (_) {}
    // Local date, not UTC: an evening capture shouldn't be named for tomorrow.
    const now = new Date();
    const date = [now.getFullYear(), now.getMonth() + 1, now.getDate()]
      .map((n) => String(n).padStart(2, '0'))
      .join('-');
    const baseName = `${host}_${date}`;

    // Hand the stitched image to the editor tab, which handles crop, format
    // choice, copy-to-clipboard, and download.
    await chrome.storage.local.set({
      capture: {
        image: outUrl,
        baseName,
        width: canvas.width,
        height: canvas.height,
        sourceUrl: tab.url,
        warnings
      }
    });
    notify({ phase: 'done', filename: `${baseName}.png` });
    setBadge('✓', '#27ae60');
    clearBadgeLater(2000);
    await chrome.tabs.create({ url: chrome.runtime.getURL('result.html') });

    return { filename: `${baseName}.png`, dataUrl: outUrl, tileCount, warnings, placements };
  } catch (err) {
    console.error('[CleanShot]', err);
    // Best-effort page restore even on failure.
    try { await sendToTab(tab.id, { cmd: 'finish' }); } catch (_) {}
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
// back in normal flow, then jumps each animation to its end state so the
// capture shows the finished design. Smooth-scroll libraries go too, since
// they fight the tile-by-tile scrolling. The page stays this way until it
// reloads.
function unpinScrollAnimations() {
  const ST = window.ScrollTrigger ||
    (window.gsap && window.gsap.core && window.gsap.core.globals().ScrollTrigger);
  if (ST) {
    const triggers = ST.getAll();
    const animations = triggers.map((t) => t.animation).filter(Boolean);
    triggers.forEach((t) => t.kill(true, true));
    animations.forEach((a) => a.progress(1));
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

  document.querySelectorAll('.swiper, .swiper-container, swiper-container').forEach((el) => {
    if (el.swiper && el.swiper.autoplay) attempt(() => el.swiper.autoplay.stop());
  });

  const $ = window.jQuery;
  if ($ && $.fn) {
    if ($.fn.slick) attempt(() => $('.slick-initialized').slick('slickPause'));
    if ($.fn.owlCarousel) attempt(() => $('.owl-carousel').trigger('stop.owl.autoplay'));
  }

  if (window.Flickity) {
    document.querySelectorAll('.flickity-enabled').forEach((el) => {
      const f = window.Flickity.data(el);
      if (f) attempt(() => f.stopPlayer());
    });
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

function blobToDataUrl(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
}
