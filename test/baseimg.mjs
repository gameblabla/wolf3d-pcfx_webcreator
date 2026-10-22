// Run: node webeditor/test/baseimg.mjs [DOS.zip cartridge.j64 disc.bin]
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { readManifest, paletteFromImage, patchSlots } from '../js/baseimg.js';
import { unzip } from '../js/core.js';
import { VSwap, MapHead, loadMaps, VgaGraph, PicTable } from '../js/formats.js';
import { JaguarROM, buildHudSheet, buildHudOverrides } from '../js/jaguar.js';
import { buildBootpack, buildMappacks, findSafeBlackTwin, NUMCHUNKS, NUMPICS }
  from '../js/assets.js';
import { ThreeDOImage } from '../js/threedo.js';
import { readAIFF } from '../js/audio.js';
import { buildSfxBank } from '../js/sfx.js';
import { applyFpsPatch } from '../js/fpspatch.js';

const image = new Uint8Array(40960);
const slot = { name: 'bootpack', offset: 34816, size: 2041, source: 'disc' };
const manifest = { slots: [slot] };
const blob = new Uint8Array(2048).fill(42);
assert.deepEqual(patchSlots(image, manifest, { bootpack: blob })
  .subarray(slot.offset, slot.offset + blob.length), blob);
assert.equal(image[slot.offset], 0, 'base image must remain unchanged');
const rejects = (base, meta, data = blob) => assert.throws(
  () => patchSlots(base, meta, { bootpack: data }), /only has room/);
rejects(image, manifest, new Uint8Array(2049));
const occupied = image.slice();
occupied[slot.offset + slot.size + 3] = 1;
rejects(occupied, manifest);
rejects(image, { ...manifest, keep: [{ offset: slot.offset + slot.size, size: 1 }] });
rejects(image, { slots: [slot, { name: 'next', offset: slot.offset + slot.size, size: 7 }] });
rejects(image.subarray(0, slot.offset + slot.size), manifest);
rejects(image, { slots: [{ ...slot, source: 'code' }] });
assert.throws(() => patchSlots(image, manifest, {}), /no data/);
console.log('Slot padding and overwrite protection checks passed.');

if (process.argv.length > 2) {
  const [dosPath, jagPath, discPath] = process.argv.slice(2);
  assert.ok(dosPath && jagPath && discPath, 'supply DOS.zip, cartridge.j64 and disc.bin');
  const read = (p) => new Uint8Array(fs.readFileSync(p));
  const base = read(new URL('../wolf_pcfx_base.bin', import.meta.url));
  const meta = readManifest(base);
  const pal = paletteFromImage(base, meta);
  const files = await unzip(read(dosPath));
  const vs = new VSwap(files.get('VSWAP.WL6'));
  const vg = new VgaGraph(files.get('VGAHEAD.WL6'), files.get('VGADICT.WL6'),
    files.get('VGAGRAPH.WL6'), NUMCHUNKS);
  const pt = new PicTable(vg, NUMPICS);
  const maps = loadMaps(new MapHead(files.get('MAPHEAD.WL6')), files.get('GAMEMAPS.WL6'));
  const hud = buildHudOverrides(buildHudSheet(new JaguarROM(read(jagPath))), pal);
  const safe = findSafeBlackTwin(pal);
  const disc = new ThreeDOImage(read(discPath));
  assert.equal(disc.extractSongs().length, 9);
  const sounds = new Map();
  for (const s of disc.extractSounds()) {
    const info = readAIFF(s.data);
    const pcm = new Int16Array(Math.floor(info.pcm.length / 2));
    const view = new DataView(info.pcm.buffer, info.pcm.byteOffset, info.pcm.byteLength);
    for (let i = 0; i < pcm.length; i++) pcm[i] = view.getInt16(i * 2, false);
    sounds.set(parseInt(/Sound(\d+)/.exec(s.name)[1], 10), { pcm, rate: info.rate });
  }
  assert.equal(sounds.size, 42);
  const blobs = {
    bootpack: buildBootpack(vg, pt, hud, safe),
    mappacks: buildMappacks(vs, maps, safe),
    sfx: buildSfxBank(vs, sounds).bank,
  };
  const out = patchSlots(base, meta, blobs);
  assert.equal(out.length, base.length);
  const allowed = new Uint8Array(base.length);
  allowed.fill(1, 0x200, 0x8200);
  for (const s of meta.slots) {
    const data = blobs[s.name];
    assert.deepEqual(out.subarray(s.offset, s.offset + data.length), data);
    allowed.fill(1, s.offset, s.offset + data.length);
    console.log(`${s.name}: ${data.length} bytes (reference: ${s.size})`);
  }
  for (let i = 0; i < base.length; i++) {
    if (!allowed[i] && out[i] !== base[i]) assert.fail(`unrelated byte changed at ${i}`);
  }
  applyFpsPatch(out, read(new URL('../fps-patch.bin', import.meta.url)));
  console.log('All three input files rebuilt successfully; normal and FPS disc patching passed.');
}
