/* core.js -- bytes, CRC32, ZIP, LZ4 and PNG helpers for the wolf-pcfx web
 * editor.  Everything the editor does runs in the browser: there is no
 * server-side build step.
 */

/* ------------------------------------------------------------------ bytes */

export function u16le(a, o) { return a[o] | (a[o + 1] << 8); }
export function u32le(a, o) {
  return (a[o] | (a[o + 1] << 8) | (a[o + 2] << 16) | (a[o + 3] << 24) >>> 0);
}
export function u16be(a, o) { return (a[o] << 8) | a[o + 1]; }
export function u32be(a, o) {
  return ((a[o] << 24) | (a[o + 1] << 16) | (a[o + 2] << 8) | a[o + 3]) >>> 0;
}
export function str(a, o, n) {
  let s = '';
  for (let i = 0; i < n; i++) {
    const c = a[o + i];
    if (!c) break;
    s += String.fromCharCode(c);
  }
  return s;
}
export function cat(arrays) {
  let n = 0;
  for (const a of arrays) n += a.length;
  const out = new Uint8Array(n);
  let p = 0;
  for (const a of arrays) { out.set(a, p); p += a.length; }
  return out;
}
export function hex(n, w = 8) { return n.toString(16).padStart(w, '0'); }

/* ------------------------------------------------------------------ CRC32 */

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    t[n] = c >>> 0;
  }
  return t;
})();

