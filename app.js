/* app.js -- the wolf-pcfx web editor.
 *
 * Everything happens in the browser: the game data is unpacked, the 3DO
 * soundtrack and sound effects are decoded, the Jaguar HUD is pulled out of
 * the cartridge image, the disc's resource packs are rebuilt, and the
 * result is patched into the stripped base image.  The finished disc image,
 * its cue sheet and the CD-DA tracks come back as a zip.
 */

import { unzip, zip, crc32hex } from './js/core.js';
import { readAIFF, readWAV, wavToCDBin, DATA_PREGAP_SECTORS }
  from './js/audio.js';
import { ThreeDOImage } from './js/threedo.js';
import { JaguarROM, buildHudSheet, buildHudOverrides } from './js/jaguar.js';
import { VSwap, MapHead, loadMaps, VgaGraph, PicTable } from './js/formats.js';
import { buildBootpack, buildMappacks, findSafeBlackTwin, NUMCHUNKS, NUMPICS }
  from './js/assets.js';
import { buildSfxBank } from './js/sfx.js';
import { readManifest, paletteFromImage, patchSlots } from './js/baseimg.js';
import { applyFpsPatch } from './js/fpspatch.js';
import { validateDiscLayout } from './js/disclayout.js';

const $ = (s) => document.querySelector(s);
const $$ = (s) => Array.from(document.querySelectorAll(s));

function log(line, cls) {
  const box = $('#log');
  const empty = box.querySelector('.log-empty');
  if (empty) empty.remove();
  const div = document.createElement('div');
  if (cls) div.className = cls;
  div.textContent = line;
  box.appendChild(div);
  box.scrollTop = box.scrollHeight;
}

function status(text) { $('#build-status').textContent = text; }

async function fileBytes(file) {
  return new Uint8Array(await file.arrayBuffer());
}

/* The port is built against the retail (full) v1.4 data set - the one from
 * the GOG release.  The shareware's files are a different set (a different
 * picture count, a different VSWAP), and the port's tables (the picture
 * count the boot pack indexes with, the palette, the per-sound offsets
 * baked into the sound bank) are the retail's, so a shareware build comes
 * out mis-indexed.  Spot the difference and say so rather than shipping a
 * disc that will not boot. */
function checkRetailData(vs, files, maps) {
  const problems = [];
  if (vs.chunksInFile !== 663 || vs.spriteStart !== 106 || vs.soundStart !== 542) {
    problems.push('VSWAP.WL6 has ' + vs.chunksInFile + ' chunks (sprites at ' +
                  vs.spriteStart + ', sounds at ' + vs.soundStart + '), expected 663/106/542');
  }
  const head = files.get('VGAHEAD.WL6');
  if (head.length !== 450) {
    problems.push('VGAHEAD.WL6 is ' + head.length + ' bytes, expected 450');
  }
  if (maps.length !== 60) {
    problems.push('the data set holds ' + maps.length + ' populated level(s), expected 60');
  }
  return problems;
}

/* ------------------------------------------------------------- the build */

