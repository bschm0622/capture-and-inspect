// Writes and reads PNGs a strip of rows at a time, so an image taller than
// any canvas can be (Chrome's limit is 65535 px a side) still comes out as
// one file and can be read back. The PNG format allows heights up to 2^31.
//
// Nothing holds the whole raw image: each strip is filtered and fed into one
// zlib stream (CompressionStream 'deflate' is zlib-wrapped deflate, which is
// what IDAT holds), and the compressed bytes are cut into IDAT chunks as they
// come out and gathered into Blobs, which Chrome keeps out of the JS heap
// (and pages to disk when they are large).
//
// Every row uses the Up filter (each byte minus the byte above). On four
// real captures (2776 px wide) Up came out 25-35% smaller than no filter on
// photo-heavy pages and 10% larger on a flat one; Paeth was 2-4% smaller
// than Up but much slower, and choosing a filter per row by the usual
// least-sum-of-absolute-values rule gained nothing over Up.
//
// Reading (decodeStrips) undoes the same: the result page uses it to cut a
// capture too tall for one image element into pieces it can show.
//
// Used by the service worker (importScripts), the result page and the test
// harness.

(function (root) {
  const CRC_TABLE = (() => {
    const t = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      t[n] = c >>> 0;
    }
    return t;
  })();

  function crc32(bytes, crc = 0xffffffff) {
    for (let i = 0; i < bytes.length; i++) crc = CRC_TABLE[(crc ^ bytes[i]) & 0xff] ^ (crc >>> 8);
    return crc;
  }

  // One chunk: length, type, data, CRC over type and data.
  function chunk(type, data) {
    const out = new Uint8Array(12 + data.length);
    const v = new DataView(out.buffer);
    v.setUint32(0, data.length);
    for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
    out.set(data, 8);
    v.setUint32(8 + data.length, (crc32(out.subarray(4, 8 + data.length)) ^ 0xffffffff) >>> 0);
    return out;
  }

  const SIGNATURE = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
  const LITTLE = new Uint8Array(new Uint32Array([1]).buffer)[0] === 1;
  const HI = 0x80808080;

  // Encodes a PNG. `strips` is an async iterable of { data, rows }: `rows`
  // rows of RGBA pixels (a Uint8Array or Uint8ClampedArray, width * 4 bytes
  // a row, byte offset a multiple of 4), top to bottom, `height` rows in
  // all. `alpha` false writes RGB and drops the alpha bytes. Returns a Blob.
  async function encode({ width, height, alpha = true, strips, idatBytes = 1 << 20, onProgress = null }) {
    if (!(width > 0 && height > 0 && width < 2 ** 31 && height < 2 ** 31)) throw new Error(`bad PNG size ${width}x${height}`);
    if (!LITTLE) throw new Error('PNG writer needs a little-endian machine');
    const channels = alpha ? 4 : 3;
    const ihdr = new Uint8Array(13);
    const v = new DataView(ihdr.buffer);
    v.setUint32(0, width);
    v.setUint32(4, height);
    ihdr[8] = 8;                 // bit depth
    ihdr[9] = alpha ? 6 : 2;     // colour type: RGBA or RGB
    // compression 0, filter method 0, interlace 0

    const blobs = [];        // finished parts, kept out of the JS heap
    let pending = [];        // IDAT chunks not yet in a Blob
    let pendingBytes = 0;
    const idat = new Uint8Array(idatBytes);
    let idatLen = 0;
    const flushIdat = () => {
      if (!idatLen) return;
      const c = chunk('IDAT', idat.subarray(0, idatLen));
      pending.push(c);
      pendingBytes += c.length;
      idatLen = 0;
      if (pendingBytes >= 32 << 20) { blobs.push(new Blob(pending)); pending = []; pendingBytes = 0; }
    };
    const take = (bytes) => {
      for (let off = 0; off < bytes.length;) {
        const n = Math.min(bytes.length - off, idat.length - idatLen);
        idat.set(bytes.subarray(off, off + n), idatLen);
        idatLen += n;
        off += n;
        if (idatLen === idat.length) flushIdat();
      }
    };

    const cs = new CompressionStream('deflate');
    const writer = cs.writable.getWriter();
    const reading = (async () => {
      const reader = cs.readable.getReader();
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        take(value);
      }
    })();

    // A row's pixel bytes (no filter byte), in 32-bit words: the row being
    // filtered and the one above it. Rows are padded to a whole word.
    const lineBytes = width * channels;
    const words = Math.ceil(lineBytes / 4);
    let cur = new Uint32Array(words), prev = new Uint32Array(words);
    let curB = new Uint8Array(cur.buffer), prevB = new Uint8Array(prev.buffer);
    const diff = new Uint32Array(words), diffB = new Uint8Array(diff.buffer);
    const rowBytes = 1 + lineBytes;
    let y = 0;
    try {
      for await (const { data, rows } of strips) {
        const n = Math.min(rows, height - y);
        if (n <= 0) break;
        const src = new Uint32Array(data.buffer, data.byteOffset, width * rows);
        // A fresh buffer per strip: the stream may still hold the last one.
        const out = new Uint8Array(rowBytes * n);
        for (let r = 0; r < n; r++) {
          const s0 = r * width;
          if (alpha) cur.set(src.subarray(s0, s0 + width));
          else {
            // Four RGBA pixels (little-endian words: R | G<<8 | B<<16 | A<<24)
            // into three words of RGB bytes.
            let x = 0, j = 0;
            for (const e = width - 3; x < e; x += 4, j += 3) {
              const p0 = src[s0 + x], p1 = src[s0 + x + 1], p2 = src[s0 + x + 2], p3 = src[s0 + x + 3];
              cur[j] = (p0 & 0xffffff) | (p1 << 24);
              cur[j + 1] = ((p1 >>> 8) & 0xffff) | (p2 << 16);
              cur[j + 2] = ((p2 >>> 16) & 0xff) | (p3 << 8);
            }
            for (let b = x * 3; x < width; x++, b += 3) {
              const p = src[s0 + x];
              curB[b] = p; curB[b + 1] = p >>> 8; curB[b + 2] = p >>> 16;
            }
          }
          // Up: each byte minus the byte above, mod 256, four at a time.
          for (let i = 0; i < words; i++) {
            const a = cur[i], b = prev[i];
            diff[i] = ((a | HI) - (b & ~HI)) ^ ((a ^ ~b) & HI);
          }
          const o = r * rowBytes;
          out[o] = 2;
          out.set(diffB.subarray(0, lineBytes), o + 1);
          const t = prev; prev = cur; cur = t;
          const tb = prevB; prevB = curB; curB = tb;
        }
        y += n;
        await writer.write(out);
        if (onProgress) onProgress(y / height);
      }
      if (y !== height) throw new Error(`PNG writer got ${y} of ${height} rows`);
      await writer.close();
    } catch (e) {
      writer.abort(e).catch(() => {});
      throw e;
    }
    await reading;
    flushIdat();
    if (pending.length) blobs.push(new Blob(pending));
    return new Blob([SIGNATURE, chunk('IHDR', ihdr), ...blobs, chunk('IEND', new Uint8Array(0))], { type: 'image/png' });
  }

  // Size and format of a PNG Blob, from its header.
  async function readSize(blob) {
    const b = new DataView(await blob.slice(0, 33).arrayBuffer());
    if (b.byteLength < 33 || b.getUint32(0) !== 0x89504e47 || b.getUint32(12) !== 0x49484452) throw new Error('not a PNG');
    return { width: b.getUint32(16), height: b.getUint32(20), depth: b.getUint8(24), colourType: b.getUint8(25), interlace: b.getUint8(28) };
  }

  // Reads a PNG Blob (8-bit RGB or RGBA, not interlaced: what encode and
  // Chrome's canvas write) top to bottom, and yields strips of up to
  // `stripRows` rows as { data, rows, y }: RGBA bytes, `rows` rows starting
  // at row `y`. Only one strip and a few MB of compressed data are in
  // memory at a time.
  async function* decodeStrips(blob, { stripRows = 256 } = {}) {
    if (!LITTLE) throw new Error('PNG reader needs a little-endian machine');
    const info = await readSize(blob);
    const { width, height } = info;
    if (info.depth !== 8 || (info.colourType !== 2 && info.colourType !== 6) || info.interlace) {
      throw new Error('unsupported PNG format');
    }
    const ch = info.colourType === 6 ? 4 : 3;
    const ds = new DecompressionStream('deflate');
    const writer = ds.writable.getWriter();
    // Feed the IDAT chunks' data to the inflater, in file order.
    const feeding = (async () => {
      let off = 8;
      while (off + 8 <= blob.size) {
        const h = new DataView(await blob.slice(off, off + 8).arrayBuffer());
        const len = h.getUint32(0);
        const type = String.fromCharCode(h.getUint8(4), h.getUint8(5), h.getUint8(6), h.getUint8(7));
        if (type === 'IDAT') {
          for (let a = off + 8, end = off + 8 + len; a < end; a += 4 << 20) {
            await writer.write(new Uint8Array(await blob.slice(a, Math.min(end, a + (4 << 20))).arrayBuffer()));
          }
        }
        if (type === 'IEND') break;
        off += 12 + len;
      }
      await writer.close();
    })();
    feeding.catch(() => {});

    const lineBytes = width * ch, rowBytes = 1 + lineBytes;
    const words = Math.ceil(lineBytes / 4);
    let cur = new Uint32Array(words), prev = new Uint32Array(words);
    let curB = new Uint8Array(cur.buffer), prevB = new Uint8Array(prev.buffer);
    const row = new Uint8Array(rowBytes);
    let have = 0, y = 0, sRows = 0;
    const stripLen = () => Math.min(stripRows, height - y);
    let strip = new Uint8ClampedArray(stripLen() * width * 4), stripW = new Uint32Array(strip.buffer), stripY = 0;
    const reader = ds.readable.getReader();
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      for (let off = 0; off < value.length && y < height;) {
        const n = Math.min(rowBytes - have, value.length - off);
        row.set(value.subarray(off, off + n), have);
        have += n;
        off += n;
        if (have < rowBytes) break;
        have = 0;
        // Undo the row's filter.
        const type = row[0];
        curB.set(row.subarray(1));
        if (type === 2) {
          for (let i = 0; i < words; i++) {
            const a = cur[i], b = prev[i];
            cur[i] = ((a & ~HI) + (b & ~HI)) ^ ((a ^ b) & HI);
          }
        } else if (type === 1) {
          for (let i = ch; i < lineBytes; i++) curB[i] += curB[i - ch];
        } else if (type === 3) {
          for (let i = 0; i < lineBytes; i++) curB[i] += ((i >= ch ? curB[i - ch] : 0) + prevB[i]) >> 1;
        } else if (type === 4) {
          for (let i = 0; i < lineBytes; i++) {
            const a = i >= ch ? curB[i - ch] : 0, b = prevB[i], c = i >= ch ? prevB[i - ch] : 0;
            const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
            curB[i] += pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
          }
        } else if (type !== 0) throw new Error(`bad PNG filter ${type}`);
        // Into the strip as RGBA.
        const o = sRows * width;
        if (ch === 4) stripW.set(cur.subarray(0, width), o);
        else {
          const A = 0xff000000;
          let x = 0, j = 0;
          for (const e = width - 3; x < e; x += 4, j += 3) {
            const w0 = cur[j], w1 = cur[j + 1], w2 = cur[j + 2];
            stripW[o + x] = (w0 & 0xffffff) | A;
            stripW[o + x + 1] = (w0 >>> 24) | ((w1 & 0xffff) << 8) | A;
            stripW[o + x + 2] = (w1 >>> 16) | ((w2 & 0xff) << 16) | A;
            stripW[o + x + 3] = (w2 >>> 8) | A;
          }
          for (let b = x * 3; x < width; x++, b += 3) stripW[o + x] = curB[b] | (curB[b + 1] << 8) | (curB[b + 2] << 16) | A;
        }
        const t = prev; prev = cur; cur = t;
        const tb = prevB; prevB = curB; curB = tb;
        y++;
        if (++sRows === strip.length / 4 / width) {
          yield { data: strip, rows: sRows, y: stripY };
          sRows = 0;
          stripY = y;
          if (y < height) { strip = new Uint8ClampedArray(stripLen() * width * 4); stripW = new Uint32Array(strip.buffer); }
        }
      }
    }
    await feeding;
    if (y !== height) throw new Error(`PNG has ${y} of ${height} rows`);
  }

  root.Png = { encode, decodeStrips, readSize, crc32 };
})(typeof self !== 'undefined' ? self : globalThis);
