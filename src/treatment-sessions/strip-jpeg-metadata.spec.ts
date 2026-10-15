import { stripJpegMetadata } from './strip-jpeg-metadata';

/** Builds a marker segment: FF xx, big-endian length (counting its own 2 bytes), payload. */
const segment = (marker: number, payload: Buffer) =>
  Buffer.concat([
    Buffer.from([0xff, marker, (payload.length + 2) >> 8, (payload.length + 2) & 0xff]),
    payload,
  ]);

const SOI = Buffer.from([0xff, 0xd8]);
const EOI = Buffer.from([0xff, 0xd9]);
const app0 = segment(0xe0, Buffer.from('JFIF\0\x01\x01\0\0\x01\0\x01\0\0', 'binary'));
const exif = (body: string) =>
  segment(0xe1, Buffer.concat([Buffer.from('Exif\0\0'), Buffer.from(body)]));
const dqt = segment(0xdb, Buffer.alloc(65, 0x10));
// Scan data may contain bytes that look like markers; they must be copied verbatim.
const sos = segment(0xda, Buffer.from([0x01, 0x01, 0x00, 0x00, 0x3f, 0x00]));
const scan = Buffer.from([0x12, 0x34, 0xff, 0xe1, 0x00, 0x04, 0x56]);

describe('stripJpegMetadata', () => {
  it('removes only the APP1 segment and keeps everything else byte for byte', () => {
    const input = Buffer.concat([SOI, app0, exif('GPS 0,0'), dqt, sos, scan, EOI]);
    const expected = Buffer.concat([SOI, app0, dqt, sos, scan, EOI]);
    expect(stripJpegMetadata(input).equals(expected)).toBe(true);
  });

  it('removes every APP1 segment', () => {
    const input = Buffer.concat([
      SOI,
      exif('one'),
      app0,
      segment(0xe1, Buffer.from('http://ns.adobe.com/xap/1.0/\0<x/>')),
      dqt,
      sos,
      scan,
      EOI,
    ]);
    const expected = Buffer.concat([SOI, app0, dqt, sos, scan, EOI]);
    expect(stripJpegMetadata(input).equals(expected)).toBe(true);
  });

  it('handles standalone markers that have no length', () => {
    const standalone = Buffer.from([0xff, 0x01, 0xff, 0xd0, 0xff, 0xd7]);
    const input = Buffer.concat([SOI, standalone, exif('x'), dqt, sos, scan, EOI]);
    const expected = Buffer.concat([SOI, standalone, dqt, sos, scan, EOI]);
    expect(stripJpegMetadata(input).equals(expected)).toBe(true);
  });

  it('returns a JPEG without APP1 unchanged', () => {
    const input = Buffer.concat([SOI, app0, dqt, sos, scan, EOI]);
    expect(stripJpegMetadata(input).equals(input)).toBe(true);
  });

  it('returns a non-JPEG buffer as is', () => {
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0xff, 0xe1, 0x00]);
    expect(stripJpegMetadata(png)).toBe(png);
  });

  it('throws MALFORMED_JPEG when a segment length runs past the end', () => {
    const input = Buffer.concat([
      SOI,
      app0,
      Buffer.from([0xff, 0xe1, 0x01, 0x00]),
      Buffer.from('Exif'),
    ]);
    expect(() => stripJpegMetadata(input)).toThrow('MALFORMED_JPEG');
  });

  it('throws MALFORMED_JPEG when SOS is never reached', () => {
    expect(() => stripJpegMetadata(Buffer.concat([SOI, app0, dqt]))).toThrow('MALFORMED_JPEG');
    expect(() => stripJpegMetadata(SOI)).toThrow('MALFORMED_JPEG');
  });

  it('throws MALFORMED_JPEG when a segment length is below 2', () => {
    const input = Buffer.concat([SOI, Buffer.from([0xff, 0xe1, 0x00, 0x01]), dqt, sos, scan, EOI]);
    expect(() => stripJpegMetadata(input)).toThrow('MALFORMED_JPEG');
  });
});

/**
 * Builds an EXIF APP1 payload: 'Exif\0\0' + TIFF header + IFD0. IFD0 holds Make (ASCII, stored
 * after the IFD), an optional Orientation and a GPS IFD pointer to a GPS IFD with one latitude ref.
 */
