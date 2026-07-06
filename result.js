// Editor page shown after a capture. Loads the stitched image from storage
// and provides: filename edit, format choice (PNG/JPG/WebP), region crop,
// copy-to-clipboard, and download.

const $ = (sel) => document.querySelector(sel);
const img = new Image();
let originalSrc = null;   // full un-cropped image, for Reset
let naturalW = 0, naturalH = 0;
let sel = null;           // active selection in natural px {x,y,w,h}

const MIME = { png: 'image/png', jpg: 'image/jpeg', webp: 'image/webp' };
const EXT = { png: 'png', jpg: 'jpg', webp: 'webp' };
const QUALITY = 0.92;

init();

async function init() {
  const { capture } = await chrome.storage.local.get('capture');
  if (!capture || !capture.image) {
    $('#err').style.display = 'block';
    $('#err').textContent = 'No screenshot found. Click the extension icon on a page to capture one.';
    return;
  }
  originalSrc = capture.image;
  $('#filename').value = capture.baseName || 'screenshot';

  const pref = (await chrome.storage.local.get('format')).format;
  if (pref && MIME[pref]) $('#format').value = pref;
  updateExt();

  img.onload = () => {
    naturalW = img.naturalWidth;
    naturalH = img.naturalHeight;
    $('#stageImg').src = img.src;
    $('#dims').textContent = `${naturalW} × ${naturalH}px`;
    clearSelection();
    show();
  };
  img.src = originalSrc;
  wire();
}

function show() {
  $('#top').style.display = 'block';
  $('#stageWrap').style.display = 'flex';
}

function updateExt() {
  $('#ext').textContent = '.' + EXT[$('#format').value];
}

// --- selection (marquee) ---
function displayScale() {
  return $('#stageImg').clientWidth / naturalW;
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

// Build a canvas of the current export region (selection if any, else full).
function exportCanvas(forJpg) {
  const r = sel || { x: 0, y: 0, w: naturalW, h: naturalH };
  const c = document.createElement('canvas');
  c.width = Math.round(r.w);
  c.height = Math.round(r.h);
  const ctx = c.getContext('2d');
  if (forJpg) { ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, c.width, c.height); }
  ctx.drawImage(img, r.x, r.y, r.w, r.h, 0, 0, c.width, c.height);
  return c;
}

function applyCrop() {
  if (!sel) return;
  const c = exportCanvas(false);
  img.onload = () => {
    naturalW = img.naturalWidth;
    naturalH = img.naturalHeight;
    $('#stageImg').src = img.src;
    $('#dims').textContent = `${naturalW} × ${naturalH}px`;
    clearSelection();
    $('#reset').disabled = false;
  };
  img.src = c.toDataURL('image/png');
}

function resetImage() {
  img.onload = () => {
    naturalW = img.naturalWidth;
    naturalH = img.naturalHeight;
    $('#stageImg').src = img.src;
    $('#dims').textContent = `${naturalW} × ${naturalH}px`;
    clearSelection();
    $('#reset').disabled = true;
  };
  img.src = originalSrc;
}

function download() {
  const fmt = $('#format').value;
  const c = exportCanvas(fmt === 'jpg');
  c.toBlob((blob) => {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${$('#filename').value || 'screenshot'}.${EXT[fmt]}`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    toast(sel ? 'Selection saved — closing…' : 'Saved — closing…');
    // The file is on its way; the editor's job is done. Close the tab so the
    // user lands back where they were. Short delay lets the toast show.
    setTimeout(closeSelf, 650);
  }, MIME[fmt], QUALITY);
}

function closeSelf() {
  chrome.tabs.getCurrent((tab) => {
    if (tab && tab.id != null) chrome.tabs.remove(tab.id);
    else window.close();
  });
}

async function copy() {
  const c = exportCanvas(false); // clipboard images are PNG
  c.toBlob(async (blob) => {
    try {
      await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
      toast('Copied to clipboard');
    } catch (e) {
      toast('Copy failed: ' + e.message);
    }
  }, 'image/png');
}

let toastTimer = null;
function toast(msg) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), 1800);
}
