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
import { flatShare, findStrip, seamRepeats, showsIn, inkLevel, textContrast, result } from './lib/regions.mjs';
import { cols, rowDiff } from './lib/image.mjs';

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
    host: 'mattinglygc.com',
    url: 'https://mattinglygc.com',
    collect: () => {
      const h = [...document.querySelectorAll('h1, h2')].find((e) => e.getBoundingClientRect().width > 0 && /building healthy/i.test(e.textContent));
      if (!h) return { heading: null };
      const r = h.getBoundingClientRect();
      return { heading: { top: Math.round(r.top + scrollY), left: Math.round(r.left), w: Math.round(r.width), h: Math.round(r.height) } };
    },
    checks: {
      // The hero column fades out on scroll through a GSAP ScrollTrigger.
      // Jumped to the end of that tween, the white headline vanished. Its
      // box must hold white text: at least 3% of it near-white.
      'hero-heading-visible'({ img, facts }) {
        const h = facts.heading;
        if (!h) return result(false, null, '"Building Healthy Relationships" heading not found on the page');
        const [x0, x1] = cols(img, h.left, h.w);
        let n = 0, white = 0;
        for (let y = h.top; y < Math.min(img.H, h.top + h.h); y++) for (let x = x0; x < x1; x++) { n++; if (img.luma[y * img.W + x] > 240) white++; }
        const share = n ? white / n : 0;
        return result(share >= 0.03, +share.toFixed(3), `${(share * 100).toFixed(1)}% of the heading box near-white (fail under 3%)`, share >= 0.03 ? [] : [{ y0: h.top, y1: h.top + h.h, note: 'hero heading missing' }]);
      }
    }
  },
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
      // The impact heading and figures, which the page fades by scroll
      // position, and the tabs it turns on a timer, with their photo. The
      // fades also slide them, so they're measured by layout, which leaves
      // transforms out. The capture puts the sticky block back where the
      // layout has it, sticky offset cancelled.
      const L = (el) => { let top = 0, left = 0; for (let a = el; a; a = a.offsetParent) { top += a.offsetTop; left += a.offsetLeft; } return { top, left, w: el.offsetWidth, h: el.offsetHeight }; };
      const impact = [{ what: 'heading', ...L(h) }, ...[...document.querySelectorAll('.our-impact_card')].map((c, i) => ({ what: `figure ${i + 1}`, ...L(c) }))];
      const tabs = [...document.querySelectorAll('.intended-audience_tab-menu_link .heading-style-h6')].map(R);
      const photo = document.querySelector('.intended-audience_tab-img-wrapper');
      return { heading: R(block), section: sec ? R(sec) : null, impact, tabs, photo: photo ? R(photo) : null };
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
      },
      // Webflow fades the impact heading and figures by scroll position, so
      // a tile caught one faded (the third figure, or the heading cut at a
      // tile edge). At full strength each has marks darker than 110.
      'impact-faded'({ img, facts }) {
        const items = facts.impact || [];
        if (items.length < 2) return result(false, null, 'impact heading and figures not found on the page');
        const lv = items.map((it) => ({ it, ink: inkLevel(img, it) ?? 255 }));
        const faded = lv.filter((l) => l.ink > 110);
        return result(!faded.length, Math.max(...lv.map((l) => l.ink)), `darkest marks: ${lv.map((l) => `${l.it.what} ${l.ink}`).join(', ')} (fail above 110)`,
          faded.map((l) => ({ y0: l.it.top, y1: l.it.top + l.it.h, note: `${l.it.what} faded` })));
      },
      // The audience tabs turn every 5s on a timer. A tile edge through the
      // list, or a tab caught mid-turn, shows a heading half grey and half
      // dark, or two tabs (or none) dark at once; a tile edge through the
      // photo shows two photos. One tab heading must be dark, each heading
      // one shade throughout, and no tile edge may break the photo.
      'tab-state'({ img, tiles, facts }) {
        const tabs = facts.tabs || [];
        if (tabs.length < 2) return result(false, null, 'tab headings not found on the page');
        const lv = tabs.map((t) => {
          const k = Math.floor(t.h / 2);
          return { t, all: inkLevel(img, t), a: inkLevel(img, { ...t, h: k }), b: inkLevel(img, { ...t, top: t.top + k, h: t.h - k }) };
        });
        const flags = lv.filter((l) => Math.abs(l.a - l.b) > 50).map((l) => ({ y0: l.t.top, y1: l.t.top + l.t.h, note: `tab heading ${l.a} above, ${l.b} below` }));
        const dark = lv.filter((l) => l.all < 90).length;
        if (dark !== 1) flags.push({ y0: tabs[0].top, y1: tabs[tabs.length - 1].top + tabs[tabs.length - 1].h, note: `${dark} tabs dark` });
        const p = facts.photo;
        if (p) flags.push(...seams(img, tiles, { region: { y0: p.top + 2, y1: p.top + p.h - 2, x: p.left, w: p.w }, minBlocks: 1 }).flags);
        return result(!flags.length, flags.length, `tab headings (darkest marks, top/bottom half): ${lv.map((l) => `${l.a}/${l.b}`).join(', ')}; ${dark} dark; ${flags.length} problem(s)`, flags);
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
      },
      // The carousel should be stopped for the capture (its Swiper has no
      // `.swiper` class, only an instance on the element). While it turns,
      // the page height the extension reads at each tile changes.
      'carousel-kept-rotating'({ cap }) {
        const hs = (cap.tiles || []).map((t) => t.pageHeight).filter(Number.isFinite);
        if (hs.length < 2) return result(false, null, 'no tile page heights recorded');
        const range = Math.max(...hs) - Math.min(...hs);
        return result(range <= 50, range, `page height varied by ${range}px over ${hs.length} tiles (fail above 50px)`);
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
      // The rows the page is built from: its background changes colour only
      // where one row gives way to the next.
      const rowEdges = [...document.querySelectorAll('[data-color]')]
        .filter((el) => el.getBoundingClientRect().width >= innerWidth * 0.9)
        .map((el) => R(el).top);
      return { extras, nav, rowEdges };
    },
    checks: {
      // The page recolours its own background (black or white) to match the
      // row in view, so each tile came out in one colour all over and the
      // change landed at a tile edge, through a heading. Read down the left
      // margin, where only the page background shows: every change from
      // black to white or back must fall on an edge between two rows.
      'background-follows-section'({ img, facts }) {
        const edges = facts.rowEdges || [];
        if (!edges.length) return result(false, null, 'no colour-marked rows found');
        const [x0, x1] = cols(img, 0, 12);
        const shade = (y) => {
          let lo = 255, hi = 0;
          for (let x = x0; x < x1; x++) { const v = img.luma[y * img.W + x]; lo = Math.min(lo, v); hi = Math.max(hi, v); }
          return hi - lo > 10 ? null : hi < 40 ? 'black' : lo > 215 ? 'white' : null;
        };
        // Runs of plain black or white margin at least 20 rows long.
        const runs = [];
        for (let y = 0; y < img.H; y++) {
          const s = shade(y);
          if (!s) continue;
          const r = runs[runs.length - 1];
          if (r && r.s === s && y - r.end <= 1) r.end = y;
          else runs.push({ s, start: y, end: y });
        }
        const solid = runs.filter((r) => r.end - r.start >= 20);
        const flags = [];
        let changes = 0;
        for (let k = 1; k < solid.length; k++) {
          const a = solid[k - 1], b = solid[k];
          if (a.s === b.s) continue;
          changes++;
          if (!edges.some((e) => e >= a.end - 4 && e <= b.start + 4)) flags.push({ y0: a.end, y1: b.start, note: `background turns ${b.s} between ${a.end} and ${b.start}px, not at a row edge` });
        }
        return result(!flags.length, flags.length, `${changes} background colour change(s), ${flags.length} away from a row edge`, flags);
      },
      // A cookie banner across the bottom of the first screen and an
      // accessibility button beside it (earlier, the button repeated in
      // every tile).
      'floating-extras-captured': extrasCaptured,
      // The fixed header must still head the capture.
      'fixed-nav-kept': navKept
    }
  },
  {
    // WP Rocket holds the page's scripts until the first mouse move, and
    // with them the lazy section backgrounds and the map.
    host: 'roofingbymidsouth.com',
    url: 'https://roofingbymidsouth.com',
    collect: () => {
      const R = (el) => { const r = el.getBoundingClientRect(); return { top: Math.round(r.top + scrollY), left: Math.round(r.left), w: Math.round(r.width), h: Math.round(r.height) }; };
      const luma = (c) => { const m = c.match(/[\d.]+/g).map(Number); return Math.round((m[0] * 77 + m[1] * 150 + m[2] * 29) / 256); };
      const find = (re) => {
        const walk = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
        for (let n; (n = walk.nextNode());) if (re.test(n.textContent) && n.parentElement.getBoundingClientRect().height > 0) return n.parentElement;
        return null;
      };
      const texts = [
        ['storm process card', /roofing experts thoroughly inspect/i],
        ['insurance claims section', /Once we take on a project/i],
        ['contact section', /Nashville roofers is eager/i]
      ].map(([what, re]) => { const el = find(re); return el ? { what, ...R(el), luma: luma(getComputedStyle(el).color) } : { what, missing: true }; });
      let sec = [...document.querySelectorAll('h1, h2, h3, h4')].find((e) => /areas we serve/i.test(e.textContent) && e.getBoundingClientRect().height > 0);
      while (sec && sec.parentElement && sec.getBoundingClientRect().width < innerWidth * 0.9) sec = sec.parentElement;
      return { texts, areas: sec ? R(sec) : null };
    },
    checks: {
      // The white text sits on a lazily loaded background photo or dark
      // panel; with the loader asleep it was white on the white page.
      'text-on-missing-background'({ img, facts }) {
        const ts = facts.texts || [];
        if (!ts.length) return result(false, null, 'no texts collected');
        const flags = [];
        const parts = ts.map((t) => {
          if (t.missing) { flags.push({ y0: 0, y1: 0, note: `${t.what} text not found on the page` }); return `${t.what} missing`; }
          const c = textContrast(img, t, t.luma);
          if (c == null || c < 0.25) flags.push({ y0: t.top, y1: t.top + t.h, note: `${t.what}: ${Math.round((c || 0) * 100)}% of the box differs from the text colour` });
          return `${t.what} ${Math.round((c || 0) * 100)}%`;
        });
        return result(flags.length === 0, flags.length, `share of each text box that differs from its text colour: ${parts.join(', ')} (fail under 25%)`, flags);
      },
      // The service-area map fills the right half of "Areas we serve".
      'map-missing'({ img, facts }) {
        const a = facts.areas;
        if (!a) return result(false, null, '"Areas we serve" section not found on the page');
        const f = flatShare(img, { y0: a.top, y1: a.top + a.h, x: a.left + a.w * 0.6, w: a.w * 0.4 });
        return result(f < 0.5, +f.toFixed(2), `${Math.round(f * 100)}% of rows flat beside the area list (fail at 50%)`, f < 0.5 ? [] : [{ y0: a.top, y1: a.top + a.h, note: 'map missing' }]);
      }
    }
  },
  {
    host: 'www.cooperhewitt.org',
    url: 'https://www.cooperhewitt.org',
    collect: () => {
      const f = [...document.querySelectorAll('footer')].filter((el) => el.getBoundingClientRect().height > 40).pop();
      if (!f) return { footer: null };
      const r = f.getBoundingClientRect();
      // The colour behind the footer: its own, or the first ancestor's that
      // isn't transparent.
      let bg = null;
      for (let el = f; el && !bg; el = el.parentElement) {
        const m = getComputedStyle(el).backgroundColor.match(/[\d.]+/g);
        if (m && (m.length < 4 || +m[3] > 0.5)) bg = m.slice(0, 3).map(Number);
      }
      bg = bg || [255, 255, 255];
      return { footer: { top: Math.round(r.top + scrollY), left: Math.round(r.left), w: Math.round(r.width), h: Math.round(r.height), luma: Math.round((bg[0] * 77 + bg[1] * 150 + bg[2] * 29) / 256) } };
    },
    checks: {
      // Tile 2's overlap matched the first tile's own bottom rows, 772px
      // up from where the page had scrolled, and the stitcher believed it:
      // the capture came out 1197px tall for a 1969px page, the lower
      // sections gone. The capture must be as tall as the page.
      'captures-full-height'({ img, cap }) {
        const hs = [cap.factsBefore && cap.factsBefore.scrollable, cap.factsAfter && cap.factsAfter.scrollable].filter((v) => v > 0);
        const off = Math.min(...hs.map((h) => Math.abs(img.H - h)));
        return result(off <= 16, off, `capture ${img.H}px, page ${hs.join('/')}px (fail beyond 16px)`, off <= 16 ? [] : [{ y0: Math.max(0, img.H - 4), y1: img.H, note: 'capture height differs from the page' }]);
      },
      // ...and the footer must be in it, where the page has it: mostly the
      // footer's own background colour, with its text on it.
      'footer-present'({ img, facts }) {
        const f = facts.footer;
        if (!f) return result(false, null, 'footer not found on the page');
        if (f.top + f.h > img.H + 2) return result(false, img.H - f.top - f.h, `footer ends at ${f.top + f.h}px, below the capture's end at ${img.H}px`, [{ y0: Math.min(f.top, img.H - 4), y1: img.H, note: 'footer missing' }]);
        const [x0, x1] = cols(img, f.left, f.w);
        let n = 0, bg = 0, marks = 0;
        for (let y = f.top; y < Math.min(img.H, f.top + f.h); y++) {
          for (let x = x0; x < x1; x++) {
            const d = Math.abs(img.luma[y * img.W + x] - f.luma);
            n++;
            if (d < 24) bg++;
            else if (d > 96) marks++;
          }
        }
        const ok = n > 0 && bg / n >= 0.6 && marks / n >= 0.005;
        return result(ok, +(bg / n).toFixed(2), `${Math.round(bg / n * 100)}% of the footer box in its background colour (fail under 60%), ${(marks / n * 100).toFixed(1)}% text marks (fail under 0.5%)`, ok ? [] : [{ y0: f.top, y1: f.top + f.h, note: 'footer not in the capture where the page has it' }]);
      }
    }
  },
  {
    // A delay loader (fmlightning) holds the scripts that reveal most
    // sections and draw the reviews widget until the first mouse move.
    host: 'www.semperfiheatingcooling.com',
    url: 'https://www.semperfiheatingcooling.com',
    collect: () => {
      const R = (el) => { const r = el.getBoundingClientRect(); return { top: Math.round(r.top + scrollY), left: Math.round(r.left), w: Math.round(r.width), h: Math.round(r.height) }; };
      const head = (re) => [...document.querySelectorAll('h1, h2, h3, h4')].find((e) => re.test(e.textContent) && e.getBoundingClientRect().width > 0);
      const who = head(/Trusted HVAC & Plumbing Solutions/i);
      const rev = head(/Reviews from Your Satisfied Neighbors/i);
      let panel = rev;
      while (panel && panel.parentElement && panel.getBoundingClientRect().height < 350) panel = panel.parentElement;
      return { who: who ? R(who) : null, reviews: rev ? { head: R(rev), panel: R(panel) } : null };
    },
    checks: {
      // "Who we are": the heading stayed invisible, waiting for its reveal.
      'section-text-missing'({ img, facts }) {
        if (!facts.who) return result(false, null, '"Trusted HVAC & Plumbing Solutions" heading not found on the page');
        const ink = inkLevel(img, facts.who);
        return result(ink != null && ink < 128, ink, `darkest 2% of the heading box at luma ${ink} (fail at 128 or lighter)`, ink != null && ink < 128 ? [] : [{ y0: facts.who.top, y1: facts.who.top + facts.who.h, note: 'heading missing' }]);
      },
      // The reviews widget left its panel empty below the heading.
      'reviews-widget-empty'({ img, facts }) {
        const r = facts.reviews;
        if (!r) return result(false, null, 'reviews heading not found on the page');
        const y0 = r.head.top + r.head.h + 10, y1 = r.panel.top + r.panel.h;
        const f = flatShare(img, { y0, y1, x: r.panel.left, w: r.panel.w * 0.55 });
        return result(f != null && f < 0.6, f == null ? null : +f.toFixed(2), `${Math.round((f || 0) * 100)}% of rows flat in the left of the reviews panel (fail at 60%)`, f != null && f < 0.6 ? [] : [{ y0, y1, note: 'reviews empty' }]);
      }
    }
  },
  {
    host: 'www.clcroofing.com',
    url: 'https://www.clcroofing.com',
    collect: () => {
      const R = (el) => { const r = el.getBoundingClientRect(); return { top: Math.round(r.top + scrollY), left: Math.round(r.left), w: Math.round(r.width), h: Math.round(r.height) }; };
      const h = [...document.querySelectorAll('h1, h2, h3')].find((e) => /Why Dallas Homeowners/i.test(e.textContent) && e.getBoundingClientRect().width > 0);
      if (!h) return { heading: null };
      let sec = h.parentElement;
      while (sec && sec.parentElement && sec.getBoundingClientRect().width < innerWidth * 0.9) sec = sec.parentElement;
      return { heading: R(h), section: sec ? R(sec) : null };
    },
    checks: {
      // The left column holding "Why Dallas Homeowners & Businesses Choose
      // CLC Roofing Inc." is sticky in a container only a little taller, so
      // it showed twice, about 200px apart. It must show once, where the
      // layout puts it.
      'sticky-heading-twice'({ img, facts }) {
        const h = facts.heading;
        if (!h) return result(false, null, '"Why Dallas Homeowners…" heading not found on the page');
        const s0 = facts.section ? facts.section.top : h.top - 1000, s1 = facts.section ? facts.section.top + facts.section.h : h.top + 1000;
        // Each half on its own: a copy cut off by a tile edge still repeats
        // one of them. The copy sat at a fractional offset (its sticky `top`
        // is 199.6px), which redraws the text a little differently, so the
        // match allows more difference than findStrip's default.
        const half = Math.floor(h.h / 2);
        const found = [{ ...h, h: half }, { ...h, top: h.top + half, h: h.h - half }].map((p) => ({ p, ...findStrip(img, p, s0, s1, 6) }));
        if (found.every((f) => f.rows < 8)) return result(false, 0, `heading not visible at its place (${h.top}px)`, [{ y0: h.top, y1: h.top + h.h, note: 'expected heading here' }]);
        const extra = found.flatMap((f) => f.matches.filter((y) => Math.abs(y - f.p.top) > 8).map((y) => ({ y0: y, y1: y + f.p.h, note: 'copy of the heading' })));
        const most = Math.max(...found.map((f) => f.matches.length));
        return result(extra.length === 0, most, `heading (${h.top}px) appears ${most}× in its section`, extra);
      }
    }
  },
  {
    host: 'www.dentiq.dental',
    url: 'https://www.dentiq.dental',
    collect: () => {
      // Sections whose background picture is painted against the window
      // (`background-attachment: fixed`).
      const out = [];
      for (const el of document.querySelectorAll('body *')) {
        const cs = getComputedStyle(el);
        if (!cs.backgroundAttachment.includes('fixed') || !/url\(/.test(cs.backgroundImage)) continue;
        const r = el.getBoundingClientRect();
        if (r.width > 300 && r.height > 200) out.push({ top: Math.round(r.top + scrollY), left: Math.round(r.left), w: Math.round(r.width), h: Math.round(r.height) });
      }
      return { fixedBackgrounds: out };
    },
    checks: {
      // The "Your confident smile is our guide" photo showed a different
      // part of the picture in each tile, cut at the tile edge. No tile
      // edge may break a fixed-background section.
      'fixed-background-seam'({ img, tiles, facts }) {
        const secs = facts.fixedBackgrounds || [];
        if (!secs.length) return result(false, null, 'no section with a fixed background found on the page');
        const flags = secs.flatMap((s) => seams(img, tiles, { region: { y0: s.top + 2, y1: s.top + s.h - 2, x: s.left, w: s.w }, minBlocks: 1 }).flags);
        return result(flags.length === 0, flags.length, `${flags.length} tile boundary break(s) inside ${secs.length} fixed-background section(s)`, flags);
      }
    }
  },
  {
    host: 'www.agcsf.com',
    url: 'https://www.agcsf.com',
    checks: {
      // Parallax images sit at a new offset in every tile, so no overlap
      // matched. Each tile was shot twice and a 50-shot cap stopped the
      // capture 3,100px short of the bottom. It must reach the bottom...
      'reaches-bottom'({ img, cap }) {
        const hs = [cap.factsBefore && cap.factsBefore.scrollable, cap.factsAfter && cap.factsAfter.scrollable].filter((v) => v > 0);
        const short = Math.min(...hs) - img.H;
        return result(short <= 16, short, `capture ${img.H}px, page ${hs.join('/')}px (fail if more than 16px short)`, short <= 16 ? [] : [{ y0: Math.max(0, img.H - 4), y1: img.H, note: `capture ends ${short}px short of the page's bottom` }]);
      },
      // ...in bounded time: not many more shots than the page has screens
      // (that part doesn't depend on how busy the machine is), and a
      // ceiling on the capture itself, not counting loading the page.
      'finishes-in-time'({ cap, vh }) {
        const p = cap.phases || {};
        if (p.captured == null || p.loaded == null) return result(false, null, 'no capture timing');
        const s = Math.round((p.captured - p.loaded) / 1000);
        const screens = 1 + Math.ceil(Math.max(0, cap.factsBefore.scrollable - vh) / (vh - 96));
        const shots = (cap.tiles || []).length;
        const ok = s <= AGCSF_SECONDS && shots <= screens * 1.5;
        return result(ok, s, `capture took ${s}s (fail over ${AGCSF_SECONDS}s) and ${shots} shots for ${screens} screens (fail over ${screens * 1.5})`);
      },
      // ...and say which seams it couldn't confirm: every tile whose overlap
      // didn't match carries a "placed by position only" warning.
      'unmatched-seams-warned'({ cap }) {
        if (!cap.placements || !cap.warnings) return result(false, null, 'extension reports no placements or warnings');
        const unmatched = cap.placements.filter((p) => !p.retake && !p.reshot && p.match && p.match.match === 'mismatch');
        // ('overlap-mismatch' is what commits up to c539d2d called it.)
        const warned = new Set(cap.warnings.filter((w) => w.kind === 'position-only' || w.kind === 'overlap-mismatch').map((w) => w.y0));
        const missing = unmatched.filter((p) => !warned.has(Math.round(p.top)));
        return result(!missing.length, missing.length, `${unmatched.length} unmatched seam(s), ${missing.length} without a warning`, missing.map((p) => ({ y0: Math.round(p.top), y1: Math.round(p.top) + 96, note: 'unmatched seam not warned' })));
      }
    }
  },
  {
    // The reviews slider (a renamed slick) steps every second and restarts
    // its own timer after each step. The capture holds the page's clock
    // while it shoots (the generic seam check sees a slider caught in two
    // positions) and must let it go afterwards: a page left frozen is a
    // broken page for the visitor, and no pixel check can see that.
    host: 'asebend.com',
    url: 'https://asebend.com',
    // (Sampled through 4s rather than compared once: it cycles through its
    // positions in about 5s, so two looks 5s apart can match.)
    collect: async () => {
      const t = document.querySelector('.slickwprev-track');
      if (!t) return { slider: null };
      const seen = new Set();
      for (let i = 0; i < 16; i++) {
        seen.add(t.style.transform);
        await new Promise((r) => setTimeout(r, 250));
      }
      return { slider: { positions: [...seen] } };
    },
    checks: {
      'clock-released'({ facts }) {
        const s = facts.slider;
        if (!s) return result(false, null, 'reviews slider not found on the page');
        const n = s.positions.length;
        return result(n > 1, n, n > 1
          ? `the slider moved through ${n} positions in the 4s after the capture`
          : `the slider stood still for 4s after the capture (${s.positions[0]})`);
      }
    }
  },
  {
    // A testimonial slider on a timer the page set when it loaded, before
    // the extension was there to hold it. It can't be stopped, so it must be
    // shot whole, from one moment: no tile edge may cross it. Without that
    // a seam through it passes or fails by luck, on whether the slide
    // happened to change between the two shots.
    host: 'taylorsway.com',
    url: 'https://taylorsway.com',
    collect: () => {
      const v = document.querySelector('.tws-v');
      if (!v) return { slider: null };
      const r = v.getBoundingClientRect();
      return { slider: { top: Math.round(r.top + scrollY), h: Math.round(r.height) } };
    },
    checks: {
      'slider-in-one-shot'({ img, tiles, facts }) {
        const s = facts.slider;
        if (!s || s.h < 60) return result(false, null, 'testimonial slider not found on the page');
        const cut = boundaries(tiles, img.H).filter((y) => y > s.top + 2 && y < s.top + s.h - 2);
        return result(!cut.length, cut.length, cut.length
          ? `tile edge(s) at y ${cut.join(', ')} cross the slider (y ${s.top}-${s.top + s.h})`
          : `the slider (y ${s.top}-${s.top + s.h}) came from one shot`,
        cut.map((y) => ({ y0: y - 8, y1: y + 8, note: 'tile edge through the timed slider' })));
      }
    }
  },
  {
    // The header sits in the page's flow at the top and a script makes its
    // wrapper fixed once the page scrolls. Sorted then as a floating extra,
    // it stayed hidden when the first tile was shot again, leaving the top
    // 139px white. (The same script scrolls the page 139px past where it was
    // asked; the generic seam and truncation checks catch what that did.)
    host: 'www.icaboston.org',
    url: 'https://www.icaboston.org',
    collect: () => {
      const h = [...document.querySelectorAll('header')].find((e) => { const r = e.getBoundingClientRect(); return r.height > 40 && r.top + scrollY < 60; });
      if (!h) return { nav: null };
      const r = h.getBoundingClientRect();
      return { nav: { top: Math.round(r.top + scrollY), left: Math.round(r.left), w: Math.round(r.width), h: Math.round(r.height) } };
    },
    checks: {
      'fixed-nav-kept': navKept
    }
  },
  {
    // A column ("Our Symphony of Services") that an Elementor script turns
    // `position: fixed` once the page scrolls to it, leaving a spacer in its
    // place. It was hidden as a floating extra from that tile on, so its
    // paragraph and button, below the tile edge, were never captured; the
    // gap is too short for the blank-band check. Both must show ink.
    host: 'terrenlandscapes.com',
    url: 'https://terrenlandscapes.com',
    collect: () => {
      const R = (el) => { const r = el.getBoundingClientRect(); return { top: Math.round(r.top + scrollY), left: Math.round(r.left), w: Math.round(r.width), h: Math.round(r.height) }; };
      const head = [...document.querySelectorAll('h1, h2, h3, h4')].find((e) => /Symphony of Services/i.test(e.textContent));
      const col = head && head.closest('section, .e-con');
      if (!col) return { parts: null };
      // (What follows the heading: dark text and a button's label.)
      const below = head.getBoundingClientRect().bottom;
      const parts = [...col.querySelectorAll('p, a')].filter((e) => e.getBoundingClientRect().top >= below && e.getBoundingClientRect().height > 10 && e.textContent.trim().length > 10)
        .map((e) => ({ what: e.textContent.trim().slice(0, 30), ...R(e) }));
      return { parts };
    },
    checks: {
      'sticky-column-whole'({ img, facts }) {
        const parts = facts.parts;
        if (!parts || !parts.length) return result(false, null, 'the "Our Symphony of Services" column was not found on the page');
        const levels = parts.map((p) => ({ p, ink: inkLevel(img, p) }));
        const missing = levels.filter((l) => l.ink == null || l.ink > 160);
        return result(!missing.length, missing.length, levels.map((l) => `"${l.p.what}" darkest marks ${l.ink}`).join('; ') + ' (missing over 160)',
          missing.map((l) => ({ y0: l.p.top, y1: l.p.top + l.p.h, note: `"${l.p.what}" not in the capture` })));
      }
    }
  },
  {
    // A round "back to top" button the page adds once it has scrolled: a
    // zero-height `position: sticky; bottom: 24px` box at the end of the
    // content, its button hanging out of it. It rode along in every tile,
    // six copies down the right edge. No site check: the generic
    // repeated-overlay detector's small-overlay rule is what sees it (the
    // column-block rule passed it).
    host: 'www.louvre.fr',
    url: 'https://www.louvre.fr'
  },
  {
    host: 'www.guggenheim.org',
    url: 'https://www.guggenheim.org',
    collect: () => {
      const a = document.querySelector('header a[href="/"], nav a[href="/"], a[class*="logo" i]');
      if (!a) return { logo: null };
      const r = a.getBoundingClientRect();
      return { logo: { top: Math.round(r.top + scrollY), left: Math.round(r.left), w: Math.round(r.width), h: Math.round(r.height) } };
    },
    checks: {
      // The header turns fixed once the page scrolls and fades a compact
      // "G" in over its wordmark. The fade was held at its most visible, so
      // the top of the capture showed the G over GUGGENHEIM NEW YORK. The
      // logo's box must look as it does on the first screen at scroll 0.
      'header-as-at-scroll-0'({ img, shot, facts }) {
        const l = facts.logo;
        if (!l) return result(false, null, 'logo link not found on the page');
        if (!shot) return result(false, null, 'no first-screen screenshot');
        const s = sameAs(img, shot, l);
        return result(s >= 0.9, +s.toFixed(2), `${Math.round(s * 100)}% of the logo box as on the first screen (fail under 90%)`,
          s >= 0.9 ? [] : [{ y0: l.top, y1: l.top + l.h, note: 'logo differs from the first screen' }]);
      }
    }
  },
  {
    // A Divi header, in the page's flow at scroll 0 and fixed once the page
    // scrolls, through a rule more specific than the capture's and
    // !important. It stayed fixed at the top of every later tile, and its
    // bottom 11px showed below each overlap, a black stripe across the page
    // at every tile edge. It must be at the top, and its rows must not show
    // again where a tile starts painting.
    host: 'hermansplumbing.com',
    url: 'https://hermansplumbing.com',
    collect: () => {
      const h = document.getElementById('main-header') || document.querySelector('header');
      if (!h) return { nav: null };
      const r = h.getBoundingClientRect();
      return { nav: { top: Math.round(r.top + scrollY), left: Math.round(r.left), w: Math.round(r.width), h: Math.round(r.height) } };
    },
    checks: {
      'fixed-nav-kept': navKept,
      'late-header-once'({ img, tiles, facts }) {
        const n = facts.nav;
        if (!n || n.top > 2) return result(false, null, 'header not found at the top of the page');
        // Where a tile starts painting below its own top, the rows it shot
        // there are the header's same rows, if the header rode along.
        const flags = [];
        for (const t of tiles.slice(1)) {
          const o = (t.drawY ?? t.y) - t.y;
          if (o < 0 || o >= n.h - 4) continue;
          const rows = [];
          for (let k = o; k < n.h && t.y + k < img.H; k++) rows.push(rowDiff(img, n.top + k, t.y + k));
          if (rows.length >= 4 && rows.reduce((a, b) => a + b, 0) / rows.length < 4) {
            flags.push({ y0: t.y + o, y1: t.y + n.h, note: `the header's bottom ${n.h - o}px below the tile edge at ${t.y + o}px` });
          }
        }
        return result(!flags.length, flags.length, `${flags.length} tile edge(s) show the header's bottom rows`, flags);
      }
    }
  },
  {
    // A sticky panel ("Roofing Options Tailored to Your Home") beside a
    // column of cards. It slides in as a whole (AOS fade-right), so its
    // stages looked different, and it was drawn four times down its column,
    // each copy measured mid-slide and cut off at the left. Its content
    // doesn't change: it belongs once, at its place, whole.
    host: 'newmanroofing.com',
    url: 'https://newmanroofing.com',
    collect: () => {
      const L = (el) => { let top = 0, left = 0; for (let a = el; a; a = a.offsetParent) { top += a.offsetTop; left += a.offsetLeft; } return { top, left, w: el.offsetWidth, h: el.offsetHeight }; };
      const h = [...document.querySelectorAll('h1, h2, h3')].find((e) => /Roofing Options Tailored/i.test(e.textContent));
      if (!h) return { heading: null };
      let sec = h.parentElement;
      while (sec && sec.parentElement && sec.getBoundingClientRect().height < innerHeight * 1.5) sec = sec.parentElement;
      return { heading: L(h), section: sec ? L(sec) : null };
    },
    checks: {
      'sticky-panel-once'({ img, facts }) {
        const h = facts.heading;
        if (!h) return result(false, null, '"Roofing Options Tailored to Your Home" not found on the page');
        const s0 = facts.section ? facts.section.top : h.top - 1500, s1 = facts.section ? facts.section.top + facts.section.h : h.top + 2500;
        const { rows, matches } = findStrip(img, h, s0, s1);
        // (Its first letters, at the left of the heading: cut off in a copy
        // measured mid-slide.)
        const lead = inkLevel(img, { top: h.top, left: h.left, w: 60, h: Math.min(h.h, 60) });
        const extra = matches.filter((y) => Math.abs(y - h.top) > 8).map((y) => ({ y0: y, y1: y + h.h, note: 'copy of the sticky panel heading' }));
        const flags = [...extra, ...(lead == null || lead > 120 ? [{ y0: h.top, y1: h.top + h.h, note: `heading's first letters missing (darkest marks ${lead})` }] : [])];
        return result(rows >= 8 && !flags.length, matches.length, `heading appears ${matches.length}x in its section; first letters' darkest marks ${lead} (fail above 120)`, flags);
      }
    }
  },
  {
    // An outlined button ("Explore Our Offices") that AOS fades up when it
    // comes into view, which the pre-scroll didn't always see. It sat at the
    // bottom of a tile: shown there not yet revealed, shown revealed in the
    // tile below, and when the tile above was shot again (after a scroll
    // from above, so not yet revealed again) the seam cut it, its top lost.
    // Both halves of it must show the same red marks.
    host: 'www.clunegc.com',
    url: 'https://www.clunegc.com',
    collect: () => {
      const L = (el) => { let top = 0, left = 0; for (let a = el; a; a = a.offsetParent) { top += a.offsetTop; left += a.offsetLeft; } return { top, left, w: el.offsetWidth, h: el.offsetHeight }; };
      const a = [...document.querySelectorAll('a')].find((e) => /Explore Our Offices/i.test(e.textContent) && e.offsetHeight > 20);
      return { button: a ? L(a) : null };
    },
    checks: {
      'reveal-whole'({ img, facts }) {
        const b = facts.button;
        if (!b) return result(false, null, '"Explore Our Offices" button not found on the page');
        const k = Math.floor(b.h / 2);
        const top = inkLevel(img, { ...b, h: k }), bottom = inkLevel(img, { ...b, top: b.top + k, h: b.h - k });
        const bad = top == null || bottom == null || top > 160 || bottom > 160 || Math.abs(top - bottom) > 50;
        return result(!bad, Math.max(top ?? 255, bottom ?? 255), `button's darkest marks ${top} in its top half, ${bottom} in its bottom half (fail above 160 or 50 apart)`,
          bad ? [{ y0: b.top, y1: b.top + b.h, note: 'button cut or missing' }] : []);
      }
    }
  },
  {
    // A Squarespace heading block whose opacity the page eases by where it
    // sits on screen, late enough after a scroll that the pre-scroll never
    // saw it change. A tile caught it near the bottom of the screen, at
    // about 0.4, and the tile below, opaque; the tile above was shot again
    // and caught it at 0.4 again, so the capture showed it pale grey. Its
    // dark text must be at full strength.
    host: 'www.element-outdoorliving.com',
    url: 'https://www.element-outdoorliving.com',
    collect: () => {
      const L = (el) => { let top = 0, left = 0; for (let a = el; a; a = a.offsetParent) { top += a.offsetTop; left += a.offsetLeft; } return { top, left, w: el.offsetWidth, h: el.offsetHeight }; };
      const h = [...document.querySelectorAll('h1, h2, h3')].find((e) => /TEAM YOU CAN TRUST/i.test(e.textContent));
      return { heading: h ? L(h) : null };
    },
    checks: {
      'late-fade-opaque'({ img, facts }) {
        const h = facts.heading;
        if (!h) return result(false, null, '"A team you can trust…" heading not found on the page');
        const ink = inkLevel(img, h);
        return result(ink != null && ink <= 110, ink, `heading's darkest marks ${ink} (fail above 110)`,
          ink != null && ink <= 110 ? [] : [{ y0: h.top, y1: h.top + h.h, note: 'heading faded' }]);
      }
    }
  },
  {
    // Webflow plays every interaction from one frame loop started at load.
    // Held with the page's clock, a section the pre-scroll's quick stops
    // didn't set off never faded in at its tile: the service-area heading
    // and paragraph came out as white space, and once the whole
    // "D.A.D. University" card (one capture in four). Its statistics count
    // up as they come into view (see the count-up fixture for their
    // values).
    host: 'www.calldad.com',
    url: 'https://www.calldad.com',
    collect: () => {
      const R = (el) => { const r = el.getBoundingClientRect(); return { top: Math.round(r.top + scrollY), left: Math.round(r.left), w: Math.round(r.width), h: Math.round(r.height) }; };
      const head = (re) => [...document.querySelectorAll('h1, h2, h3')].find((e) => re.test(e.textContent) && e.getBoundingClientRect().width > 0);
      const loc = head(/Find a location near you/i);
      let card = head(/Training for future/i);
      while (card && card.parentElement && card.getBoundingClientRect().height < 300) card = card.parentElement;
      return { loc: loc ? R(loc) : null, card: card ? R(card) : null };
    },
    checks: {
      'loop-reveal-shown'({ img, facts }) {
        const flags = [];
        const notes = [];
        if (!facts.loc || !facts.card) return result(false, null, 'service-area heading or training card not found on the page');
        const ink = inkLevel(img, facts.loc);
        notes.push(`heading's darkest marks ${ink} (fail at 128 or lighter)`);
        if (ink == null || ink >= 128) flags.push({ y0: facts.loc.top, y1: facts.loc.top + facts.loc.h, note: 'service-area heading missing' });
        const c = facts.card;
        const f = flatShare(img, { y0: c.top, y1: c.top + c.h, x: c.left, w: c.w });
        notes.push(`${Math.round((f || 0) * 100)}% of the training card's rows flat (fail at 60%)`);
        if (f == null || f >= 0.6) flags.push({ y0: c.top, y1: c.top + c.h, note: 'training card missing' });
        return result(flags.length === 0, ink, notes.join('; '), flags);
      }
    }
  }
];

