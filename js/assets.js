/* assets.js -- build the PC-FX disc's resource packs in the browser.
 *
 * Two containers live on the disc:
 *
 *   WBOO  the boot pack: the title screen, the HUD pics, the between-level
 *         screens and the proportional font glyphs, all resident from boot.
 *   WPAK  the map packs: one entry per level with its geometry, the wall
 *         textures it uses and the whole sprite set.
 *
 * The layout is the same one tools/wolf_assets.py writes (the port's own
 * Python tools produce the reference build); see that file for the
 * reasoning behind each choice.
 */

import { u16le, cat, lz4Block } from './core.js';
import { decodeCompshape } from './formats.js';

export const KIND = {
  MAPPLANE0: 0, MAPPLANE1: 1, WALLTEX: 2, SPRITE: 3, MAPDIM: 4,
  PIC: 5, FONTGLYPH: 6, ICONPIC: 7, FULLPIC: 8,
};
export const NUMCHUNKS = 149;
export const NUMPICS = 132;
export const STARTPICS = 3;
export const STARTFONT = 1;
export const TITLEPIC = 87;
export const ICON_PICS = Array.from({ length: 42 }, (_, i) => 91 + i);
export const LUMP_PICS = Array.from({ length: 43 }, (_, i) => 43 + i);

/* --------------------------------------------------------------- container */

class Lump {
  constructor(kind, raw, vswapPage = 0, lz4 = false) {
    this.kind = kind;
    this.vswapPage = vswapPage;
    this.raw = raw;
    this.lz4 = lz4;
  }
}

function encodeLumpPayload(lump) {
  if (lump.lz4) {
    const block = lz4Block(lump.raw);
    const payload = new Uint8Array(2 + block.length);
    payload[0] = block.length & 0xff;
    payload[1] = (block.length >> 8) & 0xff;
    payload.set(block, 2);
    return { payload, discLen: payload.length, rawLen: lump.raw.length, lz4: 1 };
  }
  return { payload: lump.raw, discLen: lump.raw.length, rawLen: lump.raw.length, lz4: 0 };
}

/* The container format:
 *   magic[4], u32 entry count, then the entry directory, then per entry the
 *   lump headers and the payloads.
 */
export function buildContainer(magic, entries) {
  const ENTRYDIR_SIZE = 24;      // name[8] + nlumps,hdr_off,pay_off,pay_bytes
  const LUMPHDR_SIZE = 24;       // 6 u32s
  const enc = new TextEncoder();
  const dirRecords = [];
  const body = [];
  let total = 8 + ENTRYDIR_SIZE * entries.length;

  for (const [name, lumps] of entries) {
    const hdrOff = total;
    const encoded = lumps.map(encodeLumpPayload);
    const payOff = hdrOff + LUMPHDR_SIZE * lumps.length;
    let cursor = 0;
    const hdrBytes = [];
    const payBytes = [];
    for (let i = 0; i < lumps.length; i++) {
      const e = encoded[i];
      const h = new Uint8Array(LUMPHDR_SIZE);
      const dv = new DataView(h.buffer);
      dv.setUint32(0, lumps[i].kind, true);
      dv.setUint32(4, lumps[i].vswapPage, true);
      dv.setUint32(8, cursor, true);
      dv.setUint32(12, e.discLen, true);
      dv.setUint32(16, e.rawLen, true);
      dv.setUint32(20, e.lz4, true);
      hdrBytes.push(h);
      payBytes.push(e.payload);
      cursor += e.discLen;
    }
    const hdrLen = LUMPHDR_SIZE * lumps.length;
    let payLen = 0;
    for (const p of payBytes) payLen += p.length;
    const nm = enc.encode(name).subarray(0, 8);
    const nmPad = new Uint8Array(8);
    nmPad.set(nm);
    dirRecords.push({ nm: nmPad, nlumps: lumps.length, hdrOff, payOff, payBytes: payLen });
    body.push(cat(hdrBytes), cat(payBytes));
    total = payOff + payLen;
  }

  const out = [];
  const head = new Uint8Array(8 + ENTRYDIR_SIZE * entries.length);
  const dv = new DataView(head.buffer);
  for (let i = 0; i < 4; i++) head[i] = magic.charCodeAt(i);
  dv.setUint32(4, entries.length, true);
  for (let i = 0; i < dirRecords.length; i++) {
    const r = dirRecords[i];
    const o = 8 + i * ENTRYDIR_SIZE;
    head.set(r.nm, o);
    dv.setUint32(o + 8, r.nlumps, true);
    dv.setUint32(o + 12, r.hdrOff, true);
    dv.setUint32(o + 16, r.payOff, true);
    dv.setUint32(o + 20, r.payBytes, true);
  }
  out.push(head);
  for (const b of body) out.push(b);
  return cat(out);
}

/* ------------------------------------------------------------- the palette */

/* The nearest opaque palette entry to pure black: Wolf3D's palette has no
 * exact black twin, and the PC-FX renderer punches a hole wherever a texel
 * is index 0, so opaque black texels are rewritten to this stand-in. */
