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
    // Inject the page-side worker (activeTab grant covers this tab).
    await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      files: ['content.js']
    });

    const info = await sendToTab(tab.id, { cmd: 'prepare' });
    if (!info || !info.ok) throw new Error(info && info.error || 'prepare failed');

    const { pageHeight, viewportHeight, pageWidth, dpr } = info;
    const tileCount = Math.max(1, Math.ceil(pageHeight / viewportHeight));
    const maxScroll = Math.max(0, pageHeight - viewportHeight);

    // Determine output scale, downshifting from dpr if the page is so tall it
    // would blow past the canvas area cap.
    let scale = dpr;
    while (scale > 1 && (pageWidth * scale) * (pageHeight * scale) > MAX_CANVAS_AREA) {
      scale -= 0.5;
    }
    if (scale < 1) scale = 1;

    const canvas = new OffscreenCanvas(
      Math.round(pageWidth * scale),
      Math.round(pageHeight * scale)
    );
    const ctx = canvas.getContext('2d');

    for (let i = 0; i < tileCount; i++) {
      const requestedY = Math.min(i * viewportHeight, maxScroll);
      const res = await sendToTab(tab.id, { cmd: 'tile', y: requestedY, index: i, total: tileCount });
      if (!res || !res.ok) throw new Error(res && res.error || 'tile failed');

      setBadge(`${i + 1}/${tileCount}`, '#555');
      notify({ phase: 'tile', index: i, total: tileCount });

      const dataUrl = await throttledCapture(tab.windowId);
      const bmp = await dataUrlToBitmap(dataUrl);

      // captureVisibleTab returns device pixels (vh*dpr tall). Place the tile
      // at the actual scroll offset, rescaled to our output scale.
      const destY = Math.round(res.actualY * scale);
      const destH = Math.round(bmp.height * (scale / dpr));
      const destW = Math.round(bmp.width * (scale / dpr));
      ctx.drawImage(bmp, 0, 0, bmp.width, bmp.height, 0, destY, destW, destH);
      bmp.close();
    }

    await sendToTab(tab.id, { cmd: 'finish' }).catch(() => {});

    const outBlob = await canvas.convertToBlob({ type: 'image/png' });
    const outUrl = await blobToDataUrl(outBlob);

    let host = 'page';
    try { host = new URL(tab.url).hostname; } catch (_) {}
    const date = new Date().toISOString().slice(0, 10);
    const baseName = `${host}_${date}`;

    // Hand the stitched image to the editor tab, which handles crop, format
    // choice, copy-to-clipboard, and download.
    await chrome.storage.local.set({
      capture: {
        image: outUrl,
        baseName,
        width: canvas.width,
        height: canvas.height,
        sourceUrl: tab.url
      }
    });
    notify({ phase: 'done', filename: `${baseName}.png` });
    setBadge('✓', '#27ae60');
    clearBadgeLater(2000);
    await chrome.tabs.create({ url: chrome.runtime.getURL('result.html') });

    return { filename: `${baseName}.png`, dataUrl: outUrl, tileCount };
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

function blobToDataUrl(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
}
