/* jaguar.js -- read the Atari Jaguar Wolfenstein 3-D cartridge image and
 * rebuild the HUD artwork out of it.
 *
 * The cartridge keeps its game data in a WAD file embedded in the ROM:
 *
 *   file offset 0x20000   "IWAD", numlumps (u32 LE), directory offset (u32 LE)
 *   directory             numlumps * { u32 offset, u32 length, char name[8] }
 *
 * with the lump offsets relative to the WAD start.  The artwork lumps are
 * compressed with a small LZ77 variant (see the decompressor below) and
 * unpack to an 8-byte header (width, height) followed by palette indices.
 * The colours live in the "RGBPALS" lump: 13 palettes of 256 RGB triples.
 */

import { u16le, u32le, str, cat } from './core.js';

const MAGIC = 'WPCFXBASE1';

/* ------------------------------------------------------------------- LZ77 */

/* The Jaguar ROM's LZ77: an 8-bit control mask where a 0 bit means
 * "literal byte" and a 1 bit means "12-bit offset + 4-bit length" back
 * reference.  A length nibble of 0 is the end marker. */
export function lz77Decompress(src) {
  const out = [];
  let i = 0;
  let ctrl = 0;
  let bits = 0;
  const n = src.length;
  while (i < n) {
    if (bits === 0) {
      ctrl = src[i++];
      bits = 8;
    }
    if ((ctrl & 1) === 0) {
      if (i >= n) break;
      out.push(src[i++]);
    } else {
      if (i + 2 > n) break;
      const a = src[i++];
      const b = src[i++];
      const offset = ((a << 4) | (b >> 4)) & 0xfff;
      const length = (b & 0x0f) + 1;
      if (length === 1) break;
      if (offset === 0 || offset > out.length) break;
      for (let k = 0; k < length; k++) out.push(out[out.length - offset]);
    }
    ctrl >>= 1;
    bits--;
  }
  return Uint8Array.from(out);
}

/* ---------------------------------------------------------------- the ROM */

export class JaguarROM {
  constructor(bytes) {
    this.data = bytes;
    const off = this.findWad();
    this.wadOffset = off;
    this.numlumps = u32le(bytes, off + 4);
    const diroff = u32le(bytes, off + 8);
    this.dirOffset = off + diroff;
    this.entries = [];
    for (let i = 0; i < this.numlumps; i++) {
      const p = this.dirOffset + i * 16;
      const o = u32le(bytes, p);
      const l = u32le(bytes, p + 4);
      const name = str(bytes, p + 8, 8);
      this.entries.push({ name, offset: o, length: l });
    }
    this.byName = new Map();
    for (const e of this.entries) {
      if (!this.byName.has(e.name)) this.byName.set(e.name, e);
      if (e.name.length && !/[A-Za-z0-9_]/.test(e.name[0])) {
        const alt = e.name.slice(1);
        if (!this.byName.has(alt)) this.byName.set(alt, e);
      }
    }
  }

  findWad() {
    const d = this.data;
    for (let i = 0; i + 12 <= d.length; i++) {
      if (str(d, i, 4) === 'IWAD') {
        const n = u32le(d, i + 4);
        const diroff = u32le(d, i + 8);
        if (n > 0 && n < 4096 && i + diroff + n * 16 <= d.length) return i;
      }
    }
    throw new Error('no WAD found in the cartridge image');
  }

  /* The stored size of a lump: the gap to the next lump in the file. */
  storedSize(entry) {
    const offsets = this.entries.map((e) => e.offset).filter((o) => o > entry.offset);
    if (!offsets.length) return entry.length;
    return Math.min(...offsets) - entry.offset;
  }

  lumpBytes(name) {
    const e = this.byName.get(name);
    if (!e) throw new Error('no lump named ' + name);
    return this.data.subarray(this.wadOffset + e.offset,
                             this.wadOffset + e.offset + this.storedSize(e));
  }

