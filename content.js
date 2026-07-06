// Injected on demand by background.js for each capture.
// Handles all page-side work: freezing animations, pre-scrolling to trigger
// lazy content, scrolling tile-by-tile, settling, and hiding fixed/sticky
// overlays after the first tile. Communicates via chrome.runtime messages.

(() => {
  // Guard against double-injection (executeScript may run more than once).
  if (window.__cleanShotInjected) return;
  window.__cleanShotInjected = true;

  const MAX_PAGE_HEIGHT = 60000; // CSS px — infinite-scroll safeguard
  // JS-driven scroll animations (framer-motion springs, GSAP) aren't sped up
  // by the CSS duration clamp, so give each tile enough time to settle.
  const SETTLE_GRACE_MS = 550;

  const scroller = document.scrollingElement || document.documentElement;
  let originalScrollY = 0;
  let styleEl = null;
  let hiddenEls = [];           // [{el, prev}] for restore
  let stickyHeaders = new Set(); // sticky elements that behave like a top nav

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const raf = () => new Promise((r) => requestAnimationFrame(() => r()));

  function pageHeight() {
    const b = document.body;
    const e = document.documentElement;
    return Math.max(
      b.scrollHeight, e.scrollHeight,
      b.offsetHeight, e.offsetHeight,
      e.clientHeight
    );
  }

  // Inject CSS that neutralizes smooth scrolling and entrance animations so
  // each tile is captured in a stable end-state, and hides scrollbars.
  function injectStyle() {
    styleEl = document.createElement('style');
    styleEl.id = '__cleanShotStyle';
    styleEl.textContent = `
      html { scroll-behavior: auto !important; }
      *, *::before, *::after {
        animation-duration: 1ms !important;
        animation-delay: 0ms !important;
        transition-duration: 1ms !important;
        transition-delay: 0ms !important;
        scroll-behavior: auto !important;
      }
      ::-webkit-scrollbar { display: none !important; width: 0 !important; height: 0 !important; }
      html { scrollbar-width: none !important; }
    `;
    (document.head || document.documentElement).appendChild(styleEl);
  }

  // Wait for images currently intersecting the viewport to finish loading.
  async function waitForVisibleImages(timeoutMs = 1500) {
    const vh = window.innerHeight;
    const imgs = Array.from(document.images).filter((img) => {
      const r = img.getBoundingClientRect();
      return r.bottom > 0 && r.top < vh && r.width > 0;
    });
    const pending = imgs
      .filter((img) => !img.complete || img.naturalWidth === 0)
      .map((img) => new Promise((resolve) => {
        const done = () => resolve();
        img.addEventListener('load', done, { once: true });
        img.addEventListener('error', done, { once: true });
      }));
    if (!pending.length) return;
    await Promise.race([Promise.all(pending), sleep(timeoutMs)]);
  }

  // Scroll through the whole page (top→bottom) once to trigger
  // IntersectionObserver reveals and lazy-loading before real capture.
  async function preScroll() {
    const vh = window.innerHeight;
    const h = Math.min(pageHeight(), MAX_PAGE_HEIGHT);
    for (let y = 0; y < h; y += vh) {
      scroller.scrollTo(0, y);
      await sleep(60);
    }
    // one extra stop at the very bottom
    scroller.scrollTo(0, h);
    await sleep(120);
    scroller.scrollTo(0, 0);
    await sleep(200);
  }

  // At scroll position 0, identify sticky elements that behave like a top
  // navigation bar: anchored in the header zone and spanning most of the
  // page width. These repeat at every tile top and should be hidden after
  // tile 0. Pinned scroll-storytelling sections are also `sticky` but start
  // below the fold, so they fail this test and are left intact (hiding them
  // would punch blank voids into the capture).
  function findStickyHeaders() {
    const vw = document.documentElement.clientWidth;
    const HEADER_ZONE = 150; // px from top
    document.querySelectorAll('body *').forEach((el) => {
      if (getComputedStyle(el).position !== 'sticky') return;
      const r = el.getBoundingClientRect();
      if (r.top < HEADER_ZONE && r.width > vw * 0.5 && r.height > 0) {
        stickyHeaders.add(el);
      }
    });
  }

  // Hide overlays that would otherwise repeat in every tile: all `position:
  // fixed` elements (nav bars, chat widgets, cookie banners) plus the sticky
  // top-navs detected at scroll 0. Called after tile 0.
  function hideStickies() {
    const hide = (el) => {
      const cs = getComputedStyle(el);
      if (cs.visibility === 'hidden' || cs.display === 'none') return;
      hiddenEls.push({ el, prev: el.style.visibility });
      el.style.setProperty('visibility', 'hidden', 'important');
    };
    document.querySelectorAll('body *').forEach((el) => {
      if (getComputedStyle(el).position === 'fixed') hide(el);
    });
    stickyHeaders.forEach(hide);
  }

  function restore() {
    for (const { el, prev } of hiddenEls) {
      if (prev) el.style.setProperty('visibility', prev);
      else el.style.removeProperty('visibility');
    }
    hiddenEls = [];
    stickyHeaders = new Set();
    if (styleEl && styleEl.parentNode) styleEl.parentNode.removeChild(styleEl);
    styleEl = null;
    scroller.scrollTo(0, originalScrollY);
  }

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    (async () => {
      try {
        if (msg.cmd === 'prepare') {
          originalScrollY = scroller.scrollTop || window.scrollY || 0;
          injectStyle();
          await preScroll();
          findStickyHeaders(); // measured at scroll 0, after preScroll settles
          const rawH = pageHeight();
          const capped = Math.min(rawH, MAX_PAGE_HEIGHT);
          if (rawH > MAX_PAGE_HEIGHT) {
            console.warn(`[CleanShot] page height ${rawH}px exceeds cap; capturing first ${MAX_PAGE_HEIGHT}px.`);
          }
          sendResponse({
            ok: true,
            pageHeight: capped,
            viewportHeight: window.innerHeight,
            pageWidth: document.documentElement.clientWidth,
            dpr: window.devicePixelRatio || 1
          });
        } else if (msg.cmd === 'tile') {
          scroller.scrollTo(0, msg.y);
          await raf();
          await raf();
          await waitForVisibleImages();
          await sleep(SETTLE_GRACE_MS);
          if (msg.index === 0) hideStickies();
          // Report where we actually landed (bottom tile clamps short).
          const actualY = scroller.scrollTop || window.scrollY || 0;
          sendResponse({ ok: true, actualY });
        } else if (msg.cmd === 'finish') {
          restore();
          sendResponse({ ok: true });
        }
      } catch (err) {
        sendResponse({ ok: false, error: String(err && err.message || err) });
      }
    })();
    return true; // keep the message channel open for async sendResponse
  });
})();
