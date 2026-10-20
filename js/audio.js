/* audio.js -- the SDX2 decoder, the AIFF/AIFC and WAV readers and writers,
 * and the WAV -> CD-DA track conversion.
 *
 * The 3DO release of Wolfenstein 3D stores its soundtrack as AIFC files
 * compressed with SDX2 ("Squareroot-Delta-Exact", the 3DO SDK's delta
 * modulation codec) and its sound effects as 8-bit AIFF.  Neither is what
 * the PC-FX build wants, so both are converted on the way in.
 */

import { u16be, u16le, u32be, u32le, str, cat } from './core.js';

/* ------------------------------------------------------------------ SDX2 */

/* The decoder: an 8-bit delta index per sample, the magnitude being
 * sign(n) * 2 * n * n, and an even index resetting the predictor.
 * This is the algorithm FFmpeg's libavcodec/dpcm.c uses, so the output is
 * bit-exact with the reference rips. */
export function sdx2Decode(src, channels = 2) {
  const table = new Int16Array(256);
  for (let i = -128; i < 128; i++) {
    let sq = (i * i * 2) & 0xffff;
    if (sq >= 0x8000) sq -= 0x10000;
    if (i < 0) {
      sq = (-sq) & 0xffff;
      if (sq >= 0x8000) sq -= 0x10000;
    }
    table[i + 128] = sq;
  }
  const out = new Int16Array(src.length);
  const pred = [0, 0];
  let ch = 0;
  for (let i = 0; i < src.length; i++) {
    let n = src[i];
    if (n > 127) n -= 256;
    if ((n & 1) === 0) pred[ch] = 0;
    let s = pred[ch] + table[n + 128];
    if (s > 32767) s = 32767;
    else if (s < -32768) s = -32768;
    pred[ch] = s;
    out[i] = s;
    ch ^= (channels - 1);
  }
  return out;
}

/* ------------------------------------------------------------------ AIFF */

/* 80-bit IEEE extended float (AIFF's sample rate). */
function ext80(b, o) {
  const hi = u16be(b, o);
  const sign = hi >> 15;
  const exp = hi & 0x7fff;
  let mant = 0;
  for (let i = 0; i < 8; i++) mant = mant * 256 + b[o + 2 + i];
  if (exp === 0 && mant === 0) return 0;
  let v = (mant / Math.pow(2, 63)) * Math.pow(2, exp - 16383);
  return sign ? -v : v;
}

/* Read an AIFF/AIFC blob: {channels, frames, bits, rate, pcm, compression}. */
export function readAIFF(data) {
  if (str(data, 0, 4) !== 'FORM') throw new Error('not a FORM file');
  const type = str(data, 8, 4);
  if (type !== 'AIFF' && type !== 'AIFC') throw new Error('not an AIFF/AIFC file');
  const end = Math.min(data.length, 8 + u32be(data, 4));
  let pos = 12;
  let channels = 0, frames = 0, bits = 0, rate = 0, compression = null, pcm = null;
  while (pos + 8 <= end) {
    const cid = str(data, pos, 4);
    const size = u32be(data, pos + 4);
    const body = pos + 8;
    if (cid === 'COMM') {
      channels = u16be(data, body);
      frames = u32be(data, body + 2);
      bits = u16be(data, body + 6);
      rate = ext80(data, body + 8);
      if (type === 'AIFC' && size >= 22) {
        compression = str(data, body + 18, 4);
      }
    } else if (cid === 'SSND') {
      const off = u32be(data, body);
      pcm = data.subarray(body + 8 + off, body + size);
    }
    pos = body + size + (size & 1);
  }
  if (!pcm) throw new Error('missing COMM/SSND chunk');
  return { channels, frames, bits, rate, pcm, compression };
}

/* Write a 16-bit big-endian AIFF. */
export function writeAIFF(channels, rate, pcm) {
  const frames = pcm.length / (2 * channels);
  const comm = new Uint8Array(18);
  const dv = new DataView(comm.buffer);
  dv.setUint16(0, channels);
  dv.setUint32(2, frames);
  dv.setUint16(6, 16);
  // 80-bit extended: the sign/exponent word first, then the 64-bit mantissa
  // with an explicit integer bit (the value is (1 + frac) * 2^(exp-16383)).
  let exp = 16383 + Math.floor(Math.log2(rate));
  const mant = rate / Math.pow(2, exp - 16383);      // in [1, 2)
  const field = mant * Math.pow(2, 63);
  const mantHi = Math.floor(field / Math.pow(2, 32));
  const mantLo = field - mantHi * Math.pow(2, 32);
  dv.setUint16(8, exp);
  dv.setUint32(10, mantHi);
  dv.setUint32(14, mantLo);
  const ssnd = new Uint8Array(8 + pcm.length);
  const sdv = new DataView(ssnd.buffer);
  sdv.setUint32(0, 0);
  sdv.setUint32(4, 0);
  ssnd.set(pcm, 8);
  const body = cat([chunk('COMM', comm), chunk('SSND', ssnd)]);
  const out = new Uint8Array(12 + body.length);
  const odv = new DataView(out.buffer);
  out[0] = 0x46; out[1] = 0x4f; out[2] = 0x52; out[3] = 0x4d;
  odv.setUint32(4, body.length + 4, false);
  out[8] = 0x41; out[9] = 0x49; out[10] = 0x46; out[11] = 0x46;
  out.set(body, 12);
  return out;
}

function chunk(id, body) {
  const out = new Uint8Array(8 + body.length);
  for (let i = 0; i < 4; i++) out[i] = id.charCodeAt(i);
  new DataView(out.buffer).setUint32(4, body.length, false);
  out.set(body, 8);
  return out;
}