  /* An artwork lump -> {width, height, pixels}. */
  art(name) {
    const dec = lz77Decompress(this.lumpBytes(name));
    const w = dec[2];
    const h = dec[3];
    return { w, h, px: dec.subarray(8, 8 + w * h) };
  }

  /* The 256 RGB triples of palette `index`. */
  palette(index = 0) {
    const e = this.byName.get('RGBPALS');
    if (!e) throw new Error('no RGBPALS lump');
    const raw = this.lumpBytes('RGBPALS');
    const out = new Uint8Array(256 * 3);
    out.set(raw.subarray(index * 768, index * 768 + 768));
    return out;
  }
}

/* ------------------------------------------------------------- HUD sheet */

/* Which ROM lump ends up in which face cell, and where inside the cell its
 * top left corner sits.  Derived by matching the ROM artwork against the
 * reference sheet; the shapes line up exactly (744/744 pixels) for the
 * cells the Jaguar draws 1:1. */
const FACE_MAP = {
  0: ['ACE3', 1, 0], 1: ['ACE5', 2, 0], 2: ['ACE7', 2, 0], 3: ['ACEL1', 2, 0],
  4: ['ACER1', 0, 0], 5: ['ACE6', 1, 0], 6: ['ACE8', 2, 0], 7: ['ACE4', 2, 0],
  8: ['ACEL2', 2, 0], 9: ['ACER2', 0, 0], 10: ['ACE9', 1, 0], 11: ['ACE1', 2, 0],
  12: ['ACE10', 2, 0], 13: ['ACEL3', 1, 0], 14: ['ACER3', 0, 0], 15: ['ACE12', 1, 0],
  16: ['ACE11', 2, 0], 17: ['ACE13', 2, 0], 18: ['ACEL4', 1, 0], 19: ['ACER4', 0, 0],
  20: ['ACE15', 1, 0], 21: ['ACE18', 2, 0], 22: ['ACE16', 2, 0], 23: ['ACEL5', 1, 0],
  24: ['ACER5', 0, 0], 25: ['ACE19', 1, 0], 26: ['ACE20', 2, 0], 27: ['ACE2', 2, 0],
  28: ['ACEL6', 1, 0], 29: ['ACER6', 0, 0], 30: ['ACE21', 1, 0], 31: ['ACE23', 2, 0],
  32: ['ACE22', 2, 0], 33: [null, 0, 0], 34: [null, 0, 0],
  35: ['ACE24', 1, 0], 36: ['ACE17', 2, 2], 37: [null, 0, 0],
  38: ['ACE25', 2, 2], 39: ['ACE14', 2, 2],
};
const DIGIT_CELLS = [[30, 341], [48, 341], [64, 341], [81, 341], [98, 341],
                     [29, 358], [47, 358], [64, 358], [81, 358], [98, 358]];
const DIGIT_LUMPS = Array.from({ length: 10 }, (_, i) => 'UM' + i);
const DIGIT_OFFSET = [0, 1];
const ICON_LUMPS = ['LANK', 'KEY', 'MMO1', 'MMO2', 'MMO3'];

function blitIndexed(dst, dw, dh, src, sw, sh, x0, y0, pal) {
  for (let y = 0; y < sh; y++) {
    const dy = y0 + y;
    if (dy < 0 || dy >= dh) continue;
    for (let x = 0; x < sw; x++) {
      const dx = x0 + x;
      if (dx < 0 || dx >= dw) continue;
      const idx = src[y * sw + x];
      if (idx === 0) continue;
      const o = (dy * dw + dx) * 4;
      dst[o] = pal[idx * 3];
      dst[o + 1] = pal[idx * 3 + 1];
      dst[o + 2] = pal[idx * 3 + 2];
      dst[o + 3] = 255;
    }
  }
}

