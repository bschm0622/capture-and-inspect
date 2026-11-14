// Editor page shown after a capture. Loads the stitched PNG from the
// extension's IndexedDB and provides: filename edit, format choice
// (PNG/JPG/WebP), region crop, copy-to-clipboard, and download.
//
// The image is shown as a stack of pieces. A capture up to 65535 px tall
// (any page up to about 32,700 CSS px at 2x) is one piece: the file itself
// in one <img>, as it always was. A taller one is read from the file a strip
// at a time and cut into pieces of PIECE_ROWS rows, each its own small PNG:
// Chrome won't decode an image over 2 GB of pixels at all, and one near that
// size takes several GB to show. Crop, copy and download work across piece
// edges.

const $ = (sel) => document.querySelector(sel);

const MIME = { png: 'image/png', jpg: 'image/jpeg', webp: 'image/webp' };
const EXT = { png: 'png', jpg: 'jpg', webp: 'webp' };
const QUALITY = 0.92;
// Chrome's canvas limits: a side, and the area.
const MAX_SIDE = 65535;
const MAX_AREA = 268435456;
// Rows per piece of a tall capture (2776 px wide: 180 MB each decoded).
const PIECE_ROWS = 16384;
// Taller than this, the clipboard can't take the image: Chrome's tab
// crashes writing a PNG over 65535 px tall (measured: 65535 copies, 65600
// crashes), so copy refuses first.
const MAX_COPY_ROWS = 65535;

let capture = null;       // what the worker stored about the capture
let originalBlob = null;  // the PNG file as captured
let original = null;      // its pieces, for Reset
let pieces = [];          // what is shown now: [{ top, height, url, img }]
let naturalW = 0, naturalH = 0;
let cropped = false;      // pieces are a crop of the original
let sel = null;           // active selection in natural px {x,y,w,h}

init();

async function init() {
  ({ capture } = await chrome.storage.local.get('capture'));
  try {
    originalBlob = await CaptureStore.get();
    // (A capture stored by an earlier version kept the image in storage.)
    if (!originalBlob && capture && capture.image) originalBlob = await (await fetch(capture.image)).blob();
  } catch (e) {
    originalBlob = null;
  }
  if (!capture || !originalBlob) {
    $('#err').style.display = 'block';
    $('#err').textContent = 'No screenshot found. Click the extension icon on a page to capture one.';
    return;
  }
  $('#filename').value = capture.baseName || 'screenshot';

  const pref = (await chrome.storage.local.get('format')).format;
  if (pref && MIME[pref]) $('#format').value = pref;
  updateExt();
  showNotice(capture.warnings || []);
  wire();

  const size = await Png.readSize(originalBlob);
  naturalW = size.width;
  naturalH = size.height;
  $('#dims').textContent = `${naturalW} × ${naturalH}px`;
  show();
  if (naturalH <= MAX_SIDE) {
    original = [await pieceFromBlob(originalBlob, 0, naturalH)];
    setPieces(original);
  } else {
    busy(true);
    try {
      original = await piecesFromPng(originalBlob, naturalW, naturalH);
    } catch (e) {
      setStatus("The preview couldn't be shown. Download still saves the full screenshot.");
      $('#download').disabled = false;
      return;
    }
    busy(false);
  }
}

function show() {
  $('#top').style.display = 'block';
  $('#stageWrap').style.display = 'flex';
}

function updateExt() {
  $('#ext').textContent = '.' + EXT[$('#format').value];
}

// --- pieces ---

function pieceFromBlob(blob, top, height) {
  const url = URL.createObjectURL(blob);
  const img = new Image();
  img.alt = 'screenshot';
  img.draggable = false;
  // (Loaded, not decoded: Chrome decodes a piece when it is drawn or comes
  // into view, and can drop it again, so all of them needn't be in memory.)
  const loaded = new Promise((res) => { img.onload = img.onerror = res; });
  img.src = url;
  return loaded.then(() => ({ top, height, url, img }));
}