export function crc32(bytes, start = 0, end = bytes.length) {
  let c = 0xffffffff;
  for (let i = start; i < end; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

export function crc32hex(bytes) { return hex(crc32(bytes)); }

/* -------------------------------------------------------------- LZ4 block */

/* A raw LZ4 block (no frame header), the format platform/lz4_depack.S
 * expects.  The encoder is deliberately simple and deterministic: the same
 * input always gives the same block, so a build is reproducible and the
 * Python tools and this editor agree byte for byte.
 *
 * token: the high nibble is the literal length (15 means "more bytes
 * follow"), the low nibble is the match length minus 4 (15 means "more bytes
 * follow").  A match is a 2-byte little-endian offset (12 bits) followed by
 * the length extension.  The last sequence of a block is literals only.
 */

const MINMATCH = 4;
const HASHLOG = 16;

export function lz4LiteralBlock(data) {
  const out = [];
  const n = data.length;
  out.push(n >= 15 ? 0xf0 : (n << 4));
  if (n >= 15) {
    let r = n - 15;
    while (r >= 255) { out.push(255); r -= 255; }
    out.push(r);
  }
  for (let i = 0; i < n; i++) out.push(data[i]);
  return Uint8Array.from(out);
}

export function lz4Block(data) {
  if (data.length > 0x10000) throw new Error('LZ4 block input must be <= 64 KB');
  const n = data.length;
  const table = new Int32Array(1 << HASHLOG).fill(-1);
  const out = [];
  let anchor = 0;
  let i = 0;
  const hash = (p) => {
    const v = (data[p] | (data[p + 1] << 8) | (data[p + 2] << 16)) >>> 0;
    return Math.imul(v, 2654435761) >>> (32 - HASHLOG);
  };

  while (i < n - MINMATCH) {
    const h = hash(i);
    const cand = table[h];
    table[h] = i;
    if (cand < 0 || i - cand > 0xffff) { i++; continue; }
    let l = 0;
    while (i + l < n && data[cand + l] === data[i + l]) l++;
    if (l < MINMATCH) { i++; continue; }
    const litLen = i - anchor;
    const mlen = l - MINMATCH;
    const offset = i - cand;
    out.push((litLen >= 15 ? 0xf0 : (litLen << 4)) | (mlen >= 15 ? 0x0f : mlen));
    if (litLen >= 15) {
      let r = litLen - 15;
      while (r >= 255) { out.push(255); r -= 255; }
      out.push(r);
    }
    for (let k = anchor; k < i; k++) out.push(data[k]);
    out.push(offset & 0xff, (offset >> 8) & 0xff);
    if (mlen >= 15) {
      let r = mlen - 15;
      while (r >= 255) { out.push(255); r -= 255; }
      out.push(r);
    }
    i += l;
    anchor = i;
  }
  const litLen = n - anchor;
  if (litLen >= 15) {
    out.push(0xf0);
    let r = litLen - 15;
    while (r >= 255) { out.push(255); r -= 255; }
    out.push(r);
  } else {
    out.push(litLen << 4);
  }
  for (let k = anchor; k < n; k++) out.push(data[k]);
  const block = Uint8Array.from(out);
  const lit = lz4LiteralBlock(data);
  return lit.length < block.length ? lit : block;
}

/* ------------------------------------------------------------------- ZIP */

async function inflateRaw(bytes) {
  const ds = new DecompressionStream('deflate-raw');
  const stream = new Blob([bytes]).stream().pipeThrough(ds);
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/* Read a zip: returns a Map of base name -> Uint8Array. */
export async function unzip(buf) {
  const bytes = new Uint8Array(buf);
  const out = new Map();
  let eocd = -1;
  for (let i = bytes.length - 22; i >= 0 && i > bytes.length - 66000; i--) {
    if (bytes[i] === 0x50 && bytes[i + 1] === 0x4b && bytes[i + 2] === 0x05 && bytes[i + 3] === 0x06) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error('not a zip file');
  const count = u16le(bytes, eocd + 10);
  let off = u32le(bytes, eocd + 16);
  for (let i = 0; i < count; i++) {
    if (u32le(bytes, off) !== 0x02014b50) throw new Error('bad zip directory');
    const method = u16le(bytes, off + 10);
    const csize = u32le(bytes, off + 20);
    const nlen = u16le(bytes, off + 28);
    const elen = u16le(bytes, off + 30);
    const clen = u16le(bytes, off + 32);
    const lho = u32le(bytes, off + 42);
    const name = str(bytes, off + 46, nlen);
    const lnlen = u16le(bytes, lho + 26);
    const lelen = u16le(bytes, lho + 28);
    const dataStart = lho + 30 + lnlen + lelen;
    const raw = bytes.subarray(dataStart, dataStart + csize);
    let data;
    if (method === 0) data = raw.slice();
    else if (method === 8) data = await inflateRaw(raw);
    else throw new Error('unsupported zip compression method ' + method);
    const base = name.split('/').pop();
    if (base && !name.endsWith('/')) out.set(base, data);
    off += 46 + nlen + elen + clen;
  }
  return out;
}

/* Write a zip (stored entries only -- the payload is already compressed). */
export function zip(entries) {
  const chunks = [];
  const central = [];
  let offset = 0;
  const enc = new TextEncoder();
  for (const e of entries) {
    const nameBytes = enc.encode(e.name);
    const data = e.data;
    const crc = crc32(data);
    const local = new Uint8Array(30 + nameBytes.length);
    const dv = new DataView(local.buffer);
    dv.setUint32(0, 0x04034b50, true);
    dv.setUint16(4, 20, true);            // version needed
    dv.setUint16(6, 0, true);             // flags
    dv.setUint16(8, 0, true);             // stored
    dv.setUint16(10, 0, true);            // time
    dv.setUint16(12, 0x21, true);         // date
    dv.setUint32(14, crc, true);
    dv.setUint32(18, data.length, true);
    dv.setUint32(22, data.length, true);
    dv.setUint16(26, nameBytes.length, true);
    dv.setUint16(28, 0, true);
    local.set(nameBytes, 30);
    chunks.push(local, data);
    central.push({ nameBytes, crc, size: data.length, offset });
    offset += local.length + data.length;
  }
  let cdSize = 0;
  const cdChunks = [];
  for (const c of central) {
    const h = new Uint8Array(46 + c.nameBytes.length);
    const dv = new DataView(h.buffer);
    dv.setUint32(0, 0x02014b50, true);
    dv.setUint16(4, 20, true);
    dv.setUint16(6, 20, true);
    dv.setUint16(8, 0, true);
    dv.setUint16(10, 0, true);
    dv.setUint16(12, 0, true);
    dv.setUint16(14, 0x21, true);
    dv.setUint32(16, c.crc, true);
    dv.setUint32(20, c.size, true);
    dv.setUint32(24, c.size, true);
    dv.setUint16(28, c.nameBytes.length, true);
    dv.setUint16(30, 0, true);
    dv.setUint16(32, 0, true);
    dv.setUint16(34, 0, true);
    dv.setUint16(36, 0, true);
    dv.setUint32(38, 0, true);
    dv.setUint32(42, c.offset, true);
    h.set(c.nameBytes, 46);
    cdChunks.push(h);
    cdSize += h.length;
  }
  const end = new Uint8Array(22);
  const dv = new DataView(end.buffer);
  dv.setUint32(0, 0x06054b50, true);
  dv.setUint16(8, central.length, true);
  dv.setUint16(10, central.length, true);
  dv.setUint32(12, cdSize, true);
  dv.setUint32(16, offset, true);
  dv.setUint16(20, 0, true);
  return new Blob([...chunks, ...cdChunks, end], { type: 'application/zip' });
}

/* ------------------------------------------------------------------- PNG */

async function deflate(bytes) {
  const cs = new CompressionStream('deflate');
  const stream = new Blob([bytes]).stream().pipeThrough(cs);
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

function pngChunk(type, data) {
  const out = new Uint8Array(12 + data.length);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, data.length);
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  out.set(data, 8);
  let c = 0xffffffff;
  for (let i = 4; i < 8 + data.length; i++) c = CRC_TABLE[(c ^ out[i]) & 0xff] ^ (c >>> 8);
  dv.setUint32(8 + data.length, (c ^ 0xffffffff) >>> 0);
  return out;
}

/* Write an RGBA PNG. */
export async function pngRGBA(width, height, rgba) {
  const raw = new Uint8Array(height * (width * 4 + 1));
  for (let y = 0; y < height; y++) {
    raw[y * (width * 4 + 1)] = 0;
    raw.set(rgba.subarray(y * width * 4, (y + 1) * width * 4), y * (width * 4 + 1) + 1);
  }
  const ihdr = new Uint8Array(13);
  const dv = new DataView(ihdr.buffer);
  dv.setUint32(0, width);
  dv.setUint32(4, height);
  ihdr[8] = 8; ihdr[9] = 6;
  const idat = await deflate(raw);
  return new Blob([new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
                   pngChunk('IHDR', ihdr),
                   pngChunk('IDAT', idat),
                   pngChunk('IEND', new Uint8Array(0))],
                  { type: 'image/png' });
}

/* Decode a PNG into {width, height, rgba}. */
export async function readPNG(blob) {
  const bmp = await createImageBitmap(blob, { premultiplyAlpha: 'none' });
  const canvas = new OffscreenCanvas(bmp.width, bmp.height);
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(bmp, 0, 0);
  const img = ctx.getImageData(0, 0, bmp.width, bmp.height);
  bmp.close();
  return { width: img.width, height: img.height, rgba: new Uint8Array(img.data.buffer) };
}
