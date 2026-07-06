# Capture & Inspect

A Chrome extension with two tools for working with the design of other sites:

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
3. Click **Load unpacked** and select this `extension/` folder
4. The camera icon appears in your toolbar — pin it if you like

## Use — Full-page screenshot

Click the toolbar icon and choose **Full-page screenshot**. The popup shows a
progress bar while it scrolls through the page and grabs each section. Because
the progress bar lives in the toolbar popup (not on the page), the page itself
never flickers. When it finishes, an **editor tab** opens with the screenshot.
Keep the popup open while it works; if you click away and it closes, the
capture still finishes and the editor still opens.

Capture takes roughly one second per screenful — a very tall page can take
10–15 seconds. The page scrolls while capturing, so **don't switch tabs**
mid-capture (the capture always shoots the active tab).

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
4. After the first tile, hides `fixed` overlays and sticky top-navs so they
   appear once at the top instead of repeating. Sticky *content* sections
   (pinned scroll-storytelling) are detected by position and left intact.
5. Stitches every tile onto one canvas at your display's native resolution
   and opens it in the editor for crop / format / copy / download.

## Known limitations

- Captures the whole `document`. Pages whose content scrolls inside an inner
  container (rare for marketing pages) aren't handled in this version.
- If a cookie banner covers the hero, dismiss it before capturing for the
  cleanest first screen (it's hidden automatically after the first tile).
- Extremely tall pages are capped at 60,000 CSS px as an infinite-scroll
  safeguard.