// Shows `list` in the stage, replacing what was there. Each piece keeps its
// place by aspect ratio while it loads.
function setPieces(list) {
  for (const p of pieces) if (!list.includes(p) && !(original || []).includes(p)) URL.revokeObjectURL(p.url);
  pieces = list;
  const box = $('#pieces');
  box.replaceChildren(...list.map((p) => {
    p.img.style.aspectRatio = `${naturalW} / ${p.height}`;
    return p.img;
  }));
  clearSelection();
}

// The pieces of a PNG too tall for one image, decoded a strip at a time.
// They appear as they are made; the rest of the page is held for them.
async function piecesFromPng(blob, width, height) {
  const list = [];
  const box = $('#pieces');
  const slots = [];
  for (let top = 0; top < height; top += PIECE_ROWS) {
    const h = Math.min(PIECE_ROWS, height - top);
    const slot = document.createElement('div');
    slot.className = 'slot';
    slot.style.aspectRatio = `${width} / ${h}`;
    slots.push(slot);
  }
  box.replaceChildren(...slots);
  setStatus('Preparing the preview…');
  let canvas = null, ctx = null, pieceTop = 0;
  for await (const { data, rows, y } of Png.decodeStrips(blob, { stripRows: 256 })) {
    if (!canvas) {
      canvas = new OffscreenCanvas(width, Math.min(PIECE_ROWS, height - pieceTop));
      ctx = canvas.getContext('2d');
    }
    ctx.putImageData(new ImageData(data, width, rows), 0, y - pieceTop);
    if (y + rows - pieceTop === canvas.height) {
      const p = await pieceFromBlob(await canvas.convertToBlob({ type: 'image/png' }), pieceTop, canvas.height);
      p.img.style.aspectRatio = `${width} / ${p.height}`;
      slots[list.length].replaceWith(p.img);
      list.push(p);
      pieceTop += canvas.height;
      canvas = null;
      setStatus(`Preparing the preview… ${Math.round(pieceTop / height * 100)}%`);
    }
  }
  pieces = list;
  setStatus('');
  return list;
}

// Draws rows [y0, y0 + n) of region r (whole px) of what is shown now into
// ctx at row dy, from whichever pieces hold them.
function drawRegion(ctx, r, y0, n, dy = 0) {
  for (const p of pieces) {
    const a = Math.max(r.y + y0, p.top), b = Math.min(r.y + y0 + n, p.top + p.height);
    if (b <= a) continue;
    ctx.drawImage(p.img, r.x, a - p.top, r.w, b - a, 0, dy + a - (r.y + y0), r.w, b - a);
  }
}

// The region in whole px, inside the image.
function wholeRegion(r) {
  const x = Math.max(0, Math.round(r.x)), y = Math.max(0, Math.round(r.y));
  return { x, y, w: Math.min(naturalW - x, Math.round(r.w)), h: Math.min(naturalH - y, Math.round(r.h)) };
}

const fitsCanvas = (w, h) => w <= MAX_SIDE && h <= MAX_SIDE && w * h <= MAX_AREA;

// A region as new pieces (for Crop), each made from the pieces shown now.
async function cropPieces(r) {
  const list = [];
  for (let y = 0; y < r.h; y += PIECE_ROWS) {
    const n = Math.min(PIECE_ROWS, r.h - y);
    const c = new OffscreenCanvas(r.w, n);
    drawRegion(c.getContext('2d'), r, y, n);
    list.push(await pieceFromBlob(await c.convertToBlob({ type: 'image/png' }), y, n));
  }
  return list;
}

// A region as one PNG, for one too tall for a canvas: written a strip at a
// time from the pieces.
function regionPng(r) {
  const strip = new OffscreenCanvas(r.w, 256);
  const ctx = strip.getContext('2d', { willReadFrequently: true });
  const holes = (capture.warnings || []).some((w) => w.kind === 'unpainted');
  async function* strips() {
    for (let y = 0; y < r.h; y += 256) {
      const n = Math.min(256, r.h - y);
      ctx.clearRect(0, 0, r.w, 256);
      drawRegion(ctx, r, y, n);
      yield { data: ctx.getImageData(0, 0, r.w, n).data, rows: n };
    }
  }
  return Png.encode({ width: r.w, height: r.h, alpha: holes, strips: strips() });
}