export function findSafeBlackTwin(pal) {
  let best = 1, bd = Infinity;
  for (let i = 1; i < 256; i++) {
    const r = pal[i * 3], g = pal[i * 3 + 1], b = pal[i * 3 + 2];
    const d = r * r + g * g + b * b;
    if (d < bd) { best = i; bd = d; }
  }
  return best;
}

/* ---------------------------------------------------------------- boot pack */

function scaleImage(w, h, pixels, outW, outH) {
  // Nearest-neighbour resize, sampling the centre of each source pixel
  // (the same rule PIL's NEAREST filter uses, so the result matches the
  // port's own build).
  const out = new Uint8Array(outW * outH);
  for (let y = 0; y < outH; y++) {
    const sy = Math.min(h - 1, Math.floor((y + 0.5) * h / outH));
    for (let x = 0; x < outW; x++) {
      const sx = Math.min(w - 1, Math.floor((x + 0.5) * w / outW));
      out[y * outW + x] = pixels[sy * w + sx];
    }
  }
  return out;
}

export function buildBootpack(vg, pt, hudOverrides, safeBlack) {
  const lumps = [];

  // kind 5: the title screen, rescaled 320x200 -> 256x240, stored RAW so it
  // can be DMA'd straight CD->KRAM.
  {
    const [w, h, px] = getPicRaw(vg, pt, TITLEPIC);
    const tw = 256, th = 240;
    const scaled = scaleImage(w, h, px, tw, th);
    const payload = new Uint8Array(4 + scaled.length);
    new DataView(payload.buffer).setUint16(0, tw, true);
    new DataView(payload.buffer).setUint16(2, th, true);
    payload.set(scaled, 4);
    lumps.push(new Lump(KIND.PIC, payload));
  }

  // kind 7: the HUD pics (the Jaguar art replaces the PC ones).
  for (const chunk of ICON_PICS) {
    let w, h, px;
    if (hudOverrides[chunk]) {
      ({ w, h, px } = hudOverrides[chunk]);
    } else {
      const p = getPicRaw(vg, pt, chunk);
      if (!p) continue;
      [w, h, px] = p;
      if (w > 320) {
        const nw = 256;
        const nh = Math.max(1, Math.round(h * 256 / w));
        px = scaleImage(w, h, px, nw, nh);
        w = nw; h = nh;
      }
    }
    const payload = new Uint8Array(4 + px.length);
    const dv = new DataView(payload.buffer);
    dv.setUint16(0, w, true);
    dv.setUint16(2, h, true);
    payload.set(px, 4);
    lumps.push(new Lump(KIND.ICONPIC, payload, chunk, true));
  }

  // kind 8: the between-levels screen pics, stored at full resolution.
  for (const chunk of LUMP_PICS) {
    const p = getPicRaw(vg, pt, chunk);
    if (!p) continue;
    let [w, h, px] = p;
    if (safeBlack && px.includes(0)) {
      for (let i = 0; i < px.length; i++) if (px[i] === 0) px[i] = safeBlack;
    }
    const payload = new Uint8Array(4 + px.length);
    const dv = new DataView(payload.buffer);
    dv.setUint16(0, w, true);
    dv.setUint16(2, h, true);
    payload.set(px, 4);
    lumps.push(new Lump(KIND.FULLPIC, payload, chunk, true));
  }

  // kind 6: the font glyphs (both proportional fonts).
  for (let fontnum = 0; fontnum < 2; fontnum++) {
    const fontRaw = vg.chunk(STARTFONT + fontnum);
    const font = new WolfFontJS(fontRaw);
    for (let ch = 0; ch < 256; ch++) {
      const gw = font.width[ch];
      const gh = font.height;
      if (gw <= 0) continue;
      const loc = font.location[ch];
      const bmp = new Uint8Array(gw * gh);
      for (let y = 0; y < gh; y++) {
        for (let x = 0; x < gw; x++) {
          bmp[y * gw + x] = font.data[loc + y * gw + x] ? 1 : 0;
        }
      }
      const payload = new Uint8Array(4 + bmp.length);
      const dv = new DataView(payload.buffer);
      dv.setUint16(0, gw, true);
      dv.setUint16(2, gh, true);
      payload.set(bmp, 4);
      lumps.push(new Lump(KIND.FONTGLYPH, payload, (fontnum << 8) | ch, true));
    }
  }

  return buildContainer('WBOO', [['BOOT', lumps]]);
}

/* ---------------------------------------------------------------- map packs */

function mapSlotName(i) {
  const ep = Math.floor(i / 10) + 1;
  const n = i % 10;
  if (n < 8) return 'E' + ep + 'M' + (n + 1);
  return 'E' + ep + (n === 8 ? 'B' : 'S');
}

function remapWalltexZero(chunk, safe) {
  let n = 0;
  const buf = chunk.slice();
  for (let i = 0; i < buf.length; i++) {
    if (buf[i] === 0) { buf[i] = safe; n++; }
  }
  return { buf, n };
}

