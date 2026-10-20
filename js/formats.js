/* formats.js -- parsers for id Software's Wolfenstein 3D v1.4 (WL6)
 * data formats: VSWAP (walls/sprites/sounds), GAMEMAPS/MAPHEAD (RLEW+Carmack
 * compressed maps) and VGAGRAPH/VGAHEAD/VGADICT (Huffman compressed,
 * EGA-planar pics + the proportional font).
 *
 * These are ports of the corresponding C functions in Wolf4SDL
 * (id_ca.c / id_pm.c / id_vl.c / id_vh.c).  Do not "clean up" the
 * bit-fiddling: it has to match the on-disk format exactly, including its
 * historical quirks (the NEARTAG/FARTAG word-oriented Carmack codec, the
 * 3-byte packed VGAHEAD offsets, the EGA 4-plane pic interleave).
 */

import { u16le, u32le, str } from './core.js';

export const NEARTAG = 0xA7;
export const FARTAG = 0xA8;
export const NUMMAPS = 60;
export const MAPPLANES = 3;
export const MAPSIZE = 64;
export const MAPAREA = MAPSIZE * MAPSIZE;
export const MAPTYPE_SIZE = 4 * MAPPLANES + 2 * MAPPLANES + 2 + 2 + 16;

/* ----------------------------------------------------------------- Huffman */

export function parseHuffmanTable(raw) {
  const table = new Uint16Array(255 * 2);
  for (let i = 0; i < 255; i++) {
    table[i * 2] = u16le(raw, i * 4);
    table[i * 2 + 1] = u16le(raw, i * 4 + 2);
  }
  return table;
}

/* CAL_HuffExpand: a 254-node binary Huffman decoder. */
export function huffExpand(src, length, hufftable) {
  if (!length) return new Uint8Array(0);
  const dest = new Uint8Array(length);
  let n = 0;
  const head = 254;
  let node = head;
  let pos = 0;
  let val = src[pos++];
  let mask = 1;
  for (;;) {
    const bit0 = hufftable[node * 2];
    const bit1 = hufftable[node * 2 + 1];
    const nodeval = (val & mask) ? bit1 : bit0;
    if (mask === 0x80) {
      val = src[pos++];
      mask = 1;
    } else {
      mask <<= 1;
    }
    if (nodeval < 256) {
      dest[n++] = nodeval;
      node = head;
      if (n >= length) break;
    } else {
      node = nodeval - 256;
    }
  }
  return dest.subarray(0, n);
}

/* ----------------------------------------------------------------- Carmack */

export function carmackExpand(src, length) {
  const nWords = length >> 1;
  const dest = new Uint8Array(length);
  let dp = 0;
  let pos = 0;
  const rd16 = (o) => src[o] | (src[o + 1] << 8);
  while ((dp >> 1) < nWords) {
    const ch = rd16(pos);
    pos += 2;
    const chhigh = ch >> 8;
    if (chhigh === NEARTAG) {
      const count = ch & 0xff;
      if (count === 0) {
        dest[dp++] = ch & 0xff;
        dest[dp++] = src[pos++];
      } else {
        const offset = src[pos++];
        if ((dp >> 1) + count > nWords) break;
        let copysrc = dp - offset * 2;
        for (let i = 0; i < count; i++) {
          dest[dp++] = dest[copysrc++];
          dest[dp++] = dest[copysrc++];
        }
      }
    } else if (chhigh === FARTAG) {
      const count = ch & 0xff;
      if (count === 0) {
        dest[dp++] = ch & 0xff;
        dest[dp++] = src[pos++];
      } else {
        const offset = rd16(pos);
        pos += 2;
        if ((dp >> 1) + count > nWords) break;
        let copysrc = offset * 2;
        for (let i = 0; i < count; i++) {
          dest[dp++] = dest[copysrc++];
          dest[dp++] = dest[copysrc++];
        }
      }
    } else {
      dest[dp++] = ch & 0xff;
      dest[dp++] = (ch >> 8) & 0xff;
    }
  }
  return dest.subarray(0, dp);
}

