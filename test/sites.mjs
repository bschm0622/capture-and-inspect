// The regression set: live sites that each broke the capture once, with one
// check per known failure. `collect` runs in the page after the capture
// (the extension has restored the page by then, and lazy content below the
// fold has loaded) and returns the DOM facts its checks need, in page
// coordinates, which are also the capture's coordinates. `checks` maps a
// check name to a function of { img, cap, tiles, vh, facts }.
//
// To add a site: append an entry with host, url and (optionally) a
// `waitUntil`, `collect` and `checks`. A site with no checks still gets the
// generic detectors.

import { seams, repeatedOverlays, boundaries } from './lib/detectors.mjs';
import { flatShare, findStrip, seamRepeats, showsIn, result } from './lib/regions.mjs';

// Floating extras (cookie banners, popups, promo and widget buttons) found on
// the live page's first screen after the capture, and the site's fixed
// header. `facts.extras` / `facts.nav` hold their boxes; `shot` is that first
// screen. An extra must not be in the capture; the header must.
const SHOWN = 0.6; // share of an element's own marks the capture reproduces

function extrasCaptured({ img, shot, facts }) {
  const ex = facts.extras || [];
  if (!ex.length) return result(false, null, 'no floating extra showing on the page to look for');
  if (!shot) return result(false, null, 'no first-screen screenshot');
  const seen = ex.map((e) => ({ e, s: showsIn(img, shot, e) })).filter((f) => f.s != null);
  if (!seen.length) return result(false, null, `${ex.length} extra(s) found, none with enough marks to compare`);
  const flags = seen.filter((f) => f.s >= SHOWN).map((f) => ({ y0: f.e.top, y1: f.e.top + f.e.h, note: `${f.e.what} in the capture (${Math.round(f.s * 100)}% of its marks)` }));
  const most = Math.max(...seen.map((f) => f.s));
  return result(flags.length === 0, +most.toFixed(2), seen.map((f) => `${f.e.what} ${Math.round(f.s * 100)}%`).join(', ') + ` of marks in the capture (fail at ${SHOWN * 100}%)`, flags);
}

function navKept({ img, shot, facts }) {
  const n = facts.nav;
  if (!n) return result(false, null, 'fixed header not found on the page');
  if (!shot) return result(false, null, 'no first-screen screenshot');
  const s = showsIn(img, shot, n, { light: !!n.light });
  if (s == null) return result(false, null, 'header has too few marks to compare');
  return result(s >= SHOWN, +s.toFixed(2), `${Math.round(s * 100)}% of the header's marks in the capture (fail under ${SHOWN * 100}%)`, s >= SHOWN ? [] : [{ y0: n.top, y1: n.top + n.h, note: 'header missing' }]);
}

