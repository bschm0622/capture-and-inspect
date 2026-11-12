// Injected on demand by background.js for each capture.
// Handles all page-side work: freezing animations, pre-scrolling to trigger
// lazy content, scrolling tile-by-tile, settling, and hiding fixed/sticky
// overlays: floating extras (cookie banners, popups, chat bubbles) in every
// tile, the site's header after the first. Communicates via chrome.runtime
// messages.

(() => {
  // Guard against double-injection (executeScript may run more than once).
  if (window.__cleanShotInjected) return;
  window.__cleanShotInjected = true;

  const MAX_PAGE_HEIGHT = 100000; // CSS px — infinite-scroll safeguard (background.js may cap lower)
  // JS-driven scroll animations (framer-motion springs, GSAP) aren't sped up
  // by the CSS duration clamp, so give each tile enough time to settle.
  const SETTLE_GRACE_MS = 550;
  // Longest a pre-scroll stop waits for the images it brought on screen.
  const PRESCROLL_IMAGES_MS = 300;
  // Where a paused video is put (seconds; the middle of a shorter one).
  const VIDEO_FRAME_S = 2;
  // The times tried for a still frame, in order, and how long trying may take.
  const VIDEO_TIMES = [2, 1, 3, 4, 6, 8];
  const VIDEO_PICK_MS = 4000;

  const scroller = document.scrollingElement || document.documentElement;
  let originalScrollY = 0;
  let styleEl = null;
  let unwrapped = [];           // [{el, style}] for restore
  let hiddenEls = [];           // [{el, prev}] for restore
  let stickyHeaders = new Set(); // sticky elements that behave like a top nav
  let overlays = new Map();      // fixed or sticky element -> 'nav' | 'backdrop' | 'extra' | 'content'
  let frozenVideos = new Map();  // video -> {time, wasPlaying}
  let firstScreen = new Map();   // element -> HOLD values at scroll 0
  let pinned = new Set();        // elements with a HOLD property held through the stylesheet
  let scrollLinked = new Map();  // element -> [[scrollTop, HOLD values]] seen while pre-scrolling
  let stops = [];                // scroll positions the pre-scroll sampled placement at
  let clones = [];               // elements of the copies of pinned sections, one copy per stage
  let notes = [];                // what the capture couldn't show as it is, for the worker's warnings
  let liveIds = new WeakMap();   // canvas -> id, so the worker can follow one across tiles
  let liveCount = 0;
  let topOffsets = new Map();    // element on the first screen -> vertical offset before pre-scrolling
  let fades = new Map();         // element -> {min, max, last, near, linked} opacity seen while pre-scrolling
  let held = [];                 // [{el, max}] scroll-linked fades and the most visible opacity they reached
  let backdrops = new Map();     // full-screen fixed layer -> colors seen while pre-scrolling
  let pageColors = new Map();    // html and body -> background colors seen while pre-scrolling
  let pausedAnimations = [];     // looping CSS animations held still during capture
  let anchors = [];              // [{el, y}] page content seen in the last tile, and where it sat
  let covered = [];              // screen rects of overlays hidden during this tile
  let clockHeld = false;         // the worker has stopped the page's clock (background.js pageClock)
  let flowBoxes = new Map();     // element -> {top, left, width} in the page's flow, until first seen fixed (null after)
  let stickySeen = new WeakSet(); // sticky elements already sorted (settleOverlays, sortOverlays)

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const raf = () => new Promise((r) => requestAnimationFrame(() => r()));

  // The properties a script (or a CSS scroll-driven animation) uses to place
  // something by the scroll position: computed-style name, CSS name. Each
  // can be held at one value through the stylesheet, where an !important
  // rule beats both the script's inline writes and the animation.
  const HOLD = [
    ['transform', 'transform'],
    ['translate', 'translate'],
    ['clipPath', 'clip-path'],
    ['backgroundPosition', 'background-position'],
    ['objectPosition', 'object-position']
  ];
  const holdValues = (cs) => HOLD.map(([p]) => cs[p]);

  function hold(el, k, value) {
    const css = HOLD[k][1];
    const tokens = new Set((el.getAttribute('data-cleanshot-hold') || '').split(' ').filter(Boolean));
    tokens.add(css);
    el.style.setProperty(`--cleanshot-${css}`, value);
    el.setAttribute('data-cleanshot-hold', [...tokens].join(' '));
    pinned.add(el);
  }
  const holds = (el, k) => (el.getAttribute('data-cleanshot-hold') || '').split(' ').includes(HOLD[k][1]);

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
      ${HOLD.map(([, css]) => `[data-cleanshot-hold~="${css}"] { ${css}: var(--cleanshot-${css}) !important; }`).join('\n      ')}
      [data-cleanshot-unstick] { position: relative !important; inset: auto !important; }
      [data-cleanshot-keep] { height: var(--cleanshot-height) !important; min-height: 0 !important; max-height: none !important; }
      [data-cleanshot-fade] { opacity: var(--cleanshot-op) !important; }
      [data-cleanshot-fade-tf] { transform: var(--cleanshot-tf) !important; translate: var(--cleanshot-tr) !important; }
      [data-cleanshot-hide] { visibility: hidden !important; opacity: 0 !important; }
      [data-cleanshot-inflow] { position: absolute !important; top: var(--cleanshot-top) !important; left: var(--cleanshot-left) !important; right: auto !important; bottom: auto !important; width: var(--cleanshot-width) !important; margin: 0 !important; }
      [data-cleanshot-probe] { transition: none !important; }
      [data-cleanshot-parallax] { position: absolute !important; transform: none !important; }
      [data-cleanshot-parallax] > * { transform: none !important; }
      [data-cleanshot-unpin] { position: relative !important; inset: 0 auto auto 0 !important; transform: none !important; }
      [data-cleanshot-spacer] { padding-top: 0 !important; padding-bottom: var(--cleanshot-pad) !important; }
      ::-webkit-scrollbar { display: none !important; width: 0 !important; height: 0 !important; }
      html { scrollbar-width: none !important; }
    `;
    (document.head || document.documentElement).appendChild(styleEl);
  }

  // The injected style squeezes every CSS animation into 1ms so entrance
  // effects land on their end state. A looping one, like the review marquee
  // on Texas Professional Roofing, would then race through a whole loop
  // every millisecond and sit somewhere random in each tile, often scrolled
  // clean out of view. Pause those where the visitor sees them now, and keep
  // their real timing so the 1ms rule doesn't move them.
  function pauseLoopingAnimations() {
    document.getAnimations().forEach((anim) => {
      const target = anim.effect && anim.effect.target;
      if (!target || !(anim instanceof CSSAnimation) || anim.playState !== 'running') return;
      if (anim.effect.getComputedTiming().iterations !== Infinity) return;
      const cs = getComputedStyle(target);
      unwrapped.push({ el: target, style: target.getAttribute('style') });
      target.style.setProperty('animation-duration', cs.animationDuration, 'important');
      target.style.setProperty('animation-delay', cs.animationDelay, 'important');
      anim.pause();
      pausedAnimations.push(anim);
    });
  }

  // Once the page's clock is held (after prepare, and again before each
  // tile, for ones started since), pause everything the browser animates on
  // its own clock: looping CSS animations started after the one above (a
  // marquee set going when its section scrolled into view) and script
  // animations (element.animate) that loop or have seconds left to run, like
  // a slow zoom. Those started since the injected style squeezed every
  // animation to 1ms would race through a loop each millisecond, so they're
  // put at their start. Entrance animations with little left are left to
  // finish.
  function pauseClockAnimations() {
    document.getAnimations().forEach((anim) => {
      if (anim.playState !== 'running' || pausedAnimations.includes(anim) || anim instanceof CSSTransition) return;
      const t = anim.effect && anim.effect.getComputedTiming();
      if (!t) return;
      const endless = t.iterations === Infinity;
      if (anim instanceof CSSAnimation) {
        if (!endless) return;
        anim.pause();
        if (t.duration <= 1) anim.currentTime = 0;
      } else {
        if (!endless && !(t.endTime - (t.localTime || 0) > 2000)) return;
        anim.pause();
      }
      pausedAnimations.push(anim);
    });
  }

  // A video player from another site can't be reached into, but the two
  // that carry most background videos take commands from the page they're
  // embedded in: Vimeo always, YouTube when embedded with its API on.
  // Paused once the clock is held; at the end, the ones embedded to play
  // on their own (autoplay, Vimeo's background mode) are started again. If
  // a player ignores the command, its frame is still shot whole where it
  // fits on a screen (liveRegions).
  let players = [];
  const PLAYERS = [
    [/^https:\/\/player\.vimeo\.com\//, { method: 'pause' }, { method: 'play' }],
    [/^https:\/\/www\.youtube(-nocookie)?\.com\/embed\//, JSON.stringify({ event: 'command', func: 'pauseVideo', args: [] }), JSON.stringify({ event: 'command', func: 'playVideo', args: [] })]
  ];
  function pausePlayers() {
    document.querySelectorAll('iframe').forEach((f) => {
      if (players.some((p) => p.f === f)) return;
      const src = f.src || '';
      const kind = PLAYERS.find(([re]) => re.test(src));
      if (!kind) return;
      try {
        f.contentWindow.postMessage(kind[1], '*');
        players.push({ f, play: kind[2], resume: /[?&](autoplay|background)=1/.test(src) });
      } catch (_) {}
    });
  }

  // Canvases and paused videos on screen are copied into stills that stand
  // in for them for the rest of the capture, so every tile shows the same
  // frame (background.js pageClock, in the page's own world, where a WebGL
  // canvas can be read right after the page draws it). Answered with an
  // event; bounded, in case the page's world never answers.
  function requestStills() {
    return new Promise((resolve) => {
      let t = null;
      const done = (e) => {
        clearTimeout(t);
        document.removeEventListener('cleanshot-stills-done', done);
        let r = null;
        try { r = JSON.parse(e.detail); } catch (_) {}
        resolve(r);
      };
      t = setTimeout(() => { document.removeEventListener('cleanshot-stills-done', done); resolve(null); }, 3000);
      document.addEventListener('cleanshot-stills-done', done);
      document.dispatchEvent(new CustomEvent('cleanshot-stills'));
    });
  }

  // Elements the page changes on its own clock: a slider whose timer was set
  // when the page loaded, before the capture could reach it, or a loop the
  // page drives with its own reference to the browser's frame timer. They
  // can't be held, so the worker shoots each one that fits on a screen
  // whole, like a canvas. Seen as changes to an element's class or inline
  // style while the capture wasn't scrolling (what a scroll sets off, lazy
  // loading and reveals, comes within a frame or two), and more than once,
  // half a second or more apart: a clock comes back, a reveal finishing
  // late doesn't (on clcroofing.com, counting single changes marked dozens
  // of finished reveals as moving and reshaped the tiles for nothing). The
  // capture's own style changes are told apart by what they write:
  // `!important` declarations and --cleanshot variables.
  let restless = new Set();
  let changedOnce = new WeakMap(); // element -> when it first changed on its own
  let lastScrollAt = 0;
  let restlessWatch = null;
  const QUIET_MS = 200;
  const AGAIN_MS = 500;
  const pageStyle = (s) => (s || '').split(';').map((d) => d.trim())
    .filter((d) => d && !/!\s*important$/i.test(d) && !d.startsWith('--cleanshot')).join(';');
  function watchRestless() {
    if (restlessWatch) return;
    if (!lastScrollAt) addEventListener('scroll', () => { lastScrollAt = performance.now(); }, { capture: true, passive: true });
    lastScrollAt = performance.now();
    restlessWatch = new MutationObserver((list) => {
      if (performance.now() - lastScrollAt < QUIET_MS) return;
      // A change the capture put back at once (background.js pageClock) is
      // no change: the first record of each attribute holds its value from
      // before the batch.
      const before = new Map();
      for (const m of list) {
        const k = m.target;
        if (!before.has(k)) before.set(k, new Map());
        if (!before.get(k).has(m.attributeName)) before.get(k).set(m.attributeName, m.oldValue);
      }
      for (const m of list) {
        const el = m.target;
        if (el.nodeType !== 1 || el === document.body || el === document.documentElement || restless.has(el)) continue;
        if (before.get(el).get(m.attributeName) === el.getAttribute(m.attributeName)) continue;
        if (m.attributeName === 'style' && pageStyle(m.oldValue) === pageStyle(el.getAttribute('style'))) continue;
        const first = changedOnce.get(el);
        if (first == null) changedOnce.set(el, performance.now());
        else if (performance.now() - first >= AGAIN_MS) restless.add(el);
      }
    });
    restlessWatch.observe(document.documentElement, { subtree: true, attributes: true, attributeOldValue: true, attributeFilter: ['class', 'style', 'hidden'] });
  }
  const scrollPage = (y) => {
    lastScrollAt = performance.now();
    scroller.scrollTo(0, y);
  };

  // Images whose request failed (www.shiftelectricco.com: a 1500px tall one
  // came back 0x0 in 2 of 6 loads, a blank band in the capture). Each is
  // asked for once more as it is, then once with a cache-busting query
  // (a failed answer can be cached); one that still fails is reported.
  let retried = new WeakSet();
  let failedImages = new Set();
  const imageUrl = (img) => {
    const u = img.currentSrc || img.src || '';
    return /^(https?|file):/i.test(u) ? u : null;
  };
  const fetchImage = (url) => new Promise((resolve) => {
    const probe = new Image();
    probe.onload = () => resolve(probe.naturalWidth > 0);
    probe.onerror = () => resolve(false);
    setTimeout(() => resolve(false), 4000);
    probe.src = url;
  });
  async function retryImage(img) {
    const url = imageUrl(img);
    const settled = () => new Promise((resolve) => {
      if (img.complete && img.naturalWidth > 0) return resolve();
      img.addEventListener('load', resolve, { once: true });
      img.addEventListener('error', resolve, { once: true });
      setTimeout(resolve, 3000);
    });
    let use = (await fetchImage(url)) ? url : null;
    if (!use) {
      const busted = `${url}${url.includes('?') ? '&' : '?'}cleanshot-retry=${Date.now()}`;
      if (await fetchImage(busted)) use = busted;
    }
    if (use === url) {
      // Setting a source attribute again, even to the same value, makes the
      // image load again; the answer is in the cache now.
      if (img.hasAttribute('srcset')) img.setAttribute('srcset', img.getAttribute('srcset'));
      if (img.hasAttribute('src')) img.setAttribute('src', img.getAttribute('src'));
      const pic = img.parentElement && img.parentElement.tagName === 'PICTURE' ? img.parentElement : null;
      if (pic) pic.querySelectorAll('source[srcset]').forEach((s) => s.setAttribute('srcset', s.getAttribute('srcset')));
    } else if (use) {
      // (Only the address that answered: a srcset would pick the failing one again.)
      const pic = img.parentElement && img.parentElement.tagName === 'PICTURE' ? img.parentElement : null;
      if (pic) pic.querySelectorAll('source').forEach((s) => s.removeAttribute('srcset'));
      img.removeAttribute('srcset');
      img.setAttribute('src', use);
    }
    if (use) await settled();
    if (!(img.complete && img.naturalWidth > 0)) failedImages.add(img);
  }

  // An image on screen still showing what a lazy loader put there to hold
  // its place. Loaders (Perfmatters, lazysizes, WP Rocket, LiteSpeed, a3)
  // keep the real source in a data attribute and swap it in when their
  // observer sees the image come into view; an image the loader never
  // looked at keeps its placeholder for good. A carousel's loop copies
  // are made that way, after the loader looked: paulbunyanplumbing.com's
  // third review, a copy, had no stars. So an image on screen that still
  // shows a placeholder (a data: URI, or nothing) and carries a source in
  // one of those attributes is given it, with its <picture> sources, as
  // its loader would. The browser's own lazy loading is told to load now.
  const LAZY_SRC = ['data-src', 'data-lazy-src', 'data-original', 'data-lazy'];
  const LAZY_SRCSET = ['data-srcset', 'data-lazy-srcset'];
  function wakeLazyImage(img) {
    if (img.loading === 'lazy') img.loading = 'eager';
    const cur = img.currentSrc || img.getAttribute('src') || '';
    if (cur && !cur.startsWith('data:') && img.naturalWidth > 0) return;
    const pick = (el, names) => names.map((n) => el.getAttribute(n)).find((v) => v && !v.startsWith('data:'));
    const src = pick(img, LAZY_SRC);
    const set = pick(img, LAZY_SRCSET);
    if (!src && !set) return;
    const pic = img.parentElement && img.parentElement.tagName === 'PICTURE' ? img.parentElement : null;
    if (pic) {
      pic.querySelectorAll('source').forEach((s) => {
        const ss = pick(s, LAZY_SRCSET);
        if (ss && s.getAttribute('srcset') !== ss) s.setAttribute('srcset', ss);
      });
    }
    if (set && img.getAttribute('srcset') !== set) img.setAttribute('srcset', set);
    if (src && img.getAttribute('src') !== src) img.setAttribute('src', src);
  }

  // Wait for images on screen to finish loading: <img> (whichever source a
  // <picture> or srcset picked) and CSS background images, which lazy
  // loaders such as WP Rocket's set only once a section scrolls into view.
  // An image that already failed is done; waiting on it would only cost
  // the timeout. A background is looked up through an Image with the same
  // URL, which is complete at once when the browser already has it.
  async function waitForVisibleImages(timeoutMs = 1500) {
    const vh = window.innerHeight;
    const vw = document.documentElement.clientWidth;
    // Across as well as down: a slider's off-screen slides sit beside the
    // screen, and their lazy images don't load until the slide comes in.
    const onScreen = (el) => {
      const r = el.getBoundingClientRect();
      return r.bottom > 0 && r.top < vh && r.right > 0 && r.left < vw && r.width > 0 && r.height > 0;
    };
    const loaded = (img) => new Promise((resolve) => {
      img.addEventListener('load', resolve, { once: true });
      img.addEventListener('error', resolve, { once: true });
    });
    Array.from(document.images).forEach((img) => { if (onScreen(img)) wakeLazyImage(img); });
    const pending = Array.from(document.images)
      .filter((img) => !img.complete && onScreen(img))
      .map(loaded);
    // An image whose request failed (a network hiccup) leaves its box
    // empty: asked for once more.
    for (const img of document.images) {
      if (img.complete && img.naturalWidth === 0 && !retried.has(img) && onScreen(img) && imageUrl(img)) {
        retried.add(img);
        pending.push(retryImage(img));
      }
    }
    const urls = new Set();
    allElements().forEach((el) => {
      const bg = getComputedStyle(el).backgroundImage;
      if (bg === 'none' || !bg.includes('url(') || !onScreen(el)) return;
      for (const m of bg.matchAll(/url\(["']?([^"')]+)["']?\)/g)) {
        if (!m[1].startsWith('data:')) urls.add(m[1]);
      }
    });
    for (const url of urls) {
      const probe = new Image();
      probe.src = url;
      if (!probe.complete) pending.push(loaded(probe));
    }
    if (!pending.length) return;
    await Promise.race([Promise.all(pending), sleep(timeoutMs)]);
  }

  // Script types the browser runs or that only hold data. A script of any
  // other type on a page is one a loader is holding back (WP Rocket's
  // text/rocketlazyloadscript, NitroPack, Perfmatters, LiteSpeed); the
  // loader swaps it for a runnable copy when it lets it go.
  const RUNNABLE = /^(|text\/javascript|application\/javascript|text\/ecmascript|application\/ecmascript|module|importmap|speculationrules|application\/(ld\+)?json)$/i;
  const heldScripts = () => Array.from(document.scripts).filter((s) => !RUNNABLE.test((s.type || '').trim())).length;

  // Where to point the wake-up mouse: over plain page content, so nothing
  // a script hovers there afterwards (some loaders tell the element under
  // the mouse that it entered once their scripts are in) opens a menu or
  // lights up a button in the capture.
  function restingPoint() {
    const vw = document.documentElement.clientWidth;
    const vh = window.innerHeight;
    const live = 'a, button, input, select, textarea, label, summary, iframe, video, [role="button"], [role="menuitem"], [role="tab"], [tabindex], [onmouseover], nav, header, [role="navigation"], [role="banner"]';
    const spots = [[0.5, 0.5], [0.5, 0.75], [0.25, 0.6], [0.75, 0.6], [0.5, 0.9], [0.1, 0.5]];
    for (const [fx, fy] of spots) {
      const x = Math.round(vw * fx), y = Math.round(vh * fy);
      const el = document.elementFromPoint(x, y);
      if (el && !el.closest(live) && !pinnedToScreen(el)) return { el, x, y };
    }
    return { el: document.body, x: Math.round(vw / 2), y: Math.round(vh / 2) };
  }

  // Many sites hold back scripts, and with them carousels, review widgets,
  // maps, entrance reveals and lazy backgrounds, until the visitor first
  // moves the mouse or touches the page: WP Rocket's "delay JavaScript",
  // NitroPack, Perfmatters, LiteSpeed, Trustindex. The capture only scrolls
  // by script, which none of them count, so without this the page is shot
  // half-built. None of them check that the input is real, so a mouse that
  // moves and comes to rest over plain content is enough: the events go
  // to the element under it and bubble up to the document and window,
  // where the loaders listen. A mousemove is what most wait for (WP Rocket
  // ignores the first one, so two); mouseover covers those that wait for it
  // instead. No clicks, keys, touches or wheel: those can open, close or
  // move things.
  //
  // Then wait for the page to finish reacting: held scripts running, the
  // scripts and stylesheets they add loading, new elements and page height
  // settling. Runs before the page-world steps in background.js, so the
  // carousels and scroll animations the woken scripts start are stopped
  // with the rest. A page with nothing to wake shows no change within a
  // moment and is left at once; a chatty one is cut off at the ceiling.
  async function wakePage() {
    const QUIET_MS = 400, NOTHING_MS = 300, CEILING_MS = 5000;
    const t0 = performance.now();
    if (document.readyState !== 'complete' && heldScripts() > 0) {
      // Loaders start the scripts they hold only after the page's load
      // (which some pages, still streaming something, never reach).
      await Promise.race([new Promise((r) => window.addEventListener('load', r, { once: true })), sleep(CEILING_MS)]);
    }
    let last = 0;
    const pending = new Set();
    const mark = () => { last = performance.now(); };
    const watch = (el) => {
      pending.add(el);
      const done = () => { if (pending.delete(el)) mark(); };
      el.addEventListener('load', done, { once: true });
      el.addEventListener('error', done, { once: true });
      setTimeout(done, CEILING_MS);
    };
    const mo = new MutationObserver((list) => {
      for (const m of list) {
        for (const n of m.addedNodes) {
          if (n.nodeType !== 1) continue;
          mark();
          if (n.matches('script[src], link[rel="stylesheet"]')) watch(n);
        }
      }
    });
    mo.observe(document, { childList: true, subtree: true });
    const { el, x, y } = restingPoint();
    const at = { bubbles: true, cancelable: true, view: window, clientX: x, clientY: y, screenX: x, screenY: y };
    const send = (Type, type) => { try { el.dispatchEvent(new Type(type, at)); } catch (_) {} };
    const sent = performance.now();
    let held = heldScripts();
    let h = pageHeight();
    send(PointerEvent, 'pointerover');
    send(MouseEvent, 'mouseover');
    send(PointerEvent, 'pointermove');
    send(MouseEvent, 'mousemove');
    await sleep(50);
    at.clientX = at.screenX = x + 3;
    send(PointerEvent, 'pointermove');
    send(MouseEvent, 'mousemove');
    const heldBefore = held;
    let woke = false;
    for (;;) {
      await sleep(50);
      const now = performance.now();
      const nh = pageHeight(), nheld = heldScripts();
      if (nh !== h || nheld !== held) { h = nh; held = nheld; mark(); }
      if (last) woke = true;
      if (now - sent >= CEILING_MS) break;
      if (!last && now - sent >= NOTHING_MS) break;
      if (last && now - last >= QUIET_MS && !pending.size) break;
    }
    mo.disconnect();
    return { woke, wakeMs: Math.round(performance.now() - t0), heldScripts: [heldBefore, held] };
  }

  // A playing video that spans two tiles shows a different frame in each,
  // which stitches into visible bands. Pause each video the first time it is
  // on screen with a frame ready, and on later tiles put it back on that same
  // frame if the page's own code started it again.
  // Players such as Wistia keep their video inside a shadow root
  // (honeycombair.com's testimonial), so look there too.
  async function freezeVideos(timeoutMs = 1500) {
    const vh = window.innerHeight;
    const visible = allElements().filter((v) => v instanceof HTMLVideoElement).filter((v) => {
      const r = v.getBoundingClientRect();
      return r.bottom > 0 && r.top < vh && r.width > 0;
    });
    // And in frames from the same site, which the page side can reach.
    document.querySelectorAll('iframe').forEach((f) => {
      const r = f.getBoundingClientRect();
      if (r.bottom <= 0 || r.top >= vh || r.width === 0) return;
      try {
        const d = f.contentDocument;
        if (d) visible.push(...d.querySelectorAll('video'));
      } catch (_) {}
    });
    const waits = [];
    // Frozen on the same frame every time, not wherever playback had got
    // to (www.element-outdoorliving.com's section video stopped on a bright
    // frame behind white text now and then): a fixed time early on, past a
    // fade-in, or the middle of a short one. (background.js pageClock shows
    // the poster instead, where the page gave one.)
    const seekTo = (v, t) => new Promise((resolve) => {
      if (Math.abs(v.currentTime - t) <= 0.01) return resolve();
      v.addEventListener('seeked', resolve, { once: true });
      setTimeout(resolve, timeoutMs);
      v.currentTime = t;
    });
    // And never a cross-fade between two clips (www.bayfrontdental.com's
    // hero froze mid-dissolve, a ghost of the next shot over the last): of
    // a few early times, the first where the picture hardly changes over
    // the next 0.3s; failing that, the stillest. A video from another site
    // without CORS can't be read back, and keeps the first time.
    const stillest = async (v, d) => {
      const times = VIDEO_TIMES.filter((t) => t < d - 0.4);
      if (times.length < 2) return null;
      const c = document.createElement('canvas');
      c.width = 64; c.height = 36;
      const x = c.getContext('2d', { willReadFrequently: true });
      const grab = async (t) => {
        await seekTo(v, t);
        x.drawImage(v, 0, 0, 64, 36);
        return x.getImageData(0, 0, 64, 36).data;
      };
      const t0 = performance.now();
      let best = null;
      try {
        for (const t of times) {
          if (performance.now() - t0 > VIDEO_PICK_MS) break;
          const a = await grab(t), b = await grab(t + 0.3);
          // (A frame of one colour, black before a fade-in, holds still
          // too, and shows nothing: www.hitt.com's hero came out black.)
          let m = 0, m2 = 0;
          for (let i = 0; i < a.length; i += 4) { const l = (a[i] * 77 + a[i + 1] * 150 + a[i + 2] * 29) >> 8; m += l; m2 += l * l; }
          const n = a.length / 4;
          if (Math.sqrt(Math.max(0, m2 / n - (m / n) ** 2)) < 12 || m / n < 16 || m / n > 240) continue;
          let s = 0;
          for (let i = 0; i < a.length; i += 4) s += Math.abs(a[i] - b[i]) + Math.abs(a[i + 1] - b[i + 1]) + Math.abs(a[i + 2] - b[i + 2]);
          const change = s / (a.length / 4) / 3;
          if (!best || change < best.change) best = { t, change };
          if (change < 3) break;
        }
      } catch (_) { return null; }
      return best && best.t;
    };
    const freeze = async (v) => {
      const d = v.duration;
      frozenVideos.set(v, { time: v.currentTime, wasPlaying: !v.paused });
      v.pause();
      if (!(Number.isFinite(d) && d > 0)) return;
      const time = (await stillest(v, d)) ?? Math.min(VIDEO_FRAME_S, d / 2);
      frozenVideos.get(v).time = time;
      return seekTo(v, time);
    };
    for (const v of visible) {
      const frozen = frozenVideos.get(v);
      if (!frozen) {
        if (v.readyState < 2) {
          waits.push(new Promise((resolve) => {
            v.addEventListener('loadeddata', resolve, { once: true });
            setTimeout(resolve, timeoutMs);
          }).then(() => {
            if (frozenVideos.has(v)) return;
            return freeze(v);
          }));
          continue;
        }
        waits.push(freeze(v));
      } else {
        v.pause();
        if (Math.abs(v.currentTime - frozen.time) > 0.01) {
          waits.push(new Promise((resolve) => {
            v.addEventListener('seeked', resolve, { once: true });
            setTimeout(resolve, timeoutMs);
            v.currentTime = frozen.time;
          }));
        }
      }
    }
    if (waits.length) await Promise.all(waits);
  }

  // JS parallax (UIkit, Rellax, hand-rolled scroll handlers) moves hero
  // images as the page scrolls, so a hero that spans two tiles shows up at
  // two offsets with a seam between. Remember how everything on the first
  // screen is placed at scroll 0 (transform, clip, background and image
  // position: see HOLD), and hold it there for later tiles.
  function recordFirstScreen() {
    const vh = window.innerHeight;
    allElements().forEach((el) => {
      const r = el.getBoundingClientRect();
      if (r.height > 0 && r.top < vh && r.bottom > 0) {
        firstScreen.set(el, holdValues(getComputedStyle(el)));
      }
    });
  }

  // The pre-scroll ends with a jump back to the top, and a busy page can
  // take a moment to move its parallax back (the Children's Museum hero sat
  // 315px down, where the bottom of the page leaves it, for a few frames).
  // Recorded then, that wrong offset would be held for every later tile.
  // So wait until whatever moved vertically during the pre-scroll is back
  // where it was before it, or has stopped moving.
  async function settleAtTop() {
    const offsetY = (el) => {
      const tf = getComputedStyle(el).transform;
      return tf === 'none' ? 0 : new DOMMatrix(tf).m42;
    };
    const moved = [...topOffsets].filter(([el]) => {
      const s = scrollLinked.get(el);
      if (!el.isConnected || !s) return false;
      const m = s.map(([, v]) => matrixOf(v[0]));
      return new Set(m.map((t) => Math.round(t.m42))).size > 1 && new Set(m.map((t) => Math.round(t.m41))).size <= 1;
    });
    topOffsets = new Map();
    if (!moved.length) return;
    let last = null;
    for (let t = 0; t < 1500; t += 50) {
      const now = moved.map(([el]) => offsetY(el));
      if (moved.every(([, y], k) => Math.abs(now[k] - y) <= 1)) return;
      // Still: as settled as it gets, even if not where it started.
      if (last && t >= 300 && now.every((y, k) => Math.abs(y - last[k]) <= 0.5)) return;
      last = now;
      await sleep(50);
    }
  }

  function pinFirstScreen() {
    for (const [el, values] of firstScreen) {
      const now = holdValues(getComputedStyle(el));
      values.forEach((v, k) => {
        if (now[k] !== v && !holds(el, k)) hold(el, k, v);
      });
    }
  }

  // JS parallax below the fold (Design Museum Danmark's TweenMax handler,
  // Rellax) slides images up and down as the page scrolls, so every tile
  // catches them at a different offset: cut off at the seams, or drifted
  // away from their text. Scripts and CSS scroll-driven animations place
  // things by the scroll in other ways too: a clip that opens, a background
  // or image position that pans, a scale. While pre-scrolling, note at each
  // stop how every element is placed (HOLD), so the ones that keep changing
  // with the scroll can be held at one value later.
  //
  // Opacity is noted the same way. Webflow interactions and similar scripts
  // fade content by scroll position (17A's impact figures light up one by
  // one as they near the top of the screen), so a tile that shows one low on
  // the screen catches it faded, and a heading cut by a tile edge comes out
  // half there. A change counts as scroll-linked when it happens while the
  // element is on or near the screen; a tab or slide that changes on a timer
  // while it is out of sight doesn't count.
  //
  // The page's own background colour (html, body) is noted too: some themes
  // recolour it to match the section in view (hitt.com goes black and back).
  function sampleScrollEffects(fadesOnly = false) {
    const vw = document.documentElement.clientWidth;
    const vh = window.innerHeight;
    const atTop = scroller.scrollTop === 0 && !topOffsets.size;
    for (const el of [document.documentElement, document.body]) {
      if (!el) continue;
      if (!pageColors.has(el)) pageColors.set(el, new Set());
      pageColors.get(el).add(getComputedStyle(el).backgroundColor);
    }
    const fixedNow = [];
    allElements().forEach((el) => {
      const cs = getComputedStyle(el);
      const r = el.getBoundingClientRect();
      if (cs.position === 'fixed') {
        if (r.width >= vw * 0.9 && r.height >= vh * 0.9) {
          if (!backdrops.has(el)) backdrops.set(el, new Set());
          backdrops.get(el).add(cs.backgroundColor);
        } else fixedNow.push(el);
        // Fixed from the first look on: never in the flow. Seen in it
        // before: that place is kept.
        const box = flowBoxes.get(el);
        if (!box) flowBoxes.set(el, null);
        else box.frozen = true;
      } else if (r.width > 0 && r.height > 0 && el instanceof HTMLElement &&
        (!flowBoxes.has(el) || (flowBoxes.get(el) && !flowBoxes.get(el).frozen))) {
        // Where it sits in the page's flow, for as long as it hasn't been
        // seen fixed (see placeInFlow).
        flowBoxes.set(el, { top: r.top + scroller.scrollTop, left: r.left, width: el.offsetWidth });
      }
      const near = r.height > 0 && r.bottom > -vh / 2 && r.top < vh * 1.5;
      const op = Number(cs.opacity);
      const f = fades.get(el);
      // An entrance usually moves as well as fades (AOS's fade-right slides
      // 100px in while it turns opaque), so where it sits at its most
      // visible is noted too: that is where it arrives.
      if (!f) {
        fades.set(el, { min: op, max: op, last: op, near, linked: false, tf: [cs.transform, cs.translate] });
      } else {
        if (Math.abs(op - f.last) > 0.01 && (near || f.near)) f.linked = true;
        f.min = Math.min(f.min, op);
        if (op > f.max + 0.01) f.tf = [cs.transform, cs.translate];
        f.max = Math.max(f.max, op);
        f.last = op;
        f.near = near;
      }
      // (A second look at the same scroll position says nothing about
      // what moves with the scroll.)
      if (fadesOnly) return;
      const tf = cs.transform;
      if (atTop && r.height > 0 && r.top < vh && r.bottom > 0) {
        topOffsets.set(el, matrixOf(tf).m42);
      }
      // Only elements placed by anything other than the defaults are worth
      // following (a background position counts only with a picture).
      const v = holdValues(cs);
      let seen = scrollLinked.get(el);
      if (!seen) {
        const plain = v[0] === 'none' && v[1] === 'none' && v[2] === 'none' && v[4] === '50% 50%' &&
          (cs.backgroundImage === 'none' || v[3] === '0% 0%');
        if (plain) return;
        // It was plain at the stops before this one.
        seen = stops.map((y) => [y, ['none', 'none', 'none', '0% 0%', '50% 50%']]);
        scrollLinked.set(el, seen);
      }
      seen.push([scroller.scrollTop, v, r.height > 0 && r.bottom > 0 && r.top < vh]);
    });
    // Whatever sat in something fixed to the screen at this stop changes
    // with the state of what floats over the page, not with the page: a
    // header that turns fixed on scroll swaps its wordmark for a compact
    // logo (www.guggenheim.org fades a "G" in over its wordmark). Held at
    // its most visible, that state would show in the first tile, where the
    // header is as it is at scroll 0. (Not a full-screen layer: a page
    // that scrolls its content through one has its fades in it.)
    for (const box of fixedNow) {
      for (const el of [box, ...box.querySelectorAll('*')]) {
        const f = fades.get(el);
        if (f) f.floats = true;
      }
    }
    if (!fadesOnly) stops.push(scroller.scrollTop);
  }

  const matrixOf = (tf) => new DOMMatrix(!tf || tf === 'none' ? undefined : tf);

  // The horizontal part of a `translate` value.
  const translateX = (v) => (v === 'none' ? '0px' : v.split(' ')[0]);

  // Two readings the same but for the last fraction of a pixel a smoothed
  // scroll handler is still easing through.
  const NUM = /-?\d*\.?\d+(?:e[-+]?\d+)?/gi;
  function steady(a, b) {
    if (a === b) return true;
    if (a.replace(NUM, '#') !== b.replace(NUM, '#')) return false;
    const na = a.match(NUM) || [], nb = b.match(NUM) || [];
    return na.every((x, i) => Math.abs(Number(x) - Number(nb[i])) <= 0.5);
  }

  // Where the layout puts an element, leaving out transforms.
  function layoutTop(el) {
    if (!(el instanceof HTMLElement)) return el.getBoundingClientRect().top + scroller.scrollTop;
    let top = 0;
    for (let a = el; a; a = a.offsetParent) top += a.offsetTop;
    return top;
  }

  // Hold each property that kept changing with the scroll (3 or more values
  // over the stops) at the value it has where a visitor looks at it: with
  // the element centred on screen, or, near the bottom of the page, as far
  // as the page scrolls. The stops can't say what that is: Design Museum
  // Danmark's parallax eases towards where the scroll puts it for a second
  // or more, so each stop caught it on the way, and a reveal that plays
  // once as it comes into view (Squarespace's clip on
  // boulderlanddesign.com's service images) was caught part-way. So go
  // there and read it once it holds still: an eased parallax has arrived, a
  // reveal has finished. Elements whose resting places are close share a
  // visit. Sideways movement is held only once the scroll is shown to drive
  // it (see below), since it is usually a carousel or marquee rather than
  // parallax. Elements on the first screen are
  // already held at scroll 0; the inside of an SVG (Lottie runs on a clock)
  // and anything that floats over the page are left alone.
  async function holdScrollLinked() {
    const vh = window.innerHeight;
    const maxScroll = Math.max(0, scroller.scrollHeight - vh);
    const todo = [], sidewaysTodo = [];
    for (const [el, samples] of scrollLinked) {
      if (firstScreen.has(el) || !el.isConnected || samples.length < 3) continue;
      if (el.closest('svg') || pinnedToScreen(el) || el.closest('[data-cleanshot-filmed]')) continue;
      const sideways = new Set(samples.map(([, v]) => Math.round(matrixOf(v[0]).m41))).size > 1;
      const sidewaysT = new Set(samples.map(([, v]) => translateX(v[1]))).size > 1;
      const values = (k) => new Set(samples.map(([, v]) => v[k])).size;
      const changing = (k) => values(k) >= 3;
      const props = HOLD.map((_, k) => k).filter((k) => changing(k) &&
        !(k === 0 && sideways) && !(k === 1 && sidewaysT));
      // Seen at only two values: a reveal that played once, or a scroll
      // effect the page updates a moment after each scroll, which the
      // pre-scroll's short stops caught late (r-o.com's footer scene of
      // parallax layers and a crane changed only at the last stop). One that
      // changed between two stops it was on screen at both times is put to
      // the test below with the sideways ones.
      const whileShown = (k) => samples.some(([, v, on], i) => i > 0 && on && samples[i - 1][2] && v[k] !== samples[i - 1][1][k]);
      const side = HOLD.map((_, k) => k).filter((k) => !props.includes(k) &&
        ((changing(k) && (k === 0 ? sideways : sidewaysT)) || (values(k) === 2 && whileShown(k))));
      if (!props.length && !side.length) continue;
      // (Its layout height too: its own transform can scale what's drawn.)
      const h = el instanceof HTMLElement ? el.offsetHeight : el.getBoundingClientRect().height;
      const rest = Math.min(maxScroll, Math.max(0, layoutTop(el) + h / 2 - vh / 2));
      if (props.length) todo.push({ el, props, rest });
      if (side.length) sidewaysTodo.push({ el, props: side, rest });
    }
    scrollLinked = new Map();
    const NEAR = 60, VISITS = 40, WAIT_MS = 2500;
    // Go to y and read the group's properties once they hold still.
    const settled = async (y, group) => {
      scroller.scrollTo(0, y);
      await raf();
      await raf();
      const read = () => group.map(({ el, props }) => {
        const v = holdValues(getComputedStyle(el));
        return props.map((k) => v[k]);
      });
      let last = read();
      for (let t = 0; t < WAIT_MS; t += 100) {
        await sleep(100);
        const now = read();
        const still = now.every((vals, g) => vals.every((v, j) => steady(v, last[g][j])));
        last = now;
        if (still && t >= 100) break;
      }
      return last;
    };
    const groups = (list) => {
      list.sort((a, b) => a.rest - b.rest);
      const out = [];
      for (let i = 0; i < list.length;) {
        const group = [];
        while (i < list.length && list[i].rest - list[group.length ? i - group.length : i].rest <= NEAR) group.push(list[i++]);
        out.push({ group, at: group[0].rest + (group[group.length - 1].rest - group[0].rest) / 2 });
      }
      return out;
    };
    const t0 = performance.now();
    let visits = 0;
    for (const { group, at } of groups(todo)) {
      if (visits++ >= VISITS || performance.now() - t0 >= 15000) break;
      const last = await settled(at, group);
      group.forEach(({ el, props }, g) => props.forEach((k, j) => hold(el, k, last[g][j])));
    }
    // Sideways movement is usually a carousel or a marquee, which runs on
    // the clock. But a scroll effect can slide sideways too
    // (www.pissetzkylaw.com's Divi column slides in 98px as the page
    // scrolls to it, and two tiles caught its photo at two offsets). Told
    // apart by asking the scroll: the same value at its resting place each
    // time it is visited, and another a third of a screen further, is the
    // scroll's doing; a clock's motion doesn't come back, and a reveal that
    // has played stays where it is. Held then.
    const T1 = performance.now();
    for (const { group, at } of groups(sidewaysTodo)) {
      if (visits >= VISITS || performance.now() - t0 >= 15000 || performance.now() - T1 >= 6000) break;
      visits += 3;
      const a = await settled(at, group);
      const b = await settled(at + (at + vh / 3 <= maxScroll ? vh / 3 : -vh / 3), group);
      const a2 = await settled(at, group);
      group.forEach(({ el, props }, g) => props.forEach((k, j) => {
        if (steady(a[g][j], a2[g][j]) && !steady(a[g][j], b[g][j])) hold(el, k, a2[g][j]);
      }));
    }
    if (!todo.length && !sidewaysTodo.length) return;
    // Back at the top, the first screen's own eased parallax takes a moment
    // to return to where it was recorded, which the first tile shows live.
    scroller.scrollTo(0, 0);
    const first = [...firstScreen].filter(([el]) => el.isConnected);
    const off = () => first.filter(([el, v]) => holdValues(getComputedStyle(el)).some((x, k) => !steady(x, v[k]))).length;
    for (let t = 0; t < 1500 && off(); t += 50) await sleep(50);
  }

  // Hold each scroll-linked fade at the most visible value it reached, which
  // is how a visitor sees it once it's comfortably in view. Only page
  // content: not anything that floats over the page, and not the inside of
  // an SVG (Lottie animates its layers' opacity on a clock). Layers stacked
  // in the same place (a crossfading slideshow, tab panels) only ever show
  // one at a time, so they're left to the page as well.
  function holdFades() {
    const list = [];
    for (const [el, f] of fades) {
      if (!f.linked || f.floats || f.max - f.min < 0.05 || !el.isConnected) continue;
      if (!(el instanceof HTMLElement) || el.closest('svg') || pinnedToScreen(el)) continue;
      list.push({ el, max: f.max, tf: f.tf, r: el.getBoundingClientRect() });
    }
    fades = new Map();
    const area = (r) => Math.max(0, r.width) * Math.max(0, r.height);
    const stacked = (a, b) => {
      if (a.el.contains(b.el) || b.el.contains(a.el)) return false;
      const w = Math.min(a.r.right, b.r.right) - Math.max(a.r.left, b.r.left);
      const h = Math.min(a.r.bottom, b.r.bottom) - Math.max(a.r.top, b.r.top);
      return w > 0 && h > 0 && w * h > 0.5 * Math.min(area(a.r), area(b.r));
    };
    held = list.filter((a) => !list.some((b) => b !== a && stacked(a, b)))
      .map(({ el, max, tf }) => ({ el, max, tf }));
  }

  // An entrance the pre-scroll missed, seen between tiles: something near
  // the screen that was fainter at an earlier tile and is more visible now
  // has been revealed by the capture's scroll (www.clunegc.com's AOS
  // `fade-up` button, which the pre-scroll's quick stops sometimes never
  // saw change). It is held as the fades above are, from the next shot on:
  // the tile above, shot again because the two disagree, would show it as
  // not yet revealed (the page plays it again once it is scrolled back
  // below its trigger line), and the seam between the shots cut it.
  // Not what the page changes on its own clock, what floats over the page
  // or the inside of an SVG, and not a layer stacked on another held one
  // or on one that faded out meanwhile (a slideshow's or a tab set's next
  // panel coming up over the last).
  //
  // An entrance can grow instead of fading in: a part scaled down that the
  // page scales up to its own size through a transform transition when it
  // is reached (www.folk.app's section marks, an SVG's dot and fill that a
  // class switches on while the section crosses the middle of the screen).
  // The tile with the section lower down showed the mark empty, the next
  // one filled, and the seam cut it in half. Held the same way, at its
  // full size, inside an SVG too: a transition the page's stylesheet asks
  // for is not Lottie's clock, which writes each frame itself.
  let tileOps = new WeakMap();   // element -> {op, sc} as last seen near the screen at a tile
  const scaleOf = (cs) => {
    const m = /^matrix(3d)?\(([^)]*)\)/.exec(cs.transform);
    if (!m) return 1;
    const [a, b] = m[2].split(',').map(Number);
    return Math.hypot(a, b);
  };
  function noteEntrances() {
    const vh = window.innerHeight;
    const heldEls = new Set(held.map((h) => h.el));
    const fresh = [], gone = [];
    allElements().forEach((el) => {
      if (heldEls.has(el)) return;
      const html = el instanceof HTMLElement;
      if (!html && !(el instanceof SVGElement)) return;
      // (One scaled to nothing has no box of its own: where it will show
      // is its parent's.)
      let r = el.getBoundingClientRect();
      if (!(r.height > 0 && r.width > 0) && el.parentElement && /^matrix/.test(getComputedStyle(el).transform)) r = el.parentElement.getBoundingClientRect();
      if (!(r.height > 0 && r.width > 0 && r.bottom > -vh / 2 && r.top < vh * 1.5)) return;
      const cs = getComputedStyle(el);
      const op = Number(cs.opacity);
      const sc = scaleOf(cs);
      const was = tileOps.get(el);
      tileOps.set(el, { op, sc });
      if (html && was && op < was.op - 0.05) gone.push({ el, r });
      if (!was || restless.has(el)) return;
      if (was.sc <= 0.9 && sc >= 0.95 && sc <= 1.05 && op >= was.op - 0.05 && /\btransform\b/.test(cs.transitionProperty)) {
        if (!pinned.has(el) && !pinnedToScreen(el)) fresh.push({ el, max: op, tf: [cs.transform, cs.translate], sc, r, grew: true });
        return;
      }
      if (!html || op < was.op + 0.05 || el.closest('svg') || pinnedToScreen(el)) return;
      fresh.push({ el, max: op, tf: [cs.transform, cs.translate], r });
    });
    if (!fresh.length) return;
    const boxes = held.filter((h) => h.el.isConnected).map((h) => ({ el: h.el, r: h.el.getBoundingClientRect() })).concat(fresh, gone);
    const area = (r) => Math.max(0, r.width) * Math.max(0, r.height);
    const stacked = (a, b) => {
      if (a.el.contains(b.el) || b.el.contains(a.el)) return false;
      const w = Math.min(a.r.right, b.r.right) - Math.max(a.r.left, b.r.left);
      const h = Math.min(a.r.bottom, b.r.bottom) - Math.max(a.r.top, b.r.top);
      return w > 0 && h > 0 && w * h > 0.5 * Math.min(area(a.r), area(b.r));
    };
    // (Parts that grow together, a dot over its fill, are one entrance, not
    // layers taking turns.)
    for (const a of fresh) {
      if (boxes.some((b) => b !== a && !(a.grew && b.grew) && stacked(a, b))) continue;
      held.push({ el: a.el, max: a.max, tf: a.tf, sc: a.sc });
    }
  }

  // Before each tile, let go of the holds and read where the page has each
  // fade now. One still below the most it has reached is held there; one at
  // or past it (a fade-in that has since finished, maybe beyond what the
  // pre-scroll caught mid-way) is left to the page, and raises the mark for
  // later tiles. Through the stylesheet, since the page's script keeps
  // writing inline opacity. Transitions are off while this happens: letting
  // go would otherwise start one, and the value read back would be where it
  // starts, the held one.
  // Its place is held with it: an entrance that moves as it fades
  // (newmanroofing.com's AOS `fade-right`, with `once: false`, starts again
  // whenever the element is below AOS's trigger line, the bottom 120px of
  // the screen) was otherwise held opaque at its starting place, 100px to
  // the side, and the tile below drew the rest of it where it belongs.
  function applyFades() {
    if (!held.length) return;
    held.forEach((h) => {
      h.el.setAttribute('data-cleanshot-probe', '');
      h.el.removeAttribute('data-cleanshot-fade');
      h.el.removeAttribute('data-cleanshot-fade-tf');
    });
    const css = held.map((h) => getComputedStyle(h.el));
    const now = css.map((cs) => Number(cs.opacity));
    held.forEach((h, k) => {
      // (One that grew in is held too where it is smaller again.)
      if (now[k] >= h.max - 0.01 && !(h.sc && scaleOf(css[k]) < h.sc - 0.05)) {
        h.max = Math.max(h.max, now[k]);
        h.tf = [css[k].transform, css[k].translate];
        return;
      }
      h.el.style.setProperty('--cleanshot-op', String(h.max));
      h.el.setAttribute('data-cleanshot-fade', '');
      if (h.tf && (h.tf[0] !== css[k].transform || h.tf[1] !== css[k].translate)) {
        h.el.style.setProperty('--cleanshot-tf', h.tf[0]);
        h.el.style.setProperty('--cleanshot-tr', h.tf[1]);
        h.el.setAttribute('data-cleanshot-fade-tf', '');
      }
    });
    held.forEach((h) => getComputedStyle(h.el).opacity);
    held.forEach((h) => h.el.removeAttribute('data-cleanshot-probe'));
  }

  // The blocks a page is stacked from, top to bottom: go down through
  // wrappers that hold most of the page, keeping what sits beside each one
  // (header, footer), and take the children of the last.
  function pageSections() {
    const vw = document.documentElement.clientWidth;
    const y = scroller.scrollTop;
    const H = pageHeight();
    const out = [];
    const wide = (el) => {
      const r = el.getBoundingClientRect();
      return r.height > 50 && r.width > vw * 0.5;
    };
    let box = document.body;
    for (let depth = 0; box && depth < 12; depth++) {
      const kids = Array.from(box.children).filter(wide);
      const big = kids.find((c) => c.getBoundingClientRect().height >= H * 0.6);
      if (!big) { out.push(...kids); break; }
      out.push(...kids.filter((c) => c !== big));
      box = big;
    }
    return out
      .map((el) => ({ el, top: el.getBoundingClientRect().top + y }))
      .sort((a, b) => a.top - b.top)
      .map((s) => s.el);
  }

  // Some pages (Design Museum Danmark) paint the whole screen with one fixed
  // layer and recolor it to match the section in view, switching the text
  // color with it. Hidden like any other fixed overlay, that leaves white
  // sections with white text. Visit each marked section once, note the
  // layer's color there and freeze the section's text colors, then turn the
  // layer into a page-tall backdrop striped with those colors.
  //
  // Others recolour the page itself, html or body (hitt.com turns black for
  // "The HITT Experience" and white again after it). A screen then has one
  // colour all over, so each tile paints the whole of its height in
  // whatever colour its scroll position chose, and the change lands at a
  // tile edge, cutting through a heading. The same visit-and-stripe fixes
  // it: each section gets the colour the page gives it while it's centered
  // on screen. Sections are the marked ones, or failing that the blocks the
  // page is built from.
  async function paintBackdrop() {
    const fixed = [...backdrops].find(([, colors]) => colors.size > 1)?.[0];
    const own = fixed ? null : [document.body, document.documentElement]
      .find((el) => el && pageColors.has(el) && pageColors.get(el).size > 1);
    const layer = fixed || own;
    backdrops = new Map();
    pageColors = new Map();
    if (!layer) return;
    const vw = document.documentElement.clientWidth;
    const vh = window.innerHeight;
    const marked = Array.from(document.querySelectorAll(
      '[data-bg], [data-bg-color], [data-background], [data-background-color], [data-color]'
    )).filter((el) => {
      const r = el.getBoundingClientRect();
      return r.width > vw * 0.5 && r.height < pageHeight() * 0.8;
    });
    let sections = marked.filter((el) => !marked.some((o) => o !== el && o.contains(el)));
    if (!sections.length && own) sections = pageSections();
    if (!sections.length) return;

    // The color may fade over a script tween, so read it once it holds still.
    const at = async (y) => {
      scroller.scrollTo(0, Math.max(0, y));
      let color = getComputedStyle(layer).backgroundColor;
      for (let i = 0; i < 20; i++) {
        await sleep(100);
        const next = getComputedStyle(layer).backgroundColor;
        if (next === color && i > 0) break;
        color = next;
      }
      return color;
    };
    const bands = [];
    for (const section of sections) {
      const r = section.getBoundingClientRect();
      const top = r.top + scroller.scrollTop;
      const color = await at(top + r.height / 2 - vh / 2);
      const els = [section, ...section.querySelectorAll('*')];
      const colors = els.map((el) => getComputedStyle(el).color);
      els.forEach((el, i) => {
        unwrapped.push({ el, style: el.getAttribute('style') });
        el.style.setProperty('color', colors[i], 'important');
      });
      bands.push({ top: bands.length ? Math.round(top) : 0, color });
    }
    scroller.scrollTo(0, 0);
    await sleep(150);

    const h = pageHeight();
    unwrapped.push({ el: layer, style: layer.getAttribute('style') });
    if (own) {
      // Body's background is painted across the whole page from the top of
      // html when html has none of its own, and from body's own box when it
      // does.
      const root = getComputedStyle(document.documentElement);
      const spread = layer === document.body && root.backgroundImage === 'none' &&
        /rgba\(.*,\s*0\)|transparent/.test(root.backgroundColor);
      const origin = spread ? 0 : Math.round(layer.getBoundingClientRect().top + scroller.scrollTop);
      const stops = bands.map((b, i) => `${b.color} ${Math.max(0, b.top - origin)}px ${(i + 1 < bands.length ? bands[i + 1].top : h) - origin}px`);
      layer.style.setProperty('background-color', bands[bands.length - 1].color, 'important');
      layer.style.setProperty('background-image', `linear-gradient(to bottom, ${stops.join(', ')})`, 'important');
      layer.style.setProperty('background-size', `100% ${h - origin}px`, 'important');
      layer.style.setProperty('background-repeat', 'no-repeat', 'important');
      layer.style.setProperty('background-position', '0 0', 'important');
      layer.style.setProperty('background-attachment', 'scroll', 'important');
      return;
    }
    const stops = bands.map((b, i) => `${b.color} ${b.top}px ${i + 1 < bands.length ? bands[i + 1].top : h}px`);
    layer.style.setProperty('position', 'absolute', 'important');
    layer.style.setProperty('inset', '0 0 auto 0', 'important');
    layer.style.setProperty('height', `${h}px`, 'important');
    layer.style.setProperty('transform', 'none', 'important');
    layer.style.setProperty('background-image', `linear-gradient(to bottom, ${stops.join(', ')})`, 'important');
  }

  // ScrollMagic pins (the Noguchi Museum's home slideshow) turn an element
  // `fixed` while the rest of the section scrolls past. Depending on the
  // window size it either repeats in every tile or gets hidden with the
  // overlays. ScrollMagic also slides it down the reserved space by padding
  // above it. Put it back at the top of that space and move all the padding
  // below, through the stylesheet so ScrollMagic's inline styles lose.
  function unpinScrollMagic() {
    document.querySelectorAll('.scrollmagic-pin-spacer').forEach((spacer) => {
      const cs = getComputedStyle(spacer);
      const pad = parseFloat(cs.paddingTop) + parseFloat(cs.paddingBottom);
      spacer.style.setProperty('--cleanshot-pad', `${pad}px`);
      spacer.setAttribute('data-cleanshot-spacer', '');
      if (spacer.firstElementChild) spacer.firstElementChild.setAttribute('data-cleanshot-unpin', '');
    });
  }

  // A full-screen `fixed` image behind the page (the Noguchi Museum's garden
  // photo) shows only through an empty stretch between two sections, like
  // a window. Hidden with the overlays, that stretch comes out blank. Move
  // the image into the widest such gap, centered, as it looks mid-scroll.
  // A layer that also shows through above the first section is a hero
  // backdrop, already caught by the first tile, so it stays put.
  function placeRevealedBackdrop() {
    const vw = document.documentElement.clientWidth;
    const vh = window.innerHeight;
    const y = scroller.scrollTop;
    const layer = allElements().find((el) => {
      const cs = getComputedStyle(el);
      if (cs.position !== 'fixed' || !(cs.zIndex === 'auto' || Number(cs.zIndex) <= 0)) return false;
      const r = el.getBoundingClientRect();
      return r.width >= vw * 0.9 && r.height >= vh * 0.9 && el.parentElement;
    });
    if (!layer) return;
    const boxes = Array.from(layer.parentElement.children)
      .filter((el) => el !== layer && !/^(fixed|absolute)$/.test(getComputedStyle(el).position))
      .map((el) => el.getBoundingClientRect())
      .filter((r) => r.height > 0)
      .map((r) => ({ top: r.top + y, bottom: r.bottom + y }))
      .sort((a, b) => a.top - b.top);
    const parentTop = layer.parentElement.getBoundingClientRect().top + y;
    if (!boxes.length || boxes[0].top - parentTop >= 100) return;
    let gap = null;
    for (let i = 1; i < boxes.length; i++) {
      const size = boxes[i].top - boxes[i - 1].bottom;
      if (size >= 100 && (!gap || size > gap.size)) gap = { size, top: boxes[i - 1].bottom };
    }
    if (!gap) return;
    unwrapped.push({ el: layer, style: layer.getAttribute('style') });
    layer.style.setProperty('position', 'absolute', 'important');
    layer.style.setProperty('inset', '0 auto auto 0', 'important');
    layer.style.setProperty('width', '100%', 'important');
    layer.style.setProperty('height', `${vh}px`, 'important');
    const placed = layer.getBoundingClientRect().top + y;
    layer.style.setProperty('top', `${gap.top + gap.size / 2 - vh / 2 - placed}px`, 'important');
  }

  // A full-screen backdrop behind the first screen (www.maggioroofing.com's
  // `ul.cb-slideshow`, a fixed crossfading slideshow) is shown in the first
  // tile and hidden after, so a section that shows it and runs on past the
  // first screen (that hero is 901px tall in an 868px window) shows the
  // page's background in its last rows. A visitor scrolling down sees the
  // backdrop through every part of that section in turn, so it is laid
  // over the section, from the top of the page to where it stops showing
  // through, and stays there for every tile. Measured at the stack under
  // nine points across each row below the first screen: the backdrop shows
  // where nothing opaque (a background colour, a picture, an image or
  // video) lies over it. One that shows through for a screen and a half or
  // more is the whole page's background, not a section's, and is left as
  // it is.
  async function extendBackdrops() {
    const vw = document.documentElement.clientWidth;
    const vh = window.innerHeight;
    // (The root's background is painted under everything, and so is body's
    // when html has none and body's is painted for it.)
    const rootBg = getComputedStyle(document.documentElement);
    const bodyLifted = rootBg.backgroundImage === 'none' && /rgba\(.*,\s*0\)|transparent/.test(rootBg.backgroundColor);
    const opaque = (e) => {
      if (e === document.documentElement || (e === document.body && bodyLifted)) return false;
      if (/^(IMG|VIDEO|CANVAS|IFRAME|PICTURE|OBJECT|EMBED)$/.test(e.tagName)) return true;
      const cs = getComputedStyle(e);
      if (cs.visibility === 'hidden' || Number(cs.opacity) < 0.5) return false;
      if (/url\(/.test(cs.backgroundImage)) return true;
      const a = cs.backgroundColor.match(/rgba?\(([^)]*)\)/);
      const parts = a ? a[1].split(/[,\s/]+/).filter(Boolean) : [];
      return parts.length >= 3 && (parts.length < 4 || Number(parts[3]) >= 0.95);
    };
    for (const [el, role] of overlays) {
      if (role !== 'backdrop' || !el.isConnected || !(el instanceof HTMLElement)) continue;
      const r0 = el.getBoundingClientRect();
      if (r0.width < vw * 0.9 || r0.height < vh * 0.9 || r0.top > 1) continue;
      // (With the rows looked at in the middle of the screen, clear of the
      // site's header; whatever else floats over the page is looked through.)
      scroller.scrollTo(0, vh / 2);
      await raf();
      const y0 = scroller.scrollTop;
      if (y0 < vh / 2 - 1) break;
      const shows = (pageY) => {
        for (let fx = 0.05; fx < 1; fx += 0.1125) {
          const over = [];
          for (const e of document.elementsFromPoint(vw * fx, pageY - y0)) {
            if (e === el || el.contains(e)) { through = over; return true; }
            if (opaque(e) && !pinnedToScreen(e)) break;
            over.push(e);
          }
        }
        return false;
      };
      let through = [];
      const limit = Math.round(y0 + vh - 1);
      let end = vh;
      while (end < limit && shows(end)) end += 2;
      // The last rows can show only in a corner narrower than the points
      // are apart (a hero cut by a diagonal): up to the bottom of the box
      // it shows through, when that is just below.
      for (const e of through) {
        const b = Math.ceil(e.getBoundingClientRect().bottom + y0);
        if (e !== document.body && b > end && b <= end + 24 && b < limit) end = b;
      }
      scroller.scrollTo(0, 0);
      await raf();
      // Still showing a screen and a half down: the page's background.
      if (end <= vh + 2 || end >= limit) continue;
      unwrapped.push({ el, style: el.getAttribute('style') });
      el.setAttribute('data-cleanshot-probe', '');
      el.style.setProperty('position', 'absolute', 'important');
      el.style.setProperty('inset', '0 0 auto 0', 'important');
      el.style.setProperty('width', '100%', 'important');
      el.style.setProperty('height', `${end}px`, 'important');
      el.style.setProperty('transform', 'none', 'important');
      const placed = el.getBoundingClientRect().top + scroller.scrollTop;
      if (Math.abs(placed) > 0.5) el.style.setProperty('top', `${-placed}px`, 'important');
      getComputedStyle(el).top;
      el.removeAttribute('data-cleanshot-probe');
      overlays.set(el, 'content');
    }
    scroller.scrollTo(0, 0);
  }

  // Scroll through the whole page (top→bottom) once to trigger
  // IntersectionObserver reveals and lazy-loading before real capture.
  //
  // A page that recolours itself can take 100ms or more to react to a
  // scroll (hitt.com does), longer than each stop lasts. The injected style
  // gives every change a 1ms transition, so a change to the page's own
  // background announces itself with a transitionend whenever it comes.
  async function preScroll() {
    const vh = window.innerHeight;
    const h = Math.min(pageHeight(), MAX_PAGE_HEIGHT);
    const own = [document.documentElement, document.body].filter(Boolean);
    own.forEach((el) => { if (!pageColors.has(el)) pageColors.set(el, new Set()); });
    const recoloured = (e) => {
      if (own.includes(e.target) && /background/.test(e.propertyName)) {
        pageColors.get(e.target).add(getComputedStyle(e.target).backgroundColor);
      }
    };
    document.addEventListener('transitionend', recoloured, true);
    // Each stop lasts until the images it brought on screen have loaded, up
    // to a limit: a lazy loader that swapped in a source has then done its
    // part, and the later tiles find the images ready.
    for (let y = 0; y < h; y += vh) {
      scroller.scrollTo(0, y);
      await sleep(60);
      await waitForVisibleImages(PRESCROLL_IMAGES_MS);
      sampleScrollEffects();
    }
    // One extra stop at the very bottom, looked at twice: fades started by
    // the last few stops are still running when the first look comes. The
    // first look counts for placement too when the page ends short of a
    // whole stop: a footer scene on screen at only two stops before it
    // (r-o.com's layered parallax) was otherwise seen in too few places
    // to be held, now and then.
    scroller.scrollTo(0, h);
    await sleep(120);
    sampleScrollEffects(Math.abs(scroller.scrollTop - stops[stops.length - 1]) < 1);
    await sleep(300);
    sampleScrollEffects(true);
    scroller.scrollTo(0, 0);
    await sleep(200);
    document.removeEventListener('transitionend', recoloured, true);
  }

  // How tall an element looks on screen. Some sticky headers (the Field
  // Museum's) are a zero-height box whose contents spill out of it, so
  // their own height says nothing.
  function shownHeight(el) {
    return Math.max(el.getBoundingClientRect().height, el.scrollHeight);
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
      if (r.top < HEADER_ZONE && r.width > vw * 0.5 && shownHeight(el) > 0) {
        stickyHeaders.add(el);
      }
    });
  }

  // Every element on the page, including ones inside shadow roots, where
  // chat widgets (LeadConnector, Intercom and the like) usually live. Many
  // widgets close their shadow root so page scripts can't reach in; an
  // extension can still open it. Only HTML elements can host one, and the
  // call throws on anything else (SVG).
  const shadowOf = chrome.dom && chrome.dom.openOrClosedShadowRoot
    ? (el) => {
      if (!(el instanceof HTMLElement)) return null;
      try { return chrome.dom.openOrClosedShadowRoot(el); } catch (_) { return el.shadowRoot; }
    }
    : (el) => el.shadowRoot;

  function allElements() {
    const out = [];
    const walk = (root) => root.querySelectorAll('*').forEach((el) => {
      out.push(el);
      const shadow = shadowOf(el);
      if (shadow) walk(shadow);
    });
    if (document.body) walk(document.body);
    return out;
  }

  // Where a fixed element shows on screen. A wrapper with no size of its own
  // (a zero-height header, a widget root whose bubble is positioned inside
  // it) is measured by what it holds.
  function screenBox(el) {
    const r = el.getBoundingClientRect();
    if (r.width >= 2 && r.height >= 2) return r;
    let box = null;
    const inner = el.querySelectorAll('*');
    for (let i = 0; i < inner.length && i < 300; i++) {
      const c = inner[i].getBoundingClientRect();
      if (c.width < 2 || c.height < 2) continue;
      box = box
        ? { left: Math.min(box.left, c.left), top: Math.min(box.top, c.top), right: Math.max(box.right, c.right), bottom: Math.max(box.bottom, c.bottom) }
        : { left: c.left, top: c.top, right: c.right, bottom: c.bottom };
    }
    return box && { ...box, width: box.right - box.left, height: box.bottom - box.top };
  }

  const DIALOG = 'dialog[open], [aria-modal="true"], [role="dialog"], [role="alertdialog"]';
  const NAV = 'nav, header, [role="navigation"], [role="banner"]';

  const shows = (el) => {
    const r = el.getBoundingClientRect();
    const cs = getComputedStyle(el);
    return r.width > 0 && r.height > 0 && cs.visibility !== 'hidden' && Number(cs.opacity) > 0;
  };

  // A full-screen layer that sits over the page rather than behind it: an
  // open dialog, or a dimming scrim (a see-through colour with no picture in
  // it). A page's own full-screen background or hero (a recoloured layer, a
  // garden photo, a fixed video with a tint over it) holds a picture or is
  // opaque, and isn't one.
  function isScrimOrDialog(el) {
    if (el.matches(DIALOG) || [...el.querySelectorAll(DIALOG)].some(shows)) return true;
    const vw = document.documentElement.clientWidth;
    const vh = window.innerHeight;
    // Only a picture that fills most of the screen makes the layer a
    // background. A popup's card can hold pictures of its own (Lindsey
    // Brothers' Elementor event flyer, which has no dialog role).
    const fills = (m) => {
      const r = m.getBoundingClientRect();
      return r.width * r.height >= vw * vh * 0.5;
    };
    if ([...el.querySelectorAll('img, picture, video, canvas, iframe, svg image')].some(fills)) return false;
    const layers = [el, ...Array.from(el.children)].filter((c) => {
      const r = c.getBoundingClientRect();
      return r.width >= vw * 0.9 && r.height >= vh * 0.9;
    });
    // A gradient is still a scrim (New Christendom Press tints with one); a
    // background picture isn't.
    const seeThrough = (color) => {
      const a = color.match(/rgba\([^)]*,\s*([\d.]+)\)/);
      return !!a && Number(a[1]) > 0 && Number(a[1]) < 1;
    };
    return layers.some((c) => {
      const cs = getComputedStyle(c);
      if (/url\(/.test(cs.backgroundImage)) return false;
      if (cs.backdropFilter && cs.backdropFilter !== 'none') return true;
      const stops = cs.backgroundImage.match(/rgba?\([^)]*\)/g) || [];
      return seeThrough(cs.backgroundColor) || (stops.length > 0 && stops.every(seeThrough));
    });
  }

  // The one rule for things that stay put while the page scrolls, decided
  // at scroll 0 and applied before every tile:
  // - 'nav': the site's own header, kept in the first tile and hidden after
  //   (it would repeat at every tile top otherwise). Anchored to the top of
  //   the screen and either wide and not too tall, or holding the site's
  //   navigation (a nav or header, several links, or a short logo or menu
  //   button in the corner).
  // - 'backdrop': part of the first screen's design that stays put while
  //   the page scrolls over it: a full-screen background or hero layer, or
  //   a big fixed panel low in the stacking order. Like the header, it
  //   shows in the first tile only.
  // - 'extra': everything else floats over the page and isn't part of it:
  //   cookie banners and consent boxes, newsletter and promo popups and their
  //   dimming, chat bubbles, accessibility widgets, call buttons, back-to-top
  //   buttons. Anything that is a dialog counts here too, wherever it sits.
  //   Hidden for the whole capture, the first tile included.
  function overlayRole(el) {
    const vw = document.documentElement.clientWidth;
    const vh = window.innerHeight;
    let r = screenBox(el);
    if (el.matches(DIALOG)) return 'extra';
    let held = null;
    if (r.width >= vw * 0.9 && r.height >= vh * 0.9) {
      if (isScrimOrDialog(el)) return 'extra';
      held = heldFloats(el);
      if (!held) return 'backdrop';
      r = held;
    }
    if (r.top <= 150) {
      const h = held ? r.height : Math.max(r.height, el.scrollHeight);
      if (r.width >= vw * 0.5 && h < vh * 0.6) return 'nav';
      if (el.matches(NAV) || el.querySelector(NAV) || el.querySelectorAll('a[href]').length >= 3) return 'nav';
      if (h < 150 && el.querySelector('a[href], button, img, svg')) return 'nav';
    }
    // A big panel that isn't a dialog and sits low in the stacking order is
    // first-screen content the page scrolls over (a fixed hero title or
    // promo). Cookie boxes, chat windows and popups that big are stacked
    // far above everything else.
    if (r.width * r.height >= vw * vh * 0.2 && stackLevel(el) <= 10 && !isScrimOrDialog(el)) return 'backdrop';
    return 'extra';
  }

  // A full-screen layer stacked over the page that paints nothing itself,
  // only a few small things inside it: a widget's root spread over the
  // window so its launcher can be placed anywhere (www.bloomdentist.com's
  // chat, a transparent 1388x868 layer at z-index 10000 in a shadow root
  // with its "Chat with us" pill in the corner, was taken for a backdrop
  // and kept in the first tile). Returns the box of what it shows, to be
  // sorted by that, or null when the layer is a real backdrop.
  function heldFloats(el) {
    if (stackLevel(el) <= 10) return null;
    const vw = document.documentElement.clientWidth;
    const vh = window.innerHeight;
    const bare = (e) => {
      const cs = getComputedStyle(e);
      return cs.backgroundImage === 'none' && (!cs.backdropFilter || cs.backdropFilter === 'none') &&
        /^(transparent|rgba\(.*,\s*0\))$/.test(cs.backgroundColor);
    };
    if (!bare(el)) return null;
    let box = null;
    const inner = el.querySelectorAll('*');
    for (let i = 0; i < inner.length && i < 300; i++) {
      const c = inner[i].getBoundingClientRect();
      if (c.width < 2 || c.height < 2) continue;
      if (c.right <= 0 || c.left >= vw || c.bottom <= 0 || c.top >= vh) continue;
      // A wrapper as big as the layer and as bare is more of the same.
      if (c.width >= vw * 0.9 && c.height >= vh * 0.9 && bare(inner[i])) continue;
      if (inner[i].checkVisibility && !inner[i].checkVisibility({ opacityProperty: true, visibilityProperty: true })) continue;
      box = box
        ? { left: Math.min(box.left, c.left), top: Math.min(box.top, c.top), right: Math.max(box.right, c.right), bottom: Math.max(box.bottom, c.bottom) }
        : { left: c.left, top: c.top, right: c.right, bottom: c.bottom };
    }
    if (!box) return null;
    box = { ...box, width: box.right - box.left, height: box.bottom - box.top };
    return box.width * box.height < vw * vh * 0.2 ? box : null;
  }

  // The z-index an element is painted at: its own, or the nearest
  // ancestor's that sets one.
  function stackLevel(el) {
    for (let a = el; a; a = a.parentElement) {
      const z = getComputedStyle(a).zIndex;
      if (z !== 'auto') return Number(z);
    }
    return 0;
  }

  // Something that turned `fixed` only after the page scrolled: a "sticky on
  // scroll" header, a chat bubble that slid in, a popup on a timer, or a
  // content section pinned while the rest scrolls past. Only the last is
  // part of the page: tall, wide and not a dialog or a scrim.
  // The header that turns fixed on scroll sat in the page's flow at the top
  // when the visitor arrived, where the first tile shows it: it is the
  // site's header, like one fixed from the start, kept in the first tile and
  // hidden after. Known by sitting at the top of the screen and holding the
  // site's navigation, so a promo bar that slides in up there stays extra.
  //
  // One the pre-scroll saw in the page's flow before it turned fixed (a
  // header or a column a script makes sticky: terrenlandscapes.com's
  // Elementor "Our Symphony of Services" column turns `position: fixed`
  // once scrolled to, and was hidden with the extras, its lower half lost)
  // is page content the page pins while it is read: 'flow', put back where
  // the page had it (see placeInFlow).
  function lateRole(el) {
    let r = screenBox(el);
    if (el.matches(DIALOG) || isScrimOrDialog(el)) return 'extra';
    const held = r.width >= document.documentElement.clientWidth * 0.9 && r.height >= window.innerHeight * 0.9 && heldFloats(el);
    if (held) r = held;
    const tall = r.height >= window.innerHeight * 0.6 && r.width >= document.documentElement.clientWidth * 0.5;
    if (tall) return 'content';
    if (flowBoxes.get(el)) return 'flow';
    if (r.top <= 150 && r.top > -r.height && r.height < window.innerHeight * 0.6 &&
      (el.matches(NAV) || el.querySelector(NAV) || el.querySelectorAll('a[href]').length >= 3)) return 'nav';
    return 'extra';
  }

  // Sort every fixed element on screen that hasn't been sorted yet. At scroll
  // 0 that is the rule above; further down, only the late rule can apply.
  // Elements with nothing to show yet (a closed drawer, a popup not opened)
  // wait until they do.
  //
  // One parked wholly off the screen at scroll 0 (a closed drawer, a panel
  // slid out to the side, a bar waiting below the bottom edge) shows nothing
  // of itself, only what spills from it, a shadow or a glow
  // (www.richardscriminallaw.com's accessibility panel, a <nav> 580px off
  // the left edge, cast its shadow on the first screen). It isn't the
  // header a visitor sees there, so it is an extra. One big enough to be a
  // pinned section is left to be sorted when it shows.
  //
  // Sticky elements the page adds later are looked at too (see floatsLow):
  // a "back to top" box made sticky once the page has scrolled (www.louvre.fr
  // adds one at the end of its content) would otherwise ride along in every
  // tile.
  function sortOverlays(atTop) {
    const vw = document.documentElement.clientWidth;
    const vh = window.innerHeight;
    allElements().forEach((el) => {
      if (overlays.has(el)) return;
      const cs = getComputedStyle(el);
      if (cs.position === 'sticky') {
        if (!stickySeen.has(el)) {
          stickySeen.add(el);
          if (floatsLow(el, cs)) overlays.set(el, 'extra');
        }
        return;
      }
      if (cs.position !== 'fixed') return;
      const r = screenBox(el);
      if (!r || r.width <= 0 || r.height <= 0) return;
      if (atTop && (r.right <= 0 || r.left >= vw || r.bottom <= 0 || r.top >= vh)) {
        if (r.height >= vh * 0.6 && r.width >= vw * 0.5) return;
        overlays.set(el, 'extra');
        return;
      }
      overlays.set(el, atTop ? overlayRole(el) : lateRole(el));
    });
  }

  // Popups usually lock the page while they're open: overflow hidden on html
  // or body, or the body pinned in place with a negative top. Hiding the
  // popup leaves the lock, so undo it for the capture; restore() puts it
  // back. The overflow lock is only touched while a popup is up, since some
  // pages lock the document for good and scroll an inner div instead.
  function unlockScroll() {
    const b = document.body;
    const h = document.documentElement;
    if (!b) return;
    const bs = getComputedStyle(b);
    if (bs.position === 'fixed' && (parseFloat(bs.top) < 0 || b.scrollHeight > window.innerHeight + 10)) {
      unwrapped.push({ el: b, style: b.getAttribute('style') });
      b.style.setProperty('position', 'static', 'important');
      b.style.setProperty('top', 'auto', 'important');
    }
    const popupUp = [...overlays].some(([el, role]) => role === 'extra' && el.isConnected &&
      getComputedStyle(el).display !== 'none' && (el.matches(DIALOG) || isScrimOrDialog(el)));
    if (!popupUp) return;
    for (const el of [h, b]) {
      if (!/hidden|clip/.test(getComputedStyle(el).overflowY)) continue;
      unwrapped.push({ el, style: el.getAttribute('style') });
      el.style.setProperty('overflow-y', 'visible', 'important');
    }
  }

  // Hide what shouldn't be in this tile: the floating extras always, and from
  // the second tile on also the header and backdrop seen at scroll 0, the
  // sticky top-navs, and late fixed elements other than pinned sections.
  // Runs before every tile, because some of these only appear partway
  // through (a popup on a timer, a header that turns fixed on scroll).
  // Hidden with opacity as well as visibility: a child can override its
  // parent's `visibility: hidden` (Elementor buttons do), but not opacity.
  //
  // The worker can ask for the first tile again (to reshoot it next to the
  // second when the two disagree), so at index 0 the header and the rest
  // that only later tiles hide are shown again.
  //
  // Hidden through the stylesheet as well, by an attribute: a widget that
  // writes its whole style attribute again (shiftelectricco.com's chat
  // bubble sets `style="bottom:0px;position:fixed;…"` a few seconds after it
  // mounts) wipes an inline hide, and the bubble came back in every later
  // tile. The inline one stays for a widget that sets visibility or opacity
  // inline with !important of its own. Each tile checks again that what it
  // hid is still hidden.
  function unhide(h) {
    h.el.removeAttribute('data-cleanshot-hide');
    // Only what the hide wrote: the page may have rewritten the style since.
    const ours = (p, v) => h.el.style.getPropertyPriority(p) === 'important' && h.el.style.getPropertyValue(p) === v;
    if (ours('visibility', 'hidden')) {
      if (h.prev) h.el.style.setProperty('visibility', h.prev);
      else h.el.style.removeProperty('visibility');
    }
    if (ours('opacity', '0')) {
      if (h.prevOpacity) h.el.style.setProperty('opacity', h.prevOpacity);
      else h.el.style.removeProperty('opacity');
    }
  }

  // Where the page has it fixed now, put it back where the pre-scroll saw
  // it in the page's flow, through the stylesheet (the page's script keeps
  // writing `position: fixed` inline). Where the page has it in flow
  // itself (at the top again, for a header), it is left alone. The script
  // usually leaves a spacer where it was, so it goes back over that, out of
  // the flow: put back in the flow it would take the space twice.
  //
  // A page rule that is more specific and !important wins over the
  // capture's (hermansplumbing.com's Divi header: `#main-header.et-fixed-header
  // { position: fixed !important }`), and the header stayed fixed at the
  // top of every tile, its edge showing below each overlap. Only an inline
  // !important beats that, so where the rule lost, the same declarations
  // are written inline too, and taken off again before the next look.
  // Taken off only where they are still what the capture wrote: a script
  // that writes the place inline itself (arnettcustomhomes.com's Divi
  // sticky row, `position: fixed !important` inline while stuck) clears
  // it again once the page scrolls back up, and the stuck values put back
  // over that kept the row fixed at the top with its spacer gone, the
  // page under it moved up by its height.
  const INFLOW_PROPS = ['position', 'top', 'left', 'right', 'bottom', 'width', 'margin'];
  const INFLOW_SET = { position: 'absolute', top: 'var(--cleanshot-top)', left: 'var(--cleanshot-left)', right: 'auto', bottom: 'auto', width: 'var(--cleanshot-width)', margin: '0' };
  let inflow = new Set();
  let inflowInline = new Map(); // element -> [[property, value, priority, as written]] as the page had them
  function dropInflowInline(el) {
    const prev = inflowInline.get(el);
    if (!prev) return;
    for (const [p, v, pr, ours] of prev) {
      if (el.style.getPropertyValue(p) !== ours || el.style.getPropertyPriority(p) !== 'important') continue;
      if (v) el.style.setProperty(p, v, pr);
      else el.style.removeProperty(p);
    }
    inflowInline.delete(el);
  }
  function placeInFlow(el) {
    // (Transitions off meanwhile, or the box read back is where a 1ms
    // transition from the old place starts.)
    const box = flowBoxes.get(el);
    el.setAttribute('data-cleanshot-probe', '');
    el.removeAttribute('data-cleanshot-inflow');
    dropInflowInline(el);
    if (box && el.isConnected && getComputedStyle(el).position === 'fixed') {
      el.style.setProperty('--cleanshot-top', '0px');
      el.style.setProperty('--cleanshot-left', '0px');
      el.style.setProperty('--cleanshot-width', `${box.width}px`);
      el.setAttribute('data-cleanshot-inflow', '');
      if (getComputedStyle(el).position !== 'absolute') {
        const prev = INFLOW_PROPS.map((p) => [p, el.style.getPropertyValue(p), el.style.getPropertyPriority(p)]);
        for (const p of INFLOW_PROPS) el.style.setProperty(p, INFLOW_SET[p], 'important');
        inflowInline.set(el, prev.map(([p, v, pr]) => [p, v, pr, el.style.getPropertyValue(p)]));
      }
      const r = el.getBoundingClientRect();
      el.style.setProperty('--cleanshot-top', `${box.top - (r.top + scroller.scrollTop)}px`);
      el.style.setProperty('--cleanshot-left', `${box.left - r.left}px`);
      getComputedStyle(el).top;
      inflow.add(el);
    }
    el.removeAttribute('data-cleanshot-probe');
  }

  function hideOverlays(index) {
    const vh = window.innerHeight;
    if (index === 0) {
      hiddenEls = hiddenEls.filter((h) => {
        if (!h.later) return true;
        unhide(h);
        return false;
      });
    }
    const hide = (el, later) => {
      const known = hiddenEls.find((h) => h.el === el);
      if (!known) {
        const cs = getComputedStyle(el);
        if (cs.visibility === 'hidden' || cs.display === 'none') return;
      }
      // Where it sat on screen: the last tile showed it there, this one
      // won't, so the worker leaves that area out when it lines them up.
      // (One already hidden that the page showed again counts too.)
      const r = el.getBoundingClientRect();
      const showing = !known || (getComputedStyle(el).visibility !== 'hidden' && Number(getComputedStyle(el).opacity) > 0);
      if (showing && r.width > 0 && r.height > 0 && r.bottom > 0 && r.top < vh) {
        covered.push({ top: Math.round(r.top), bottom: Math.round(r.bottom), left: Math.round(r.left), right: Math.round(r.right) });
      }
      if (!known) hiddenEls.push({ el, later, prev: el.style.visibility, prevOpacity: el.style.opacity });
      el.setAttribute('data-cleanshot-hide', '');
      el.style.setProperty('visibility', 'hidden', 'important');
      el.style.setProperty('opacity', '0', 'important');
    };
    sortOverlays(index === 0);
    for (const [el, role] of overlays) {
      if (role === 'flow') {
        const h = hiddenEls.find((x) => x.el === el);
        if (h) { unhide(h); hiddenEls = hiddenEls.filter((x) => x !== h); }
        placeInFlow(el);
        continue;
      }
      // Sorted because it was fixed, and back in the page's flow now: part
      // of the page here, whatever it was before (a header that turns fixed
      // only once the page scrolls, back at scroll 0 when the worker shoots
      // the first tile again: emcocooling.com and icaboston.org lost their
      // headers from the top of the capture that way).
      if (/^(static|relative)$/.test(getComputedStyle(el).position)) {
        const h = hiddenEls.find((x) => x.el === el);
        if (h) { unhide(h); hiddenEls = hiddenEls.filter((x) => x !== h); }
        continue;
      }
      if (role === 'extra') hide(el, false);
      else if (index > 0 && role !== 'content') hide(el, true);
    }
    if (index > 0) stickyHeaders.forEach((el) => hide(el, true));
  }

  // Some sites (instant.ai) lock html and body to the window height and
  // scroll an inner div instead, so the document itself never moves. Let
  // that div and everything around it grow to full height, which hands the
  // scrolling back to the document.
  function unwrapInnerScroller() {
    if (scroller.scrollHeight > window.innerHeight + 10) return;
    let best = null;
    allElements().forEach((el) => {
      const cs = getComputedStyle(el);
      if (!/(auto|scroll)/.test(cs.overflowY)) return;
      if (el.scrollHeight <= el.clientHeight + 50) return;
      if (!best || el.scrollHeight > best.scrollHeight) best = el;
    });
    if (!best) return;
    for (let el = best; el; el = el.parentElement) {
      unwrapped.push({ el, style: el.getAttribute('style') });
      el.style.setProperty('height', 'auto', 'important');
      el.style.setProperty('max-height', 'none', 'important');
      el.style.setProperty('overflow', 'visible', 'important');
      // A fixed full-screen wrapper takes no space in the page, so the
      // document would stay one screen tall. Put it back in normal flow.
      if (getComputedStyle(el).position === 'fixed') {
        el.style.setProperty('position', 'relative', 'important');
        el.style.setProperty('inset', 'auto', 'important');
      }
    }
  }

  // Overlays that would otherwise repeat or float in the capture:
  // - sticky bar pinned to the bottom of the screen (instant.ai's partner
  //   logos) show once at the screen edge and again where they really sit,
  //   so put them back where they belong;
  // - a site's own fake scrollbar, a thin fixed strip at the edge, isn't
  //   part of the design;
  // - a parallax background (Squarespace "fixed" image sections) is a fixed
  //   element seen through a clipped section. Left fixed it would be hidden
  //   with the other overlays and leave a blank band, so pin it to the
  //   section it belongs to instead.
  // - Squarespace 7.0 parallax images (Brine, Bedford and kin) sit in one
  //   layer at the end of the page: each is `fixed` at its section's page
  //   coordinates and slid into view by script. Make them `absolute` at those
  //   same coordinates, through the stylesheet so the script's per-scroll
  //   inline transforms can't move them again.
  function clippedByAncestor(el) {
    for (let a = el.parentElement; a && a !== document.body; a = a.parentElement) {
      const cs = getComputedStyle(a);
      if (cs.clipPath !== 'none' || cs.clip !== 'auto') return a;
    }
    return null;
  }

  // A sticky element follows the reader down through its container, so it
  // lands in every tile it passes through, each time somewhere else: 17A's
  // "A decade of supporting public leaders", Whitney's Lichtenstein feature
  // beside the exhibitions list, CLC Roofing's left-column heading, folk's
  // section eyebrows. Each goes back to where the layout puts it, with its
  // sticky offset cancelled (left in place, `position: relative` would
  // shift it down by its `top`, onto the heading below). Measured at scroll
  // 0, two kinds stay as they are: the site's top nav, in the header zone
  // (hidden after the first tile with the other headers), and a pinned
  // section that fills the screen while the page scrolls a long way past it
  // (see filmPinnedSections), which back in flow would leave the rest of its
  // container blank.
  function inHeaderZone(el) {
    return el.getBoundingClientRect().top + scroller.scrollTop <= 150 || shownHeight(el) <= 0;
  }

  function isPinnedSection(el) {
    const r = el.getBoundingClientRect();
    const h = shownHeight(el);
    const box = el.parentElement && el.parentElement.getBoundingClientRect();
    return r.width >= document.documentElement.clientWidth * 0.7 && h >= window.innerHeight * 0.6 &&
      !!box && box.height >= h * 1.5;
  }

  // A pinned section that changes as the page scrolls past it (agcsf.com's
  // project galleries: a full-screen frame stuck for four screens while a
  // script slides a row of photos sideways through it) shows a different
  // stage in every tile, cut at every seam. A visitor sees it as a run of
  // stages, so that is how it's shown: visit each stage, one screen of
  // scrolling apart, copy the section as it stands there, and stack the
  // copies down the space the page reserves for it, which they fill. The
  // section itself is hidden. One that looks the same at every stage is
  // left as it is.
  //
  // A smaller sticky panel can do the same beside a column of content
  // (saybriefly.com's meeting features: a picture stuck beside a list of
  // four, swapped by script for the item level with it). Back in flow it
  // would show the first picture once and leave empty space beside the
  // other three. It is laid out as its stages too, but only when what it
  // shows changes from stage to stage (another picture, other text, a part
  // shown or hidden) over a quarter of it or more: a table of contents
  // that lights up the heading in view changes one line, and stays a
  // single panel.
  function stickyPanel(el) {
    const cs = getComputedStyle(el);
    const r = screenBox(el);
    const h = shownHeight(el);
    const box = el.parentElement && el.parentElement.getBoundingClientRect();
    return !!r && r.width >= 150 && h >= 150 && h < window.innerHeight && !floatsLow(el, cs) &&
      !!box && box.height >= h * 1.5;
  }

  // What a panel shows, for telling its stages apart: each visible part
  // that paints something (text, a picture, a canvas, a background), with
  // where it sits in the panel and how much of the panel it covers. The
  // panel's own opacity doesn't count: a panel that fades or slides in as
  // a whole (newmanroofing.com's, an AOS fade-right that the page plays
  // again on the way back up) shows the same thing at every stage, only
  // arriving, and the parts' places are read against the panel's own box.
  function shownParts(frame) {
    const fr = frame.getBoundingClientRect();
    const out = new Map();
    const walk = (el, op) => {
      const cs = getComputedStyle(el);
      if (cs.display === 'none') return;
      const o = el === frame ? 1 : op * Number(cs.opacity);
      if (o < 0.5) return;
      const r = el.getBoundingClientRect();
      if (cs.visibility === 'visible' && r.width > 0 && r.height > 0) {
        const text = Array.from(el.childNodes).filter((n) => n.nodeType === 3).map((n) => n.textContent.trim()).join(' ');
        const media = el.currentSrc || (el.getAttribute && el.getAttribute('src')) || '';
        const bg = cs.backgroundImage !== 'none' ? cs.backgroundImage : '';
        const fill = /rgba\([^)]*,\s*0\)|transparent/.test(cs.backgroundColor) ? '' : cs.backgroundColor;
        if (text || media || bg || fill || /^(CANVAS|svg|VIDEO)$/.test(el.tagName)) {
          const w = Math.min(r.right, fr.right) - Math.max(r.left, fr.left);
          const h = Math.min(r.bottom, fr.bottom) - Math.max(r.top, fr.top);
          const key = `${el.tagName}|${text}|${media}|${bg}|${fill}|${Math.round((r.left - fr.left) / 8)},${Math.round((r.top - fr.top) / 8)}`;
          out.set(key, (out.get(key) || 0) + Math.max(0, w) * Math.max(0, h));
        }
      }
      for (const c of el.children) walk(c, o);
    };
    walk(frame, 1);
    return out;
  }

  // The share of a panel's area whose parts differ between two looks.
  function partsChanged(a, b, area) {
    let gone = 0, came = 0;
    for (const [k, v] of a) if (!b.has(k)) gone += v;
    for (const [k, v] of b) if (!a.has(k)) came += v;
    return area > 0 ? Math.min(1, Math.max(gone, came) / area) : 0;
  }

  async function filmPinnedSections() {
    const vh = window.innerHeight;
    const frames = allElements().filter((el) => {
      if (!(el instanceof HTMLElement) || getComputedStyle(el).position !== 'sticky') return false;
      return !inHeaderZone(el) && (isPinnedSection(el) || stickyPanel(el));
    });
    for (const frame of frames) {
      if (frames.some((f) => f !== frame && f.contains(frame))) continue;
      const panel = !isPinnedSection(frame);
      const parent = frame.parentElement;
      const stick = parseFloat(getComputedStyle(frame).top) || 0;
      const y = scroller.scrollTop;
      const r = frame.getBoundingClientRect();
      const pr = parent.getBoundingClientRect();
      const off = r.top - pr.top;
      const h = r.height;
      const travel = pr.height - off - h;
      const n = Math.round(travel / h) + 1;
      if (n < 2) continue;
      const pageTop = r.top + y;
      const stages = [];
      for (let k = 0; k < n; k++) {
        scroller.scrollTo(0, Math.max(0, pageTop + travel * k / (n - 1) - stick));
        await raf();
        await raf();
        await sleep(150);
        await waitForVisibleImages(800);
        const stage = { at: off + travel * k / (n - 1), node: frame.cloneNode(true) };
        // The panel's own look and place at this stage, for the copies (see
        // below).
        // (Its place is read with its own transform off: the copies carry
        // that transform themselves.)
        const fcs = getComputedStyle(frame);
        const look = { opacity: Number(fcs.opacity), transform: fcs.transform, translate: fcs.translate };
        const saved = ['transform', 'translate'].map((p) => [p, frame.style.getPropertyValue(p), frame.style.getPropertyPriority(p)]);
        frame.setAttribute('data-cleanshot-probe', '');
        frame.style.setProperty('transform', 'none', 'important');
        frame.style.setProperty('translate', 'none', 'important');
        const fr = frame.getBoundingClientRect();
        for (const [p, v, pr] of saved) { if (v) frame.style.setProperty(p, v, pr); else frame.style.removeProperty(p); }
        frame.removeAttribute('data-cleanshot-probe');
        stage.frameLook = { ...look, left: fr.left, width: fr.width };
        if (panel) {
          stage.parts = shownParts(frame);
          // How each part looks here, for the copy to keep: a script that
          // swaps the pictures by inline opacity finds the copies too.
          stage.looks = Array.from(frame.querySelectorAll('*')).map((e) => {
            const cs = getComputedStyle(e);
            return [cs.opacity, cs.visibility];
          });
        }
        stages.push(stage);
      }
      if (panel
        ? stages.every((s) => partsChanged(stages[0].parts, s.parts, r.width * h) < 0.25)
        : stages.every((s) => s.node.outerHTML === stages[0].node.outerHTML)) continue;
      // The page's script may size the container by how many frames it
      // holds (agcsf.com's grew a screen per copy), so it keeps its height.
      parent.style.setProperty('--cleanshot-height', `${pr.height}px`);
      parent.setAttribute('data-cleanshot-keep', '');
      const ps = getComputedStyle(parent);
      if (ps.position === 'static') {
        unwrapped.push({ el: parent, style: parent.getAttribute('style') });
        parent.style.setProperty('position', 'relative', 'important');
      }
      unwrapped.push({ el: frame, style: frame.getAttribute('style') });
      frame.style.setProperty('visibility', 'hidden', 'important');
      frame.style.setProperty('opacity', '0', 'important');
      frame.setAttribute('data-cleanshot-filmed', '');
      // A panel that slides or fades in as a whole was measured, and may
      // have been copied, partway in (newmanroofing.com's sat 100px to the
      // left and transparent until the page played its entrance, and every
      // copy came out cut off at the left edge). Every copy takes the
      // panel's look and place from the stage where it showed most, the
      // way it rests once arrived.
      const rest = stages.reduce((a, s) => (s.frameLook.opacity >= a.frameLook.opacity ? s : a), stages[0]).frameLook;
      const left = rest.left - pr.left - parseFloat(ps.borderLeftWidth);
      let after = frame;
      for (const { at, node, looks } of stages) {
        node.setAttribute('data-cleanshot-clone', '');
        node.setAttribute('aria-hidden', 'true');
        for (const [p, v] of [['position', 'absolute'], ['top', `${at - parseFloat(ps.borderTopWidth)}px`], ['left', `${left}px`],
          ['bottom', 'auto'], ['right', 'auto'], ['width', `${rest.width}px`], ['height', `${h}px`], ['margin', '0'],
          ['opacity', String(rest.opacity)], ['transform', rest.transform], ['translate', rest.translate]]) {
          node.style.setProperty(p, v, 'important');
        }
        // The page's script finds the copies too and moves them on with the
        // scroll (agcsf.com's slides every row of photos it can find, every
        // frame), so each copy's styles as copied are held through the
        // stylesheet, where the script's inline writes lose.
        // A panel's parts keep how they looked at that stage as well.
        const parts = Array.from(node.querySelectorAll('*'));
        const list = looks ? [node, ...parts] : [node, ...node.querySelectorAll('[style]')];
        const rules = list.map((c) => {
          const id = String(clones.length);
          clones.push(c);
          c.setAttribute('data-cleanshot-cid', id);
          const props = Array.from(c.style);
          let decl = props.map((p) => `${p}: ${c.style.getPropertyValue(p)} !important;`).join(' ');
          const look = looks && c !== node ? looks[parts.indexOf(c)] : null;
          if (look) {
            if (!props.includes('opacity')) decl += ` opacity: ${look[0]} !important;`;
            if (!props.includes('visibility')) decl += ` visibility: ${look[1]} !important;`;
          }
          return `[data-cleanshot-cid="${id}"] { ${decl} }`;
        });
        styleEl.textContent += `\n${rules.join('\n')}`;
        parent.insertBefore(node, after.nextSibling);
        after = node;
      }
      const top = Math.round(pr.top + y);
      notes.push({ kind: 'pinned-stages', y0: top, y1: Math.round(top + pr.height), note: `${panel ? 'a panel' : 'a section'} that stays on screen while the page scrolls past it, changing as it goes (y ${top}-${Math.round(top + pr.height)}), is shown as ${n} ${panel ? 'copies down its column' : 'screens'}, one for each stage` });
    }
    scroller.scrollTo(0, 0);
    await sleep(150);
  }

  // A background with `background-attachment: fixed` is painted against the
  // window, not its section, so every tile shows a different part of the
  // picture through the section and it breaks at every seam (Cofa
  // Dentistry's "A better dental experience", Dentiq's and Hendo Roofing's
  // call-to-action photos). Paint it with the section instead, sized and
  // placed as a visitor sees it with the section centred on screen (or at
  // the top of the page for one on the first screen).
  async function settleFixedBackgrounds() {
    const vw = document.documentElement.clientWidth;
    const vh = window.innerHeight;
    const maxScroll = Math.max(0, scroller.scrollHeight - vh);
    const y = scroller.scrollTop;
    // Top-level commas only: gradients have commas of their own.
    const layers = (s) => {
      const out = [];
      let depth = 0, cur = '';
      for (const ch of s) {
        if (ch === '(') depth++;
        if (ch === ')') depth--;
        if (ch === ',' && depth === 0) { out.push(cur.trim()); cur = ''; } else cur += ch;
      }
      out.push(cur.trim());
      return out;
    };
    const natural = (img) => new Promise((resolve) => {
      const m = img.match(/^url\(["']?(.*?)["']?\)$/);
      if (!m) return resolve(null);
      const probe = new Image();
      const done = () => resolve(probe.naturalWidth ? [probe.naturalWidth, probe.naturalHeight] : null);
      probe.onload = done;
      probe.onerror = done;
      setTimeout(done, 1500);
      probe.src = m[1];
      if (probe.complete) done();
    });
    const len = (t, ref) => (t === 'auto' || t == null ? null : t.endsWith('%') ? ref * parseFloat(t) / 100 : parseFloat(t));
    for (const el of allElements()) {
      const cs = getComputedStyle(el);
      if (!cs.backgroundAttachment.includes('fixed') || cs.backgroundImage === 'none' || pinnedToScreen(el)) continue;
      const r = el.getBoundingClientRect();
      if (r.width < 2 || r.height < 2) continue;
      const images = layers(cs.backgroundImage);
      const at = (list, i) => list[i % list.length];
      const att = layers(cs.backgroundAttachment), size = layers(cs.backgroundSize), pos = layers(cs.backgroundPosition);
      const top = r.top + y + parseFloat(cs.borderTopWidth);
      const left = r.left + parseFloat(cs.borderLeftWidth);
      const rest = top < vh ? 0 : Math.min(maxScroll, Math.max(0, top + r.height / 2 - vh / 2));
      const out = { att: [], size: [], pos: [] };
      for (let i = 0; i < images.length; i++) {
        if (at(att, i) !== 'fixed') {
          out.att.push(at(att, i)); out.size.push(at(size, i)); out.pos.push(at(pos, i));
          continue;
        }
        const nat = await natural(images[i]);
        const st = at(size, i).split(/\s+/);
        let w, h;
        if (st[0] === 'cover' || st[0] === 'contain') {
          const s = nat ? (st[0] === 'cover' ? Math.max(vw / nat[0], vh / nat[1]) : Math.min(vw / nat[0], vh / nat[1])) : 1;
          [w, h] = nat ? [nat[0] * s, nat[1] * s] : [vw, vh];
        } else {
          w = len(st[0], vw); h = len(st[1], vh);
          if (w == null && h == null) [w, h] = nat || [vw, vh];
          else if (w == null) w = nat ? h * nat[0] / nat[1] : vw;
          else if (h == null) h = nat ? w * nat[1] / nat[0] : vh;
        }
        const pt = /calc/.test(at(pos, i)) ? ['50%', '50%'] : at(pos, i).split(/\s+/);
        const px = pt[0].endsWith('%') ? (vw - w) * parseFloat(pt[0]) / 100 : parseFloat(pt[0]) || 0;
        const py = (pt[1] || '50%').endsWith('%') ? (vh - h) * parseFloat(pt[1] || '50') / 100 : parseFloat(pt[1]) || 0;
        let x = px - left, yy = rest + py - top;
        // A section taller (or wider) than what that leaves covered: a
        // visitor scrolling through it sees the picture behind every part
        // of it in turn, but one window's worth of picture, placed for the
        // section centred, leaves its top and bottom bare
        // (schlueterplumbing.com's 1269px services section: 200px of white
        // over its white "PLUMBING SERVICES" heading). Grow the picture
        // until it covers the section, about the same centre. A picture
        // that repeats in that direction has no bare part to cover.
        const rep = at(layers(cs.backgroundRepeat), i).split(/\s+/);
        const repX = !/no-repeat/.test(rep[0]) && !/^repeat-y$/.test(rep[0]);
        const repY = !/no-repeat/.test(rep[rep.length - 1]) && !/^repeat-x$/.test(rep[0]);
        const bareX = !repX && (x > 0.5 || x + w < r.width - 0.5);
        const bareY = !repY && (yy > 0.5 || yy + h < r.height - 0.5);
        if ((bareX || bareY) && w > 0 && h > 0 && w >= vw - 1 && h >= vh - 1) {
          const s = Math.max(1, r.width / w, r.height / h);
          const cx = x + w / 2, cy = yy + h / 2;
          w *= s; h *= s;
          x = Math.min(0, Math.max(r.width - w, cx - w / 2));
          yy = Math.min(0, Math.max(r.height - h, cy - h / 2));
        }
        out.att.push('scroll');
        out.size.push(`${w}px ${h}px`);
        out.pos.push(`${x}px ${yy}px`);
      }
      unwrapped.push({ el, style: el.getAttribute('style') });
      el.style.setProperty('background-attachment', out.att.join(', '), 'important');
      el.style.setProperty('background-size', out.size.join(', '), 'important');
      el.style.setProperty('background-position', out.pos.join(', '), 'important');
    }
  }

  // A small sticky element told to stick in the lower half of the screen
  // (Loops' "Book a demo" card, `top: calc(100vh - …)`) is a floating button
  // that follows the reader, not a heading. Put back in flow it lands in
  // the middle of the content, so it's hidden like the other extras. So is
  // a small one stuck by its bottom edge (`top: auto; bottom: 24px`): it
  // rides the bottom of the screen, the way a "back to top" button or a
  // floating call button does (www.louvre.fr's is a zero-height box whose
  // button hangs out of it, measured by what it holds).
  function floatsLow(el, cs) {
    const top = parseFloat(cs.top);
    const byBottom = cs.top === 'auto' && cs.bottom !== 'auto';
    const r = screenBox(el);
    return (top >= window.innerHeight * 0.5 || byBottom) && !!r && r.width > 0 && r.height > 0 &&
      r.height < window.innerHeight * 0.3 && r.width < document.documentElement.clientWidth * 0.5;
  }

  function settleOverlays() {
    allElements().forEach((el) => {
      const cs = getComputedStyle(el);
      if (cs.position === 'sticky') {
        stickySeen.add(el);
        if (floatsLow(el, cs)) overlays.set(el, 'extra');
        else if (!inHeaderZone(el) && !isPinnedSection(el)) el.setAttribute('data-cleanshot-unstick', '');
      } else if (cs.position === 'fixed' && el.classList.contains('Parallax-item')) {
        el.setAttribute('data-cleanshot-parallax', '');
      } else if (cs.position === 'fixed' && clippedByAncestor(el)) {
        unwrapped.push({ el, style: el.getAttribute('style') });
        el.style.setProperty('position', 'absolute', 'important');
        el.style.setProperty('inset', '0', 'important');
        el.style.setProperty('width', '100%', 'important');
        el.style.setProperty('height', '100%', 'important');
        el.querySelectorAll('img, video').forEach((media) => {
          unwrapped.push({ el: media, style: media.getAttribute('style') });
          media.style.setProperty('height', '100%', 'important');
          media.style.setProperty('object-fit', 'cover', 'important');
        });
      } else if (cs.position === 'fixed') {
        const r = el.getBoundingClientRect();
        if (r.width > 0 && r.width <= 16 && r.height >= 60) {
          unwrapped.push({ el, style: el.getAttribute('style') });
          el.style.setProperty('visibility', 'hidden', 'important');
        }
      }
    });
  }

  // The page can move under the capture between two tiles: a carousel that
  // resizes to each slide (Premier Roofing's testimonials swing by 300px), a
  // header that shrinks once the page scrolls, an embed that loads late. To
  // tell the worker where the next tile belongs, note a few pieces of
  // ordinary page content in the lower part of each tile, where the next
  // one overlaps it, and on the next tile measure how far they moved.
  function pinnedToScreen(el) {
    for (let a = el; a && a !== document.body; a = a.parentElement) {
      if (/^(fixed|sticky)$/.test(getComputedStyle(a).position)) return true;
    }
    return false;
  }

  // Sampled from the bottom third of the screen, where the next tile picks
  // up. Each piece must start close above the point it was found at, so a
  // big section box whose top sits far away (above a carousel that resizes)
  // doesn't stand in for the content at the seam.
  function recordAnchors() {
    const vw = document.documentElement.clientWidth;
    const vh = window.innerHeight;
    const y = scroller.scrollTop;
    const seen = new Set();
    anchors = [];
    for (let row = 0; row < 6; row++) {
      for (let col = 0; col < 7; col++) {
        const py = vh * (0.7 + 0.05 * row);
        const el = document.elementFromPoint(vw * (col + 0.5) / 7, py);
        if (!el || seen.has(el) || el === document.body || el === document.documentElement) continue;
        seen.add(el);
        const r = el.getBoundingClientRect();
        if (r.height === 0 || r.top < py - 300 || pinnedToScreen(el)) continue;
        anchors.push({ el, y: r.top + y });
      }
    }
  }

  // How far the content noted on the last tile has moved since, in page px
  // (positive: it moved down). Null when too few pieces agree to trust.
  // A piece pinned to the screen since (a column a script made sticky) left
  // the page's flow; where it went says nothing about the content.
  function measureDrift() {
    const y = scroller.scrollTop;
    const deltas = anchors
      .filter((a) => a.el.isConnected && !pinnedToScreen(a.el))
      .map((a) => ({ a, r: a.el.getBoundingClientRect() }))
      .filter(({ r }) => r.height > 0)
      .map(({ a, r }) => r.top + y - a.y)
      .sort((p, q) => p - q);
    if (deltas.length < 3) return null;
    const mid = deltas[deltas.length >> 1];
    const agree = deltas.filter((d) => Math.abs(d - mid) <= 2).length;
    return agree >= Math.max(3, deltas.length / 2) ? mid : null;
  }

  // Canvases on screen: a WebGL image effect (Squarespace's section and
  // image effects on boulderlanddesign.com) or an animation draws them
  // itself, by the scroll or the clock, out of reach of the stylesheet, so
  // they can't be held still. The worker takes each one that fits on a
  // screen whole from one shot, and reports the ones it couldn't.
  // The same goes for everything else whose content runs on a clock the
  // capture can't stop: a frame from another site (a YouTube or Vimeo
  // player, a Google map), which the extension can't reach into; a video
  // that is still playing when the tile is shot (the page started it again,
  // or it never had a frame to stop on); and elements the page keeps
  // changing on its own (see watchRestless). A wrapper taller than two
  // screens that the page restyles (a body class, a section marked as
  // visited) says nothing about where the motion is, so it's left out.
  let frameSeen = new WeakMap(); // frame from another site -> when it came on screen (null: off screen)
  const frameWatch = new IntersectionObserver((list) => {
    for (const e of list) frameSeen.set(e.target, e.isIntersecting ? (frameSeen.get(e.target) ?? e.time) : null);
  });
  function liveRegions() {
    const vh = window.innerHeight;
    const vw = document.documentElement.clientWidth;
    const out = [];
    // What shows of it: a background video frame is often made larger than
    // its section (r-o.com's Vimeo hero runs 212px above and below) and cut
    // to it by the section's overflow, so it's only as tall as the section.
    // A slider's track, slid sideways by thousands of pixels, lies outside
    // the window it is seen through; it shows as that window.
    const shownRect = (el) => {
      const b = el.getBoundingClientRect();
      let top = b.top, bottom = b.bottom, left = b.left, right = b.right;
      let win = null;
      for (let a = el.parentElement, k = 0; a && a !== document.body && k < 30; a = a.parentElement, k++) {
        const cs = getComputedStyle(a);
        const clip = cs.clipPath !== 'none';
        const cy = clip || cs.overflowY !== 'visible', cx = clip || cs.overflowX !== 'visible';
        if (!cx && !cy) continue;
        const p = a.getBoundingClientRect();
        if (cy) { top = Math.max(top, p.top); bottom = Math.min(bottom, p.bottom); }
        if (cx) {
          if (!win) win = p;
          left = Math.max(left, p.left); right = Math.min(right, p.right);
        }
      }
      if (right - left < 1 && win && b.bottom > win.top && b.top < win.bottom) ({ left, right } = win);
      return { top, bottom, left, right, width: right - left, height: bottom - top };
    };
    const add = (el, kind) => {
      const r = shownRect(el);
      if (r.width < 100 || r.height < 60 || r.bottom <= 0 || r.top >= vh || r.right <= 0 || r.left >= vw) return;
      if (kind === 'moving' && r.height > 2 * vh) return;
      if (!el.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true }) || pinnedToScreen(el)) return;
      if (!liveIds.has(el)) liveIds.set(el, ++liveCount);
      // (Outwards: a frame that starts half a pixel into a row paints part of
      // that row, which must come from the same shot as the rest of it.)
      out.push({ id: liveIds.get(el), kind, top: Math.floor(r.top), bottom: Math.ceil(r.bottom), left: Math.floor(Math.max(0, r.left)), right: Math.ceil(Math.min(vw, r.right)) });
    };
    // (A still that stands in for a canvas or video holds one frame.)
    document.querySelectorAll('canvas:not([data-cleanshot-still])').forEach((el) => add(el, 'canvas'));
    document.querySelectorAll('iframe, embed, object').forEach((el) => {
      let reachable = false;
      try { reachable = !!el.contentDocument; } catch (_) {}
      if (reachable) return;
      add(el, 'frame');
      // (How long it has been on screen without a break, for the worker's
      // wait for it to finish painting.)
      if (!frameSeen.has(el)) { frameSeen.set(el, null); frameWatch.observe(el); }
      const since = frameSeen.get(el);
      const r = out[out.length - 1];
      if (r && r.id === liveIds.get(el)) r.shownMs = since == null ? 0 : Math.round(performance.now() - since);
    });
    for (const v of frozenVideos.keys()) if (v.isConnected && !v.paused) add(v, 'video');
    // A small part that changes (a slider's dots, a line of text a demo
    // types out, a counter) stands for the nearest box around it big enough
    // to matter: the slider, the card.
    // Slides that take turns (a crossfade gallery: each changes only as it
    // comes in or goes out, and the hidden ones can't be seen) stand for
    // what holds them once two of them have been seen changing.
    const moving = new Set();
    const siblings = new Map();
    for (const el of restless) if (el.isConnected && el.parentElement) siblings.set(el.parentElement, (siblings.get(el.parentElement) || 0) + 1);
    for (const el of restless) {
      if (!el.isConnected) { restless.delete(el); continue; }
      let box = siblings.get(el.parentElement) >= 2 ? el.parentElement : el;
      for (let k = 0; box && box !== document.body && k < 8; k++, box = box.parentElement) {
        const r = box.getBoundingClientRect();
        if (r.width >= 100 && r.height >= 60) break;
      }
      if (!box || box === document.body || moving.has(box) || box.closest('[data-cleanshot-clone]')) continue;
      moving.add(box);
      add(box, 'moving');
    }
    return out;
  }

  function restore() {
    // Newest first, so an element changed twice ends up with its original style.
    for (const { el, style } of unwrapped.reverse()) {
      if (style === null) el.removeAttribute('style');
      else el.setAttribute('style', style);
    }
    unwrapped = [];
    hiddenEls.forEach(unhide);
    hiddenEls = [];
    for (const el of inflow) {
      el.removeAttribute('data-cleanshot-inflow');
      dropInflowInline(el);
      ['--cleanshot-top', '--cleanshot-left', '--cleanshot-width'].forEach((p) => el.style.removeProperty(p));
    }
    inflow = new Set();
    flowBoxes = new Map();
    for (const [v, { wasPlaying }] of frozenVideos) {
      if (wasPlaying) v.play().catch(() => {});
    }
    frozenVideos = new Map();
    pausedAnimations.forEach((anim) => anim.play());
    pausedAnimations = [];
    clockHeld = false;
    document.documentElement.removeAttribute('data-cleanshot-shot');
    retried = new WeakSet();
    failedImages = new Set();
    for (const { f, play, resume } of players) {
      if (resume && f.isConnected) try { f.contentWindow.postMessage(play, '*'); } catch (_) {}
    }
    players = [];
    if (restlessWatch) restlessWatch.disconnect();
    restlessWatch = null;
    restless = new Set();
    changedOnce = new WeakMap();
    for (const el of pinned) {
      el.removeAttribute('data-cleanshot-hold');
      HOLD.forEach(([, css]) => el.style.removeProperty(`--cleanshot-${css}`));
    }
    pinned = new Set();
    document.querySelectorAll('[data-cleanshot-clone]').forEach((el) => el.remove());
    document.querySelectorAll('[data-cleanshot-filmed]').forEach((el) => el.removeAttribute('data-cleanshot-filmed'));
    document.querySelectorAll('[data-cleanshot-unstick]').forEach((el) => el.removeAttribute('data-cleanshot-unstick'));
    document.querySelectorAll('[data-cleanshot-keep]').forEach((el) => {
      el.removeAttribute('data-cleanshot-keep');
      el.style.removeProperty('--cleanshot-height');
    });
    clones = [];
    notes = [];
    stops = [];
    for (const { el } of held) {
      el.removeAttribute('data-cleanshot-fade');
      el.removeAttribute('data-cleanshot-fade-tf');
      el.removeAttribute('data-cleanshot-probe');
      el.style.removeProperty('--cleanshot-op');
      el.style.removeProperty('--cleanshot-tf');
      el.style.removeProperty('--cleanshot-tr');
    }
    held = [];
    tileOps = new WeakMap();
    scrollLinked = new Map();
    topOffsets = new Map();
    fades = new Map();
    backdrops = new Map();
    pageColors = new Map();
    document.querySelectorAll('[data-cleanshot-parallax]').forEach((el) => el.removeAttribute('data-cleanshot-parallax'));
    document.querySelectorAll('[data-cleanshot-unpin]').forEach((el) => el.removeAttribute('data-cleanshot-unpin'));
    document.querySelectorAll('[data-cleanshot-spacer]').forEach((el) => {
      el.removeAttribute('data-cleanshot-spacer');
      el.style.removeProperty('--cleanshot-pad');
    });
    firstScreen = new Map();
    stickySeen = new WeakSet();
    anchors = [];
    stickyHeaders = new Set();
    overlays = new Map();
    if (styleEl && styleEl.parentNode) styleEl.parentNode.removeChild(styleEl);
    styleEl = null;
    scroller.scrollTo(0, originalScrollY);
  }

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    (async () => {
      try {
        if (msg.cmd === 'wake') {
          // (Watched from once the page has settled after waking: what the
          // woken scripts do as they start up is setting up, not a clock.)
          const woke = await wakePage();
          watchRestless();
          sendResponse({ ok: true, ...woke });
        } else if (msg.cmd === 'hold') {
          clockHeld = true;
          pauseClockAnimations();
          pausePlayers();
          sendResponse({ ok: true });
        } else if (msg.cmd === 'prepare') {
          watchRestless();
          originalScrollY = scroller.scrollTop || window.scrollY || 0;
          unlockScroll();
          pauseLoopingAnimations();
          injectStyle();
          unwrapInnerScroller();
          await preScroll();
          await paintBackdrop();
          unpinScrollMagic();
          await filmPinnedSections();
          await settleFixedBackgrounds();
          settleOverlays();
          holdFades();
          placeRevealedBackdrop();
          findStickyHeaders(); // measured at scroll 0, after preScroll settles
          sortOverlays(true);
          await extendBackdrops();
          await settleAtTop();
          recordFirstScreen();
          await holdScrollLinked();
          const rawH = pageHeight();
          const capped = Math.min(rawH, MAX_PAGE_HEIGHT);
          if (rawH > MAX_PAGE_HEIGHT) {
            console.warn(`[CleanShot] page height ${rawH}px exceeds cap; capturing first ${MAX_PAGE_HEIGHT}px.`);
          }
          anchors = [];
          sendResponse({
            ok: true,
            pageHeight: capped,
            rawPageHeight: rawH,
            viewportHeight: window.innerHeight,
            pageWidth: document.documentElement.clientWidth,
            dpr: window.devicePixelRatio || 1,
            notes
          });
        } else if (msg.cmd === 'tile') {
          covered = [];
          unlockScroll();
          if (msg.from != null && msg.from < msg.y) {
            scrollPage(msg.from);
            await raf();
            await raf();
          }
          scrollPage(msg.y);
          await raf();
          await raf();
          await waitForVisibleImages();
          // Hide once before the settle wait and again after it. Headers
          // that turn fixed on scroll appear within a frame or two, and
          // hiding them only at the last moment isn't always painted by the
          // time the tile is shot. The second pass catches anything slower.
          hideOverlays(msg.index);
          if (msg.index > 0) pinFirstScreen();
          applyFades();
          await sleep(SETTLE_GRACE_MS);
          // Lazy loaders that wait for the scroll to stop (a debounced
          // handler) only swap their images in during the settle wait.
          await waitForVisibleImages();
          hideOverlays(msg.index);
          if (msg.index > 0) pinFirstScreen();
          applyFades();
          noteEntrances();
          await freezeVideos();
          let dirty = [];
          if (clockHeld) {
            pauseClockAnimations();
            pausePlayers();
            // (A page that plays its videos again when they come into view
            // has had the settle wait to do it: back on their frame first.)
            await freezeVideos();
            const st = await requestStills();
            if (st && st.dirty) dirty = st.dirty;
          }
          await raf();
          await raf();
          // Report where we actually landed (bottom tile clamps short), how
          // far the page moved since the last tile, and how far it scrolls
          // now, measured as late as possible before the shot. A tile shot
          // again out of turn leaves the anchors to the tile it was shot for.
          const drift = msg.keepAnchors ? null : measureDrift();
          if (!msg.keepAnchors) recordAnchors();
          const actualY = scroller.scrollTop || window.scrollY || 0;
          // From here on what is on screen counts as shot, and the page
          // isn't let change it (background.js pageClock).
          if (clockHeld) {
            const shotTo = Math.max(Number(document.documentElement.getAttribute('data-cleanshot-shot')) || 0, Math.ceil(actualY + window.innerHeight));
            document.documentElement.setAttribute('data-cleanshot-shot', String(shotTo));
          }
          const broken = [...failedImages].filter((img) => img.isConnected && !(img.complete && img.naturalWidth > 0)).map((img) => {
            const r = img.getBoundingClientRect();
            return { y0: Math.round(r.top + actualY), y1: Math.round(r.bottom + actualY) };
          }).filter((b) => b.y1 - b.y0 >= 24);
          sendResponse({
            ok: true, actualY, drift, covered, live: liveRegions(), broken, dirty,
            pageHeight: pageHeight(),
            maxScroll: Math.max(0, scroller.scrollHeight - window.innerHeight)
          });
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
