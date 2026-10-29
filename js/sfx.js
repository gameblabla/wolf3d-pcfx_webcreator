/* sfx.js -- build the PC-FX KING ADPCM sound-effect bank in the browser.
 *
 * The bank holds Wolf3D's digitized sounds: the 46 that came with the
 * DOS VSWAP (8-bit PCM) plus a handful of extras the 3DO release
 * digitized but DOS never did, taken from the 3DO sound effects.
 *
 * Everything is resampled to 8 kHz and encoded with the 4-bit ADPCM the
 * KING's sound engine plays (see platform/wolf_sound.c for the decoder
 * contract).
 */

import { u16le, u32le } from './core.js';

export const DST_RATE = 8000;
export const SRC_RATE = 7042;
export const ADPCM_RATE_FIELD = 2;         // 8000 Hz
export const ENCODE_GAIN = 128;
export const ENCODE_CLAMP_LO = -0x4000;
export const ENCODE_CLAMP_HI = 0x3fff;
export const SINC_LOBES = 8;
export const SINC_LPF_FRAC = 0.95;
export const ALIGN_WORDS = 256;
export const ALIGN_BYTES = ALIGN_WORDS * 2;
export const KRAM_BASE = 0x21000;
export const BANK_BUDGET_BYTES = (0x40000 - KRAM_BASE) * 2;

export const STEP_SIZES = [
  16, 17, 19, 21, 23, 25, 28, 31, 34, 37, 41, 45, 50,
  55, 60, 66, 73, 80, 88, 97, 107, 118, 130, 143, 157, 173, 190, 209,
  230, 253, 279, 307, 337, 371, 408, 449, 494, 544, 598, 658, 724, 796,
  876, 963, 1060, 1166, 1282, 1411, 1552,
];
export const STEP_DELTAS = [
  -1, -1, -1, -1, 2, 4, 6, 8, -1, -1, -1, -1, 2, 4, 6, 8,
];

/* The decoder's step table: delta = (step * ((nib & 7) + 1)) >> f, negated
 * when bit 3 is set.  The shift truncates first, so the predictor moves
 * ((step*(mag+1)) >> f) << f. */
const STEP_DELTA = [];
for (let i = 0; i < STEP_SIZES.length; i++) {
  const row = new Int32Array(16);
  for (let n = 0; n < 16; n++) {
    let d = (STEP_SIZES[i] * ((n & 7) + 1)) >> ADPCM_RATE_FIELD;
    if (n & 8) d = -d;
    row[n] = d << ADPCM_RATE_FIELD;
  }
  STEP_DELTA.push(row);
}
const NEXT_IDX = [];
for (let i = 0; i < STEP_SIZES.length; i++) {
  const row = new Int32Array(16);
  for (let n = 0; n < 16; n++) row[n] = Math.max(0, Math.min(48, i + STEP_DELTAS[n]));
  NEXT_IDX.push(row);
}

function clamp(v, lo, hi) { return v < lo ? lo : (v > hi ? hi : v); }

/* The 4-bit ADPCM encoder: for every sample, try all 16 nibbles and keep
 * the one the hardware decoder reproduces most closely. */
export function encodeADPCM(samples) {
  let pred = 0, idx = 0;
  const nibbles = [];
  for (const target of samples) {
    let bestErr = Infinity, bestNib = 0, bestPred = pred;
    const deltas = STEP_DELTA[idx];
    for (let nib = 0; nib < 16; nib++) {
      let cand = pred + deltas[nib];
      if (cand < ENCODE_CLAMP_LO) cand = ENCODE_CLAMP_LO;
      else if (cand > ENCODE_CLAMP_HI) cand = ENCODE_CLAMP_HI;
      const err = (target - cand) * (target - cand);
      if (err < bestErr) { bestErr = err; bestNib = nib; bestPred = cand; }
    }
    nibbles.push(bestNib);
    pred = bestPred;
    idx = NEXT_IDX[idx][bestNib];
  }
  while (nibbles.length % 4) nibbles.push(0);
  const out = new Uint8Array(nibbles.length / 2);
  const dv = new DataView(out.buffer);
  for (let i = 0; i < nibbles.length; i += 4) {
    const hw = (nibbles[i] & 15) | ((nibbles[i + 1] & 15) << 4) |
               ((nibbles[i + 2] & 15) << 8) | ((nibbles[i + 3] & 15) << 12);
    dv.setUint16(i / 2, hw, true);
  }
  return out;
}

