# Capture & Inspect

A Chrome extension with three tools for working with the design of other sites:

1. **Full-page screenshot** — scrolls through a page, settles each section, and
   stitches the tiles into one clean PNG. Built for capturing marketing sites as
   style references.
2. **Inspect element** — point at any element and read its exact computed styles,
   then copy them as AI-ready context (Markdown), as CSS, or copy a screenshot of
   just that element. Built for UI QA: hand an AI precise facts about what a
   component looks like instead of a vague description.
3. **Extract palette** — pull every color the page declares (text, backgrounds,
   gradients, borders, shadows, SVG fills), ranked by how often it's used, and
   export as a hex list, CSS variables, or a Tailwind config. Reads declared
   values, not sampled pixels, so you get the site's real design tokens.

Click the toolbar icon and pick a tool from the popup.

## Why not Chrome's built-in full-page capture?

Chrome's built-in tool resizes the render surface to the full page height in
one shot. On modern sites this breaks in several ways, all of which this
extension fixes:

- **Blank sections** — scroll-triggered reveals and lazy-loaded images never
  fire, leaving big empty gaps.
- **Hard cutoff at 16,384px** — a GPU texture limit truncates tall pages.
- **Frozen mid-animation** — hero headlines get caught half-faded.
- **Repeated overlays** — sticky navs, chat widgets, and cookie banners get
  baked in over the middle of the page.
- **Stretched hero sections** — `100vh` sections balloon into whitespace.

## Install

1. Open `chrome://extensions`
2. Turn on **Developer mode** (top-right)
3. Click **Load unpacked** and select this folder (the one with `manifest.json` in it)
4. The camera icon appears in your toolbar — pin it if you like

## Use — Full-page screenshot

Click the toolbar icon and choose **Full-page screenshot**. The popup shows a
progress bar while it scrolls through the page and grabs each section. Because
the progress bar lives in the toolbar popup (not on the page), the page itself
never flickers. When it finishes, an **editor tab** opens with the screenshot.
Keep the popup open while it works; if you click away and it closes, the
capture still finishes and the editor still opens.

Capture takes about two seconds per screenful: 20–45 seconds for a typical
marketing page, a few minutes for a very long one. Most of that is waiting
for the page to settle at each stop, and Chrome allows only about two
shots a second. The page scrolls while capturing, so **don't switch tabs**
mid-capture (the capture always shoots the active tab).

If the capture couldn't make part of the page look exactly as it does in
the browser, the editor says so in a notice above the image, in plain
words: the page changed while it was being shot, a video or animation shows
a single moment, a section that changes as you scroll is shown as a series
of screens, a video hadn't loaded, or the page was too long for one image.

## Use — Inspect element

Click the toolbar icon and choose **Inspect element**. The popup closes and
the page enters pick mode: hover to highlight elements, click one to lock it in.
A panel opens with its computed styles (typography, box model, colors, effects,
layout). From there:

- **Copy for AI** — a Markdown block (selector, size, styles, HTML snippet) with
  a "describe what's wrong" prompt line, ready to paste into Claude/Cursor/etc.
- **Copy CSS** — the styles as a CSS rule.
- **Copy image** — a PNG of just that element (the panel hides itself for the
  shot so it isn't included).
- **Pick another** — reselect without leaving the mode. Press **Esc** to exit.

## Use — Extract palette

Click the toolbar icon and choose **Extract palette**. It scans the page's
computed styles and opens a panel listing every color, ranked by usage, each
tagged with its role (text / bg / border / shadow / icon). Click any swatch to
copy its hex, or use the footer to copy the whole palette as a **hex list**,
**CSS variables** (`--color-1: …`), or a **Tailwind** `colors` config. It reads
declared color values, so photos and gradients-as-images won't muddy the result.

### In the editor

- **Filename** — prefilled as `<hostname>_<date>` (e.g. `runway.com_2026-07-04`),
  editable before you save. The date lets you re-capture the same site later
  without overwriting.
- **Format** — PNG (lossless), JPG, or WebP. WebP/JPG are ~5–10× smaller for
  the same visual reference. Your choice is remembered for next time.
- **Crop** — drag a box on the image, then **Crop to selection** (or just hit
  Download/Copy to export only the selection). **Reset** restores the full page.
- **Copy** — puts the image (or selected region) on your clipboard as PNG, ready
  to paste into Figma, a doc, or a chat.
- **Download** — saves in the chosen format with your filename, then closes
  the editor tab automatically so you land back where you were. (Copy leaves
  the tab open, in case you want to keep working with it.)

## How it works

1. Freezes smooth-scrolling and CSS animations so each frame is stable.
2. Pre-scrolls the whole page once to trigger lazy content and reveals.
3. Scrolls tile-by-tile, waiting for images and JS animations to settle at
   each stop (≈0.5s), then captures the visible viewport.
   Holds the page still while it shoots: sliders, animations and other
   changes the page makes on its own to anything already shot are put back
   before they're painted, canvases and paused videos are swapped for a
   still of one frame (a video's own poster picture where it has one,
   not a blank placeholder), frames from other sites (maps, players) are shot
   again until they stop changing, and an image whose request failed is
   asked for once more. A reveal the pre-scroll missed (a fade in, or a
   small mark that grows to its full size) is held at how it looks once
   revealed from the tile that first shows it on. Fades a page plays from
   its own animation loop still play when a tile scrolls them into view,
   and a number counting up to its value (a "75,000+ customers"
   statistic) is shot once it has stopped, not part-way.
4. After the first tile, hides `fixed` overlays and sticky top-navs so they
   appear once at the top instead of repeating. Sticky *content* sections
   (pinned scroll-storytelling) are detected by position and left intact.
5. Stitches every tile into one image at your display's native resolution
   and opens it in the editor for crop / format / copy / download.

## Known limitations

- Captures the whole `document`. A page that scrolls one inner container
  instead of the document is unwrapped and captured whole; an app with
  several panes that scroll separately is captured as those panes stand.
- If a cookie banner covers the hero, dismiss it before capturing for the
  cleanest first screen (it's hidden automatically after the first tile).
- Captures are always at your display's full resolution, however tall. A page
  longer than about 96,000 CSS px (at a 1388px-wide window on a 2x display;
  less on a wider window) is captured to that point and the editor says so:
  that is the largest image Chrome itself can open. Very tall captures take
  longer to save (13 s for a 76,000px text page, up to about 50 s for one
  full of photos) and can't be copied to the clipboard whole past 32,767 CSS px
  (copy a selection, or download).
- A part of the page that never stops moving (a word that rolls on a timer,
  a marker that fills in only while its section is mid-screen, a video) is
  shown as it was at the moment its tile was shot. Once in a while that
  moment is part-way through the motion.
- A video or map served by another site can refuse to load for some
  visitors; the capture shows what the page showed.

## Permissions and privacy

The extension asks for `activeTab` and `scripting` (to read and scroll the
tab you click it on, and only that tab), `storage` and `unlimitedStorage`
(to hand a large capture to the editor tab and remember your format
choice), and `clipboardWrite` (for Copy). It has no access to other tabs or
sites, contacts no server of its own, and sends nothing anywhere:
captures stay in your browser until you download or copy them.

## Tests

`test/` holds a harness that drives the extension in a real Chrome over a
set of live sites and synthetic pages and checks the stitched image. See
`test/README.md`.
