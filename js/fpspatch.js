/* fpspatch.js -- apply the optional on-screen FPS build patch. */

import { crc32hex } from './core.js';

const PATCH_MAGIC = 'WFP1';
const HEADER_SIZE = 24;
const PROGRAM_START = 0x4c000;
const PROGRAM_END = 0x90000;

function u32(view, offset) {
  return view.getUint32(offset, true);
}

export function applyFpsPatch(image, patch) {
  if (patch.length < HEADER_SIZE) throw new Error('the FPS patch is truncated');
  const magic = String.fromCharCode(patch[0], patch[1], patch[2], patch[3]);
  if (magic !== PATCH_MAGIC) throw new Error('the FPS patch has an unknown format');

  const view = new DataView(patch.buffer, patch.byteOffset, patch.byteLength);
  const start = u32(view, 4);
  const end = u32(view, 8);
  const expectedCrc = u32(view, 12).toString(16).padStart(8, '0');
  const targetCrc = u32(view, 16).toString(16).padStart(8, '0');
  const recordCount = u32(view, 20);
  if (start !== PROGRAM_START || end !== PROGRAM_END || end > image.length) {
    throw new Error('the FPS patch does not match this disc layout');
  }
  if (crc32hex(image.subarray(start, end)) !== expectedCrc) {
    throw new Error('the FPS patch does not match the shipped base image');
  }

  let cursor = HEADER_SIZE;
  let previousEnd = start;
  let changedBytes = 0;
  for (let i = 0; i < recordCount; i++) {
    if (cursor + 8 > patch.length) throw new Error('the FPS patch is truncated');
    const offset = u32(view, cursor);
    const length = u32(view, cursor + 4);
    cursor += 8;
    if (!length || offset < previousEnd || offset + length > end ||
        cursor + length > patch.length) {
      throw new Error('the FPS patch contains an invalid record');
    }
    image.set(patch.subarray(cursor, cursor + length), offset);
    cursor += length;
    previousEnd = offset + length;
    changedBytes += length;
  }
  if (cursor !== patch.length) throw new Error('the FPS patch has trailing data');
  if (crc32hex(image.subarray(start, end)) !== targetCrc) {
    throw new Error('the FPS patch did not produce the expected program');
  }
  return { records: recordCount, bytes: changedBytes };
}