async function build() {
  const wl6File = picked.wl6;
  const isoFile = picked.iso;
  const j64File = picked.j64;
  if (!wl6File || !isoFile || !j64File) {
    const missing = [];
    if (!wl6File) missing.push('the Wolfenstein 3D data');
    if (!isoFile) missing.push('the 3DO disc image');
    if (!j64File) missing.push('the Jaguar cartridge');
    log('missing: ' + missing.join(', ') + ' - all three are needed', 'err');
    return;
  }
  const showFps = $('#show-fps').checked;
  $('#btn-build').disabled = true;
  $('#show-fps').disabled = true;
  $('#log').innerHTML = '';
  try {
    /* --- the base image (the one that ships with the page) --- */
    status('reading the base image...');
    const res = await fetch('wolf_pcfx_base.bin');
    if (!res.ok) throw new Error('wolf_pcfx_base.bin is missing next to this page');
    const base = new Uint8Array(await res.arrayBuffer());
    const manifest = readManifest(base);
    const pal = paletteFromImage(base, manifest);
    log('base image: ' + (base.length / 1048576).toFixed(1) + ' MiB, ' +
        manifest.slots.length + ' resource slot(s)');
    const chip = $('#chip-base');
    if (chip) {
      chip.textContent = 'base image ' + (base.length / 1048576).toFixed(1) + ' MiB';
      chip.classList.add('ok');
    }

    /* --- the game data --- */
    status('unpacking the Wolfenstein 3D data...');
    const files = await unzip(await wl6File.arrayBuffer());
    const need = ['GAMEMAPS.WL6', 'MAPHEAD.WL6', 'VSWAP.WL6', 'VGAGRAPH.WL6',
                  'VGAHEAD.WL6', 'VGADICT.WL6'];
    for (const n of need) if (!files.has(n)) throw new Error('the zip has no ' + n);
    const vs = new VSwap(files.get('VSWAP.WL6'));
    const vg = new VgaGraph(files.get('VGAHEAD.WL6'), files.get('VGADICT.WL6'),
                           files.get('VGAGRAPH.WL6'), NUMCHUNKS);
    const pt = new PicTable(vg, NUMPICS);
    const maps = loadMaps(new MapHead(files.get('MAPHEAD.WL6')),
                          files.get('GAMEMAPS.WL6'));
    log('game data: ' + vs.chunksInFile + ' VSWAP chunks, ' + maps.length +
        ' populated level(s)');

    const problems = checkRetailData(vs, files, maps);
    if (problems.length) {
      log('WARNING: this does not look like the retail (GOG) Wolfenstein 3D v1.4 ' +
          'data set:', 'err');
      for (const p of problems) log('  - ' + p, 'err');
      log('  the shareware\'s files are a different data set and do not build a ' +
          'working image; the build continues, but the disc probably will not ' +
          'boot.', 'err');
    }

    /* --- the 3DO disc --- */
    status('decoding the 3DO disc image...');
    const disc = new ThreeDOImage(await fileBytes(isoFile));
    const songs = disc.extractSongs();
    const sounds3do = new Map();
    for (const s of disc.extractSounds()) {
      const info = readAIFF(s.data);
      const n = Math.floor(info.pcm.length / 2);
      const pcm = new Int16Array(n);
      const dv = new DataView(info.pcm.buffer, info.pcm.byteOffset, info.pcm.byteLength);
      for (let i = 0; i < n; i++) pcm[i] = dv.getInt16(i * 2, false);   // big endian
      sounds3do.set(parseInt(/Sound(\d+)/.exec(s.name)[1], 10), { pcm, rate: info.rate });
    }
    log('3DO disc: ' + songs.length + ' music track(s), ' + sounds3do.size +
        ' sound effect(s)');

    /* --- the Jaguar cartridge --- */
    status('pulling the HUD out of the Jaguar cartridge...');
    const rom = new JaguarROM(await fileBytes(j64File));
    const sheet = buildHudSheet(rom);
    const hudOverrides = buildHudOverrides(sheet, pal);
    log('Jaguar cartridge: ' + sheet.faces + ' face cell(s), ' + sheet.digits +
        ' digit(s), ' + sheet.icons + ' icon(s) -> ' + Object.keys(hudOverrides).length +
        ' HUD pic override(s)');

    /* --- the resource packs --- */
    status('building the resource packs...');
    const safeBlack = findSafeBlackTwin(pal);
    const bootpack = buildBootpack(vg, pt, hudOverrides, safeBlack);
    log('boot pack: ' + bootpack.length + ' bytes');
    const mappacks = buildMappacks(vs, maps, safeBlack);
    log('map packs: ' + mappacks.length + ' bytes');
    const sfx = buildSfxBank(vs, sounds3do);
    log('sound bank: ' + sfx.bank.length + ' bytes');

    /* --- patch the base image --- */
    status('patching the disc image...');
    const image = patchSlots(base, manifest, {
      bootpack: bootpack,
      mappacks: mappacks,
      sfx: sfx.bank,
    });
    if (showFps) {
      status('applying the FPS build...');
      const patchResponse = await fetch('fps-patch.bin');
      if (!patchResponse.ok) throw new Error('fps-patch.bin is missing next to this page');
      const patchInfo = applyFpsPatch(image,
        new Uint8Array(await patchResponse.arrayBuffer()));
      log('FPS build: applied ' + patchInfo.records + ' patch record(s), ' +
          patchInfo.bytes + ' program byte(s)');
    }
    const crc = crc32hex(image);
    log('final image: wolf_pcfx.bin (' + image.length + ' bytes) crc32 ' + crc, 'ok');

    /* --- the audio tracks and the cue sheet --- */
    status('converting the soundtrack...');
    const entries = [];
    const t01 = await fetch('TRACK1.wav').catch(() => null);
    if (!t01 || !t01.ok) {
      throw new Error('TRACK1.wav is required: this base image needs audio track 01 before the data track');
    }
    const leadWav = readWAV(new Uint8Array(await t01.arrayBuffer()));
    const leadTrack = wavToCDBin(leadWav, 0);
    validateDiscLayout(image, manifest, leadTrack.sectors);
    entries.push({ name: 'wolf_pcfx_t01.bin', data: leadTrack.data });
    const trackNames = [];
    for (let i = 0; i < songs.length; i++) {
      const wav = readWAV(songs[i].data);
      const cd = wavToCDBin(wav, i === 0 ? DATA_PREGAP_SECTORS : 0);
      const name = 'wolf_pcfx_' + songs[i].name.replace('.wav', '').toUpperCase() + '.bin';
      entries.push({ name, data: cd.data });
      trackNames.push(name);
    }

    let cue = 'FILE "wolf_pcfx_t01.bin" BINARY\n  TRACK 01 AUDIO\n    INDEX 01 00:00:00\n' +
      'FILE "wolf_pcfx.bin" BINARY\n  TRACK 02 MODE1/2048\n' +
      '    INDEX 00 00:00:00\n    INDEX 01 00:02:00\n';
    let num = 3;
    for (const name of trackNames) {
      cue += 'FILE "' + name + '" BINARY\n  TRACK ' + String(num).padStart(2, '0') + ' AUDIO\n';
      if (num === 3) cue += '    INDEX 00 00:00:00\n    INDEX 01 00:02:00\n';
      else cue += '    INDEX 01 00:00:00\n';
      num++;
    }
    const enc = new TextEncoder();
    entries.push({ name: 'wolf_pcfx.cue', data: enc.encode(cue) });
    entries.push({ name: 'wolf_pcfx.bin', data: image });
    entries.push({ name: 'README.txt', data: enc.encode(
      'Wolfenstein 3D - NEC PC-FX disc image\n' +
      '=====================================\n\n' +
      'Built with the wolf-pcfx web editor (entirely in the browser).\n\n' +
      'FPS counter: ' + (showFps ? 'on' : 'off') + '\n\n' +
      'wolf_pcfx.bin   the data track (MODE1/2048)\n' +
      'wolf_pcfx.cue   the cue sheet\n' +
      'wolf_pcfx_t01.bin, wolf_pcfx_SONG*.bin   the CD-DA tracks\n\n' +
      'wolf_pcfx.bin crc32: ' + crc + '\n') });

    const blob = zip(entries);
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'wolf_pcfx_pc-fx' + (showFps ? '_fps' : '') + '.zip';
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 60000);
    status('done' + (showFps ? ' - FPS on' : '') + ' - ' +
           (blob.size / 1048576).toFixed(1) + ' MiB, crc32 ' + crc);
    log('done: ' + a.download + ' (' + (blob.size / 1048576).toFixed(1) + ' MiB)', 'ok');
  } catch (err) {
    log('ERROR: ' + err.message, 'err');
    status('failed');
    console.error(err);
  } finally {
    $('#btn-build').disabled = false;
    $('#show-fps').disabled = false;
  }
}