function findIconPos(canvas, dw, dh, pix, w, h) {
  let best = null;
  const ymax = Math.min(dh - h, 56);
  const xmax = dw - w;
  for (let y0 = 0; y0 <= ymax; y0++) {
    for (let x0 = 0; x0 <= xmax; x0++) {
      let same = 0, tot = 0;
      for (let y = 0; y < h; y += 2) {
        for (let x = 0; x < w; x += 2) {
          const o = ((y0 + y) * dw + (x0 + x)) * 4;
          const opaque = canvas[o + 3] !== 0;
          same += (opaque === (pix[y * w + x] !== 0)) ? 1 : 0;
          tot++;
        }
      }
      if (tot && (best === null || same > best[0])) best = [same, tot, x0, y0];
    }
  }
  if (best && best[0] >= best[1] * 0.85) return [best[2], best[3]];
  return null;
}

/* Rebuild the HUD sheet (an RGBA image) from the cartridge image. */
export function buildHudSheet(rom, sheetSize = [199, 376]) {
  const pal = rom.palette(0);
  const [dw, dh] = sheetSize;
  const canvas = new Uint8Array(dw * dh * 4);
  let faces = 0, digits = 0, icons = 0;

  for (const cell of Object.keys(FACE_MAP).map(Number).sort((a, b) => a - b)) {
    const [lump, ox, oy] = FACE_MAP[cell];
    if (!lump) continue;
    let art;
    try { art = rom.art(lump); } catch (e) { continue; }
    const r = Math.floor(cell / 5), c = cell % 5;
    blitIndexed(canvas, dw, dh, art.px, art.w, art.h,
               FACE_COLS[c][0] + ox, FACE_ROWS[r][0] + oy, pal);
    faces++;
  }
  for (let i = 0; i < DIGIT_LUMPS.length; i++) {
    let art;
    try { art = rom.art(DIGIT_LUMPS[i]); } catch (e) { continue; }
    const [x0, y0] = DIGIT_CELLS[i];
    blitIndexed(canvas, dw, dh, art.px, art.w, art.h,
               x0 + DIGIT_OFFSET[0], y0 + DIGIT_OFFSET[1], pal);
    digits++;
  }
  for (const lump of ICON_LUMPS) {
    let art;
    try { art = rom.art(lump); } catch (e) { continue; }
    const pos = findIconPos(canvas, dw, dh, art.px, art.w, art.h);
    if (pos) {
      blitIndexed(canvas, dw, dh, art.px, art.w, art.h, pos[0], pos[1], pal);
      icons++;
    }
  }
  return { width: dw, height: dh, rgba: canvas, faces, digits, icons };
}

/* Where the HUD sheet puts each face (see tools/wolf_jag_hud.py). */
const FACE_ROWS = [[77, 108], [110, 141], [143, 174], [176, 207],
                   [209, 240], [242, 273], [275, 306], [308, 339]];
const FACE_COLS = [[1, 25], [30, 60], [65, 94], [99, 124], [134, 157]];
const DIGIT_ROW_A = [341, 358];
const DIGIT_ROW_B = [358, 376];
const DIGIT_COLS_A = [[30, 46], [48, 62], [64, 79], [80, 95], [98, 114]];
const DIGIT_COLS_B = [[29, 45], [47, 63], [64, 79], [81, 97], [98, 114]];
const DIGIT_W = 16, DIGIT_H = 18;
const FACE_W = 24, FACE_H = 32;
const AMMO_ICON_BOX = [9, 10, 16, 26];
const AMMO_ICON_W = 11, AMMO_ICON_H = 26;

/* The gfxv_wl6.h chunk numbers the HUD draws. */
export const CHUNK = {
  KNIFEPIC: 91, PISTOLPIC: 92, GATLINGGUNPIC: 93, N_0PIC: 95,
  FACE1APIC: 109, GOTGATLINGPIC: 131, MUTANTBJPIC: 132, FACE8APIC: 130,
  GUNPIC: 92, N_BLANKPIC: 99,
};

const BACKDROP = [[125, 146, 158], [102, 119, 129], [99, 116, 125]];