/* ------------------------------------------------------------- resampling */

function sinc(x) {
  if (x === 0) return 1;
  const z = Math.PI * x;
  return Math.sin(z) / z;
}

function gcd(a, b) { while (b) { const t = a % b; a = b; b = t; } return a; }

function sincKernels(srcRate) {
  const ratio = DST_RATE / srcRate;
  const fc = 0.5 * Math.min(1, ratio) * SINC_LPF_FRAC;
  const half = Math.ceil(SINC_LOBES / (2 * fc));
  const step = srcRate / DST_RATE;
  const period = Math.floor(DST_RATE / gcd(Math.trunc(srcRate), DST_RATE));
  const kernels = [];
  for (let p = 0; p < period; p++) {
    const frac = (p * step) % 1.0;
    const k = [];
    for (let t = -half; t <= half; t++) {
      const d = t - frac;
      const u = (d + half) / (2.0 * half);
      const w = 0.42 - 0.5 * Math.cos(2.0 * Math.PI * u) + 0.08 * Math.cos(4.0 * Math.PI * u);
      k.push(2.0 * fc * sinc(2.0 * fc * d) * w);
    }
    const tot = k.reduce((a, b) => a + b, 0);
    // Round the kernel to 9 decimals so this matches the Python tools
    // bit for bit (the two libms differ in the last bits).
    kernels.push(tot ? k.map((v) => Math.round(v / tot * 1e9) / 1e9) : k);
  }
  return { kernels, half, step, period };
}

const kernelCache = new Map();

function kernelsFor(srcRate) {
  let k = kernelCache.get(srcRate);
  if (!k) { k = sincKernels(srcRate); kernelCache.set(srcRate, k); }
  return k;
}

/* 8-bit unsigned PCM -> the encoder's range. */
export function resampleU8(pcm, srcRate) {
  if (!pcm.length) return [];
  const nIn = pcm.length;
  const { kernels, half, step, period } = kernelsFor(srcRate);
  const outLen = Math.max(1, Math.round(nIn * DST_RATE / srcRate));
  const out = [];
  for (let i = 0; i < outLen; i++) {
    const base = Math.trunc(i * step);
    const ker = kernels[i % period];
    let acc = 0.0;
    for (let j = 0; j < ker.length; j++) {
      let idx = base + j - half;
      if (idx < 0) idx = 0;
      else if (idx >= nIn) idx = nIn - 1;
      acc += (pcm[idx] - 128) * ker[j];
    }
    out.push(clamp(Math.floor(acc * ENCODE_GAIN + 0.5), ENCODE_CLAMP_LO, ENCODE_CLAMP_HI));
  }
  for (let i = 0; i < DST_RATE / 100; i++) out.push(0);
  return out;
}

/* Signed 16-bit PCM -> the encoder's range (the 3DO AIFFs measure as 8-bit
 * material in a 16-bit container, so they are scaled the same way). */
export function resampleS16(pcm, srcRate) {
  if (!pcm.length) return [];
  const nIn = pcm.length;
  const scale = ENCODE_GAIN / 256.0;
  const { kernels, half, step, period } = kernelsFor(srcRate);
  const outLen = Math.max(1, Math.round(nIn * DST_RATE / srcRate));
  const out = [];
  for (let i = 0; i < outLen; i++) {
    const base = Math.trunc(i * step);
    const ker = kernels[i % period];
    let acc = 0.0;
    for (let j = 0; j < ker.length; j++) {
      let idx = base + j - half;
      if (idx < 0) idx = 0;
      else if (idx >= nIn) idx = nIn - 1;
      acc += pcm[idx] * ker[j];
    }
    out.push(clamp(Math.floor(acc * scale + 0.5), ENCODE_CLAMP_LO, ENCODE_CLAMP_HI));
  }
  for (let i = 0; i < DST_RATE / 100; i++) out.push(0);
  return out;
}

/* ------------------------------------------------------------- the sounds */