/* ------------------------------------------------------------------ setup */

/* The chosen file for each input.  A file can arrive two ways - the file
 * picker or a drop - and the two do not always end up in the same place
 * (Safari refuses to let you assign to input.files), so the selection is
 * kept here and both paths feed it. */
const picked = { wl6: null, iso: null, j64: null };

/* The file a drop carried, worked out without touching input.files. */
function fileFromDataTransfer(dt) {
  if (!dt) return null;
  if (dt.files && dt.files.length) return dt.files[0];
  if (dt.items) {
    for (const item of dt.items) {
      if (item.kind === 'file') {
        const f = item.getAsFile();
        if (f) return f;
      }
    }
  }
  return null;
}

/* Each drop zone is a file picker: click it (or the Upload button below it)
 * to browse, or drop a file on it.  The whole card is a drop target, so a
 * file dropped on the button or on the card's text lands here too. */
function wireDrop(id, key) {
  const input = $(id);
  const card = input.closest('.card');
  const zone = input.closest('.drop');
  const tag = zone.querySelector('[data-role=status]');
  const show = (file) => {
    picked[key] = file || null;
    if (tag) tag.textContent = file ? file.name : 'nothing selected';
    zone.classList.toggle('done', !!file);
    zone.classList.remove('error');
  };

  input.addEventListener('change', () => show(input.files[0] || null));

  zone.addEventListener('click', (ev) => {
    if (ev.target !== input) input.click();
  });

  const over = (ev) => {
    ev.preventDefault();
    if (ev.dataTransfer) ev.dataTransfer.dropEffect = 'copy';
    zone.classList.add('over');
  };
  const leave = (ev) => {
    if (!ev.relatedTarget || !card.contains(ev.relatedTarget)) {
      zone.classList.remove('over');
    }
  };
  card.addEventListener('dragenter', over);
  card.addEventListener('dragover', over);
  card.addEventListener('dragleave', leave);
  card.addEventListener('drop', (ev) => {
    ev.preventDefault();
    ev.stopPropagation();
    zone.classList.remove('over');
    const file = fileFromDataTransfer(ev.dataTransfer);
    if (!file) {
      zone.classList.add('error');
      return;
    }
    show(file);
  });
}

function wire() {
  $('#btn-build').addEventListener('click', build);
  wireDrop('#f-wl6', 'wl6');
  wireDrop('#f-iso', 'iso');
  wireDrop('#f-j64', 'j64');
  for (const btn of document.querySelectorAll('button.upload')) {
    btn.addEventListener('click', () => {
      const input = $(btn.dataset.pick);
      if (input) input.click();
    });
  }
}

// The module is loaded asynchronously (see the loader in index.html), so the
// document may already be parsed by the time this runs.
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', wire);
} else {
  wire();
}
