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

  const MAX_PAGE_HEIGHT = 60000; // CSS px — infinite-scroll safeguard
  // JS-driven scroll animations (framer-motion springs, GSAP) aren't sped up
  // by the CSS duration clamp, so give each tile enough time to settle.
  const SETTLE_GRACE_MS = 550;
  // Longest a pre-scroll stop waits for the images it brought on screen.
  const PRESCROLL_IMAGES_MS = 300;

  const scroller = document.scrollingElement || document.documentElement;
  let originalScrollY = 0;
  let styleEl = null;
  let unwrapped = [];           // [{el, style}] for restore
  let hiddenEls = [];           // [{el, prev}] for restore
  let stickyHeaders = new Set(); // sticky elements that behave like a top nav
  let overlays = new Map();      // fixed or sticky element -> 'nav' | 'backdrop' | 'extra' | 'content'
  let frozenVideos = new Map();  // video -> {time, wasPlaying}
  let firstScreen = new Map();   // element -> transform at scroll 0
  let pinned = [];               // elements held at their scroll-0 transform
  let scrollLinked = new Map();  // element -> {ys, xs, tf} seen while pre-scrolling
  let topOffsets = new Map();    // element on the first screen -> vertical offset before pre-scrolling
  let fades = new Map();         // element -> {min, max, last, near, linked} opacity seen while pre-scrolling
  let held = [];                 // [{el, max}] scroll-linked fades and the most visible opacity they reached
  let backdrops = new Map();     // full-screen fixed layer -> colors seen while pre-scrolling
  let pageColors = new Map();    // html and body -> background colors seen while pre-scrolling
  let pausedAnimations = [];     // looping CSS animations held still during capture
  let anchors = [];              // [{el, y}] page content seen in the last tile, and where it sat
  let covered = [];              // screen rects of overlays hidden during this tile

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
      [data-cleanshot-pin] { transform: var(--cleanshot-tf) !important; }
      [data-cleanshot-fade] { opacity: var(--cleanshot-op) !important; }
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
    const pending = Array.from(document.images)
      .filter((img) => !img.complete && onScreen(img))
      .map(loaded);
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
    const waits = [];
    for (const v of visible) {
      const frozen = frozenVideos.get(v);
      if (!frozen) {
        if (v.readyState < 2) {
          waits.push(new Promise((resolve) => {
            v.addEventListener('loadeddata', resolve, { once: true });
            setTimeout(resolve, timeoutMs);
          }).then(() => {
            if (frozenVideos.has(v)) return;
            frozenVideos.set(v, { time: v.currentTime, wasPlaying: !v.paused });
            v.pause();
          }));
          continue;
        }
        frozenVideos.set(v, { time: v.currentTime, wasPlaying: !v.paused });
        v.pause();
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
  // screen is transformed at scroll 0, and hold it there for later tiles.
  function recordFirstScreen() {
    const vh = window.innerHeight;
    allElements().forEach((el) => {
      const r = el.getBoundingClientRect();
      if (r.height > 0 && r.top < vh && r.bottom > 0) {
        firstScreen.set(el, getComputedStyle(el).transform);
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
      return el.isConnected && s && s.ys.size > 1 && s.xs.size <= 1;
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
    for (const [el, tf] of firstScreen) {
      if (el.hasAttribute('data-cleanshot-pin')) continue;
      if (getComputedStyle(el).transform === tf) continue;
      el.style.setProperty('--cleanshot-tf', tf);
      el.setAttribute('data-cleanshot-pin', '');
      pinned.push(el);
    }
  }

  // JS parallax below the fold (Design Museum Danmark's TweenMax handler,
  // Rellax) slides images up and down as the page scrolls, so every tile
  // catches them at a different offset: cut off at the seams, or drifted
  // away from their text. While pre-scrolling, note the elements whose
  // vertical offset keeps changing with the scroll. Sideways movement is
  // left out, since that's a carousel or marquee rather than parallax.
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
    allElements().forEach((el) => {
      const cs = getComputedStyle(el);
      const r = el.getBoundingClientRect();
      if (cs.position === 'fixed') {
        if (r.width >= vw * 0.9 && r.height >= vh * 0.9) {
          if (!backdrops.has(el)) backdrops.set(el, new Set());
          backdrops.get(el).add(cs.backgroundColor);
        }
      }
      const near = r.height > 0 && r.bottom > -vh / 2 && r.top < vh * 1.5;
      const op = Number(cs.opacity);
      const f = fades.get(el);
      if (!f) {
        fades.set(el, { min: op, max: op, last: op, near, linked: false });
      } else {
        if (Math.abs(op - f.last) > 0.01 && (near || f.near)) f.linked = true;
        f.min = Math.min(f.min, op);
        f.max = Math.max(f.max, op);
        f.last = op;
        f.near = near;
      }
      // (A second look at the same scroll position says nothing about
      // what moves with the scroll.)
      if (fadesOnly) return;
      const tf = cs.transform;
      if (atTop && r.height > 0 && r.top < vh && r.bottom > 0) {
        topOffsets.set(el, tf === 'none' ? 0 : new DOMMatrix(tf).m42);
      }
      let seen = scrollLinked.get(el);
      if (!seen) {
        if (tf === 'none') return;
        seen = { ys: new Set(), xs: new Set(), tf };
        scrollLinked.set(el, seen);
      }
      const m = new DOMMatrix(tf === 'none' ? undefined : tf);
      seen.ys.add(Math.round(m.m42));
      seen.xs.add(Math.round(m.m41));
      if (tf !== 'none') seen.tf = tf;
    });
  }

  // Hold each of those with its vertical offset removed, which is where the
  // layout puts it and where parallax scripts rest it when it's centered on
  // screen. Elements on the first screen are already held at scroll 0.
  function holdScrollLinked() {
    for (const [el, { ys, xs, tf }] of scrollLinked) {
      if (ys.size < 3 || xs.size > 1 || firstScreen.has(el)) continue;
      const m = new DOMMatrix(tf);
      m.m42 = 0;
      el.style.setProperty('--cleanshot-tf', m.toString());
      el.setAttribute('data-cleanshot-pin', '');
      pinned.push(el);
    }
    scrollLinked = new Map();
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
      if (!f.linked || f.max - f.min < 0.05 || !el.isConnected) continue;
      if (!(el instanceof HTMLElement) || el.closest('svg') || pinnedToScreen(el)) continue;
      list.push({ el, max: f.max, r: el.getBoundingClientRect() });
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
      .map(({ el, max }) => ({ el, max }));
  }

  // Before each tile, let go of the holds and read where the page has each
  // fade now. One still below the most it has reached is held there; one at
  // or past it (a fade-in that has since finished, maybe beyond what the
  // pre-scroll caught mid-way) is left to the page, and raises the mark for
  // later tiles. Through the stylesheet, since the page's script keeps
  // writing inline opacity. Transitions are off while this happens: letting
  // go would otherwise start one, and the value read back would be where it
  // starts, the held one.
  function applyFades() {
    if (!held.length) return;
    held.forEach((h) => {
      h.el.setAttribute('data-cleanshot-probe', '');
      h.el.removeAttribute('data-cleanshot-fade');
    });
    const now = held.map((h) => Number(getComputedStyle(h.el).opacity));
    held.forEach((h, k) => {
      if (now[k] >= h.max - 0.01) {
        h.max = Math.max(h.max, now[k]);
        return;
      }
      h.el.style.setProperty('--cleanshot-op', String(h.max));
      h.el.setAttribute('data-cleanshot-fade', '');
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
    // the last few stops are still running when the first look comes.
    scroller.scrollTo(0, h);
    await sleep(120);
    sampleScrollEffects(true);
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
    const r = screenBox(el);
    if (el.matches(DIALOG)) return 'extra';
    if (r.width >= vw * 0.9 && r.height >= vh * 0.9) return isScrimOrDialog(el) ? 'extra' : 'backdrop';
    if (r.top <= 150) {
      const h = Math.max(r.height, el.scrollHeight);
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
  function lateRole(el) {
    const r = screenBox(el);
    const tall = r.height >= window.innerHeight * 0.6 && r.width >= document.documentElement.clientWidth * 0.5;
    return tall && !el.matches(DIALOG) && !isScrimOrDialog(el) ? 'content' : 'extra';
  }

  // Sort every fixed element on screen that hasn't been sorted yet. At scroll
  // 0 that is the rule above; further down, only the late rule can apply.
  // Elements with nothing to show yet (a closed drawer, a popup not opened)
  // wait until they do.
  function sortOverlays(atTop) {
    allElements().forEach((el) => {
      if (overlays.has(el) || getComputedStyle(el).position !== 'fixed') return;
      const r = screenBox(el);
      if (!r || r.width <= 0 || r.height <= 0) return;
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
  function hideOverlays(index) {
    const vh = window.innerHeight;
    if (index === 0) {
      hiddenEls = hiddenEls.filter((h) => {
        if (!h.later) return true;
        if (h.prev) h.el.style.setProperty('visibility', h.prev);
        else h.el.style.removeProperty('visibility');
        if (h.prevOpacity) h.el.style.setProperty('opacity', h.prevOpacity);
        else h.el.style.removeProperty('opacity');
        return false;
      });
    }
    const hide = (el, later) => {
      if (hiddenEls.some((h) => h.el === el)) return;
      const cs = getComputedStyle(el);
      if (cs.visibility === 'hidden' || cs.display === 'none') return;
      // Where it sat on screen: the last tile showed it there, this one
      // won't, so the worker leaves that area out when it lines them up.
      const r = el.getBoundingClientRect();
      if (r.width > 0 && r.height > 0 && r.bottom > 0 && r.top < vh) {
        covered.push({ top: Math.round(r.top), bottom: Math.round(r.bottom), left: Math.round(r.left), right: Math.round(r.right) });
      }
      hiddenEls.push({ el, later, prev: el.style.visibility, prevOpacity: el.style.opacity });
      el.style.setProperty('visibility', 'hidden', 'important');
      el.style.setProperty('opacity', '0', 'important');
    };
    sortOverlays(index === 0);
    for (const [el, role] of overlays) {
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

  // A sticky heading or sidebar inside a tall section (17A's "A decade of
  // supporting public leaders") follows the reader down, so it lands in
  // every tile it passes through. Measured at scroll 0: top navs sit in the
  // header zone and pinned storytelling sections fill most of the screen,
  // and both are left alone. A taller one that only fills part of the width
  // inside a much taller container (Whitney's Lichtenstein feature beside
  // the exhibitions list) is a column the rest of the section scrolls past,
  // so it goes back in flow too.
  function isStickyColumn(el) {
    const r = el.getBoundingClientRect();
    const h = shownHeight(el);
    if (r.top + scroller.scrollTop <= 150 || h <= 0) return false;
    if (h < window.innerHeight * 0.6) return true;
    const box = el.parentElement && el.parentElement.getBoundingClientRect();
    return r.width < document.documentElement.clientWidth * 0.7 && !!box && box.height > h * 1.5;
  }

  // A small sticky element told to stick in the lower half of the screen
  // (Loops' "Book a demo" card, `top: calc(100vh - …)`) is a floating button
  // that follows the reader, not a heading. Put back in flow it lands in
  // the middle of the content, so it's hidden like the other extras.
  function floatsLow(el, cs) {
    const top = parseFloat(cs.top);
    const r = screenBox(el);
    return top >= window.innerHeight * 0.5 && !!r &&
      r.height < window.innerHeight * 0.3 && r.width < document.documentElement.clientWidth * 0.5;
  }

  function settleOverlays() {
    allElements().forEach((el) => {
      const cs = getComputedStyle(el);
      if (cs.position === 'sticky' && cs.bottom !== 'auto' && cs.top === 'auto') {
        unwrapped.push({ el, style: el.getAttribute('style') });
        el.style.setProperty('position', 'relative', 'important');
      } else if (cs.position === 'sticky' && floatsLow(el, cs)) {
        overlays.set(el, 'extra');
      } else if (cs.position === 'sticky' && isStickyColumn(el)) {
        unwrapped.push({ el, style: el.getAttribute('style') });
        el.style.setProperty('position', 'relative', 'important');
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
  function measureDrift() {
    const y = scroller.scrollTop;
    const deltas = anchors
      .filter((a) => a.el.isConnected)
      .map((a) => ({ a, r: a.el.getBoundingClientRect() }))
      .filter(({ r }) => r.height > 0)
      .map(({ a, r }) => r.top + y - a.y)
      .sort((p, q) => p - q);
    if (deltas.length < 3) return null;
    const mid = deltas[deltas.length >> 1];
    const agree = deltas.filter((d) => Math.abs(d - mid) <= 2).length;
    return agree >= Math.max(3, deltas.length / 2) ? mid : null;
  }

  function restore() {
    // Newest first, so an element changed twice ends up with its original style.
    for (const { el, style } of unwrapped.reverse()) {
      if (style === null) el.removeAttribute('style');
      else el.setAttribute('style', style);
    }
    unwrapped = [];
    for (const { el, prev, prevOpacity } of hiddenEls) {
      if (prev) el.style.setProperty('visibility', prev);
      else el.style.removeProperty('visibility');
      if (prevOpacity) el.style.setProperty('opacity', prevOpacity);
      else el.style.removeProperty('opacity');
    }
    hiddenEls = [];
    for (const [v, { wasPlaying }] of frozenVideos) {
      if (wasPlaying) v.play().catch(() => {});
    }
    frozenVideos = new Map();
    pausedAnimations.forEach((anim) => anim.play());
    pausedAnimations = [];
    for (const el of pinned) {
      el.removeAttribute('data-cleanshot-pin');
      el.style.removeProperty('--cleanshot-tf');
    }
    pinned = [];
    for (const { el } of held) {
      el.removeAttribute('data-cleanshot-fade');
      el.removeAttribute('data-cleanshot-probe');
      el.style.removeProperty('--cleanshot-op');
    }
    held = [];
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
          sendResponse({ ok: true, ...await wakePage() });
        } else if (msg.cmd === 'prepare') {
          originalScrollY = scroller.scrollTop || window.scrollY || 0;
          unlockScroll();
          pauseLoopingAnimations();
          injectStyle();
          unwrapInnerScroller();
          await preScroll();
          await paintBackdrop();
          unpinScrollMagic();
          settleOverlays();
          holdFades();
          placeRevealedBackdrop();
          findStickyHeaders(); // measured at scroll 0, after preScroll settles
          sortOverlays(true);
          await settleAtTop();
          recordFirstScreen();
          holdScrollLinked();
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
            dpr: window.devicePixelRatio || 1
          });
        } else if (msg.cmd === 'tile') {
          covered = [];
          unlockScroll();
          scroller.scrollTo(0, msg.y);
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
          await freezeVideos();
          await raf();
          await raf();
          // Report where we actually landed (bottom tile clamps short), how
          // far the page moved since the last tile, and how far it scrolls
          // now, measured as late as possible before the shot. A tile shot
          // again out of turn leaves the anchors to the tile it was shot for.
          const drift = msg.keepAnchors ? null : measureDrift();
          if (!msg.keepAnchors) recordAnchors();
          const actualY = scroller.scrollTop || window.scrollY || 0;
          sendResponse({
            ok: true, actualY, drift, covered,
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