export const SITES = [
  {
    host: 'newchristendompress.com',
    url: 'https://newchristendompress.com',
    collect: () => {
      const R = (el) => { const r = el.getBoundingClientRect(); return { top: Math.round(r.top + scrollY), left: Math.round(r.left), w: Math.round(r.width), h: Math.round(r.height) }; };
      const shown = (el) => { const r = el.getBoundingClientRect(), cs = getComputedStyle(el); return r.width > 0 && r.height > 0 && r.top < innerHeight && cs.visibility !== 'hidden' && +cs.opacity > 0; };
      const extras = [...document.querySelectorAll('.popup-teaser, dialog[open], [aria-modal="true"]')].filter(shown).map((el) => ({ what: el.className ? `.${String(el.className).trim().split(/\s+/)[0]}` : el.tagName.toLowerCase(), ...R(el) }));
      return { videos: [...document.querySelectorAll('video')].map(R).filter((r) => r.w >= 300 && r.h >= 200), extras };
    },
    checks: {
      // The "Get 10% off" button and the newsletter popup floated over the
      // hero (the popup's dimming also left a step at the first tile edge,
      // which the generic seam detector catches).
      'floating-extras-captured': extrasCaptured,
      // Video frames differ between tiles, leaving bands.
      'video-frame-bands'({ img, tiles, facts }) {
        if (!facts.videos || !facts.videos.length) return result(false, null, 'no video found on the page');
        const flags = [];
        for (const v of facts.videos) {
          const r = seams(img, tiles, { region: { y0: v.top + 2, y1: v.top + v.h - 2, x: v.left, w: v.w }, minBlocks: 1 });
          flags.push(...r.flags);
        }
        return result(flags.length === 0, flags.length, `${flags.length} tile boundary break(s) inside ${facts.videos.length} video(s)`, flags);
      }
    }
  },
  {
    host: 'www.childrensmuseum.org',
    url: 'https://www.childrensmuseum.org',
    waitUntil: 'domcontentloaded', // `load` never fires under automation
    collect: () => {
      const R = (el) => { const r = el.getBoundingClientRect(); return { top: Math.round(r.top + scrollY), left: Math.round(r.left), w: Math.round(r.width), h: Math.round(r.height) }; };
      return { slideshows: [...document.querySelectorAll('[uk-slideshow], [data-uk-slideshow]')].map(R).filter((r) => r.h > 100) };
    },
    checks: {
      // Hero parallax seam / UIkit slideshow advancing between tiles.
      'hero-slideshow-seam'({ img, tiles, facts }) {
        const s = facts.slideshows && facts.slideshows[0];
        if (!s) return result(false, null, 'no UIkit slideshow found on the page');
        const r = seams(img, tiles, { region: { y0: s.top + 2, y1: s.top + s.h - 2, x: s.left, w: s.w }, minBlocks: 1 });
        return result(r.pass, r.flags.length, `${r.flags.length} tile boundary break(s) inside the hero slideshow (${s.top}-${s.top + s.h}px)`, r.flags);
      }
    }
  },
  {
    host: 'www.group17a.com',
    url: 'https://www.group17a.com',
    collect: () => {
      const R = (el) => { const r = el.getBoundingClientRect(); return { top: Math.round(r.top + scrollY), left: Math.round(r.left), w: Math.round(r.width), h: Math.round(r.height) }; };
      const h = [...document.querySelectorAll('h1, h2, h3')].find((e) => /a decade of supporting/i.test(e.textContent));
      if (!h) return { heading: null };
      // The block that sticks: the heading's nearest sticky ancestor.
      let block = h;
      for (let a = h; a && a !== document.body; a = a.parentElement) if (getComputedStyle(a).position === 'sticky') { block = a; break; }
      let sec = block.parentElement;
      while (sec && sec.parentElement && sec.getBoundingClientRect().height < innerHeight * 1.2) sec = sec.parentElement;
      return { heading: R(block), section: sec ? R(sec) : null };
    },
    checks: {
      // A sticky heading in a tall section lands in every tile it passes.
      'sticky-heading-duplicated'({ img, facts }) {
        const h = facts.heading;
        if (!h) return result(false, null, '"A decade of supporting…" heading not found on the page');
        const s0 = facts.section ? facts.section.top : h.top - 1500, s1 = facts.section ? facts.section.top + facts.section.h : h.top + 1500;
        // Match each half of the sticky block on its own: a copy cut off by
        // a tile edge still repeats one of them.
        const half = Math.floor(h.h / 2);
        const parts = [{ ...h, h: half }, { ...h, top: h.top + half, h: h.h - half }];
        const found = parts.map((p) => ({ p, ...findStrip(img, p, s0, s1) }));
        if (found.every((f) => f.rows < 8)) return result(false, 0, `heading block not visible at its place (${h.top}px)`, [{ y0: h.top, y1: h.top + h.h, note: 'expected heading here' }]);
        const extra = found.flatMap((f) => f.matches.filter((y) => Math.abs(y - f.p.top) > 8).map((y) => ({ y0: y, y1: y + f.p.h, note: 'copy of the sticky heading block' })));
        const most = Math.max(...found.map((f) => f.matches.length));
        return result(extra.length === 0, most, `sticky heading block (${h.top}-${h.top + h.h}px) appears ${most}× in its section`, extra);
      }
    }
  },
  {
    host: 'instant.ai',
    url: 'https://instant.ai',
    checks: {
      // The document doesn't scroll; an inner div does.
      'inner-scroller-captured'({ img, cap }) {
        const inner = cap.factsBefore.innerScrollerHeight;
        if (!inner) return result(true, null, 'no inner scroller on the page now (document scrolls)');
        const r = img.H / inner;
        return result(r >= 0.9, +r.toFixed(2), `capture ${img.H}px vs inner scroller content ${inner}px`, r >= 0.9 ? [] : [{ y0: img.H - 4, y1: img.H, note: 'capture ends here' }]);
      }
    }
  },
  {
    host: 'www.fieldmuseum.org',
    url: 'https://www.fieldmuseum.org',
    checks: {
      // A zero-height sticky header repeated at the top of every tile.
      'header-repeated'({ img, tiles }) {
        const r = repeatedOverlays(img, tiles, { zone: 150 });
        return result(r.pass, r.flags.length, `${r.flags.length} tile top(s) repeating the strip above them`, r.flags);
      }
    }
  },
  {
    host: 'www.dentalcareseattle.com',
    url: 'https://www.dentalcareseattle.com',
    collect: () => {
      const R = (el) => { const r = el.getBoundingClientRect(); return { top: Math.round(r.top + scrollY), left: Math.round(r.left), w: Math.round(r.width), h: Math.round(r.height) }; };
      return { sections: [...document.querySelectorAll('.Index-page--has-image')].map(R).filter((r) => r.h > 100) };
    },
    checks: {
      // Squarespace 7.0 parallax images missing, leaving blank bands.
      'parallax-images-missing'({ img, facts }) {
        if (!facts.sections || !facts.sections.length) return result(false, null, 'no Squarespace image sections found');
        const flags = [];
        const shares = facts.sections.map((s) => {
          const f = flatShare(img, { y0: s.top, y1: s.top + s.h, x: s.left, w: s.w });
          if (f > 0.5) flags.push({ y0: s.top, y1: s.top + s.h, note: `image section ${Math.round(f * 100)}% flat rows` });
          return f;
        });
        return result(flags.length === 0, +Math.max(...shares).toFixed(2), `flat-row share per image section: ${shares.map((f) => `${Math.round(f * 100)}%`).join(', ')} (fail above 50%)`, flags);
      }
    }
  },
  {
    host: 'designmuseum.dk',
    url: 'https://designmuseum.dk',
    collect: () => {
      const R = (el) => { const r = el.getBoundingClientRect(); return { top: Math.round(r.top + scrollY), left: Math.round(r.left), w: Math.round(r.width), h: Math.round(r.height) }; };
      const marked = [...document.querySelectorAll('[data-bg], [data-bg-color], [data-background], [data-background-color]')];
      const sections = marked.filter((el) => !marked.some((o) => o !== el && o.contains(el))).map(R).filter((r) => r.h > 100 && r.left > 40);
      return { sections };
    },
    checks: {
      // Per-section background colours (and white text with them) vanished.
      // Read in the page margin beside each section, where only the
      // full-screen colour layer shows.
      'section-backgrounds-missing'({ img, facts }) {
        const secs = facts.sections || [];
        if (!secs.length) return result(false, null, 'no colour-marked sections found');
        // A section counts as white when most of its rows have a white
        // margin (anything else floating in the margin, like a popup, only
        // covers some rows).
        const x1c = (s) => Math.max(1, Math.floor((s.left - 8) * img.W / img.cssWidth));
        const white = secs.filter((s) => {
          const x1 = x1c(s);
          let rows = 0, whiteRows = 0;
          for (let y = s.top; y < Math.min(img.H, s.top + s.h); y += 2) {
            let w = 0;
            for (let x = 0; x < x1; x++) if (img.luma[y * img.W + x] > 245) w++;
            rows++; if (w / x1 > 0.9) whiteRows++;
          }
          return rows && whiteRows / rows > 0.6;
        });
        const pass = white.length <= secs.length / 2;
        return result(pass, white.length, `${white.length}/${secs.length} colour-marked sections have plain white margins`, pass ? [] : white.map((s) => ({ y0: s.top, y1: s.top + s.h, note: 'section colour missing' })));
      },
      // TweenMax parallax drift: images cut off at tile boundaries. The
      // images' own rects move with the parallax, so look inside the
      // sections that hold them, which don't.
      'parallax-drift'({ img, tiles, facts }) {
        const flags = [];
        for (const s of facts.sections || []) {
          flags.push(...seams(img, tiles, { region: { y0: s.top + 2, y1: s.top + s.h - 2, x: s.left, w: s.w }, minBlocks: 1 }).flags);
        }
        return result(flags.length === 0, flags.length, `${flags.length} tile boundary break(s) inside ${(facts.sections || []).length} image sections`, flags);
      }
    }
  },
  {
    host: 'www.noguchi.org',
    url: 'https://www.noguchi.org',
    collect: () => {
      const R = (el) => { const r = el.getBoundingClientRect(); return { top: Math.round(r.top + scrollY), left: Math.round(r.left), w: Math.round(r.width), h: Math.round(r.height) }; };
      const spacer = [...document.querySelectorAll('.scrollmagic-pin-spacer')].map((s) => ({ s, r: R(s) })).sort((a, b) => b.r.h - a.r.h)[0];
      const pin = spacer && spacer.s.firstElementChild;
      // The fixed full-screen photo behind the page, and the widest empty
      // stretch between its siblings, where it shows through as a window.
      let gap = null;
      const layer = [...document.querySelectorAll('body *')].find((el) => {
        const cs = getComputedStyle(el);
        if (cs.position !== 'fixed' || !(cs.zIndex === 'auto' || Number(cs.zIndex) <= 0)) return false;
        const r = el.getBoundingClientRect();
        return r.width >= innerWidth * 0.9 && r.height >= innerHeight * 0.9 && el.parentElement;
      });
      if (layer) {
        const boxes = [...layer.parentElement.children]
          .filter((el) => el !== layer && !/^(fixed|absolute)$/.test(getComputedStyle(el).position))
          .map(R).filter((r) => r.h > 0).sort((a, b) => a.top - b.top);
        for (let i = 1; i < boxes.length; i++) {
          const size = boxes[i].top - (boxes[i - 1].top + boxes[i - 1].h);
          if (size >= 100 && (!gap || size > gap.h)) gap = { top: boxes[i - 1].top + boxes[i - 1].h, h: size };
        }
      }
      return { spacer: spacer ? spacer.r : null, pin: pin ? R(pin) : null, gap };
    },
    checks: {
      // ScrollMagic-pinned slideshow repeated or vanished.
      'pinned-slideshow'({ img, facts }) {
        const { spacer, pin } = facts;
        if (!spacer || !pin) return result(false, null, 'no ScrollMagic pin found on the page');
        const strip = { top: pin.top, left: pin.left, w: pin.w, h: Math.min(pin.h, 300) };
        const { rows, matches } = findStrip(img, strip, spacer.top, spacer.top + spacer.h);
        if (rows < 8) return result(false, 0, `slideshow not visible at the top of its section (${pin.top}px)`, [{ y0: pin.top, y1: pin.top + strip.h, note: 'slideshow missing' }]);
        const extra = matches.filter((y) => Math.abs(y - pin.top) > 8);
        return result(extra.length === 0, matches.length, `slideshow appears ${matches.length}× in its ${spacer.h}px section`, extra.map((y) => ({ y0: y, y1: y + strip.h, note: 'slideshow repeated' })));
      },
      // The fixed garden photo behind a gap between sections left a white band.
      'garden-gap-blank'({ img, facts }) {
        const g = facts.gap;
        if (!g) return result(false, null, 'no gap revealing a fixed backdrop found');
        const f = flatShare(img, { y0: g.top, y1: g.top + g.h });
        return result(f <= 0.5, +f.toFixed(2), `${Math.round(f * 100)}% flat rows in the ${g.h}px gap at ${g.top}px (fail above 50%)`, f <= 0.5 ? [] : [{ y0: g.top, y1: g.top + g.h, note: 'gap is blank' }]);
      }
    }
  },
  {
    host: 'texasprofessionalroofing.com',
    url: 'https://texasprofessionalroofing.com',
    collect: () => {
      const R = (el) => { const r = el.getBoundingClientRect(); return { top: Math.round(r.top + scrollY), left: Math.round(r.left), w: Math.round(r.width), h: Math.round(r.height) }; };
      // Marquee tracks: infinitely animated elements far wider than the
      // screen. Their parent is the visible strip.
      const tracks = document.getAnimations()
        .filter((a) => a.effect && a.effect.target && a.effect.getComputedTiming().iterations === Infinity)
        .map((a) => a.effect.target).filter((el) => el.getBoundingClientRect().width > innerWidth * 2);
      // Clip each strip by every ancestor that clips its overflow, and skip
      // hidden ones: the page also carries an invisible duplicate section.
      const visible = (el) => {
        if (!el.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true })) return null;
        let r = el.getBoundingClientRect();
        let t = r.top, b = r.bottom, l = Math.max(0, r.left), rt = Math.min(innerWidth, r.right);
        for (let a = el.parentElement; a && a !== document.body; a = a.parentElement) {
          const cs = getComputedStyle(a);
          if (cs.overflowX === 'visible' && cs.overflowY === 'visible' && cs.clipPath === 'none') continue;
          const ar = a.getBoundingClientRect();
          t = Math.max(t, ar.top); b = Math.min(b, ar.bottom); l = Math.max(l, ar.left); rt = Math.min(rt, ar.right);
        }
        return b - t > 50 && rt - l > 100 ? { top: Math.round(t + scrollY), left: Math.round(l), w: Math.round(rt - l), h: Math.round(b - t) } : null;
      };
      const consent = [...document.querySelectorAll('.tpr-consent')].filter((el) => el.getBoundingClientRect().height > 0).map((el) => ({ what: 'consent notice', ...R(el) }));
      return { marquees: [...new Set(tracks.map((t) => t.parentElement))].map(visible).filter(Boolean), extras: consent };
    },
    checks: {
      // The cookie notice sat over the hero in the first tile.
      'floating-extras-captured': extrasCaptured,
      // Infinite CSS review marquee raced off screen, leaving a blank band.
      'marquee-blank'({ img, facts }) {
        const ms = facts.marquees || [];
        if (!ms.length) return result(false, null, 'no marquee found on the page');
        const flags = [];
        const shares = ms.map((m) => {
          const f = flatShare(img, { y0: m.top, y1: m.top + m.h, x: m.left, w: m.w });
          if (f > 0.5) flags.push({ y0: m.top, y1: m.top + m.h, note: `marquee strip ${Math.round(f * 100)}% flat rows` });
          return f;
        });
        return result(flags.length === 0, +Math.max(...shares).toFixed(2), `flat-row share per marquee strip: ${shares.map((f) => `${Math.round(f * 100)}%`).join(', ')} (fail above 50%)`, flags);
      }
    }
  },
  {
    host: 'premier-roofing.com',
    url: 'https://premier-roofing.com',
    checks: {
      // The testimonial carousel resizes to each slide as it rotates, so the
      // page grows and shrinks by up to 300px between tiles. Tiles placed
      // for the old layout repeat a strip across the tile edge (the footer
      // twice) or leave rows never painted (the unpainted-rows detector).
      'page-moved-under-tiles'({ img, tiles, vh }) {
        const flags = seamRepeats(img, boundaries(tiles, img.H), { maxD: vh });
        return result(flags.length === 0, flags.length, `${flags.length} tile edge(s) with the rows above repeated below`, flags);
      }
    }
  },
  {
    host: 'whitney.org',
    url: 'https://whitney.org',
    collect: () => {
      const R = (el) => { const r = el.getBoundingClientRect(); return { top: Math.round(r.top + scrollY), left: Math.round(r.left), w: Math.round(r.width), h: Math.round(r.height) }; };
      // The feature block that sticks beside the scrolling column.
      const el = [...document.querySelectorAll('body *')].find((e) => getComputedStyle(e).position === 'sticky' && e.getBoundingClientRect().height > innerHeight * 0.6);
      // The cookie box, and the big fixed WHITNEY logo that heads the page.
      const extras = [...document.querySelectorAll('.cky-consent-container')].filter((e) => e.getBoundingClientRect().height > 0).map((e) => ({ what: 'cookie notice', ...R(e) }));
      const logo = [...document.querySelectorAll('body *')].find((e) => getComputedStyle(e).position === 'fixed' && e.getBoundingClientRect().top < 150 && e.getBoundingClientRect().width > innerWidth * 0.5 && e.querySelector('svg, img'));
      return { ...(el ? { block: R(el), section: R(el.parentElement) } : { block: null }), extras, nav: logo ? R(logo) : null };
    },
    checks: {
      // The cookie notice sat over the hero.
      'floating-extras-captured': extrasCaptured,
      // Hiding the floating extras must not take the fixed logo with them.
      'fixed-nav-kept': navKept,
      // A tall sticky column (the Lichtenstein feature) follows the reader
      // down, so it shows up again in the next tile.
      // Looked for with the repeated-overlay detector inside the block's
      // column: a template cut from the capture doesn't work here, since the
      // cookie notice covers the first copy and a tile edge cuts it.
      'sticky-feature-repeated'({ img, tiles, facts }) {
        const b = facts.block;
        if (!b) return result(false, null, 'no tall sticky block found on the page');
        const s = facts.section;
        const r = repeatedOverlays(img, tiles, { region: { y0: s.top, y1: s.top + s.h, x: s.left, w: s.w } });
        return result(r.pass, r.value, `${r.flags.length} strip(s) of the sticky column (${s.top}-${s.top + s.h}px) repeated at the tile step`, r.flags);
      }
    }
  },
  {
    host: 'www.hitt.com',
    url: 'https://www.hitt.com',
    collect: () => {
      const R = (el) => { const r = el.getBoundingClientRect(); return { top: Math.round(r.top + scrollY), left: Math.round(r.left), w: Math.round(r.width), h: Math.round(r.height) }; };
      // The accessibility button lives in a shadow root.
      const all = [];
      const walk = (root) => root.querySelectorAll('*').forEach((el) => { all.push(el); if (el.shadowRoot) walk(el.shadowRoot); });
      walk(document.body);
      const shown = (el) => { const r = el.getBoundingClientRect(), cs = getComputedStyle(el); return r.width > 0 && r.height > 0 && r.top < innerHeight && cs.visibility !== 'hidden' && +cs.opacity > 0; };
      const extras = [
        ...all.filter((el) => el.matches('.cky-consent-container') && shown(el)).map((el) => ({ what: 'cookie banner', ...R(el) })),
        ...all.filter((el) => el.matches('.trigger-button') && shown(el)).map((el) => ({ what: 'accessibility button', ...R(el) }))
      ];
      // The fixed header is a 1px box its rows spill out of: measure them.
      const header = document.querySelector('header[role="banner"]');
      let nav = null;
      if (header) {
        const rows = [...header.querySelectorAll('*')].filter(shown).map((el) => el.getBoundingClientRect()).filter((r) => r.top >= 0 && r.bottom <= 150);
        // It's see-through over the hero video, so only its white type is
        // compared (the video shows a different frame in the screenshot).
        if (rows.length) nav = { top: 0, left: 0, w: innerWidth, h: Math.round(Math.max(...rows.map((r) => r.bottom))), light: true };
      }
      return { extras, nav };
    },
    checks: {
      // A cookie banner across the bottom of the first screen and an
      // accessibility button beside it (earlier, the button repeated in
      // every tile).
      'floating-extras-captured': extrasCaptured,
      // The fixed header must still head the capture.
      'fixed-nav-kept': navKept
    }
  }
];

