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
