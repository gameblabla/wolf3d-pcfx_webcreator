/* The executable contains absolute LBAs and fixed CD-DA track numbers.
 * Changing the cue alone cannot turn this base into a data-track-first disc.
 * Legacy BASE1 images shipped with the 1085-sector warning track. */
export function validateDiscLayout(image, manifest, leadSectors) {
  const layout = manifest.disc_layout || { lead_sectors: 1085, data_pregap: 150 };
  if (leadSectors !== layout.lead_sectors) {
    throw new Error('TRACK1.wav must produce ' + layout.lead_sectors +
      ' CD sectors for this base image (got ' + leadSectors + ')');
  }
  const start = layout.data_pregap * 2048;
  const signature = new TextEncoder().encode('PC-FX:Hu_CD-ROM ');
  if (!signature.every((v, i) => image[start + i] === v)) {
    throw new Error('base image boot header does not match the data-track pregap');
  }
}