function makeQuantizer(pal) {
  // Only slots whose two VDC nibbles are both set may hold an opaque colour:
  // a tile pixel is transparent where its low nibble is 0.
  const slots = [];
  for (let s = 1; s < 256; s++) if ((s & 0x0f) && (s & 0xf0)) slots.push(s);
  const cache = new Map();
  return (r, g, b) => {
    const key = (r << 16) | (g << 8) | b;
    let v = cache.get(key);
    if (v !== undefined) return v;
    let best = slots[0];
    let bd = Infinity;
    for (const s of slots) {
      const dr = pal[s * 3] - r;
      const dg = pal[s * 3 + 1] - g;
      const db = pal[s * 3 + 2] - b;
      const d = 2 * dr * dr + 4 * dg * dg + db * db;
      if (d < bd) { best = s; bd = d; }
    }
    cache.set(key, best);
    return best;
  };
}

function isBg(px, x, y, alphaKeyed) {
  const o = (y * px.width + x) * 4;
  if (px.rgba[o + 3] < 128) return true;
  if (alphaKeyed) return false;
  const r = px.rgba[o], g = px.rgba[o + 1], b = px.rgba[o + 2];
  for (const c of BACKDROP) if (c[0] === r && c[1] === g && c[2] === b) return true;
  return false;
}

function bbox(px, x0, x1, y0, y1, alphaKeyed) {
  let minx = 1 << 30, miny = 1 << 30, maxx = -1, maxy = -1;
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      if (isBg(px, x, y, alphaKeyed)) continue;
      if (x < minx) minx = x;
      if (x > maxx) maxx = x;
      if (y < miny) miny = y;
      if (y > maxy) maxy = y;
    }
  }
  if (maxx < 0) return null;
  return [minx, miny, maxx + 1, maxy + 1];
}

/* Cut the artwork in `box`, quantise it and centre it in a canvas, then
 * double the width for id_ca's /2 decimation. */
function extractIndexed(px, box, canvasW, canvasH, quant, alphaKeyed, valign = 'center') {
  const [x0, y0, x1, y1] = box;
  const bw = x1 - x0, bh = y1 - y0;
  const ox = (canvasW - bw) >> 1;
  const oy = valign === 'bottom' ? canvasH - bh : (canvasH - bh) >> 1;
  const idx = new Uint8Array(canvasW * canvasH);
  for (let y = 0; y < bh; y++) {
    const cy = oy + y;
    if (cy < 0 || cy >= canvasH) continue;
    for (let x = 0; x < bw; x++) {
      const cx = ox + x;
      if (cx < 0 || cx >= canvasW) continue;
      const sx = x0 + x, sy = y0 + y;
      if (isBg(px, sx, sy, alphaKeyed)) continue;
      const o = (sy * px.width + sx) * 4;
      idx[cy * canvasW + cx] = quant(px.rgba[o], px.rgba[o + 1], px.rgba[o + 2]);
    }
  }
  const dw = canvasW * 2;
  const out = new Uint8Array(dw * canvasH);
  for (let y = 0; y < canvasH; y++) {
    for (let x = 0; x < canvasW; x++) {
      const v = idx[y * canvasW + x];
      out[y * dw + x * 2] = v;
      out[y * dw + x * 2 + 1] = v;
    }
  }
  return { w: dw, h: canvasH, px: out };
}

/* Build the HUD overrides: {chunk: {w, h, px}} from the cartridge's HUD
 * sheet.  `sheet` is the decoded PNG ({width, height, rgba}). */
