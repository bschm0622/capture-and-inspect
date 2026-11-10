# Capture regression harness

Drives the real extension in Chromium over a fixed set of live sites and checks each stitched capture for defects. Live pages change, so nothing is compared with a stored golden image. Instead, detectors look for the marks a broken capture leaves: blank bands, overlays repeated tile after tile, seams at tile boundaries, a capture shorter than the page, and rows no tile ever painted.

## Running

```sh
npm install                              # once: playwright-core 1.64.1 (Chromium 1248) and sharp
node test/run.mjs                        # the working tree's extension, every site
node test/run.mjs --site noguchi         # one site (substring of the host; comma list or repeat)
node test/run.mjs --ref b2d7f6e          # an older commit, same checks
node test/run.mjs --url https://x.com    # any page, generic detectors only
node test/run.mjs --urls list.txt        # one URL per line, generic detectors only
```

Options: `--headed` (show the browser), `--jobs N` (sites in parallel, default 1), `--timeout S` (per capture, default 240), `--label name` (suffix for the output folder).

Each run writes `test/out/<timestamp>-<label>/` (git-ignored):

- `<host>.png`: the full capture, exactly as the extension returned it
- `<host>.first-screen.jpg`: the page's first screen as a visitor sees it, taken after the capture (cookie banners and popups included)
- `report.html`: contact sheet with a preview per site (click it for the full PNG), every check's result, and red boxes on the preview at each flagged y-range
- `results.json`: per site, every check's pass/fail, measured value, detail and flagged ranges, plus capture size, tile tops, tile count, duration and the page facts used. Also `tileLog` (for each shot: where it was asked to scroll, where it landed, the page height then and how far the page moved since the last shot) and, from the extension itself, `warnings` and `placements` (where each tile was put and how its overlap matched; `null` for commits from before the extension reported them)

The extension's own warnings (unpainted rows, an overlap that wouldn't match, two tiles that still disagree where they overlap after the tile above was shot again, page height changing by more than a screen, a truncated capture) are printed under each site's line and listed in the report. They don't fail a site; the checks do.

The exit code is 1 if any check on any site fails or a site couldn't be captured.

### How it drives the extension

- The extension is never loaded from the repo folder. Each run copies the extension files (manifest, root `.js`/`.html`, `icons/`) into a temp folder, from the working tree or, with `--ref`, from that commit via `git show`. Nothing is checked out. The copy's manifest gets `host_permissions: ["<all_urls>"]` so scripts can be injected without the toolbar click that grants `activeTab`. The shipped manifest is unchanged.
- Chromium runs in new headless mode (`channel: 'chromium'`; the headless shell can't load extensions). The window is a real 1388×868 CSS px window at device scale 2, so captures are 2776 px wide. Playwright's viewport emulation is deliberately off: with emulated DPR the page reports 2x while `captureVisibleTab` returns 1x pixels, which stitches into gaps. The harness checks the inner size and DPR after load and fails the site if they're wrong.
- Each site gets a fresh browser profile. A site that hangs or errors is reported as failed with the reason, and the run continues.
- The capture is started by calling `self.__runCapture(tab)` in the service worker. The `result.html` tab it opens is closed, and the PNG comes from the returned data URL.
- Tile positions are recorded from outside, with no change to the extension: the harness wraps `drawImage` on the worker's stitching canvas and `chrome.tabs.sendMessage`. That gives the exact y of every tile in the output, including the clamped last tile. Only the 9-argument form counts as a tile; the worker's other draws (its matching grids, the final crop) use shorter forms. Tiles overlap and each paints only the rows below what is already painted, so a tile has two positions: `y`/`h`, the whole screen it shot, and `drawY`, where its painted part starts. Seams are looked for at `drawY`; repeated overlays compare tiles by `y` but only over rows the later tile painted. When two tiles disagree where they overlap, the worker shoots the tile above again and repaints its rows; that draw starts where the old one did and replaces it in the tile list.
- Page facts are read twice: before the capture (the real scrollable height, counting an inner scrolling container) and after it, when the extension has restored the page and lazy content has loaded (element positions for site checks).
- After the capture the harness also screenshots the restored page's first screen (`shot`), so a check can ask whether something a visitor sees there, like a cookie banner or the site's header, made it into the capture.

## The generic detectors

They run on every capture (`test/lib/detectors.mjs`). Each works on a grid with one row per CSS px and 347 columns, sampled nearest-neighbour so a tile boundary stays on exactly one row. Thresholds live in `T` at the top of the file.

**blank-band**: a run of rows that are each one flat colour (luma std < 3), staying the same colour, at least 0.45 × viewport tall (391 px). Runs touching the bottom of the capture are ignored.
Blind spots: a missing image over a gradient or patterned background (not flat); a blank band shorter than 391 px; faint content inside the band can split it into shorter runs. It can't tell a deliberate tall empty section from a missing one (the tallest legitimate flat run on the regression set is 349 px).

**repeated-overlay**: the same textured strip at the same offset in two consecutive tiles, so exactly one tile step apart, with ±2 px slack for fractional scroll positions. Compared in 8 column blocks, so a popup card or chat bubble is found even when the rest of its rows differ. At least 24 matching content rows are needed. A match that holds almost as well 4–12 px off the step is dropped as a periodic pattern (dots, stripes, tiled textures).
Blind spots: an element that follows the scroll but lands at a different offset in each tile (a sticky heading that sticks partway down a tile: see the 17A site check); a translucent overlay over changing content; flat overlays with no texture (a plain coloured bar); overlays repeating only in the clamped last tile, where the step is shorter (checked, but with less room).

**seam**: at each tile boundary, a break exactly one row thick in at least 2 of 8 column blocks. In a block, the jump between the boundary row and the row above must be ≥ 12 (mean |Δluma|), ≥ 4× the typical row-to-row jump within 30 rows, and ≥ 2× the jump one row either side plus 4. At least 15% of the block's columns must break sharply with content (not the block's background colour) on both sides. Blocks that are flat on either side are skipped.
The coverage rule exists because text across a boundary otherwise looks like a seam: glyph tops and crossbars make one-row jumps, but every glyph edge has background on one side.
Blind spots: a change that isn't a sharp break, such as a slow colour shift, a slight sub-pixel offset, or a text colour change across a heading (17A's "State or local government leader" at 1736 px, grey above and dark below, is missed); a seam in content narrower than about 2 blocks (≈ 350 CSS px); a real hard edge between two textured areas that falls exactly on a boundary (rare, but it would be flagged).

