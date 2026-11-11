// Drives one capture of one site through the real extension.
//
// Each site gets its own fresh persistent context (own profile, own service
// worker), so a site that hangs or leaves the worker's `capturing` flag stuck
// can't affect the next one.
//
// Tile geometry comes from instrumenting the service worker from the outside
// (no change to the extension): `drawImage` on the stitching canvas is
// wrapped to record where each tile lands, and `chrome.tabs.sendMessage` is
// wrapped to record the content script's prepare/tile replies.

import { chromium } from 'playwright-core';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { gateVerdict } from './gate.mjs';

export const VIEWPORT = { width: 1388, height: 868 };
export const DPR = 2;
// Headless Chromium still reserves room for browser chrome inside
// --window-size; this is how much, measured with Chromium 1248. The inner
// size is checked after load and the site fails if it doesn't match.
const CHROME_HEIGHT = 87;

// Seam evidence kept per tile: rows above and below where it starts
// painting, sampled to the analysis grid's columns (image.mjs COLS).
export const OV_COLS = 347, OV_ABOVE = 12, OV_BELOW = 4;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function withTimeout(promise, ms, what) {
  let t;
  return Promise.race([
    promise.finally(() => clearTimeout(t)),
    new Promise((_, rej) => { t = setTimeout(() => rej(new Error(`timeout after ${Math.round(ms / 1000)}s: ${what}`)), ms); })
  ]);
}

// The user agent a desktop Chrome of this version sends. Headless Chromium
// says "HeadlessChrome", which some bot walls turn away on sight.
export const desktopUA = (version) =>
  `Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${version.split('.')[0]}.0.0.0 Safari/537.36`;
// The Chromium build playwright-core installs (156 for 1.64.1).
const BROWSER_VERSION = (() => {
  try {
    const f = path.join(path.dirname(new URL(import.meta.resolve('playwright-core')).pathname), 'browsers.json');
    return JSON.parse(fs.readFileSync(f, 'utf8')).browsers.find((b) => b.name === 'chromium').browserVersion;
  } catch { return '156.0.0.0'; }
})();

// `honest`: send the user-agent string a desktop Chrome of the same version
// sends. On the 2026-11 gallery sweep that alone let all five sites that
// had served a Cloudflare challenge through; turning off the
// AutomationControlled blink feature (navigator.webdriver) let none
// through, so it isn't used. One regression site (premier-roofing.com)
// refuses that user agent and accepts the headless one, so run.mjs tries
// the other when a site comes back blocked. Nothing stealthier, and no
// challenge is ever solved.
export async function launch(extDir, { headless = true, honest = true } = {}) {
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'capture-profile-'));
  const args = [
    `--window-size=${VIEWPORT.width},${VIEWPORT.height + CHROME_HEIGHT}`,
    `--force-device-scale-factor=${DPR}`,
    `--disable-extensions-except=${extDir}`,
    `--load-extension=${extDir}`,
    '--hide-scrollbars',
    '--mute-audio'
  ];
  if (honest) args.push(`--user-agent=${desktopUA(BROWSER_VERSION)}`);
  const context = await chromium.launchPersistentContext(userDataDir, {
    channel: 'chromium', // full Chromium (new headless); headless-shell can't load extensions
    headless,
    // No Playwright viewport emulation: emulated DPR only changes what the
    // page reports, while captureVisibleTab still returns 1x pixels. A real
    // window at a forced scale factor keeps both in agreement.
    viewport: null,
    args
  });
  let sw = context.serviceWorkers().find((w) => w.url().startsWith('chrome-extension://'));
  if (!sw) sw = await context.waitForEvent('serviceworker', { timeout: 15000 });
  return { context, sw, userDataDir };
}

