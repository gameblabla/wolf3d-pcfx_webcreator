/* threedo.js -- read the Wolfenstein 3D (3DO) disc image.
 *
 * The 3DO release keeps its music in the disc filesystem as AIFC files
 * compressed with SDX2, and its sound effects as 8-bit AIFF.  Both are
 * converted to what the PC-FX build wants.
 *
 * Two rips are understood: the raw 2352-byte-per-sector image (the 3DO
 * filesystem's own directory records) and plain ISO 9660 images.
 */

import { u16be, u32be, u32le, str } from './core.js';
import { sdx2Decode, writeAIFF } from './audio.js';

const SECTOR_RAW = 2352;
const SECTOR_ISO = 2048;
const DATA_OFFSET_RAW = 16;
const BLOCK_SIZE = 2048;

/* A plain byte-pattern search (no regex: the image is 130 MB). */
function indexOfBytes(hay, needle, from) {
  const n = needle.length;
  const last = hay.length - n;
  outer:
  for (let i = from; i <= last; i++) {
    for (let k = 0; k < n; k++) if (hay[i + k] !== needle[k]) continue outer;
    return i;
  }
  return -1;
}

export class ThreeDOImage {
  constructor(bytes) {
    this.data = bytes;
    const [sector, offset] = this.detectLayout();
    this.sectorSize = sector;
    this.dataOffset = offset;
  }

  detectLayout() {
    const d = this.data;
    if (!d.length) throw new Error('empty disc image');
    const sync = [0, ...Array(10).fill(0xff), 0];
    if (d.length % SECTOR_RAW === 0) {
      const probes = Math.min(d.length / SECTOR_RAW, 64);
      let hits = 0;
      for (let i = 0; i < probes; i++) {
        let ok = true;
        for (let k = 0; k < sync.length; k++) {
          if (d[i * SECTOR_RAW + k] !== sync[k]) { ok = false; break; }
        }
        if (ok) hits++;
      }
      if (hits >= probes / 2) return [SECTOR_RAW, DATA_OFFSET_RAW];
    }
    if (d.length % SECTOR_ISO === 0 &&
        str(d, 16 * SECTOR_ISO + 1, 5) === 'CD001') {
      return [SECTOR_ISO, 0];
    }
    throw new Error('unrecognised disc image layout');
  }

  readBlock(block, count = 1) {
    const out = new Uint8Array(count * BLOCK_SIZE);
    let p = 0;
    for (let i = 0; i < count; i++) {
      const start = (block + i) * this.sectorSize + this.dataOffset;
      out.set(this.data.subarray(start, start + BLOCK_SIZE), p);
      p += BLOCK_SIZE;
    }
    return out;
  }

  readFile(startBlock, size) {
    const nblocks = Math.ceil(size / BLOCK_SIZE);
    return this.readBlock(startBlock, nblocks).subarray(0, size);
  }

  /* The filesystem's directory entries: a name plus, at fixed offsets from
   * the name, the file's size and its first block.  The search is a plain
   * byte scan (a regex over the whole 130 MB image would be far too
   * memory-hungry). */
  findEntries(prefix, suffix) {
    const found = [];
    const seen = new Set();
    const d = this.data;
    const pfx = new TextEncoder().encode(prefix);
    const sfx = suffix ? new TextEncoder().encode(suffix) : null;
    let i = 0;
    for (;;) {
      const at = indexOfBytes(d, pfx, i);
      if (at < 0) break;
      i = at + 1;
      if (at < 16) continue;
      let j = at + pfx.length;
      let digits = '';
      while (j < d.length && d[j] >= 0x30 && d[j] <= 0x39 && digits.length < 3) {
        digits += String.fromCharCode(d[j]);
        j++;
      }
      if (!digits) continue;
      if (sfx) {
        let ok = true;
        for (let k = 0; k < sfx.length; k++) {
          if (d[j + k] !== sfx[k]) { ok = false; break; }
        }
        if (!ok) continue;
        j += sfx.length;
      }
      const size = u32be(d, at - 16);
      const start = u32be(d, at + 36);
      if (size < 64 || size > 64 * 1024 * 1024) continue;
      const key = size + ':' + start;
      if (seen.has(key)) continue;
      seen.add(key);
      const head = this.readBlock(start, 1).subarray(0, 16);
      if (str(head, 0, 4) !== 'FORM') continue;
      const t = str(head, 8, 4);
      if (t !== 'AIFF' && t !== 'AIFC') continue;
      found.push({ name: prefix + digits + (suffix || ''), size, start });
    }
    return found;
  }

  /* The sound effects: 8-bit AIFF -> 16-bit AIFF. */
  extractSounds() {
    const out = [];
    const entries = this.findEntries('Sound', '.aiff');
    const byNum = new Map();
    for (const e of entries) {
      const m = /Sound(\d+)/i.exec(e.name);
      if (m && !byNum.has(parseInt(m[1], 10))) byNum.set(parseInt(m[1], 10), e);
    }
    for (const num of [...byNum.keys()].sort((a, b) => a - b)) {
      const e = byNum.get(num);
      const info = readAIFFLocal(this.readFile(e.start, e.size));
      if (!info) continue;
      let pcm = info.pcm;
      if (info.bits === 8) {
        const wide = new Uint8Array(pcm.length * 2);
        for (let i = 0; i < pcm.length; i++) {
          wide[i * 2] = pcm[i];
          wide[i * 2 + 1] = (pcm[i] << 8) & 0xff;
        }
        pcm = wide;
      } else if (info.bits !== 16) {
        continue;
      }
      out.push({ name: 'Sound' + num + '.aiff',
                 data: writeAIFF(info.channels, info.rate, pcm),
                 frames: info.frames, rate: info.rate });
    }
    return out;
  }

  /* The soundtrack: SDX2 AIFC -> 16-bit WAV. */
  extractSongs() {
    const out = [];
    const entries = this.findEntries('Song', '');
    const byNum = new Map();
    for (const e of entries) {
      const m = /Song(\d+)/i.exec(e.name);
      if (m && !byNum.has(parseInt(m[1], 10))) byNum.set(parseInt(m[1], 10), e);
    }
    for (const num of [...byNum.keys()].sort((a, b) => a - b)) {
      const e = byNum.get(num);
      const info = readAIFFLocal(this.readFile(e.start, e.size));
      if (!info) continue;
      let pcm = info.pcm;
      if (info.compression && info.compression.startsWith('SDX2')) {
        const samples = sdx2Decode(pcm, info.channels);
        pcm = new Uint8Array(samples.length * 2);
        const dv = new DataView(pcm.buffer);
        for (let i = 0; i < samples.length; i++) dv.setInt16(i * 2, samples[i], true);
      } else if (info.bits === 8) {
        const wide = new Uint8Array(pcm.length * 2);
        for (let i = 0; i < pcm.length; i++) {
          wide[i * 2] = pcm[i];
          wide[i * 2 + 1] = (pcm[i] << 8) & 0xff;
        }
        pcm = wide;
      } else if (info.bits !== 16) {
        continue;
      }
      out.push({ name: 'Song' + num + '.wav',
                 data: writeWAVLocal(info.channels, info.rate, pcm),
                 frames: info.frames, rate: info.rate });
    }
    return out;
  }
}

/* The AIFF reader lives in audio.js; these thin wrappers keep the import
 * list of this module small. */
import { readAIFF as readAIFFLocal, writeWAV as writeWAVLocal } from './audio.js';
