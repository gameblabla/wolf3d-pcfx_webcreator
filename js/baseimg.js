/* baseimg.js -- the stripped base disc image and the patch that fills it in.
 *
 * The port ships `wolf_pcfx_base.bin`: the disc image with every piece of
 * id Software's data taken out (the boot pack, the map packs and the
 * sound-effect bank) and a small manifest in the image's lead-in saying
 * where those pieces used to live.  The title screen and the ROM code stay.
 *
 * Building a disc is then a matter of regenerating those pieces from the
 * user's own copies of the game data and writing them back into the base
 * image at the offsets the manifest records.
 */

import { u16be, u32be, u32le, str } from './core.js';

export const MAGIC = 'WPCFXBASE1';
export const MANIFEST_OFFSET = 0x200;
export const MANIFEST_MAX = 0x8000;

export function readManifest(image) {
  if (str(image, MANIFEST_OFFSET, MAGIC.length) !== MAGIC) {
    throw new Error('not a wolf-pcfx base image (no manifest)');
  }
  const n = u32le(image, MANIFEST_OFFSET + MAGIC.length);
  const start = MANIFEST_OFFSET + MAGIC.length + 4;
  const blob = new TextDecoder().decode(image.subarray(start, start + n));
  return JSON.parse(blob);
}

/* The 256 colours of the game palette.  The base image's manifest carries the
 * 6-bit game palette (the same table Wolf4SDL's wolfpal.inc holds) so the
 * editor quantises to exactly the colours the port's own build does; the
 * Y8U4V4 table in the code section is the fallback. */
export function paletteFromImage(image, manifest) {
  const pal = new Uint8Array(256 * 3);
  if (manifest.gamepal) {
    for (let i = 0; i < 256; i++) {
      pal[i * 3] = manifest.gamepal[i][0];
      pal[i * 3 + 1] = manifest.gamepal[i][1];
      pal[i * 3 + 2] = manifest.gamepal[i][2];
    }
    return pal;
  }
  const entry = (manifest.keep || []).find((k) => k.name === 'palette_yuv');
  if (!entry) throw new Error('the base image has no palette');
  for (let i = 0; i < 256; i++) {
    const yuv = u16be(image, entry.offset + i * 2);
    const y = yuv >> 8;
    const u = ((yuv >> 4) & 0x0f) * 16 - 128;
    const v = (yuv & 0x0f) * 16 - 128;
    pal[i * 3] = Math.max(0, Math.min(255, Math.round(y + 1.402 * v)));
    pal[i * 3 + 1] = Math.max(0, Math.min(255, Math.round(y - 0.344 * u - 0.714 * v)));
    pal[i * 3 + 2] = Math.max(0, Math.min(255, Math.round(y + 1.772 * u)));
  }
  return pal;
}

/* The manifest records the reference blob's byte count, whereas disc
 * resources occupy whole 2048-byte sectors. Allow rebuilt art to use the
 * final sector's zero padding, without moving any of the fixed LBAs.
 * Check the original image and all recorded regions before using padding. */
function slotCapacity(image, manifest, slot) {
  const end = slot.offset + slot.size;
  if (slot.source !== 'disc' || slot.offset % 2048 !== 0) return slot.size;
  let limit = Math.min(Math.ceil(end / 2048) * 2048, image.length);
  for (const region of [...manifest.slots, ...(manifest.keep || []),
                        { offset: MANIFEST_OFFSET, size: MANIFEST_MAX }]) {
    if (region === slot) continue;
    if (region.offset < limit && region.offset + region.size > end) {
      limit = Math.min(limit, Math.max(end, region.offset));
    }
  }
  for (let p = end; p < limit; p++) {
    if (image[p] !== 0) return p - slot.offset;
  }
  return limit - slot.offset;
}

/* Write resources into their fixed disc slots, including verified sector
 * padding. Larger resources still fail instead of colliding with data. */
export function patchSlots(image, manifest, blobs) {
  const out = new Uint8Array(image);
  for (const slot of manifest.slots) {
    const data = blobs[slot.name];
    if (!data) throw new Error('no data for the ' + slot.name + ' slot');
    const capacity = slotCapacity(image, manifest, slot);
    if (data.length > capacity) {
      throw new Error('the ' + slot.name + ' data is ' + data.length +
                      ' bytes, the base image only has room for ' + capacity);
    }
    out.set(data, slot.offset);
  }
  // the manifest has done its job: wipe it so the image matches the one the
  // port's own build produces
  out.fill(0, MANIFEST_OFFSET, MANIFEST_OFFSET + MANIFEST_MAX);
  return out;
}