/* CA_RLEWexpand: a run-length codec over 16-bit words keyed on a sentinel. */
export function rlewExpand(src, length, rlewtag) {
  const dest = new Uint8Array(length);
  let dp = 0;
  let pos = 0;
  const rd16 = (o) => src[o] | (src[o + 1] << 8);
  while (dp < length) {
    const value = rd16(pos);
    pos += 2;
    if (value !== rlewtag) {
      dest[dp++] = value & 0xff;
      dest[dp++] = (value >> 8) & 0xff;
    } else {
      const count = rd16(pos);
      pos += 2;
      const value2 = rd16(pos);
      pos += 2;
      for (let i = 0; i < count; i++) {
        dest[dp++] = value2 & 0xff;
        dest[dp++] = (value2 >> 8) & 0xff;
      }
    }
  }
  return dest.subarray(0, length);
}

export function calCarmackThenRlew(compressed, planeWords, rlewtag) {
  const carmackLen = u16le(compressed, 0);
  const carmackOut = carmackExpand(compressed.subarray(2), carmackLen);
  return rlewExpand(carmackOut.subarray(2), planeWords * 2, rlewtag);
}

/* -------------------------------------------------------------- VGA planes */

/* VL_DePlaneVGA: EGA 4-bitplane -> linear 8bpp. */
export function deplaneVGA(buf, width, height) {
  const size = width * height;
  const temp = new Uint8Array(size);
  let srci = 0;
  const pwidth = width >> 2;
  for (let plane = 0; plane < 4; plane++) {
    for (let y = 0; y < height; y++) {
      const base = y * width;
      for (let x = 0; x < pwidth; x++) {
        const b = buf[srci++];
        temp[base + (x << 2) + plane] = b;
      }
    }
  }
  return temp;
}

/* ------------------------------------------------------------------- VSWAP */

export class VSwap {
  constructor(data) {
    this.data = data;
    this.chunksInFile = u16le(data, 0);
    this.spriteStart = u16le(data, 2);
    this.soundStart = u16le(data, 4);
    let off = 6;
    this.offsets = new Uint32Array(this.chunksInFile);
    for (let i = 0; i < this.chunksInFile; i++) {
      this.offsets[i] = u32le(data, off);
      off += 4;
    }
    this.lengths = new Uint16Array(this.chunksInFile);
    for (let i = 0; i < this.chunksInFile; i++) {
      this.lengths[i] = u16le(data, off);
      off += 2;
    }
    this.chunks = [];
    for (let i = 0; i < this.chunksInFile; i++) {
      const o = this.offsets[i];
      const ln = this.lengths[i];
      this.chunks.push(o ? data.subarray(o, o + ln) : new Uint8Array(0));
    }
  }
  wallChunk(page) { return this.chunks[page]; }
  spriteChunk(page) { return this.chunks[this.spriteStart + page]; }
  get numWalls() { return this.spriteStart; }
  get numSprites() { return this.soundStart - this.spriteStart; }
}

/* ------------------------------------------------------------- compshape_t */

export function decodeCompshape(chunk) {
  const leftpix = (chunk[0] | (chunk[1] << 8)) << 16 >> 16;
  const rightpix = (chunk[2] | (chunk[3] << 8)) << 16 >> 16;
  const bmp = new Int16Array(64 * 64).fill(-1);
  for (let x = leftpix; x <= rightpix; x++) {
    const ofs = u16le(chunk, 4 + (x - leftpix) * 2);
    let p = ofs;
    for (;;) {
      const end = ((chunk[p] | (chunk[p + 1] << 8)) << 16 >> 16) >> 1;
      if (end === 0) break;
      const top = (chunk[p + 2] | (chunk[p + 3] << 8)) << 16 >> 16;
      const start = ((chunk[p + 4] | (chunk[p + 5] << 8)) << 16 >> 16) >> 1;
      for (let y = start; y < end; y++) bmp[y * 64 + x] = chunk[top + y];
      p += 6;
    }
  }
  return { leftpix, rightpix, bmp };
}

/* -------------------------------------------------------------------- maps */

export class MapHead {
  constructor(data) {
    this.rlewtag = u16le(data, 0);
    this.headerOffsets = new Int32Array(NUMMAPS);
    for (let i = 0; i < NUMMAPS; i++) {
      this.headerOffsets[i] = (data[2 + i * 4] | (data[3 + i * 4] << 8) |
                              (data[4 + i * 4] << 16) | (data[5 + i * 4] << 24)) >> 0;
      if (this.headerOffsets[i] > 0x7fffffff) this.headerOffsets[i] -= 0x100000000;
    }
  }
}