function instrumentWorker([cssWidth, cols, above, below]) {
  if (self.__harness) return;
  const h = self.__harness = { draws: [], messages: [], canvas: null };
  const proto = OffscreenCanvasRenderingContext2D.prototype;
  const draw = proto.drawImage;
  // Luma rows [y0, y0 + n) of an RGBA image `w` px wide, `rowPx` px per CSS
  // row, sampled to `cols` columns (column and row centres), base64.
  const sample = (data, w, rowPx, n) => {
    const out = new Uint8Array(cols * n);
    for (let r = 0; r < n; r++) {
      const y = Math.floor((r + 0.5) * rowPx);
      for (let c = 0; c < cols; c++) {
        const i = (y * w + Math.floor((c + 0.5) * w / cols)) * 4;
        out[r * cols + c] = (data[i] * 77 + data[i + 1] * 150 + data[i + 2] * 29) >> 8;
      }
    }
    let s = '';
    for (let i = 0; i < out.length; i++) s += String.fromCharCode(out[i]);
    return btoa(s);
  };
  // Only the 9-argument form is a tile going onto the stitching canvas; the
  // worker's other draws (its small matching grids, the final crop) use
  // shorter forms.
  proto.drawImage = function (...a) {
    if (a.length === 9) {
      const rec = { sy: a[2], sh: a[4], dx: a[5], dy: a[6], dw: a[7], dh: a[8] };
      // The seam evidence: just above where this tile starts painting, the
      // rows already on the canvas (the tile above's) and the same page
      // rows as this tile shot them, plus this tile's first rows below.
      // When the two agree, a break at the seam is in the page itself.
      try {
        const bmp = a[0];
        const src = bmp.width / cssWidth;        // source px per CSS px
        const out = this.canvas.width / cssWidth; // canvas px per CSS px
        const n = Math.min(above, Math.floor(a[2] / src), Math.floor(a[6] / out));
        if (n >= 4 && a[2] + below * src <= bmp.height) {
          const prev = this.getImageData(0, a[6] - n * out, this.canvas.width, n * out).data;
          const tmp = new OffscreenCanvas(bmp.width, Math.round((n + below) * src));
          draw.call(tmp.getContext('2d'), bmp, 0, a[2] - n * src, bmp.width, (n + below) * src, 0, 0, bmp.width, (n + below) * src);
          const own = tmp.getContext('2d').getImageData(0, 0, tmp.width, tmp.height).data;
          rec.ov = { n, below, prev: sample(prev, this.canvas.width, out, n), own: sample(own, bmp.width, src, n + below) };
        }
      } catch (e) { rec.ovError = String(e.message || e); }
      h.draws.push(rec);
      h.canvas = { width: this.canvas.width, height: this.canvas.height };
    }
    return draw.apply(this, a);
  };
  const send = chrome.tabs.sendMessage.bind(chrome.tabs);
  chrome.tabs.sendMessage = (tabId, msg, ...rest) => {
    const cb = rest.find((r) => typeof r === 'function');
    if (!cb) return send(tabId, msg, ...rest);
    const t0 = Date.now();
    return send(tabId, msg, ...rest.filter((r) => r !== cb), (resp) => {
      if (msg && msg.cmd !== 'finish') h.messages.push({ cmd: msg.cmd, y: msg.y, resp, ms: Date.now() - t0 });
      cb(resp);
    });
  };
}

// Page-side facts gathered before the capture. `scrollable` is the page's
// real scrollable height: the document's, or an inner scroller's when the
// document itself is locked to the window (instant.ai).
function pageFacts() {
  const doc = document.scrollingElement || document.documentElement;
  let inner = 0;
  for (const el of document.querySelectorAll('body *')) {
    const cs = getComputedStyle(el);
    if (!/(auto|scroll)/.test(cs.overflowY)) continue;
    if (el.clientWidth < innerWidth * 0.5 || el.scrollHeight <= el.clientHeight + 50) continue;
    const top = el.getBoundingClientRect().top + scrollY;
    inner = Math.max(inner, top + el.scrollHeight);
  }
  return {
    url: location.href,
    title: document.title,
    innerWidth, innerHeight, dpr: devicePixelRatio,
    docHeight: doc.scrollHeight,
    innerScrollerHeight: inner,
    scrollable: Math.max(doc.scrollHeight, inner)
  };
}