// --- selection (marquee) ---
function displayScale() {
  return $('#pieces').clientWidth / naturalW;
}

function wire() {
  const overlay = $('#overlay');
  const box = $('#selbox');
  let start = null;

  overlay.addEventListener('mousedown', (e) => {
    const r = overlay.getBoundingClientRect();
    start = { x: e.clientX - r.left, y: e.clientY - r.top };
    box.style.display = 'block';
    drawBox(start.x, start.y, 0, 0);
  });
  window.addEventListener('mousemove', (e) => {
    if (!start) return;
    const r = overlay.getBoundingClientRect();
    const cx = Math.max(0, Math.min(e.clientX - r.left, r.width));
    const cy = Math.max(0, Math.min(e.clientY - r.top, r.height));
    drawBox(Math.min(start.x, cx), Math.min(start.y, cy),
            Math.abs(cx - start.x), Math.abs(cy - start.y));
  });
  window.addEventListener('mouseup', () => {
    if (!start) return;
    const b = box.getBoundingClientRect();
    const o = $('#overlay').getBoundingClientRect();
    const s = displayScale();
    const w = b.width / s, h = b.height / s;
    if (w > 4 && h > 4) {
      sel = { x: (b.left - o.left) / s, y: (b.top - o.top) / s, w, h };
      $('#crop').disabled = false;
    } else {
      clearSelection();
    }
    start = null;
  });

  function drawBox(x, y, w, h) {
    Object.assign(box.style, { left: x + 'px', top: y + 'px', width: w + 'px', height: h + 'px' });
  }

  $('#crop').addEventListener('click', applyCrop);
  $('#reset').addEventListener('click', resetImage);
  $('#download').addEventListener('click', download);
  $('#copy').addEventListener('click', copy);
  $('#format').addEventListener('change', () => {
    updateExt();
    chrome.storage.local.set({ format: $('#format').value });
  });
}

function clearSelection() {
  sel = null;
  const box = $('#selbox');
  if (box) box.style.display = 'none';
  $('#crop').disabled = true;
}

// Build a canvas of the current export region (selection if any, else
// full), when it fits in one. A one-piece image is drawn exactly as before.
function exportCanvas(forJpg) {
  const r = sel || { x: 0, y: 0, w: naturalW, h: naturalH };
  const c = document.createElement('canvas');
  c.width = Math.round(r.w);
  c.height = Math.round(r.h);
  const ctx = c.getContext('2d');
  if (forJpg) { ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, c.width, c.height); }
  if (pieces.length === 1) ctx.drawImage(pieces[0].img, r.x, r.y, r.w, r.h, 0, 0, c.width, c.height);
  else drawRegion(ctx, wholeRegion(r), 0, Math.round(r.h));
  return c;
}

const exportRegion = () => wholeRegion(sel || { x: 0, y: 0, w: naturalW, h: naturalH });

async function applyCrop() {
  if (!sel) return;
  const r = wholeRegion(sel);
  let list;
  if (fitsCanvas(r.w, r.h) && pieces.length === 1) {
    const c = exportCanvas(false);
    const blob = await new Promise((res) => c.toBlob(res, 'image/png'));
    list = [await pieceFromBlob(blob, 0, c.height)];
  } else {
    setStatus('Cropping…');
    list = await cropPieces(r);
    setStatus('');
  }
  naturalW = r.w;
  naturalH = r.h;
  $('#dims').textContent = `${naturalW} × ${naturalH}px`;
  cropped = true;
  setPieces(list);
  $('#reset').disabled = false;
}

async function resetImage() {
  const size = await Png.readSize(originalBlob);
  naturalW = size.width;
  naturalH = size.height;
  $('#dims').textContent = `${naturalW} × ${naturalH}px`;
  cropped = false;
  setPieces(original);
  $('#reset').disabled = true;
}

function save(blob, name, message) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60000);
  toast(message, message.length > 40 ? 4000 : 1800);
  // The file is on its way; the editor's job is done. Close the tab so the
  // user lands back where they were. Short delay lets the toast show.
  setTimeout(closeSelf, message.length > 40 ? 3000 : 650);
}

