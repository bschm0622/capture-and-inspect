# Capture regression harness

Drives the real extension in Chromium over a fixed set of live sites, or any list of URLs, and checks each stitched capture for defects. Live pages change, so nothing is compared with a stored golden image. Instead, detectors look for the marks a broken capture leaves: blank bands, overlays repeated tile after tile, seams at tile boundaries, a capture shorter than the page, rows no tile ever painted, and content the page has that the capture doesn't show.

## Running

```sh
npm install                              # once: playwright-core 1.64.1 (Chromium 1248) and sharp
node test/run.mjs                        # the working tree's extension, every regression site
node test/run.mjs --site noguchi         # one site (substring of the host; comma list or repeat)
node test/run.mjs --ref b2d7f6e          # an older commit, same checks
node test/run.mjs --url https://x.com    # any page, generic detectors only
node test/run.mjs --urls list.txt        # one URL per line, generic detectors only (a sweep)
node test/run.mjs --fixtures             # the synthetic pages in test/fixtures (see Fixtures)
node test/run.mjs --url https://x.com --overlay patch/   # try changed extension files without touching the repo
```

Options:

- `--jobs N`: sites in parallel (default 1; 3 is fine for a sweep)
- `--timeout S`: per capture (default 240; 600 for `--fixtures`, whose tall pages take 50+ tiles). A site's whole process is killed 240 s after that.
- `--out dir`: the run folder. If it already holds a run, that run is resumed (see Sweeps).
- `--keep-png all|failing|none`: which full PNGs to keep. Default `all` for the regression set, `failing` for a URL list (any site that didn't pass). Previews are always kept.
- `--retry-errors`: on resume, capture again sites that errored twice already
- `--label name`: suffix for the output folder name
- `--headed`: show the browser
- `--headless-ua`: send Chromium's own user agent ("HeadlessChrome") instead of a desktop Chrome one
- `--capture-blocked`: capture a page judged blocked anyway (it is still reported as blocked)
- `--overlay dir`: extension files in `dir` (manifest, root `.js`/`.html`) replace the ones copied from the working tree or `--ref`. For trying a patch to the extension, a sketch or another agent's work, without editing or committing it. Recorded in `run.json`; a resumed run must use the same overlay.
- `--fixtures`: capture the synthetic pages in `test/fixtures` instead of live sites; `--site` filters them by name

Each run writes `test/out/<timestamp>-<label>/` (or `--out`; `test/out` is not committed):

- `sites/<host>.json`: one record per site, written the moment the site is done
- `<host>.png`: the full capture, exactly as the extension returned it (subject to `--keep-png`)
- `<host>.preview.jpg`: a 260 px wide preview
- `<host>.first-screen.jpg`: the page's first screen as a visitor sees it, taken after the capture (cookie banners and popups included); for a blocked site, the challenge page
- `report.html`: contact sheet with a preview per site (click it for the full PNG), every check's result, and red boxes on the preview at each flagged y-range
- `summary.txt`, `summary.json`: see Sweeps
- `results.json`: every record in one file, in the order asked for
- `run.json`: the extension ref and options, so a resumed run uses the same extension

A record holds the site's `verdict` (`pass`, `fail`, `blocked` or `error`), every check's pass/fail, measured value, detail and flagged ranges, capture size, tile tops and count, `durationMs` (and `phases`: ms from the start to the page loaded and to the capture returned; `captureMs`, the capture alone), and the page facts used. Also `tileLog` (for each shot: where it was asked to scroll, where it landed, the page height then and how far the page moved since the last shot) and, from the extension itself, `warnings` and `placements` (where each tile was put and how its overlap matched; `null` for commits from before the extension reported them). And what is needed to run the checks again later without capturing again: `draws` (each tile's draw onto the stitching canvas, with its seam evidence), `dom` (the page's own account of its text, images, embeds and fixed boxes), `gate` and `http` (what the page was).

The extension's own warnings (unpainted rows, a tile placed by position only because its overlap wouldn't match, two tiles that still disagree where they overlap after the tile above was shot again, a shot budget that ran low, page height changing by more than a screen, a page not fully captured, an image that failed to load twice, a frame from another site still changing after its repeat shots) are printed under each site's line, listed in the report and counted in the summary. They don't fail a site; the checks do.