**truncation**: the capture is under 70% of the page's real scrollable height, and more than one viewport short. The real height is the larger of the document's scroll height and any inner scrolling container's content height, measured before the capture.
Blind spots: a page whose height legitimately shrinks during capture (the extension removes ScrollTrigger pin spacers) could be flagged; infinite-scroll pages are capped at 60000 px by the extension; content clipped inside a fixed-height inner region that isn't `overflow: auto/scroll` is invisible to the measurement.

**unpainted-rows**: rows that are fully transparent (at least 90% of sampled columns with alpha 0), so no tile was drawn there. A browser screenshot is always opaque, so any such row is a hole, including a run at the very bottom of the capture.
Blind spots: a hole narrower than 90% of the width; rows painted with the wrong content (that is what the other detectors and `seamRepeats` are for).

## Site checks

`test/sites.mjs` has one entry per regression site and one check per known failure. A check gets `{ img, cap, tiles, vh, shot, facts }`, where `facts` is what the site's `collect` function returned from the page after the capture and `shot` is the first-screen screenshot, loaded like a capture. It returns `{ pass, value, detail, flags }`. Helpers: `flatShare`, `findStrip`, `seamRepeats` (rows just below a tile edge that repeat the rows just above it, which is what a tile placed too low leaves) and `showsIn` in `test/lib/regions.mjs`; `seams`, `repeatedOverlays` and `blankBands` from the detectors accept a `region` to look inside one part of the page.

`showsIn(img, shot, rect)` compares an element's own marks (the pixels on the screenshot far from the element's most common colour: text, icons, edges) with the capture at the same place, and returns the share the capture reproduces, or null when there are too few to say. Whatever sits behind a hidden element doesn't count, so a hidden cookie banner scores near 0 and a captured one near 1. Two shared checks use it: `floating-extras-captured` (the extras listed in `facts.extras` must score under 0.6) and `fixed-nav-kept` (the header in `facts.nav` must score 0.6 or more, so hiding extras can't take the header with them). On the regression set a captured extra scores 0.87–1.0 and a hidden one 0–0.39. For a see-through header over a video (hitt.com), `light: true` compares only its near-white type.
Blind spots: a see-through extra (a dimming scrim) has no marks of its own; the generic seam detector catches its edge at the first tile boundary instead. An element over a video or animation can score lower than it should, since the capture froze a different frame from the screenshot.

### Adding a site

Append to `SITES`:

```js
{
  host: 'example.com',
  url: 'https://example.com',
  waitUntil: 'domcontentloaded',   // only if `load` never fires
  collect: () => ({ hero: (() => { const r = document.querySelector('.hero').getBoundingClientRect(); return { top: r.top + scrollY, left: r.left, w: r.width, h: r.height }; })() }),
  checks: {
    'hero-seam'({ img, tiles, facts }) { /* return result(pass, value, detail, flags) */ }
  }
}
```

`collect` is serialised into the page, so it must be an arrow function with no outside references. A site with no `checks` still gets the five generic detectors.

### Adding a check

Name it for the failure it catches, and keep it to that one failure: never assert how the design looks beyond what's needed to see the defect. Before relying on it, run it against a commit where the failure exists (`--ref`) and confirm it fails there and passes now. A check that passes on both is unproven.

## Tuning notes

Thresholds were set on captures of the regression set from both commits and checked on six sites that weren't used for tuning. Don't change a threshold to make a particular capture pass. If a detector flags something, open that y-range in the PNG first: a flag on the current extension can be a real defect.