// Which known failure each site-specific check stands for, for the report.
export const KNOWN = {
  'video-frame-bands': 'Video frames differ between tiles, leaving bands',
  'hero-slideshow-seam': 'Hero parallax seam / UIkit slideshow advanced between tiles',
  'sticky-heading-duplicated': 'Duplicated sticky heading in a tall section',
  'inner-scroller-captured': 'Inner div scrolls, not the document (one screen tall)',
  'header-repeated': 'Zero-height sticky header repeated in every tile',
  'parallax-images-missing': 'Squarespace 7.0 parallax images missing (blank bands)',
  'section-backgrounds-missing': 'Per-section background colours and white text vanished',
  'parallax-drift': 'TweenMax parallax drift',
  'pinned-slideshow': 'ScrollMagic-pinned slideshow repeated or vanished',
  'garden-gap-blank': 'Fixed garden photo behind a gap left a white band',
  'marquee-blank': 'Infinite CSS review marquee raced and left a blank band',
  'page-moved-under-tiles': 'Page height changed between tiles: strip repeated at a tile edge',
  'sticky-feature-repeated': 'Tall sticky feature column repeated in the next tile',
  'floating-extras-captured': 'Cookie banner, popup or floating button captured over the page',
  'fixed-nav-kept': 'Fixed site header hidden along with the floating extras'
};