// What the page is, read before the capture, to tell a bot wall or an error
// page from the site: the title, how much text and media it has, and the
// marks the common challenge and firewall pages carry.
function gateFacts() {
  const q = (s) => { try { return !!document.querySelector(s); } catch { return false; } };
  const text = (document.body && document.body.innerText || '').replace(/\s+/g, ' ').trim();
  const markers = [];
  const title = document.title || '';
  if (/^just a moment|attention required|access denied|verify(ing)? (that )?you are (a )?human|security check|are you a robot|pardon our interruption|request (blocked|rejected)|^40[13] forbidden|^error \d{3}|bot verification|ddos protection/i.test(title)) markers.push(`title "${title.slice(0, 60)}"`);
  if (window._cf_chl_opt || q('#challenge-form') || q('#challenge-stage') || q('#cf-challenge-running')) markers.push('cloudflare challenge');
  if (q('#cf-wrapper') && q('.cf-error-details, #cf-error-details')) markers.push('cloudflare error page');
  if (q('#px-captcha')) markers.push('perimeterx captcha');
  if (q('iframe[src*="captcha-delivery.com"]')) markers.push('datadome captcha');
  if (q('iframe[src*="_Incapsula_Resource"]')) markers.push('incapsula');
  if (/sucuri website firewall|access denied - sucuri/i.test(text.slice(0, 2000))) markers.push('sucuri firewall');
  if (/^access denied.{0,200}reference #/i.test(text.slice(0, 400))) markers.push('akamai access denied');
  // Chromium's own error page, shown when the server refused the page.
  if (text.length < 500 && /HTTP ERROR \d{3}/.test(text)) markers.push(`browser error page (${text.match(/HTTP ERROR \d{3}/)[0]})`);
  let media = 0;
  for (const el of document.querySelectorAll('img, video, picture, canvas, svg, iframe')) {
    const r = el.getBoundingClientRect();
    if (r.width >= 200 && r.height >= 120) media++;
  }
  // What is fixed to the window now, before the extension touches the page
  // (popups and bars it hides may never come back).
  const fixed = [];
  for (const el of document.querySelectorAll('body *')) {
    const cs = getComputedStyle(el);
    if (cs.position !== 'fixed' && cs.position !== 'sticky') continue;
    const r = el.getBoundingClientRect();
    const top = cs.position === 'sticky' ? parseFloat(cs.top) : r.top;
    if (r.width >= 16 && r.height >= 16 && cs.visibility !== 'hidden' && cs.display !== 'none' && +cs.opacity > 0.1 && Number.isFinite(top)) {
      fixed.push({ pos: cs.position, box: [Math.round(r.left), Math.round(top), Math.round(r.width), Math.round(r.height)] });
    }
    if (fixed.length >= 200) break;
  }
  return {
    fixed,
    title, textLength: text.length, text: text.slice(0, 300), markers, media,
    links: document.links.length,
    height: (document.scrollingElement || document.documentElement).scrollHeight,
    webdriver: navigator.webdriver === true
  };
}

// What the page says is on it, read after the capture, in page CSS px:
// the text lines a visitor would see, images, embeds, and what is fixed to
// the window. Detectors compare it with what the capture shows at the same
// place. Only content in the normal flow counts: anything inside a
// fixed/sticky box, clipped by an overflow box, transparent, hidden or
// outside the page width is left out.
function domFacts([maxLines]) {
  const W = document.documentElement.clientWidth;
  const sy = scrollY, sx = scrollX;
  const memo = new Map();
  // Per element: null if a visitor can't see it, else its clip rect (page px).
  const vis = (el) => {
    if (!el || el.nodeType !== 1) return { clip: [-1e9, -1e9, 1e9, 1e9], op: 1 };
    if (memo.has(el)) return memo.get(el);
    let res = null;
    const up = vis(el.parentElement);
    if (up) {
      const cs = getComputedStyle(el);
      const op = up.op * (+cs.opacity || 0);
      if (cs.display !== 'none' && cs.visibility !== 'hidden' && cs.visibility !== 'collapse' && op >= 0.5 &&
          cs.position !== 'fixed' && cs.position !== 'sticky' && !(cs.contentVisibility === 'hidden') &&
          // A two-sided (flip) card: which face shows depends on 3D
          // transforms, so neither is counted.
          cs.backfaceVisibility !== 'hidden') {
        let clip = up.clip;
        if (cs.overflowX !== 'visible' || cs.overflowY !== 'visible' || (cs.clipPath && cs.clipPath !== 'none')) {
          const r = el.getBoundingClientRect();
          clip = [Math.max(clip[0], r.left + sx), Math.max(clip[1], r.top + sy), Math.min(clip[2], r.right + sx), Math.min(clip[3], r.bottom + sy)];
        }
        res = { clip, op, cs };
      }
    }
    memo.set(el, res);
    return res;
  };
  const inside = (r, v) => {
    const x0 = r.left + sx, y0 = r.top + sy, x1 = r.right + sx, y1 = r.bottom + sy;
    const c = v.clip;
    const iw = Math.min(x1, c[2], W) - Math.max(x0, c[0], 0), ih = Math.min(y1, c[3]) - Math.max(y0, c[1], 0);
    return iw > 0 && ih > 0 && iw * ih >= 0.9 * (x1 - x0) * (y1 - y0);
  };
  const luma = (c) => {
    const m = c && c.match(/rgba?\(([\d.]+),\s*([\d.]+),\s*([\d.]+)(?:,\s*([\d.]+))?/);
    if (!m) return null;
    if (m[4] != null && +m[4] < 0.5) return -1;
    return Math.round((+m[1] * 77 + +m[2] * 150 + +m[3] * 29) / 256);
  };
  const box = (r) => [Math.round(r.left + sx), Math.round(r.top + sy), Math.round(r.width), Math.round(r.height)];

  const lines = [];
  const walker = document.createTreeWalker(document.body || document.documentElement, NodeFilter.SHOW_TEXT);
  const range = document.createRange();
  let truncated = false;
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    const t = n.nodeValue.replace(/\s+/g, '');
    if (t.length < 2) continue;
    const el = n.parentElement;
    if (!el || /^(SCRIPT|STYLE|NOSCRIPT|TEMPLATE|OPTION|TEXTAREA|TITLE)$/.test(el.tagName)) continue;
    const v = vis(el);
    if (!v) continue;
    const cs = v.cs;
    const L = luma(cs.webkitTextFillColor && cs.webkitTextFillColor !== cs.color ? cs.webkitTextFillColor : cs.color);
    if (L === -1 || L == null) continue; // transparent text (gradient-clipped etc.)
    if (parseFloat(cs.fontSize) < 9) continue;
    range.selectNodeContents(n);
    for (const r of range.getClientRects()) {
      if (r.width < 24 || r.height < 8 || !inside(r, v)) continue;
      if (lines.length >= maxLines) { truncated = true; break; }
      lines.push([...box(r), L, Math.min(t.length, 999)]);
    }
  }

  const visBox = (el, minW, minH) => {
    const v = vis(el);
    if (!v) return null;
    const r = el.getBoundingClientRect();
    if (r.width < minW || r.height < minH || !inside(r, v)) return null;
    return box(r);
  };
  const images = [];
  for (const img of document.images) {
    const b = visBox(img, 48, 48);
    if (!b) continue;
    const ds = img.getAttribute('data-src') || img.getAttribute('data-lazy-src') || img.getAttribute('data-srcset') || img.getAttribute('data-lazy-srcset');
    const src = img.currentSrc || img.src || '';
    images.push({
      box: b, complete: img.complete, nw: img.naturalWidth, nh: img.naturalHeight,
      // A lazy-load placeholder still in place: the real source is in a
      // data attribute and what loaded is nothing, a data: URI or a tiny gif.
      lazyPending: !!ds && (!src || src.startsWith('data:') || img.naturalWidth <= 2),
      src: src.slice(0, 120)
    });
  }
  const embeds = [];
  for (const el of document.querySelectorAll('iframe, video, embed, object, canvas')) {
    const b = visBox(el, 120, 80);
    if (!b) continue;
    embeds.push({ tag: el.tagName.toLowerCase(), box: b, src: (el.currentSrc || el.src || el.data || '').slice(0, 120), ready: el.tagName === 'VIDEO' ? el.readyState : null, poster: el.tagName === 'VIDEO' ? !!el.poster : null });
  }
  // What stays put in the window as the page scrolls: fixed and sticky
  // boxes (viewport px) and backgrounds attached to the window (page px).
  const fixed = [], bgFixed = [];
  for (const el of document.querySelectorAll('body *')) {
    const cs = getComputedStyle(el);
    if (cs.position === 'fixed' || cs.position === 'sticky') {
      const r = el.getBoundingClientRect();
      // A sticky box sits at its `top` once stuck, wherever it is now.
      const top = cs.position === 'sticky' ? parseFloat(cs.top) : r.top;
      if (r.width >= 16 && r.height >= 16 && cs.visibility !== 'hidden' && cs.display !== 'none' && +cs.opacity > 0.1 && Number.isFinite(top)) {
        fixed.push({ pos: cs.position, box: [Math.round(r.left), Math.round(top), Math.round(r.width), Math.round(r.height)] });
      }
    }
    if (/fixed/.test(cs.backgroundAttachment) && cs.backgroundImage !== 'none') {
      const r = el.getBoundingClientRect();
      if (r.width >= 100 && r.height >= 60) bgFixed.push({ box: box(r) });
    }
  }
  return { width: W, height: (document.scrollingElement || document.documentElement).scrollHeight, scrollY: sy, lines, truncated, images, embeds, fixed: fixed.slice(0, 200), bgFixed: bgFixed.slice(0, 100) };
}

export async function captureSite(extDir, site, { headless = true, timeoutMs = 240000, honest = true, captureBlocked = false } = {}) {
  const t0 = Date.now();
  const out = { host: site.host, url: site.url, ok: false, phases: {} };
  let ctx;
  try {
    ctx = await launch(extDir, { headless, honest });
    const { context, sw } = ctx;
    out.browserVersion = context.browser() ? context.browser().version() : null;
    // runCapture ends by opening result.html; close it as soon as it shows.
    context.on('page', (p) => {
      if (p.url().startsWith('chrome-extension://') || p.url() === 'about:blank') {
        p.waitForLoadState('domcontentloaded').then(() => {
          if (p.url().includes('result.html')) p.close().catch(() => {});
        }).catch(() => {});
      }
    });
    const page = context.pages()[0] || await context.newPage();
    await withTimeout((async () => {
      // One retry: a cold DNS/TLS hiccup shouldn't fail a site.
      let resp;
      try {
        resp = await page.goto(site.url, { waitUntil: site.waitUntil || 'load', timeout: 45000 });
      } catch (e) {
        out.navRetry = String(e.message || e).split('\n')[0];
        resp = await page.goto(site.url, { waitUntil: site.waitUntil || 'load', timeout: 45000 });
      }
      out.http = resp ? { status: resp.status(), url: resp.url() } : null;
      // Let late scripts, fonts and hero media settle the way a person would
      // before clicking the toolbar button.
      await page.waitForLoadState('networkidle', { timeout: 8000 }).catch(() => {});
      await sleep(site.settleMs ?? 3000);
    })(), 120000, 'navigation');
    out.phases.loaded = Date.now() - t0;
    out.gate = await page.evaluate(gateFacts).catch((e) => ({ error: String(e.message || e) }));
    // A challenge page may pass on its own once its script has run; give it
    // the time a person would, then look again. Nothing is clicked.
    if (gateVerdict(out).blocked) {
      await sleep(10000);
      await page.waitForLoadState('load', { timeout: 10000 }).catch(() => {});
      out.gate = await page.evaluate(gateFacts).catch((e) => ({ error: String(e.message || e) }));
      out.gate.waited = true;
    }
    out.blocked = gateVerdict(out);
    if (out.blocked.blocked && !captureBlocked) {
      out.shot = await page.screenshot({ type: 'png' }).catch(() => null);
      out.ok = true;
      return out;
    }
    out.factsBefore = await page.evaluate(pageFacts);
    const f = out.factsBefore;
    if (f.innerWidth !== VIEWPORT.width || f.innerHeight !== VIEWPORT.height || f.dpr !== DPR) {
      throw new Error(`harness: viewport is ${f.innerWidth}x${f.innerHeight}@${f.dpr}, expected ${VIEWPORT.width}x${VIEWPORT.height}@${DPR}`);
    }

    await page.bringToFront();
    await sw.evaluate(instrumentWorker, [VIEWPORT.width, OV_COLS, OV_ABOVE, OV_BELOW]);
    const pageUrl = page.url();
    const res = await withTimeout(sw.evaluate(async (url) => {
      const tabs = await chrome.tabs.query({});
      const tab = tabs.find((t) => t.url === url) || tabs.find((t) => /^https?:/.test(t.url || ''));
      if (!tab) return { error: 'harness: tab not found' };
      const r = await self.__runCapture(tab);
      self.__harness.dataUrl = r.dataUrl || null;
      return {
        error: r.error, filename: r.filename, tileCount: r.tileCount,
        warnings: r.warnings || null, placements: r.placements || null,
        size: r.dataUrl ? r.dataUrl.length : 0,
        draws: self.__harness.draws, messages: self.__harness.messages, canvas: self.__harness.canvas
      };
    }, pageUrl), timeoutMs, 'capture');
    out.phases.captured = Date.now() - t0;
    if (res.error) throw new Error(`extension: ${res.error}`);

    // Pull the data URL out in chunks; one 40 MB string over CDP is fragile.
    const CHUNK = 8 << 20;
    const parts = [];
    for (let i = 0; i < res.size; i += CHUNK) {
      parts.push(await sw.evaluate(([a, b]) => self.__harness.dataUrl.slice(a, b), [i, i + CHUNK]));
    }
    const dataUrl = parts.join('');
    out.png = Buffer.from(dataUrl.slice(dataUrl.indexOf(',') + 1), 'base64');
    out.tileCount = res.tileCount;
    // What the extension reported about its own capture (null on commits
    // from before it did).
    out.warnings = res.warnings;
    out.placements = res.placements;
    out.canvas = res.canvas;
    out.draws = res.draws;
    const prep = res.messages.find((m) => m.cmd === 'prepare');
    out.prepare = prep && prep.resp;
    const wake = res.messages.find((m) => m.cmd === 'wake');
    out.wake = wake ? wake.resp : null;
    // Time spent in the page: waking it, preparing it, and every tile
    // (which leaves out the worker's capture throttle and stitching).
    const sum = (cmd) => res.messages.filter((m) => m.cmd === cmd).reduce((s, m) => s + (m.ms || 0), 0);
    out.pageTime = { wake: sum('wake'), prepare: sum('prepare'), tiles: sum('tile') };
    out.tiles = res.messages.filter((m) => m.cmd === 'tile').map((m) => ({ requestedY: m.y, ...m.resp }));

    // Facts after the capture: the extension has restored the page, and lazy
    // content below the fold has loaded during its pre-scroll, so element
    // positions here match the capture's layout better than the ones before.
    out.factsAfter = await page.evaluate(pageFacts).catch(() => null);
    // The first screen as a visitor sees it now, floating extras and all,
    // for checks that ask whether something on it reached the capture.
    out.shot = await page.screenshot({ type: 'png' }).catch(() => null);
    out.dom = await withTimeout(page.evaluate(domFacts, [6000]), 30000, 'dom facts').catch((e) => ({ error: String(e.message || e) }));
    if (site.collect) {
      out.siteFacts = await withTimeout(page.evaluate(site.collect), 30000, 'site facts').catch((e) => ({ error: String(e.message || e) }));
    }
    out.ok = true;
  } catch (e) {
    out.error = String(e && e.message || e).split('\n')[0];
  } finally {
    out.durationMs = Date.now() - t0;
    if (ctx) {
      await withTimeout(ctx.context.close(), 15000, 'close').catch(() => {});
      fs.rm(ctx.userDataDir, { recursive: true, force: true }, () => {});
    }
  }
  return out;
}
