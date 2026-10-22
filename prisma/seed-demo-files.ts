import PDFDocument from 'pdfkit';
import { deflateSync } from 'zlib';

// The demo files are generated, so that the seed carries no binary and what it stores are real
// PNG and PDF files the API accepts, downloads and renders like any uploaded one.

const CRC_TABLE = Array.from({ length: 256 }, (_, index) => {
  let value = index;
  for (let bit = 0; bit < 8; bit += 1) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  return value >>> 0;
});

function crc32(data: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of data) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Buffer): Buffer {
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const checksum = Buffer.alloc(4);
  checksum.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, checksum]);
}

/** An RGBA bitmap as a PNG file. `pixel` returns the four channels of each point. */
export function encodePng(
  width: number,
  height: number,
  pixel: (x: number, y: number) => [number, number, number, number],
): Buffer {
  const rowLength = width * 4 + 1;
  const raw = Buffer.alloc(rowLength * height);
  for (let y = 0; y < height; y += 1) {
    // Each row starts with its filter type; 0 is "none".
    for (let x = 0; x < width; x += 1) raw.set(pixel(x, y), y * rowLength + 1 + x * 4);
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header.set([8, 6, 0, 0, 0], 8); // 8 bits per channel, RGBA

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/**
 * A handwritten-looking stroke on a transparent background, as the signature pad of the web
 * produces it. `variant` gives each signer a different stroke.
 */
export function demoSignature(variant = 1): string {
  const width = 300;
  const height = 100;
  const ink = (x: number, y: number) => {
    const t = x / width;
    if (t < 0.08 || t > 0.92) return false;
    const wave =
      height / 2 +
      Math.sin(t * Math.PI * (4 + variant)) * 22 * (1 - t * 0.5) +
      Math.sin(t * Math.PI * 11 + variant) * 7;
    // The underline every signature ends with.
    const underline = t > 0.2 && t < 0.85 && Math.abs(y - (height - 18 + t * 6)) < 1;
    return Math.abs(y - wave) < 1.6 || underline;
  };
  const png = encodePng(width, height, (x, y) => (ink(x, y) ? [17, 24, 39, 255] : [0, 0, 0, 0]));
  return `data:image/png;base64,${png.toString('base64')}`;
}

/** A grey image with a brighter shape in the middle: a stand-in for a periapical X-ray. */
export function demoRadiograph(): Buffer {
  const width = 320;
  const height = 240;
  return encodePng(width, height, (x, y) => {
    const dx = (x - width / 2) / 60;
    const dy = (y - height / 2) / 90;
    const tooth = Math.max(0, 1 - (dx * dx + dy * dy));
    const shade = Math.round(28 + tooth * 190 + ((x * 7 + y * 13) % 9));
    return [shade, shade, shade, 255];
  });
}

/** A patch of skin, with spots before the treatment and almost none after it. */
export function demoSkinPhoto(phase: 'BEFORE' | 'AFTER'): Buffer {
  const width = 320;
  const height = 240;
  const spots = phase === 'BEFORE' ? 14 : 3;
  return encodePng(width, height, (x, y) => {
    let spot = 0;
    for (let index = 0; index < spots; index += 1) {
      const dx = x - ((index * 97) % width);
      const dy = y - ((index * 61 + 30) % height);
      if (dx * dx + dy * dy < 36) spot = 1;
    }
    const grain = (x * 7 + y * 13) % 6;
    return spot
      ? [168 + grain, 96 + grain, 84 + grain, 255]
      : [232 + (grain % 3), 190 + grain, 160 + grain, 255];
  });
}

/** A one-page PDF with a made-up laboratory result. */
export function demoLabReport(patientName: string, date: string): Promise<Buffer> {
  const doc = new PDFDocument({
    size: 'A4',
    margin: 56,
    info: { Title: 'Resultado de laboratorio' },
  });
  const chunks: Buffer[] = [];
  doc.on('data', (data: Buffer) => chunks.push(data));
  const finished = new Promise<Buffer>((resolve, reject) => {
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
  });

  doc.font('Helvetica-Bold').fontSize(15).text('Laboratorio Clínico Demo');
  doc.font('Helvetica').fontSize(9).fillColor('#555555').text('Documento ficticio de la semilla.');
  doc.moveDown();
  doc.fillColor('black').fontSize(11).text(`Paciente: ${patientName}`);
  doc.text(`Fecha de la muestra: ${date}`);
  doc.moveDown();
  doc.font('Helvetica-Bold').text('Perfil lipídico y glucosa');
  doc.font('Helvetica');
  for (const [name, value, reference] of [
    ['Glucosa en ayunas', '112 mg/dL', '70 - 100'],
    ['Colesterol total', '228 mg/dL', '< 200'],
    ['Colesterol LDL', '148 mg/dL', '< 130'],
    ['Colesterol HDL', '41 mg/dL', '> 40'],
    ['Triglicéridos', '196 mg/dL', '< 150'],
  ]) {
    doc.text(`${name}: ${value}   (referencia ${reference})`);
  }
  doc.end();
  return finished;
}
