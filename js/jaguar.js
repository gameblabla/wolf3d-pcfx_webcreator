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
 * unpack to an 8-byte header followed by palette indices: byte 2 holds the
 * width, byte 3 the height, and the pixels start at offset 8.  The colours
 * live in the "RGBPALS" lump -- 13 palettes of 256 RGB triples -- and the
 * HUD art uses the first one.
 *
 * Every lump name carries a flag: the top bit of the first character is
 * set, so the face artwork is stored as 0xC6 "ACE1" and its real name is
 * "FACE1".  The bit has to be cleared before the name means anything.
 */

import { u32le, str } from './core.js';

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

/* The name of a lump with the flag bit cleared: the cartridge sets the top
 * bit of the first character of every name. */
function lumpName(raw) {
  if (!raw.length) return raw;
  return String.fromCharCode(raw.charCodeAt(0) & 0x7f) + raw.slice(1);
}

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
      this.entries.push({ name: lumpName(str(bytes, p + 8, 8)), offset: o, length: l });
    }
    this.byName = new Map();
    for (const e of this.entries) {
      if (!this.byName.has(e.name)) this.byName.set(e.name, e);
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

  /* An artwork lump -> {w, h, px}. */
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

/* Where every piece of the HUD artwork sits in the sheet the Jaguar draws.
 *
 * The sheet is 199x376: the three status icons along the top, the BJ face
 * grid under them and the status digits along the bottom.  The positions
 * come from the reference rip of the sheet (assets/jaguar/HUD.png); every
 * piece placed here matches that rip pixel for pixel, colours included --
 * the rip and the cartridge hold the same artwork.
 *
 * The two words the rip shows under the icons ("Ammo" and "Keys") are not
 * bitmaps: the Jaguar draws them with its own font at run time, so there
 * is nothing to lift out of the cartridge for them.
 */

/* The face grid: three idle frames and the two profiles, six rows of them
 * as BJ's health drops.  The near-death row and the two special faces
 * (the grin and the corpse) sit below the grid. */
const FACE_GRID = [];
for (let row = 0; row < 6; row++) {
  const y = 77 + 33 * row;
  FACE_GRID.push(
    { kind: 'face', lump: 'FACE' + (3 + 3 * row), x: 2, y },
    { kind: 'face', lump: 'FACE' + (4 + 3 * row), x: 35, y },
    { kind: 'face', lump: 'FACE' + (5 + 3 * row), x: 68, y },
    { kind: 'face', lump: 'FACEL' + (row + 1), x: row < 2 ? 101 : 100, y },
    { kind: 'face', lump: 'FACER' + (row + 1), x: 134, y });
}

const SHEET_LAYOUT = [
  /* the three status icons along the top of the sheet */
  { kind: 'icon', lump: 'AMMO1', x: 1, y: 1 },      // the ammo cartridge
  { kind: 'icon', lump: 'AMMO2', x: 34, y: 1 },     // the key card
  { kind: 'icon', lump: 'AMMO3', x: 67, y: 1 },     // the difficulty figure

  /* the row above the grid: the face the HUD opens on and two frames */
  { kind: 'face', lump: 'FIRSTFAC', x: 2, y: 44 },
  { kind: 'face', lump: 'FACE1', x: 35, y: 44 },
  { kind: 'face', lump: 'FACE2', x: 68, y: 44 },

  ...FACE_GRID,

  /* the near-death row */
  { kind: 'face', lump: 'FACE21', x: 2, y: 275 },
  { kind: 'face', lump: 'FACE22', x: 35, y: 275 },
  { kind: 'face', lump: 'FACE23', x: 68, y: 275 },

  /* the grin and the corpse */
  { kind: 'face', lump: 'FACE24', x: 2, y: 308 },
  { kind: 'face', lump: 'FACE25', x: 35, y: 311 },
];

/* The status digits: 0-4 on the upper row, 5-9 on the lower one. */
for (let i = 0; i < 5; i++) {
  SHEET_LAYOUT.push({ kind: 'digit', lump: 'NUM' + i, x: 30 + 17 * i, y: 342 });
}
for (let i = 0; i < 5; i++) {
  SHEET_LAYOUT.push({ kind: 'digit', lump: 'NUM' + (i + 5), x: 30 + 17 * i, y: 359 });
}

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

/* Rebuild the HUD sheet (an RGBA image) from the cartridge image. */
export function buildHudSheet(rom, sheetSize = [199, 376]) {
  const pal = rom.palette(0);
  const [dw, dh] = sheetSize;
  const canvas = new Uint8Array(dw * dh * 4);
  const counts = { face: 0, digit: 0, icon: 0 };

  for (const item of SHEET_LAYOUT) {
    let art;
    try { art = rom.art(item.lump); } catch (e) { continue; }
    if (!art.w || !art.h) continue;
    blitIndexed(canvas, dw, dh, art.px, art.w, art.h, item.x, item.y, pal);
    counts[item.kind]++;
  }
  return { width: dw, height: dh, rgba: canvas,
           faces: counts.face, digits: counts.digit, icons: counts.icon };
}

/* Where the HUD sheet puts each face (see tools/wolf_jag_hud.py). */
const FACE_ROWS = [[77, 108], [110, 141], [143, 174], [176, 207],
                   [209, 240], [242, 273], [275, 306], [308, 339]];
const FACE_COLS = [[1, 25], [30, 60], [65, 94], [99, 124], [134, 157]];
// Match the PC-FX crop correction: the gap at row 358 keeps the lower row's
// first pixel out of digit 3 (the stray underline seen below the ammo count).
const DIGIT_ROW_A = [341, 358];
const DIGIT_ROW_B = [358, 376];
const DIGIT_COLS_A = [[30, 46], [48, 62], [64, 79], [80, 95], [98, 114]];
const DIGIT_COLS_B = [[29, 45], [47, 63], [64, 79], [81, 97], [98, 114]];
const DIGIT_W = 16, DIGIT_H = 18;
const FACE_W = 24, FACE_H = 32;
/* The ammo cartridge, in the sheet: the bullet inside the AMMO1 icon. */
const AMMO_ICON_BOX = [9, 10, 16, 26];
const AMMO_ICON_W = 11, AMMO_ICON_H = 26;

/* The gfxv_wl6.h chunk numbers the HUD draws. */
export const CHUNK = {
  KNIFEPIC: 91, GUNPIC: 92, MACHINEGUNPIC: 93, GATLINGGUNPIC: 94,
  NOKEYPIC: 95, GOLDKEYPIC: 96, SILVERKEYPIC: 97,
  N_BLANKPIC: 98, N_0PIC: 99,
  FACE1APIC: 109, FACE8APIC: 130, GOTGATLINGPIC: 131, MUTANTBJPIC: 132,
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

function lanczos(x) {
  if (Math.abs(x) >= 3) return 0;
  if (Math.abs(x) < 1e-7) return 1;
  const p = Math.PI * x;
  return (Math.sin(p) / p) * (Math.sin(p / 3) / (p / 3));
}

/* Pillow's LANCZOS filter is used by the native PC-FX HUD baker. The browser
 * derives the corrected icon from the supplied ROM, without shipping art. */
function resizeLanczosRgba(sheet, box, dstW, dstH) {
  const [x0, y0, x1, y1] = box;
  const srcW = x1 - x0, srcH = y1 - y0;
  const xScale = srcW / dstW, yScale = srcH / dstH;
  const xFilterScale = Math.max(1, xScale), yFilterScale = Math.max(1, yScale);
  const out = new Uint8Array(dstW * dstH * 4);
  for (let y = 0; y < dstH; y++) {
    const cy = (y + 0.5) * yScale - 0.5;
    const firstY = Math.max(0, Math.ceil(cy - 3 * yFilterScale));
    const lastY = Math.min(srcH - 1, Math.floor(cy + 3 * yFilterScale));
    for (let x = 0; x < dstW; x++) {
      const cx = (x + 0.5) * xScale - 0.5;
      const firstX = Math.max(0, Math.ceil(cx - 3 * xFilterScale));
      const lastX = Math.min(srcW - 1, Math.floor(cx + 3 * xFilterScale));
      const sums = [0, 0, 0, 0];
      let total = 0;
      for (let sy = firstY; sy <= lastY; sy++) {
        const wy = lanczos((sy - cy) / yFilterScale);
        for (let sx = firstX; sx <= lastX; sx++) {
          const weight = wy * lanczos((sx - cx) / xFilterScale);
          if (weight === 0) continue;
          total += weight;
          const from = ((y0 + sy) * sheet.width + x0 + sx) * 4;
          for (let c = 0; c < 4; c++) sums[c] += sheet.rgba[from + c] * weight;
        }
      }
      const to = (y * dstW + x) * 4;
      for (let c = 0; c < 4; c++)
        out[to + c] = Math.max(0, Math.min(255, Math.round(sums[c] / total)));
    }
  }
  return out;
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
 * sheet.  `sheet` is the decoded sheet ({width, height, rgba}). */
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
  // The ammo cartridge from the top of the Jaguar HUD sheet, enlarged with
  // the same Lanczos filter as the native PC-FX asset baker.
  {
    const cw = AMMO_ICON_W, ch = AMMO_ICON_H;
    const idx = new Uint8Array(cw * ch);
    const scaled = resizeLanczosRgba(px, AMMO_ICON_BOX, cw, ch);
    for (let y = 0; y < ch; y++) {
      for (let x = 0; x < cw; x++) {
        const o = (y * cw + x) * 4;
        const r = scaled[o], g = scaled[o + 1], b = scaled[o + 2], a = scaled[o + 3];
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