/* Only the opaque pixel bytes of a compshape_t may be touched: blindly
 * byte-scanning the chunk would corrupt the offsets in the post list. */
function remapSpriteZero(chunk, safe) {
  if (chunk.length < 4 + 64 * 2) return { buf: chunk, n: 0 };
  const buf = chunk.slice();
  const leftpix = (buf[0] | (buf[1] << 8)) << 16 >> 16;
  const rightpix = (buf[2] | (buf[3] << 8)) << 16 >> 16;
  let n = 0;
  for (let x = leftpix; x <= rightpix; x++) {
    const ofs = u16le(buf, 4 + (x - leftpix) * 2);
    let p = ofs;
    for (;;) {
      const end = ((buf[p] | (buf[p + 1] << 8)) << 16 >> 16) >> 1;
      if (end === 0) break;
      const top = (buf[p + 2] | (buf[p + 3] << 8)) << 16 >> 16;
      const start = ((buf[p + 4] | (buf[p + 5] << 8)) << 16 >> 16) >> 1;
      for (let y = start; y < end; y++) {
        if (buf[top + y] === 0) { buf[top + y] = safe; n++; }
      }
      p += 6;
    }
  }
  return { buf, n };
}

function wallPagesForPlane0(plane0) {
  const pages = new Set();
  let hasDoor = false;
  for (const v of plane0) {
    if (v >= 1 && v <= 63) {
      pages.add((v - 1) * 2);
      pages.add((v - 1) * 2 + 1);
    } else if (v >= 90 && v <= 101) {
      hasDoor = true;
    }
  }
  return { pages, hasDoor };
}

export function buildMappacks(vs, maps, safeBlack) {
  const entries = [];
  const doorwall = vs.spriteStart - 8;

  for (const m of maps) {
    const lumps = [];
    // the map dimensions
    const dim = new Uint8Array(4);
    const dimv = new DataView(dim.buffer);
    dimv.setUint16(0, m.hdr.width, true);
    dimv.setUint16(2, m.hdr.height, true);
    lumps.push(new Lump(KIND.MAPDIM, dim));

    for (const [kind, plane] of [[KIND.MAPPLANE0, m.plane0], [KIND.MAPPLANE1, m.plane1]]) {
      const bytes = new Uint8Array(plane.length * 2);
      const dv = new DataView(bytes.buffer);
      for (let i = 0; i < plane.length; i++) dv.setUint16(i * 2, plane[i], true);
      lumps.push(new Lump(kind, bytes, 0, true));
    }

    const { pages, hasDoor } = wallPagesForPlane0(m.plane0);
    if (hasDoor) {
      for (let n = 0; n < 8; n++) pages.add(doorwall + n);
    }
    const wallPages = [...pages].filter((p) => p >= 0 && p < vs.numWalls).sort((a, b) => a - b);
    for (const page of wallPages) {
      let c = vs.wallChunk(page);
      if (safeBlack !== null && safeBlack !== undefined) c = remapWalltexZero(c, safeBlack).buf;
      lumps.push(new Lump(KIND.WALLTEX, c, page, false));
    }
    // every level ships the whole sprite set (the spec allows it).
    for (let page = 0; page < vs.numSprites; page++) {
      let c = vs.spriteChunk(page);
      if (safeBlack !== null && safeBlack !== undefined && c.length) {
        c = remapSpriteZero(c, safeBlack).buf;
      }
      lumps.push(new Lump(KIND.SPRITE, c, page, true));
    }
    entries.push([mapSlotName(m.index), lumps]);
  }
  return buildContainer('WPAK', entries);
}

/* ------------------------------------------------------------------ helpers */

function getPicRaw(vg, pt, chunk) {
  const raw = vg.chunk(chunk);
  if (raw === null) return null;
  const [w, h] = pt.size(chunk - STARTPICS);
  return [w, h, deplaneVGAJS(raw, w, h)];
}

function deplaneVGAJS(buf, width, height) {
  const size = width * height;
  const temp = new Uint8Array(size);
  let srci = 0;
  const pwidth = width >> 2;
  for (let plane = 0; plane < 4; plane++) {
    for (let y = 0; y < height; y++) {
      const base = y * width;
      for (let x = 0; x < pwidth; x++) {
        temp[base + (x << 2) + plane] = buf[srci++];
      }
    }
  }
  return temp;
}

class WolfFontJS {
  constructor(raw) {
    this.height = (raw[0] | (raw[1] << 8)) << 16 >> 16;
    this.location = new Int16Array(256);
    for (let i = 0; i < 256; i++) {
      this.location[i] = (raw[2 + i * 2] | (raw[3 + i * 2] << 8)) << 16 >> 16;
    }
    this.width = new Int8Array(256);
    for (let i = 0; i < 256; i++) this.width[i] = raw[514 + i];
    this.data = raw;          // the glyph offsets are relative to the chunk
  }
}