async function download() {
  const fmt = $('#format').value;
  const base = $('#filename').value || 'screenshot';
  const done = sel ? 'Selection saved — closing…' : 'Saved — closing…';
  // The whole capture as PNG: the file itself.
  if (fmt === 'png' && !sel && !cropped) {
    save(originalBlob, `${base}.png`, done);
    return;
  }
  const r = exportRegion();
  if (fitsCanvas(r.w, r.h)) {
    const c = exportCanvas(fmt === 'jpg');
    c.toBlob((blob) => save(blob, `${base}.${EXT[fmt]}`, done), MIME[fmt], QUALITY);
    return;
  }
  // Taller than a canvas can be: only PNG can hold it.
  const note = fmt === 'png' ? done : `Saved as PNG: JPG and WebP can't hold an image this tall — closing…`;
  $('#download').disabled = true;
  setStatus('Saving…');
  try {
    save(await regionPng(r), `${base}.png`, note);
  } finally {
    setStatus('');
    $('#download').disabled = false;
  }
}

function closeSelf() {
  chrome.tabs.getCurrent((tab) => {
    if (tab && tab.id != null) chrome.tabs.remove(tab.id);
    else window.close();
  });
}

async function copy() {
  const r = exportRegion();
  if (r.h > MAX_COPY_ROWS || !fitsCanvas(r.w, r.h)) {
    toast(sel ? 'This selection is too tall to copy. Select a smaller part, or download it.'
              : 'This screenshot is too tall to copy. Download it instead, or select a part to copy.', 5000, true);
    return;
  }
  const c = exportCanvas(false); // clipboard images are PNG
  c.toBlob(async (blob) => {
    try {
      await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
      toast('Copied to clipboard');
    } catch (e) {
      toast('Copy failed: ' + e.message, 4000, true);
    }
  }, 'image/png');
}

// --- notices ---

// What the capture said about itself, in plain words: one line per kind of
// problem, with roughly where it is.
const NOTICE = {
  truncated: (w) => w.reason === 'too-tall'
    ? `The page is too long for one image, so the screenshot stops before the end: the last ${Math.max(1, Math.round((w.y1 - w.y0) / w.y1 * 100))}% of the page isn't in it.`
    : 'The page kept changing, so the screenshot stops before the bottom of the page.',
  unpainted: () => 'Some strips of the page could not be captured and are left empty.',
  'position-only': () => 'The page moved while it was captured. Where two shots meet, things may be slightly out of line.',
  'tiles-disagree': () => 'Something on the page changed while it was captured. Where two shots meet, there may be a visible step.',
  'live-effect': () => 'Videos or animations on the page show a single moment, and may not line up where two shots meet.',
  budget: () => 'The page kept moving, so some places may be less exact than usual.',
  'page-height-changed': () => 'The page changed length while it was captured.',
  'pinned-stages': () => 'A section that changes as you scroll is shown as a series of screens, one for each stage.',
  'video-no-frame': () => "A video on the page hadn't loaded when it was captured, so its place is empty."
};

function showNotice(warnings) {
  const lines = [];
  const seen = new Set();
  for (const w of warnings) {
    const f = NOTICE[w.kind];
    const key = w.kind === 'truncated' ? `${w.kind}:${w.reason || ''}` : w.kind;
    if (seen.has(key)) continue;
    seen.add(key);
    lines.push(f ? f(w) : 'Part of the screenshot may not look exactly like the page.');
  }
  if (!lines.length) return;
  const el = $('#notice');
  el.replaceChildren(...lines.map((t) => Object.assign(document.createElement('div'), { textContent: t })));
  el.hidden = false;
}

// Copy, crop and download wait while the pieces are being made.
function busy(on) {
  for (const id of ['#copy', '#download']) $(id).disabled = on;
  $('#overlay').style.pointerEvents = on ? 'none' : '';
}

function setStatus(text) {
  const el = $('#status');
  el.textContent = text;
  el.hidden = !text;
}

let toastTimer = null;
function toast(msg, ms = 1800, error = false) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.toggle('error', error);
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), ms);
}