/* The digitized sounds in the VSWAP, in DigiMap order. */
export function readDigiSounds(vs) {
  const info = vs.chunks[vs.chunksInFile - 1];
  const sounds = [];
  for (let i = 0; i * 4 + 4 <= info.length; i++) {
    const startpage = u16le(info, i * 4);
    const length = u16le(info, i * 4 + 2);
    if (length === 0) { sounds.push(new Uint8Array(0)); continue; }
    const buf = [];
    let bufLen = 0;
    let page = startpage;
    while (bufLen < length) {
      const idx = vs.soundStart + page;
      if (idx >= vs.chunksInFile - 1) break;
      const c = vs.chunks[idx];
      buf.push(c);
      bufLen += c.length;
      page++;
    }
    const out = new Uint8Array(Math.min(bufLen, length));
    let p = 0;
    for (const c of buf) {
      if (p >= out.length) break;
      out.set(c.subarray(0, Math.min(c.length, out.length - p)), p);
      p += c.length;
    }
    sounds.push(out);
  }
  while (sounds.length && !sounds[sounds.length - 1].length) sounds.pop();
  return sounds;
}

/* Which 3DO sound each digi index uses (see tools/gen_wolf_sfx.py). */
export const DIGI_TO_3DO = {
  0: 8, 1: 5, 3: 4, 4: 16, 5: 15, 6: 17, 7: 7, 8: 22, 9: 34, 10: 32,
  11: 16, 12: 9, 13: 10, 14: 27, 15: 20, 16: 6, 17: 12, 18: 35, 19: 7,
  20: 24, 21: 15, 22: 24, 23: 34, 24: 7, 25: 39, 26: 38, 27: 35, 28: 8,
  29: 5, 30: 1, 31: 42, 32: 26, 33: 23, 34: 11, 35: 12, 36: 10, 37: 34,
  38: 35, 39: 9, 40: 10, 41: 11, 42: 12, 43: 7, 44: 9, 45: 10,
};

/* The sounds the DOS release never digitized but the 3DO did. */
export const EXTRA_DIGI_3DO = [
  [2], [13], [25], [25], [24], [24], [3], [3], [3], [3], [26],
  [14], [18], [19], [40], [29], [41],
];

/* Build the bank.  `sounds3do` is a Map of 3DO sound number -> {pcm (s16), rate}. */
export function buildSfxBank(vs, sounds3do) {
  const sounds = readDigiSounds(vs);
  const chunks = [];
  let bankLen = 0;
  const metas = [];
  const cache = new Map();

  const place3do = (which) => {
    if (cache.has(which)) return cache.get(which);
    const src = sounds3do.get(which);
    if (!src) throw new Error('missing 3DO sound ' + which);
    const adpcm = encodeADPCM(resampleS16(src.pcm, src.rate));
    while (bankLen % ALIGN_BYTES) { chunks.push(new Uint8Array(1)); bankLen++; }
    if (bankLen + adpcm.length > BANK_BUDGET_BYTES) {
      throw new Error('the sound bank overflows the KRAM budget');
    }
    const meta = { start: bankLen / 2, words: adpcm.length / 2 };
    chunks.push(adpcm);
    bankLen += adpcm.length;
    cache.set(which, meta);
    return meta;
  };

  for (let i = 0; i < sounds.length; i++) {
    const which = DIGI_TO_3DO[i];
    if (which !== undefined) {
      metas.push(place3do(which));
      continue;
    }
    if (!sounds[i].length) { metas.push({ start: 0, words: 0 }); continue; }
    const adpcm = encodeADPCM(resampleU8(sounds[i], SRC_RATE));
    while (bankLen % ALIGN_BYTES) { chunks.push(new Uint8Array(1)); bankLen++; }
    if (bankLen + adpcm.length > BANK_BUDGET_BYTES) {
      throw new Error('the sound bank overflows the KRAM budget');
    }
    metas.push({ start: bankLen / 2, words: adpcm.length / 2 });
    chunks.push(adpcm);
    bankLen += adpcm.length;
  }
  for (const [which] of EXTRA_DIGI_3DO) {
    metas.push(place3do(which));
  }
  let total = 0;
  for (const c of chunks) total += c.length;
  const bank = new Uint8Array(total);
  let p = 0;
  for (const c of chunks) { bank.set(c, p); p += c.length; }
  return { bank, metas };
}
