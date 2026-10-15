const MALFORMED = 'MALFORMED_JPEG';

const SOI = 0xd8;
const SOS = 0xda;
const APP1 = 0xe1;

/** Markers that stand alone: they carry no length and no payload. */
const isStandalone = (marker: number) => marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7);

/**
 * Removes every APP1 segment (EXIF, XMP: GPS position, camera, timestamps) from a JPEG.
 * The header segments are walked up to the start of scan; from there on the image data is
 * copied untouched. A buffer that is not a JPEG is returned as is.
 */
export function stripJpegMetadata(data: Buffer): Buffer {
  if (data.length < 2 || data[0] !== 0xff || data[1] !== SOI) return data;

  const kept: Buffer[] = [data.subarray(0, 2)];
  let position = 2;

  while (position < data.length) {
    if (data[position] !== 0xff) throw new Error(MALFORMED);
    // Any number of 0xFF fill bytes may precede a marker code.
    let codeAt = position + 1;
    while (codeAt < data.length && data[codeAt] === 0xff) codeAt++;
    if (codeAt >= data.length) throw new Error(MALFORMED);
    const marker = data[codeAt];

    if (marker === SOS) {
      kept.push(data.subarray(position));
      return Buffer.concat(kept);
    }
    if (isStandalone(marker)) {
      kept.push(data.subarray(position, codeAt + 1));
      position = codeAt + 1;
      continue;
    }

    // Length is big-endian and counts its own two bytes.
    if (codeAt + 2 >= data.length) throw new Error(MALFORMED);
    const length = data.readUInt16BE(codeAt + 1);
    const end = codeAt + 1 + length;
    if (length < 2 || end > data.length) throw new Error(MALFORMED);

    if (marker !== APP1) kept.push(data.subarray(position, end));
    position = end;
  }

  // The end of the buffer came before the start of scan.
  throw new Error(MALFORMED);
}
