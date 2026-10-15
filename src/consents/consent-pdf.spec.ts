import { deflateSync } from 'zlib';
import { ConsentPdfInput, renderConsentPdf } from './consent-pdf';

/** A valid 2x2 RGB PNG built in memory, so the test needs no fixture file. */
function tinyPng(): Buffer {
  const crcTable = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const crc = (buf: Buffer) => {
    let c = 0xffffffff;
    for (const byte of buf) c = crcTable[(c ^ byte) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type: string, data: Buffer) => {
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const check = Buffer.alloc(4);
    check.writeUInt32BE(crc(body));
    return Buffer.concat([length, body, check]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(2, 0);
  header.writeUInt32BE(2, 4);
  header.set([8, 2, 0, 0, 0], 8);
  // Two scanlines, each a filter byte (0) followed by two RGB pixels.
  const filter = Buffer.from([0]);
  const pixels = Buffer.concat([filter, Buffer.alloc(6, 0x20), filter, Buffer.alloc(6, 0x80)]);
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(pixels)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

const input = (overrides: Partial<ConsentPdfInput> = {}): ConsentPdfInput => ({
  clinic: { name: 'Clínica Aurora', address: 'Av. Principal 123' },
  patient: { name: 'Ana Pérez', identification: '0102030405' },
  treatment: { name: 'Toxina botulínica', version: 2 },
  templateVersion: { version: 3, checksum: 'a'.repeat(64) },
  title: 'Consentimiento informado',
  body: 'Yo, Ana Pérez, autorizo el procedimiento.\n\nHe sido informada de los riesgos.',
  checksum: 'b'.repeat(64),
  signature: {
    png: tinyPng(),
    signerName: 'Ana Pérez',
    signerRole: 'PATIENT',
    signerIdentification: '0102030405',
    relationship: null,
    understood: true,
    questionsAnswered: true,
    marketingPhotos: false,
  },
  operatorName: 'Dr. Luis Mora',
  signedAt: new Date('2026-10-15T15:30:00Z'),
  timezone: 'America/Guayaquil',
  ...overrides,
});

describe('renderConsentPdf', () => {
  it('produces a PDF', async () => {
    const pdf = await renderConsentPdf(input());
    expect(pdf.subarray(0, 4).toString('ascii')).toBe('%PDF');
  });

  it('gives identical bytes for the same input', async () => {
    const [first, second] = [await renderConsentPdf(input()), await renderConsentPdf(input())];
    expect(first.equals(second)).toBe(true);
  });

  it('renders a representative who is not the patient', async () => {
    const pdf = await renderConsentPdf(
      input({
        signature: {
          ...input().signature,
          signerName: 'María Pérez',
          signerRole: 'REPRESENTATIVE',
          relationship: 'Madre',
        },
      }),
    );
    expect(pdf.subarray(0, 4).toString('ascii')).toBe('%PDF');
  });

  it('renders characters outside Latin-1 without throwing', async () => {
    const pdf = await renderConsentPdf(
      input({ body: 'Texto — con “comillas” y un emoji 😀 al final.' }),
    );
    expect(pdf.subarray(0, 4).toString('ascii')).toBe('%PDF');
  });

  it('spills long bodies onto more pages', async () => {
    const short = await renderConsentPdf(input());
    const long = await renderConsentPdf(input({ body: 'Párrafo de prueba.\n\n'.repeat(200) }));
    expect(long.length).toBeGreaterThan(short.length);
  });
});