// Share of a box's grid pixels the capture shows as the first-screen
// screenshot does (within 24 grey levels, a row either way).
function sameAs(img, shot, rect) {
  const [x0, x1] = cols(img, rect.left, rect.w);
  const y0 = Math.max(0, Math.round(rect.top)), y1 = Math.min(shot.H, img.H, Math.round(rect.top + rect.h));
  let n = 0, same = 0;
  for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) {
    n++;
    const v = shot.luma[y * shot.W + x];
    if ([-1, 0, 1].some((dy) => y + dy >= 0 && y + dy < img.H && Math.abs(img.luma[(y + dy) * img.W + x] - v) < 24)) same++;
  }
  return n ? same / n : 0;
}

// Ceiling on agcsf.com's capture time, with room for a busy machine. On one
// (another harness running alongside): c539d2d took 175s for 53 shots and
// stopped 3,872px short; the fix took 82s for 27 shots and the whole page.
const AGCSF_SECONDS = 150;

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
  'hero-heading-visible': 'Exit tween jumped to its end: hero heading faded out of the capture',
  'impact-faded':'Scroll-linked fade caught part-way: a figure or heading faded or cut',
  'tab-state': 'Timed tabs caught in two states across a tile edge',
  'carousel-kept-rotating': 'Carousel kept rotating during the capture',
  'background-follows-section': 'Page background recoloured by scroll, cut at a tile edge',
  'floating-extras-captured': 'Cookie banner, popup or floating button captured over the page',
  'fixed-nav-kept': 'Fixed site header hidden along with the floating extras',
  'text-on-missing-background': 'Scripts held until the first mouse move: white text on a background that never loaded',
  'map-missing': 'Scripts held until the first mouse move: the map never loaded',
  'section-text-missing': 'Scripts held until the first mouse move: a section never revealed',
  'reviews-widget-empty': 'Scripts held until the first mouse move: the reviews widget stayed empty',
  'captures-full-height': 'Overlap matched a screen away from the scroll position: lower sections lost',
  'footer-present': 'Overlap matched a screen away from the scroll position: lower sections lost',
  'reaches-bottom': 'Overlaps never matched; shot cap stopped the capture short of the bottom',
  'finishes-in-time': 'Overlaps never matched; every tile shot twice',
  'unmatched-seams-warned': 'Seams placed by position only were not reported',
  'sticky-heading-twice': 'Sticky column in a slightly taller container shown twice',
  'fixed-background-seam': 'Fixed-attachment background showed a different part of the picture in each tile',
  'clock-released': "Page left frozen after the capture: its slider didn't move again",
  'slider-in-one-shot': 'Slider on a timer set at page load cut by a tile edge (two moments, or right only by luck)',
  'sticky-column-whole': 'Column a script makes sticky hidden as a floating extra: its text lost below a tile edge',
  'header-as-at-scroll-0': "Header's scrolled-state logo held visible over its wordmark at the top of the capture",
  'late-header-once': 'Header fixed by a stronger page rule rode along in every tile: its bottom rows a stripe at each tile edge',
  'sticky-panel-once': 'Sticky panel with an entrance slide shown as copies down its column, each cut off at the left',
  'reveal-whole': 'Reveal the pre-scroll missed, cut by the seam between a shot without it and one with it',
  'loop-reveal-shown': "Fade-ins played by the page's own frame loop held: a section left blank",
  'late-fade-opaque': 'Scroll-linked fade too late for the pre-scroll caught part-way in a tile shot again: heading pale'
};