The exit code is 1 if any site fails or errors, or, in the regression set and the fixtures, is blocked (its checks couldn't run). In a URL-list sweep a blocked site is listed and doesn't fail the run.

A capture is analysed at its own scale: output px per CSS px is the stitching canvas's width over the page width (commits before the bands could scale a tall page down).

### How it drives the extension

- The extension is never loaded from the repo folder. Each run copies the extension files (manifest, root `.js`/`.html`, `icons/`) into a temp folder, from the working tree or, with `--ref`, from that commit via `git show`. Nothing is checked out. The copy's manifest gets `host_permissions: ["<all_urls>"]` so scripts can be injected without the toolbar click that grants `activeTab`. The shipped manifest is unchanged.
- Chromium runs in new headless mode (`channel: 'chromium'`; the headless shell can't load extensions). The window is a real 1388×868 CSS px window at device scale 2, so captures are 2776 px wide. Playwright's viewport emulation is deliberately off: with emulated DPR the page reports 2x while `captureVisibleTab` returns 1x pixels, which stitches into gaps. The harness checks the inner size and DPR after load and fails the site if they're wrong.
- The browser sends the user agent a desktop Chrome of the same version sends (`Chrome/156.0.0.0`, without "Headless"). Nothing else about the browser is disguised, and no challenge is ever solved. See Blocked pages.
- Each site runs in its own Node process with its own browser profile. A site that hangs or crashes the browser is killed with everything it started, recorded as an error with the reason, and the run continues.
- The capture is started by calling `self.__runCapture(tab)` in the service worker. The `result.html` tab it opens is closed, and the PNG is read from the extension's IndexedDB (`capture-store.js`), where the worker hands it to the result page (from commits before that, the returned data URL).
- Tile positions are recorded from outside, with no change to the extension: the harness wraps `drawImage` on the worker's stitching canvas and `chrome.tabs.sendMessage`. That gives the exact y of every tile in the output, including the clamped last tile. Only the 9-argument form counts as a tile; the worker's other draws (its matching grids, the final crop) use shorter forms. The stitcher paints into a stack of canvases (bands, each at most 65535 px tall) marked with `bandTop`: draws are recorded at their place in the whole capture, and a tile that straddles two bands, drawn in two parts, is recorded as one. Tiles overlap and each paints only the rows below what is already painted, so a tile has two positions: `y`/`h`, the whole screen it shot, and `drawY`, where its painted part starts. Seams are looked for at `drawY`; repeated overlays compare tiles by `y` but only over rows the later tile painted. When two tiles disagree where they overlap, the worker shoots the tile above again and repaints its rows; that draw starts where the old one did and replaces it in the tile list.
- Seam evidence: at each tile draw, the wrapper also keeps the 12 rows just above `drawY` twice, as already on the canvas (painted by the tile above) and as this tile shot them, plus this tile's first 4 rows below, sampled to 347 columns. Both are sampled the same way inside the worker, so they compare exactly; rows above a band edge are read from the band above. The tile's rows are first resampled to the canvas's scale the way the stitcher draws them, so a capture the extension scaled down compares like with like.
- Page facts are read before the capture (the real scrollable height, counting an inner scrolling container; what is fixed to the window; whether the page is a challenge page) and after it, when the extension has restored the page and lazy content has loaded (element positions for site checks, and `dom`: every line of visible text with its colour, every image with its load state, every iframe, video, canvas and embed, every fixed or sticky box, and `claimed`: the rows that some box in the page's flow lays claim to, merged into runs. A box claims its rows when it is a leaf of the layout (no child with a height of its own) or when a visitor can't see it right now (transparent or hidden, so content waiting to show). Rows no box claims are the space between and around boxes, padding and margins.)
- After the capture the harness also screenshots the restored page's first screen (`shot`), so a check can ask whether something a visitor sees there, like a cookie banner or the site's header, made it into the capture.

## The result page

`node test/result-page.mjs [fixture]` (default `tall-40k`; `--out dir` keeps the files) captures a fixture through the real extension and drives the `result.html` tab it opens: the capture shows at its size; rows shown at every piece and band edge equal the stored PNG; a mouse selection across the band edge, Crop, Copy and Download of the crop (equal to the file's pixels); Copy of a whole capture over 65535 px is refused with a plain message (Chrome's tab crashes writing a PNG that tall to the clipboard); Download of the whole is the stored file byte for byte; JPG of a capture too tall for a canvas is saved as PNG and says so. The clipboard in headless Chromium is not the system's, so whether a paste works is for a person to check.

## Blocked pages

Before capturing, the harness looks at what loaded. A site is `blocked`, not passed or failed, when the page carries a known challenge or firewall mark (a "Just a moment…" / "Attention Required" / "Access denied" style title, Cloudflare's challenge form or error page, PerimeterX, DataDome, Incapsula, Sucuri or Akamai blocks), or answered with HTTP 400+ and has under 1000 characters of text, or has under 150 characters of text, no large image or video and is no taller than one screen. A challenge page gets 10 more seconds to pass on its own (nothing is clicked) and is looked at again. A blocked site isn't captured (unless `--capture-blocked`); its first screen is kept so a person can see what was served, and the summary lists it with the reason (`lib/gate.mjs`).

Mitigations, tried on the five sites that served a Cloudflare challenge in the 2026-11 gallery sweep: a desktop user-agent string (no "Headless") let all five through; turning off the `AutomationControlled` blink feature (so `navigator.webdriver` is false) let none through. The harness uses the first and not the second. With `--headless-ua` all five are reported `blocked`.

## The generic detectors

They run on every capture (`test/lib/detectors.mjs`, `test/lib/page-checks.mjs`). The pixel ones work on a grid with one row per CSS px and 347 columns, sampled nearest-neighbour so a tile boundary stays on exactly one row. Thresholds live in `T` and `P` at the top of the files.

Three kinds of evidence back them, strongest first. The two shots of the rows where tiles overlap (kept by the harness, above). The page's own account of what is on it (`dom`). The extension's placements (whether it found each overlap matching). Each detector says below what it does when the stronger evidence isn't there, which is the case for runs from before the harness kept it.

**seam**: a break at a tile boundary that comes from joining two different moments of the page. With the harness's seam evidence, in each of 8 column blocks: the capture jumps at least 12 (mean |Δluma|) from the row above the boundary to the row below it, that jump is at least 8 more than the later tile's own jump between the same two page rows, and the two shots of the 6 rows above the boundary differ by at least 6. Two such blocks are needed (about 350 CSS px): on the re-captured sweep, single-block flags were live map tiles that changed with no visible cut twice out of three. A break the later tile shows itself, over rows both shots agree on, is an edge in the page (a section or a full-screen hero ending exactly there), however sharp.
Without the seam evidence, the earlier pixel rule (below) runs, and a boundary where the extension's placement says the overlap matched (`agree.blocks === 0`, or a match of `ok`) is cleared as a page edge.
Pixel rule: a break exactly one row thick in at least 2 of 8 column blocks: jump ≥ 12, ≥ 4× the typical row-to-row jump within 30 rows, ≥ 2× the jump one row either side plus 4, and at least 15% of the block's columns breaking sharply with content (not the block's background colour) on both sides. That last rule exists because text across a boundary otherwise looks like a seam.
Blind spots: a change between shots that leaves no jump at the boundary itself (a video whose frame changed in rows above it); a seam narrower than two column blocks (≈ 350 CSS px), or one whose jump is diluted below 12 across a block; a change between shots too subtle to see is still flagged (the shots really differ, but a person may see nothing); without the seam evidence, a section edge on a boundary where the extension's match came out `mismatch` for some other reason.

**repeated-overlay**: the same textured strip at the same offset in two consecutive tiles, so exactly one tile step apart, with ±2 px slack for fractional scroll positions. Compared in 8 column blocks, so a popup card or chat bubble is found even when the rest of its rows differ. At least 24 matching content rows are needed. A match that holds almost as well 4–12 px off the step is dropped as a periodic pattern. A run also needs 12 matched rows that differ from its commonest row (beyond the |Δluma| 2 match tolerance). Rows whose only texture is vertical edges (a card's side against a dark gutter, a coloured bar beside a panel, a column of dots) are the same row over and over, match every other such row in the column, and join into a long enough strip through the gaps between lines of text, where the shifted comparison lands on text and can't tell. A real overlay's varied rows (text, an outline, a picture) match too. Over every capture kept in test/out on 2026-11-11, the false repeats had 2–6 such rows (dark footers and card grids, green service cards, coloured cards on a dotted ground, card edges) and every real one 14 or more (chat bubbles, a newsletter popup, sticky headings and nav). With the page's account, a repeat counts only where the page had something fixed to the window (a fixed or sticky box, read before and after the capture) covering at least a quarter of the strip's place in the window. A repeat with nothing fixed there is a background that repeats at the tile step (a window-fixed photo, a tiled texture) or a detail that recurs by chance.
Blind spots: an element that follows the scroll but lands at a different offset in each tile (a sticky heading that sticks partway down a tile: see the 17A site check); a translucent overlay over changing content; flat overlays with no texture, or whose part in a column block is straight-sided with nothing changing down it; an overlay the page removed before the harness looked; a fixed full-window backdrop makes every repeat under it count, and so does the site's fixed header, which is on nearly every page though the extension hides it after the first tile (the fixed-box test says where an overlay could be, rarely where one is).

**blank-band**: a run of rows that are each one flat colour (luma std < 3), staying the same colour, at least 0.45 × viewport (391 px) tall. With the page's account, a shorter run, down to 150 px, also fails when the page has text (10+ characters), images or embeds at least half inside it: they didn't paint. Runs touching the bottom of the capture are ignored.
A tall run is cleared when no more than 10% of it lies in rows the page's boxes claim (`dom.claimed`): it is the space between sections, their padding and margins (clearviewlandscaping.com's 409 px: 200 px of one section's bottom padding and 200 px of the next one's top). Text and images can't clear it: a widget a script never filled or an entrance that never played leaves no text or image there either, but it does leave a box: the widget's empty frame (a min-height container is a leaf), the hidden content (claimed while transparent). Checked on two local pages: 220 px section paddings cleared; an empty 480 px reviews container and a 460 px block held at opacity 0 still flagged. Records from before the harness kept the claims are judged by height alone.
Blind spots: a missing image over a gradient or patterned background (not flat); faint content inside the band can split it into shorter runs; deliberate empty space inside a box (a spacer element) is flagged; content that should be there but sits in a wrapper's padding (an injected widget whose host box has no height) is cleared.

**truncation**: the capture is more than 16 px shorter than the smallest height the page had during the capture: its scrollable height before, its scrollable height after, and the height the extension reported at each tile. The real height is the larger of the document's scroll height and any inner scrolling container's content height.
Blind spots: a page that grows and shrinks back during the capture is held to its smallest height; pages are capped by the extension (100000 px, or less where the image would pass 2^31 bytes: about 96,700 px at 1388 px and 2x); content clipped inside a fixed-height inner region that isn't `overflow: auto/scroll` is invisible to the measurement; a capture that is too tall isn't this detector's job (see `seamRepeats`).

**unpainted-rows**: rows that are fully transparent (at least 90% of sampled columns with alpha 0), so no tile was drawn there.
Blind spots: a hole narrower than 90% of the width; rows painted with the wrong content.

The last one needs the page's account and passes with "no page facts" without it. The page is measured after the capture; if its height then differs from the capture's by more than 24 px, positions may not line up and they say so instead of judging.

**text-same-colour**: lines of visible text (not hidden, under half opacity, transparent, clipped by an overflow box, inside a fixed or sticky box, or on a two-sided flip card) whose box in the capture is one flat colour, and that colour is the text's own (within 40 grey levels). That is light text whose background never loaded. Lines within 80 px are merged; a range is flagged at 40 characters. Each candidate is confirmed on the full-resolution PNG (under 0.2% of its pixels more than 32 grey levels from the box's most common grey).
Why only the same colour: the page is read after the capture, and content that slid or faded in during it (entrance animations) sits a little way from where the capture painted it, so a box of dark text over plain background is usually the text 30–60 px off, not missing.
Blind spots: text missing over a background of another colour (an entrance animation caught at its start); text inside images or canvases.

Tried and dropped: images the page never loaded (failed, or still on a lazy-load placeholder) with an empty box in the capture, and iframes, videos and canvases whose box is empty. On the re-captured gallery sweep they flagged nothing: the content that never loaded there (reviews widgets, galleries, video embeds) was never added to the page at all, so there was no element to ask about.

## Sweeps

A sweep is `--urls` over a long list. It is safe to leave running: each site runs in its own process and is killed if it hangs (`--timeout` plus 240 s); each finished site is written to `sites/<host>.json` at once; running the same command again with the same `--out` skips sites already done (a site that errored is tried once more; `--retry-errors` tries again after that).

```sh
node test/run.mjs --urls gallery.txt --jobs 3 --out test/out/sweep-2026-11-11
node test/run.mjs --urls gallery.txt --jobs 3 --out test/out/sweep-2026-11-11   # resumes
node test/run.mjs summary test/out/sweep-2026-11-11
node test/run.mjs compare test/out/sweep-old test/out/sweep-2026-11-11
```

`summary` (also written to `summary.txt` and `summary.json` at the end of every run) gives counts by verdict, failing checks with the number of sites and flagged ranges, extension warnings by kind with the sites that had them, total and median time per site and capture, the ten slowest sites, and the blocked, errored and failing sites with reasons. `compare A B` matches sites by host and lists new failures (with the checks that newly fail), fixed sites, sites still failing (with checks added and gone), newly blocked and unblocked sites, new and gone errors, and the change in median time. Each argument may be a comma-separated list of run folders, or a folder of run folders (a sweep run in batches); for a host in several, the later folder wins.

## Scorecard

```sh
node test/run.mjs score --verdicts truth.tsv [--detectors stored|current|<git ref>] [--json out.json] <run dirs>
```

Measures each generic detector against a person's review of the same captures. The verdicts file is tab-separated with a header and columns `host`, `verdict` (`ok`, `minor`, `defect`, `blocked`, `environment`) and optionally `ranges`: where each known defect is, in CSS px, `;`-separated, as `y0-y1` or a single y (a seam, taken as ±40). Other columns are ignored.

A flag on a site judged defect or minor is real when it overlaps one of the site's ranges (±60 px), or the site lists none. A flag on a site judged ok, or off every range, is false. Flags on blocked and environment pages are counted apart. Each range is one known defect, caught by a detector when one of its flags overlaps it. The table gives per detector: flags, real, false (on ok sites / off-range), precision, defects caught, recall, and how many ok sites it flagged; then defective sites caught, blocked pages agreed, every known defect no detector caught, and every false flag, so each can be opened and looked at.

`--detectors stored` scores the checks as each run recorded them. `current` runs the working tree's detectors again on every site whose PNG was kept; a git ref runs that commit's `test/lib` (written to a temp folder). Sites without a PNG are left out of a rescore and counted, so to measure false alarms keep the PNGs of sites judged ok (`--keep-png all`) or capture a sample of them again at the same ref.

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

`collect` is serialised into the page, so it must be an arrow function with no outside references. A site with no `checks` still gets the generic detectors.

### Adding a check

Name it for the failure it catches, and keep it to that one failure: never assert how the design looks beyond what's needed to see the defect. Before relying on it, run it against a commit where the failure exists (`--ref`) and confirm it fails there and passes now. A check that passes on both is unproven.

## Fixtures

`node test/run.mjs --fixtures` serves `test/fixtures` on 127.0.0.1 (a port picked at run time; the same files on `[::1]` at that port, a second origin for frames) and captures each page through the real extension, the same way as a live site; records are keyed `fixture-<name>`. They drive paths of the stitcher no site in the regression set reaches. Each page is a stack of 200 px bands of known colours (`bands.js`), so the `bands-in-place` check can say which content is out of place; `fixtures.mjs` holds the pages' checks. A fixture built to break the capture on purpose lists the generic checks it expects to fail (`expectGenericFail`); they are recorded as passing with `expected: true`, and its own checks judge whether the extension said what went wrong.

| fixture | path | checks |
|---|---|---|
| `tall-40k` | a page taller than a canvas side can be at device scale 2 (65535 px is Chrome's limit): two bands, a tile drawn across their edge, the PNG writer | whole height at full resolution, bands in place, every device row's colour exact, the rows around the band edge equal to the browser's own screenshot |
| `tall-64k` | past the old 60000 px cap, under the new one: two bands | as tall-40k, and no `truncated` or `page-height-changed` warning |
| `tall-100k` | past the height cap (about 96,700 px at this width): three bands | captured to the cap, one `truncated` warning (`reason: 'too-tall'`) and no `page-height-changed`; rows exact, band edges equal the browser's screenshot |
| `grow` | the page grows from 3800 to 8600 px while the tiles run, past the canvas's growth room: `grow()` | reaches the page's end, bands in place |
| `stale` | a full-screen layer shows the screen as it was before each tile's scroll for 1.5 s: `sameFrame`, the wait and retake | a shot judged stale, bands in place |
| `shrink` | content jumps up 150 px on every scroll: retakes, rows left unpainted, the shot budget running low | every hole reported (`unpainted`), `budget` warning |
| `body-lock` | a modal open, the body pinned with `position: fixed; top: -400px`, html overflow hidden: `unlockScroll` | whole page from its top, popup and scrim gone |
| `slider-timer` | a 1200px slider turned every 0.7s by a `setInterval` the page registers at load, before the timer wrappers: changes to what was shot put back (`pageClock` freeze) | the slider shows one slide top to bottom |
| `webgl-tall` | a 1200px WebGL canvas without `preserveDrawingBuffer`, redrawn every frame by a loop holding its own `requestAnimationFrame`: a still copied right after the page's draw (`pageClock` stills) | one frame top to bottom |
| `restart-anim` | a 1100px SVG animated each frame, played again from the start whenever the page scrolls (a Lottie hero): the restart's frames put back | one frame top to bottom |
| `flaky-image` | an image whose first request fails (the server answers `flaky-*` files with a 500 once): `retryImage` | the image is in the capture |
| `frame-slow` | a frame from another origin (`[::1]` against `127.0.0.1`) that paints 1.5s after it comes on screen: shots of its box repeated until two agree | the frame is shot painted |

`edges-match-page` compares with screenshots the harness takes after the capture (`refShots` on a fixture: CSS y to centre in the window). At a6c3f84 and 9e30e54: `tall-40k` and `tall-64k` fail outright ("The size of the OffscreenCanvas is zero": the stitching canvas is created taller than 65535 px, holds nothing, and `convertToBlob` throws; the area check doesn't look at the side limit); the other four pass. Since the bands, all pass. The pages trigger their behaviour only on the capture's own scrolls (a tile step, or scrolls 400 ms or more apart), not on the pre-scroll's quick stops.

## Tuning notes

Don't change a threshold to make a particular capture pass, and never write a rule that names a site. If a detector flags something, open that y-range in the PNG first: a flag on the current extension can be a real defect. Judge a detector change with the scorecard on a reviewed sweep, old and new side by side, and look at every flag that moved.
