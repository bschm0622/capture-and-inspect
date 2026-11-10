// Loads a stitched capture into a small analysable grid: one row per CSS
// pixel (half the 2x device rows) and COLS columns, sampled nearest-neighbour
// so a tile boundary stays exactly on one row and is never blurred into its
// neighbours. A 2776x20000 capture becomes ~7 MB of luma and runs through
// every detector in well under a second.

import sharp from 'sharp';

export const COLS = 347; // 4 CSS px per column

export async function loadCapture(png, dpr = 2) {
  const meta = await sharp(png, { limitInputPixels: false }).metadata();
  const H = Math.round(meta.height / dpr);
  const { data, info } = await sharp(png, { limitInputPixels: false })
    .removeAlpha()
    .resize({ width: COLS, height: H, kernel: 'nearest', fit: 'fill' })
    .raw()
    .toBuffer({ resolveWithObject: true });
  const W = info.width;
  const luma = new Uint8Array(W * H);
  for (let i = 0, j = 0; i < luma.length; i++, j += 3) {
    luma[i] = (data[j] * 77 + data[j + 1] * 150 + data[j + 2] * 29) >> 8;
  }
  const img = { W, H, rgb: data, luma, cssWidth: Math.round(meta.width / dpr), devWidth: meta.width, devHeight: meta.height };
  // Rows no tile ever painted: the stitching canvas starts transparent and a
  // browser screenshot never is, so a fully transparent row is a hole.
  img.unpainted = new Uint8Array(H);
  if (meta.hasAlpha) {
    const alpha = await sharp(png, { limitInputPixels: false })
      .extractChannel(3)
      .resize({ width: COLS, height: H, kernel: 'nearest', fit: 'fill' })
      .raw()
      .toBuffer();
    for (let y = 0; y < H; y++) {
      let clear = 0;
      for (let x = 0; x < W; x++) if (alpha[y * W + x] === 0) clear++;
      if (clear >= W * 0.9) img.unpainted[y] = 1;
    }
  }
  img.rowStd = new Float32Array(H);
  img.rowMean = new Float32Array(H * 3);
  for (let y = 0; y < H; y++) {
    let s = 0, s2 = 0, r = 0, g = 0, b = 0;
    for (let x = 0; x < W; x++) {
      const v = luma[y * W + x];
      s += v; s2 += v * v;
      const j = (y * W + x) * 3;
      r += data[j]; g += data[j + 1]; b += data[j + 2];
    }
    const m = s / W;
    img.rowStd[y] = Math.sqrt(Math.max(0, s2 / W - m * m));
    img.rowMean[y * 3] = r / W; img.rowMean[y * 3 + 1] = g / W; img.rowMean[y * 3 + 2] = b / W;
  }
  return img;
}

// Column range [x0, x1) in grid columns for a CSS-pixel horizontal span.
export function cols(img, left = 0, width = null) {
  const scale = img.W / img.cssWidth;
  const x0 = Math.max(0, Math.floor(left * scale));
  const x1 = Math.min(img.W, Math.ceil((width == null ? img.cssWidth : left + width) * scale));
  return [x0, Math.max(x0 + 1, x1)];
}

// Mean absolute luma difference between rows a and b over columns [x0, x1).
export function rowDiff(img, a, b, x0 = 0, x1 = img.W) {
  const { luma, W } = img;
  let s = 0;
  for (let x = x0; x < x1; x++) s += Math.abs(luma[a * W + x] - luma[b * W + x]);
  return s / (x1 - x0);
}

// Luma standard deviation of row y over columns [x0, x1).
export function rowStdIn(img, y, x0 = 0, x1 = img.W) {
  if (x0 === 0 && x1 === img.W) return img.rowStd[y];
  const { luma, W } = img;
  let s = 0, s2 = 0;
  for (let x = x0; x < x1; x++) { const v = luma[y * W + x]; s += v; s2 += v * v; }
  const n = x1 - x0, m = s / n;
  return Math.sqrt(Math.max(0, s2 / n - m * m));
}

export function median(a) {
  if (!a.length) return 0;
  const s = [...a].sort((p, q) => p - q);
  return s[s.length >> 1];
}

// Downscaled JPEG preview for the report, plus a crop helper for debugging.
export async function preview(png, width = 320) {
  return sharp(png, { limitInputPixels: false }).resize({ width }).jpeg({ quality: 70 }).toBuffer();
}
