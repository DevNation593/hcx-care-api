const MALFORMED = 'MALFORMED_JPEG';

const SOI = 0xd8;
const SOS = 0xda;
const APP1 = 0xe1;

/** Markers that stand alone: they carry no length and no payload. */
const isStandalone = (marker: number) => marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7);

const EXIF_ID = Buffer.from('Exif\0\0', 'binary');
const ORIENTATION_TAG = 0x0112;
const SHORT_TYPE = 3;

/**
 * Reads the IFD0 Orientation (1-8) of an APP1 payload that starts with 'Exif\0\0' and a
 * readable TIFF header. Returns null for anything else: XMP, malformed EXIF, no orientation.
 */
function readExifOrientation(payload: Buffer): { littleEndian: boolean; value: number } | null {
  if (payload.length < EXIF_ID.length + 8 || !payload.subarray(0, 6).equals(EXIF_ID)) return null;
  const tiff = payload.subarray(EXIF_ID.length);
  const order = tiff.toString('latin1', 0, 2);
  if (order !== 'II' && order !== 'MM') return null;
  const littleEndian = order === 'II';
  const u16 = (at: number) => (littleEndian ? tiff.readUInt16LE(at) : tiff.readUInt16BE(at));
  const u32 = (at: number) => (littleEndian ? tiff.readUInt32LE(at) : tiff.readUInt32BE(at));
  if (u16(2) !== 42) return null;
  const ifd0 = u32(4);
  if (ifd0 < 8 || ifd0 + 2 > tiff.length) return null;
  const count = u16(ifd0);
  for (let i = 0; i < count; i++) {
    const entry = ifd0 + 2 + i * 12;
    if (entry + 12 > tiff.length) return null;
    if (u16(entry) !== ORIENTATION_TAG) continue;
    if (u16(entry + 2) !== SHORT_TYPE || u32(entry + 4) !== 1) return null;
    const value = u16(entry + 8);
    return value >= 1 && value <= 8 ? { littleEndian, value } : null;
  }
  return null;
}

/**
 * An APP1 segment holding only 'Exif\0\0', a TIFF header in the original byte order and an
 * IFD0 with the single Orientation entry, followed by a zero next-IFD offset.
 */
function minimalOrientationApp1(littleEndian: boolean, value: number): Buffer {
  const tiff = Buffer.alloc(8 + 2 + 12 + 4);
  const u16 = (v: number, at: number) =>
    littleEndian ? tiff.writeUInt16LE(v, at) : tiff.writeUInt16BE(v, at);
  const u32 = (v: number, at: number) =>
    littleEndian ? tiff.writeUInt32LE(v, at) : tiff.writeUInt32BE(v, at);
  tiff.write(littleEndian ? 'II' : 'MM', 0, 'latin1');
  u16(42, 2);
  u32(8, 4);
  u16(1, 8);
  u16(ORIENTATION_TAG, 10);
  u16(SHORT_TYPE, 12);
  u32(1, 14);
  u16(value, 18);
  // Bytes 20-21 pad the inline value; bytes 22-25 are the next-IFD offset 0.
  const payload = Buffer.concat([EXIF_ID, tiff]);
  const header = Buffer.alloc(4);
  header[0] = 0xff;
  header[1] = APP1;
  header.writeUInt16BE(payload.length + 2, 2);
  return Buffer.concat([header, payload]);
}

/**
 * Removes every APP1 segment (EXIF, XMP: GPS position, camera, timestamps) from a JPEG. When an
 * EXIF segment carries an IFD0 Orientation, a minimal APP1 with only that tag takes the place of
 * the first such segment so the photo still displays upright. The header segments are walked
 * up to the start of scan; from there on the image data is copied untouched. A buffer that is
 * not a JPEG is returned as is.
 */
export function stripJpegMetadata(data: Buffer): Buffer {
  if (data.length < 2 || data[0] !== 0xff || data[1] !== SOI) return data;

  const kept: Buffer[] = [data.subarray(0, 2)];
  let position = 2;
  let orientationKept = false;

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

    if (marker !== APP1) {
      kept.push(data.subarray(position, end));
    } else if (!orientationKept) {
      const orientation = readExifOrientation(data.subarray(codeAt + 3, end));
      if (orientation) {
        kept.push(minimalOrientationApp1(orientation.littleEndian, orientation.value));
        orientationKept = true;
      }
    }
    position = end;
  }

  // The end of the buffer came before the start of scan.
  throw new Error(MALFORMED);
}