export function buildHudOverrides(sheet, pal) {
  const quant = makeQuantizer(pal);
  let alphaKeyed = false;
  for (let i = 3; i < sheet.rgba.length; i += 4) {
    if (sheet.rgba[i] < 128) { alphaKeyed = true; break; }
  }
  const px = sheet;
  const ov = {};

  // faces: rows 0..6, three frames per row
  for (let group = 0; group < 7; group++) {
    const [y0, y1] = FACE_ROWS[group];
    for (let frame = 0; frame < 3; frame++) {
      const [x0, x1] = FACE_COLS[frame];
      const bb = bbox(px, x0, x1, y0, y1, alphaKeyed);
      if (!bb) continue;
      ov[CHUNK.FACE1APIC + 3 * group + frame] =
        extractIndexed(px, bb, FACE_W, FACE_H, quant, alphaKeyed, 'bottom');
    }
  }
  // the special faces (grin, dead)
  {
    const [y0, y1] = FACE_ROWS[7];
    const grin = bbox(px, FACE_COLS[0][0], FACE_COLS[0][1], y0, y1, alphaKeyed);
    const dead = bbox(px, FACE_COLS[1][0], FACE_COLS[1][1], y0, y1, alphaKeyed);
    if (grin) ov[CHUNK.GOTGATLINGPIC] =
      extractIndexed(px, grin, FACE_W, FACE_H, quant, alphaKeyed, 'bottom');
    if (dead) {
      const cell = extractIndexed(px, dead, FACE_W, FACE_H, quant, alphaKeyed, 'bottom');
      ov[CHUNK.FACE8APIC] = cell;
      ov[CHUNK.MUTANTBJPIC] = cell;
    }
  }
  // the digits
  for (let i = 0; i < 5; i++) {
    const [x0, x1] = DIGIT_COLS_A[i];
    const bb = bbox(px, x0, x1, DIGIT_ROW_A[0], DIGIT_ROW_A[1], alphaKeyed);
    if (bb) ov[CHUNK.N_0PIC + i] = extractIndexed(px, bb, DIGIT_W, DIGIT_H, quant, alphaKeyed);
  }
  for (let i = 0; i < 5; i++) {
    const [x0, x1] = DIGIT_COLS_B[i];
    const bb = bbox(px, x0, x1, DIGIT_ROW_B[0], DIGIT_ROW_B[1], alphaKeyed);
    if (bb) ov[CHUNK.N_0PIC + 5 + i] = extractIndexed(px, bb, DIGIT_W, DIGIT_H, quant, alphaKeyed);
  }
  // the blank digit
  ov[CHUNK.N_BLANKPIC] = { w: DIGIT_W * 2, h: DIGIT_H, px: new Uint8Array(DIGIT_W * 2 * DIGIT_H) };
  // the ammo bullet icon (repurposes the never-drawn GUNPIC chunk)
  {
    const [ax, ay, bx, by] = AMMO_ICON_BOX;
    const cw = AMMO_ICON_W, ch = AMMO_ICON_H;
    const idx = new Uint8Array(cw * ch);
    for (let y = 0; y < ch; y++) {
      for (let x = 0; x < cw; x++) {
        // nearest-neighbour crop of the source box
        const sx = ax + Math.min(bx - ax - 1, Math.floor(x * (bx - ax) / cw));
        const sy = ay + Math.min(by - ay - 1, Math.floor(y * (by - ay) / ch));
        const o = (sy * px.width + sx) * 4;
        const r = px.rgba[o], g = px.rgba[o + 1], b = px.rgba[o + 2], a = px.rgba[o + 3];
        if (a < 128) continue;
        if (!alphaKeyed) {
          let bg = false;
          for (const c of BACKDROP) if (c[0] === r && c[1] === g && c[2] === b) bg = true;
          if (bg) continue;
        }
        idx[y * cw + x] = quant(r, g, b);
      }
    }
    const dw = cw * 2;
    const doubled = new Uint8Array(dw * ch);
    for (let y = 0; y < ch; y++) {
      for (let x = 0; x < cw; x++) {
        const v = idx[y * cw + x];
        doubled[y * dw + x * 2] = v;
        doubled[y * dw + x * 2 + 1] = v;
      }
    }
    ov[CHUNK.GUNPIC] = { w: dw, h: ch, px: doubled };
  }
  return ov;
}
