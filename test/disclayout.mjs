// Run: node webeditor/test/disclayout.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { readManifest } from '../js/baseimg.js';
import { readWAV, wavToCDBin } from '../js/audio.js';
import { validateDiscLayout } from '../js/disclayout.js';

const base = new Uint8Array(fs.readFileSync(new URL('../wolf_pcfx_base.bin', import.meta.url)));
const manifest = readManifest(base);
const wav = new Uint8Array(fs.readFileSync(new URL('../TRACK1.wav', import.meta.url)));
const track = wavToCDBin(readWAV(wav));
validateDiscLayout(base, manifest, track.sectors);
assert.throws(() => validateDiscLayout(base, manifest, 0), /must produce/);
assert.throws(() => validateDiscLayout(base, manifest, track.sectors + 1), /must produce/);
assert.throws(() => validateDiscLayout(base.subarray(150 * 2048), manifest, track.sectors), /boot header/);
validateDiscLayout(base, { disc_layout: { lead_sectors: track.sectors, data_pregap: 150 } }, track.sectors);
console.log('Disc layout checks passed (lead track: ' + track.sectors + ' sectors).');