export class MapType {
  constructor(raw) {
    this.planeStart = [0, 0, 0];
    for (let i = 0; i < 3; i++) {
      this.planeStart[i] = (raw[i * 4] | (raw[i * 4 + 1] << 8) |
                           (raw[i * 4 + 2] << 16) | (raw[i * 4 + 3] << 24)) >> 0;
    }
    this.planeLength = [u16le(raw, 12), u16le(raw, 14), u16le(raw, 16)];
    this.width = u16le(raw, 18);
    this.height = u16le(raw, 20);
    let n = '';
    for (let i = 22; i < 38 && raw[i]; i++) n += String.fromCharCode(raw[i]);
    this.name = n;
  }
}

export function loadMaps(maphead, gamemaps) {
  const out = [];
  for (let i = 0; i < NUMMAPS; i++) {
    const pos = maphead.headerOffsets[i];
    if (pos < 0) continue;
    const hdr = new MapType(gamemaps.subarray(pos, pos + MAPTYPE_SIZE));
    if (hdr.width !== MAPSIZE || hdr.height !== MAPSIZE) continue;
    const planes = [];
    for (let pl = 0; pl < 2; pl++) {
      const pstart = hdr.planeStart[pl];
      const plen = hdr.planeLength[pl];
      if (!plen) { planes.push(new Uint16Array(MAPAREA)); continue; }
      const comp = gamemaps.subarray(pstart, pstart + plen);
      const expanded = calCarmackThenRlew(comp, MAPAREA, maphead.rlewtag);
      const words = new Uint16Array(MAPAREA);
      for (let k = 0; k < MAPAREA; k++) words[k] = expanded[k * 2] | (expanded[k * 2 + 1] << 8);
      planes.push(words);
    }
    out.push({ index: i, hdr, plane0: planes[0], plane1: planes[1] });
  }
  return out;
}

/* ---------------------------------------------------------------- VGAGRAPH */

export class VgaGraph {
  constructor(headData, dictData, graphData, numChunks) {
    const n = numChunks + 1;
    this.starts = new Int32Array(n);
    for (let i = 0; i < n; i++) {
      const b = headData.subarray(i * 3, i * 3 + 3);
      const val = b[0] | (b[1] << 8) | (b[2] << 16);
      this.starts[i] = (val === 0x00ffffff) ? -1 : val;
    }
    this.hufftable = parseHuffmanTable(dictData);
    this.data = graphData;
    this.numChunks = numChunks;
  }
  rawChunk(chunk) {
    const pos = this.starts[chunk];
    if (pos < 0) return null;
    let nxt = chunk + 1;
    while (this.starts[nxt] === -1) nxt++;
    return this.data.subarray(pos, this.starts[nxt]);
  }
  chunk(chunk, explicitLen = null) {
    const raw = this.rawChunk(chunk);
    if (raw === null) return null;
    if (explicitLen !== null) return huffExpand(raw.subarray(4), explicitLen, this.hufftable);
    const expanded = (raw[0] | (raw[1] << 8) | (raw[2] << 16) | (raw[3] << 24)) >> 0;
    return huffExpand(raw.subarray(4), expanded, this.hufftable);
  }
}

export class PicTable {
  constructor(vgagraph, numpics) {
    const raw = vgagraph.chunk(0, numpics * 4);
    this.entries = [];
    for (let i = 0; i < numpics; i++) {
      this.entries.push([(raw[i * 4] | (raw[i * 4 + 1] << 8)) << 16 >> 16,
                         (raw[i * 4 + 2] | (raw[i * 4 + 3] << 8)) << 16 >> 16]);
    }
  }
  size(picnum) { return this.entries[picnum]; }
}

export function getPic(vgagraph, pictable, startpics, chunk) {
  const raw = vgagraph.chunk(chunk);
  if (raw === null) return null;
  const [w, h] = pictable.size(chunk - startpics);
  return { w, h, px: deplaneVGA(raw, w, h) };
}

/* ---------------------------------------------------------------- the font */

/* fontstruct: {int16 height; int16 location[256]; int8 width[256]; data}. */
export class WolfFont {
  constructor(raw) {
    this.height = (raw[0] | (raw[1] << 8)) << 16 >> 16;
    this.location = new Int16Array(256);
    for (let i = 0; i < 256; i++) {
      this.location[i] = (raw[2 + i * 2] | (raw[3 + i * 2] << 8)) << 16 >> 16;
    }
    this.width = new Int8Array(256);
    for (let i = 0; i < 256; i++) this.width[i] = raw[514 + i];
    this.data = raw.subarray(770);
  }
}
