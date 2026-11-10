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

export const VIEWPORT = { width: 1388, height: 868 };
export const DPR = 2;
// Headless Chromium still reserves room for browser chrome inside
// --window-size; this is how much, measured with Chromium 1248. The inner
// size is checked after load and the site fails if it doesn't match.
const CHROME_HEIGHT = 87;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function withTimeout(promise, ms, what) {
  let t;
  return Promise.race([
    promise.finally(() => clearTimeout(t)),
    new Promise((_, rej) => { t = setTimeout(() => rej(new Error(`timeout after ${Math.round(ms / 1000)}s: ${what}`)), ms); })
  ]);
}

export async function launch(extDir, { headless = true } = {}) {
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'capture-profile-'));
  const context = await chromium.launchPersistentContext(userDataDir, {
    channel: 'chromium', // full Chromium (new headless); headless-shell can't load extensions
    headless,
    // No Playwright viewport emulation: emulated DPR only changes what the
    // page reports, while captureVisibleTab still returns 1x pixels. A real
    // window at a forced scale factor keeps both in agreement.
    viewport: null,
    args: [
      `--window-size=${VIEWPORT.width},${VIEWPORT.height + CHROME_HEIGHT}`,
      `--force-device-scale-factor=${DPR}`,
      `--disable-extensions-except=${extDir}`,
      `--load-extension=${extDir}`,
      '--hide-scrollbars',
      '--mute-audio'
    ]
  });
  let sw = context.serviceWorkers().find((w) => w.url().startsWith('chrome-extension://'));
  if (!sw) sw = await context.waitForEvent('serviceworker', { timeout: 15000 });
  return { context, sw, userDataDir };
}

function instrumentWorker() {
  if (self.__harness) return;
  const h = self.__harness = { draws: [], messages: [], canvas: null };
  const proto = OffscreenCanvasRenderingContext2D.prototype;
  const draw = proto.drawImage;
  // Only the 9-argument form is a tile going onto the stitching canvas; the
  // worker's other draws (its small matching grids, the final crop) use
  // shorter forms.
  proto.drawImage = function (...a) {
    if (a.length === 9) {
      h.draws.push({ sy: a[2], sh: a[4], dx: a[5], dy: a[6], dw: a[7], dh: a[8] });
      h.canvas = { width: this.canvas.width, height: this.canvas.height };
    }
    return draw.apply(this, a);
  };
  const send = chrome.tabs.sendMessage.bind(chrome.tabs);
  chrome.tabs.sendMessage = (tabId, msg, ...rest) => {
    const cb = rest.find((r) => typeof r === 'function');
    if (!cb) return send(tabId, msg, ...rest);
    return send(tabId, msg, ...rest.filter((r) => r !== cb), (resp) => {
      if (msg && msg.cmd !== 'finish') h.messages.push({ cmd: msg.cmd, y: msg.y, resp });
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

export async function captureSite(extDir, site, { headless = true, timeoutMs = 240000 } = {}) {
  const t0 = Date.now();
  const out = { host: site.host, url: site.url, ok: false, phases: {} };
  let ctx;
  try {
    ctx = await launch(extDir, { headless });
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
      try {
        await page.goto(site.url, { waitUntil: site.waitUntil || 'load', timeout: 45000 });
      } catch (e) {
        out.navRetry = String(e.message || e).split('\n')[0];
        await page.goto(site.url, { waitUntil: site.waitUntil || 'load', timeout: 45000 });
      }
      // Let late scripts, fonts and hero media settle the way a person would
      // before clicking the toolbar button.
      await page.waitForLoadState('networkidle', { timeout: 8000 }).catch(() => {});
      await sleep(site.settleMs ?? 3000);
    })(), 120000, 'navigation');
    out.phases.loaded = Date.now() - t0;
    out.factsBefore = await page.evaluate(pageFacts);
    const f = out.factsBefore;
    if (f.innerWidth !== VIEWPORT.width || f.innerHeight !== VIEWPORT.height || f.dpr !== DPR) {
      throw new Error(`harness: viewport is ${f.innerWidth}x${f.innerHeight}@${f.dpr}, expected ${VIEWPORT.width}x${VIEWPORT.height}@${DPR}`);
    }

    await page.bringToFront();
    await sw.evaluate(instrumentWorker);
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
    out.tiles = res.messages.filter((m) => m.cmd === 'tile').map((m) => ({ requestedY: m.y, ...m.resp }));

    // Facts after the capture: the extension has restored the page, and lazy
    // content below the fold has loaded during its pre-scroll, so element
    // positions here match the capture's layout better than the ones before.
    out.factsAfter = await page.evaluate(pageFacts).catch(() => null);
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