/* ------------------------------------------------------------------- WAV */

/* Write a 16-bit little-endian WAV. */
export function writeWAV(channels, rate, pcm) {
  const blockAlign = channels * 2;
  const out = new Uint8Array(44 + pcm.length);
  const dv = new DataView(out.buffer);
  const put = (o, s) => { for (let i = 0; i < s.length; i++) out[o + i] = s.charCodeAt(i); };
  put(0, 'RIFF');
  dv.setUint32(4, 36 + pcm.length, true);
  put(8, 'WAVE');
  put(12, 'fmt ');
  dv.setUint32(16, 16, true);
  dv.setUint16(20, 1, true);
  dv.setUint16(22, channels, true);
  dv.setUint32(24, rate, true);
  dv.setUint32(28, rate * blockAlign, true);
  dv.setUint16(32, blockAlign, true);
  dv.setUint16(34, 16, true);
  put(36, 'data');
  dv.setUint32(40, pcm.length, true);
  out.set(pcm, 44);
  return out;
}

/* Read a WAV: {channels, rate, bits, pcm (as signed 16-bit LE samples)}. */
export function readWAV(data) {
  if (str(data, 0, 4) !== 'RIFF' || str(data, 8, 4) !== 'WAVE') {
    throw new Error('not a RIFF/WAVE file');
  }
  let pos = 12;
  let fmt = 0, channels = 0, rate = 0, bits = 0, pcm = null;
  while (pos + 8 <= data.length) {
    const cid = str(data, pos, 4);
    const size = u32le(data, pos + 4);
    const body = pos + 8;
    if (cid === 'fmt ') {
      fmt = u16le(data, body);
      channels = u16le(data, body + 2);
      rate = u32le(data, body + 4);
      bits = u16le(data, body + 14);
    } else if (cid === 'data') {
      pcm = data.subarray(body, Math.min(body + size, data.length));
    }
    pos = body + size + (size & 1);
  }
  if (!pcm) throw new Error('missing data chunk');
  return { fmt, channels, rate, bits, pcm };
}

/* ------------------------------------------------------------------ CD-DA */

export const CD_AUDIO_SECTOR = 2352;      // 588 stereo 16-bit frames
export const DATA_PREGAP_SECTORS = 150;   // the 2-second pregap

/* The float -> int16 conversion pcfx-cdlink does, in float32. */
function fToS16(v) {
  let s = Math.fround(v * 32767.0);
  s = Math.fround(s + (s >= 0.0 ? 0.5 : -0.5));
  if (s > 32767.0) s = 32767.0;
  else if (s < -32768.0) s = -32768.0;
  return s | 0;
}

/* Convert a WAV into a raw CD-DA track: 2352-byte sectors of signed 16-bit
 * little-endian stereo audio at 44100 Hz, optionally preceded by silence. */
export function wavToCDBin(wav, pregapSectors = 0) {
  const { fmt, channels, rate, bits, pcm } = wav;
  if (fmt !== 1 && fmt !== 3) throw new Error('unsupported WAV format');
  const bps = bits >> 3;
  const frameBytes = bps * channels;
  const nframes = Math.floor(pcm.length / frameBytes);
  const samples = new Float32Array(nframes * 2);
  const dv = new DataView(pcm.buffer, pcm.byteOffset, pcm.byteLength);
  for (let i = 0; i < nframes; i++) {
    for (let ch = 0; ch < 2; ch++) {
      const sch = (channels === 1) ? 0 : ch;
      const off = i * frameBytes + sch * bps;
      let v;
      if (fmt === 3 && bits === 32) v = dv.getFloat32(off, true);
      else if (bits === 16) v = dv.getInt16(off, true) / 32768.0;
      else if (bits === 8) v = (pcm[off] - 128.0) / 128.0;
      else if (bits === 24) {
        let s = pcm[off] | (pcm[off + 1] << 8) | (pcm[off + 2] << 16);
        if (s & 0x800000) s -= 0x1000000;
        v = s / 8388608.0;
      } else if (bits === 32) v = dv.getInt32(off, true) / 2147483648.0;
      else throw new Error('unsupported bit depth ' + bits);
      samples[i * 2 + ch] = v;
    }
  }
  let out;
  if (rate === 44100) {
    out = samples;
  } else {
    const ratio = rate / 44100.0;
    const n = Math.floor(nframes / ratio);
    out = new Float32Array(n * 2);
    for (let i = 0; i < n; i++) {
      const sp = i * ratio;
      const idx = Math.floor(sp);
      const frac = sp - idx;
      const nxt = (idx + 1 < nframes) ? idx + 1 : idx;
      const ffrac = Math.fround(frac);
      for (let ch = 0; ch < 2; ch++) {
        const a = Math.fround(samples[idx * 2 + ch]);
        const b = Math.fround(samples[nxt * 2 + ch]);
        out[i * 2 + ch] = Math.fround(a + Math.fround(Math.fround(b - a) * ffrac));
      }
    }
  }
  const bytes = out.length * 2;
  const pad = (CD_AUDIO_SECTOR - (bytes % CD_AUDIO_SECTOR)) % CD_AUDIO_SECTOR;
  const buf = new Uint8Array(pregapSectors * CD_AUDIO_SECTOR + bytes + pad);
  const bdv = new DataView(buf.buffer);
  let p = pregapSectors * CD_AUDIO_SECTOR;
  for (let i = 0; i < out.length; i++) {
    bdv.setInt16(p, fToS16(out[i]), true);
    p += 2;
  }
  return { data: buf, sectors: buf.length / CD_AUDIO_SECTOR };
}