function exifTiff(littleEndian: boolean, orientation?: number): Buffer {
  const u16 = (v: number) => {
    const b = Buffer.alloc(2);
    if (littleEndian) b.writeUInt16LE(v);
    else b.writeUInt16BE(v);
    return b;
  };
  const u32 = (v: number) => {
    const b = Buffer.alloc(4);
    if (littleEndian) b.writeUInt32LE(v);
    else b.writeUInt32BE(v);
    return b;
  };
  const entries: Array<[number, number, number, Buffer]> = [];
  const make = Buffer.from('SecretCam\0', 'binary');
  const entryCount = orientation === undefined ? 2 : 3;
  const ifd0Size = 2 + entryCount * 12 + 4;
  const makeOffset = 8 + ifd0Size;
  const gpsOffset = makeOffset + make.length;
  entries.push([0x010f, 2, make.length, u32(makeOffset)]);
  if (orientation !== undefined) {
    entries.push([0x0112, 3, 1, Buffer.concat([u16(orientation), Buffer.alloc(2)])]);
  }
  entries.push([0x8825, 4, 1, u32(gpsOffset)]);
  const gpsIfd = Buffer.concat([
    u16(1),
    u16(0x0001),
    u16(2),
    u32(2),
    Buffer.from('S\0\0\0', 'binary'),
    u32(0),
  ]);
  const ifd0 = Buffer.concat([
    u16(entries.length),
    ...entries.map(([tag, type, count, value]) =>
      Buffer.concat([u16(tag), u16(type), u32(count), value]),
    ),
    u32(0),
  ]);
  const header = Buffer.concat([Buffer.from(littleEndian ? 'II' : 'MM'), u16(42), u32(8)]);
  return Buffer.concat([Buffer.from('Exif\0\0', 'binary'), header, ifd0, make, gpsIfd]);
}

/** The minimal APP1 the stripper must emit for a given byte order and orientation. */
function minimalOrientationApp1(littleEndian: boolean, orientation: number): Buffer {
  const header = littleEndian
    ? [0x49, 0x49, 0x2a, 0x00, 0x08, 0x00, 0x00, 0x00]
    : [0x4d, 0x4d, 0x00, 0x2a, 0x00, 0x00, 0x00, 0x08];
  const entry = littleEndian
    ? [0x01, 0x00, 0x12, 0x01, 0x03, 0x00, 0x01, 0x00, 0x00, 0x00, orientation, 0x00, 0x00, 0x00]
    : [0x00, 0x01, 0x01, 0x12, 0x00, 0x03, 0x00, 0x00, 0x00, 0x01, 0x00, orientation, 0x00, 0x00];
  return segment(
    0xe1,
    Buffer.concat([
      Buffer.from('Exif\0\0', 'binary'),
      Buffer.from(header),
      Buffer.from(entry),
      Buffer.alloc(4),
    ]),
  );
}

describe('stripJpegMetadata EXIF orientation', () => {
  it.each([
    ['big-endian', false],
    ['little-endian', true],
  ])('keeps only the orientation of %s EXIF in a minimal APP1', (_label, littleEndian) => {
    const input = Buffer.concat([
      SOI,
      app0,
      segment(0xe1, exifTiff(littleEndian, 6)),
      dqt,
      sos,
      scan,
      EOI,
    ]);
    const output = stripJpegMetadata(input);
    const expected = Buffer.concat([
      SOI,
      app0,
      minimalOrientationApp1(littleEndian, 6),
      dqt,
      sos,
      scan,
      EOI,
    ]);
    expect(output.equals(expected)).toBe(true);
    expect(output.includes('SecretCam')).toBe(false);
    // The GPS IFD pointer tag (0x8825) is gone in either byte order.
    expect(output.includes(Buffer.from([0x88, 0x25]))).toBe(false);
    expect(output.includes(Buffer.from([0x25, 0x88]))).toBe(false);
  });

  it('drops EXIF that has no orientation', () => {
    const input = Buffer.concat([SOI, app0, segment(0xe1, exifTiff(false)), dqt, sos, scan, EOI]);
    expect(stripJpegMetadata(input).equals(Buffer.concat([SOI, app0, dqt, sos, scan, EOI]))).toBe(
      true,
    );
  });

  it('drops EXIF whose orientation is out of range', () => {
    const input = Buffer.concat([SOI, segment(0xe1, exifTiff(true, 9)), dqt, sos, scan, EOI]);
    expect(stripJpegMetadata(input).equals(Buffer.concat([SOI, dqt, sos, scan, EOI]))).toBe(true);
  });

  it('drops EXIF with an unreadable TIFF header', () => {
    const broken = Buffer.concat([Buffer.from('Exif\0\0', 'binary'), Buffer.from('XX\0*')]);
    const input = Buffer.concat([SOI, segment(0xe1, broken), dqt, sos, scan, EOI]);
    expect(stripJpegMetadata(input).equals(Buffer.concat([SOI, dqt, sos, scan, EOI]))).toBe(true);
  });

  it('removes XMP while keeping the orientation from EXIF', () => {
    const input = Buffer.concat([
      SOI,
      segment(0xe1, exifTiff(false, 6)),
      segment(0xe1, Buffer.from('http://ns.adobe.com/xap/1.0/\0<x:GPS/>')),
      dqt,
      sos,
      scan,
      EOI,
    ]);
    const output = stripJpegMetadata(input);
    expect(
      output.equals(Buffer.concat([SOI, minimalOrientationApp1(false, 6), dqt, sos, scan, EOI])),
    ).toBe(true);
    expect(output.includes('ns.adobe.com')).toBe(false);
  });
});
