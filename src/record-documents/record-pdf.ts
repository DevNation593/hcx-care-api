import PDFDocument from 'pdfkit';
import * as QRCode from 'qrcode';
import '../common/pdf/standard-fonts';
import { DocumentRow, DocumentSection } from './document-content';

export interface RecordPdfInput {
  clinic: { name: string; address?: string | null; phone?: string | null };
  title: string;
  /** The date of the record, already written for the reader. */
  issuedOn: string;
  patient: { name: string; identification?: string | null; birthDate?: string | null };
  professional: {
    name: string;
    title?: string | null;
    licenseNumber?: string | null;
    specialty?: string | null;
  };
  sections: DocumentSection[];
  notes?: string | null;
  verification: { code: string; url: string };
}

const MARGIN = 56;
const MUTED = '#555555';
const RULE = '#bbbbbb';
const QR_SIZE = 84;
const MAX_TABLE_COLUMNS = 5;

/**
 * The standard PDF fonts cover Latin-1 only. Anything else (an emoji, a symbol pasted from
 * another program) is replaced so that it does not come out as a different character.
 */
export const printable = (text: string) =>
  text
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/[–—]/g, '-')
    .replace(/≥/g, '>=')
    .replace(/≤/g, '<=')
    .replace(/[^\n\r\t\x20-\x7E -ÿ]/g, '?');

/** Renders a clinical record as a signed, verifiable A4 document. */
export async function renderRecordPdf(input: RecordPdfInput): Promise<Buffer> {
  const qr = await QRCode.toBuffer(input.verification.url, {
    type: 'png',
    margin: 0,
    width: QR_SIZE * 3,
    errorCorrectionLevel: 'M',
  });

  const doc = new PDFDocument({
    size: 'A4',
    margin: MARGIN,
    info: { Title: printable(input.title), Author: printable(input.clinic.name) },
  });
  const chunks: Buffer[] = [];
  doc.on('data', (chunk: Buffer) => chunks.push(chunk));
  const finished = new Promise<Buffer>((resolve, reject) => {
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
  });

  const width = doc.page.width - MARGIN * 2;
  const bottom = () => doc.page.height - MARGIN;
  /** Starts a new page when what comes next does not fit in what is left of this one. */
  const need = (height: number) => {
    if (doc.y + height > bottom()) doc.addPage();
  };
  const rule = () => {
    doc
      .moveTo(MARGIN, doc.y)
      .lineTo(MARGIN + width, doc.y)
      .lineWidth(0.5)
      .strokeColor(RULE)
      .stroke();
    doc.moveDown(0.6);
  };
  const label = (text: string) =>
    doc.font('Helvetica-Bold').fontSize(8.5).fillColor(MUTED).text(printable(text).toUpperCase());
  const body = (text: string) =>
    doc.font('Helvetica').fontSize(10.5).fillColor('black').text(printable(text), { width });

  // Letterhead
  doc.font('Helvetica-Bold').fontSize(15).fillColor('black').text(printable(input.clinic.name));
  const contact = [input.clinic.address, input.clinic.phone].filter(Boolean).join(' · ');
  if (contact) doc.font('Helvetica').fontSize(9).fillColor(MUTED).text(printable(contact));
  doc.moveDown(0.5);
  rule();

  // Title and date
  doc.font('Helvetica-Bold').fontSize(14).fillColor('black').text(printable(input.title));
  doc.font('Helvetica').fontSize(9.5).fillColor(MUTED).text(printable(input.issuedOn));
  doc.moveDown(0.8);

  // Patient
  label('Paciente');
  body(
    [
      input.patient.name,
      input.patient.identification && `Identificación: ${input.patient.identification}`,
      input.patient.birthDate && `Fecha de nacimiento: ${input.patient.birthDate}`,
    ]
      .filter(Boolean)
      .join('   ·   '),
  );
  doc.moveDown(0.8);

  const table = (row: Extract<DocumentRow, { table: unknown }>) => {
    const { columns, rows } = row.table;
    // Too many columns to read side by side (a prescription has eight): one entry per row.
    if (columns.length > MAX_TABLE_COLUMNS) {
      rows.forEach((cells, index) => {
        const parts = cells.flatMap((cell, column) => (cell ? `${columns[column]}: ${cell}` : []));
        need(30);
        body(`${index + 1}. ${parts.join('   ·   ')}`);
        doc.moveDown(0.3);
      });
      return;
    }
    const columnWidth = width / Math.max(columns.length, 1);
    const line = (cells: string[], bold: boolean) => {
      doc.font(bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(9.5);
      const texts = cells.map(printable);
      const height =
        Math.max(...texts.map((text) => doc.heightOfString(text, { width: columnWidth - 8 })), 10) +
        6;
      need(height);
      const top = doc.y;
      texts.forEach((text, index) => {
        doc
          .fillColor(bold ? MUTED : 'black')
          .text(text, MARGIN + index * columnWidth, top, { width: columnWidth - 8 });
      });
      doc.x = MARGIN;
      doc.y = top + height;
    };
    line(columns, true);
    rows.forEach((cells) => line(cells, false));
  };

  for (const section of input.sections) {
    need(48);
    doc.font('Helvetica-Bold').fontSize(11.5).fillColor('black').text(printable(section.title));
    doc.moveDown(0.3);
    for (const row of section.rows) {
      need(30);
      label(row.label);
      if ('text' in row) body(row.text);
      else if ('table' in row) table(row);
      else {
        need(70);
        doc.image(row.image, { fit: [220, 64] });
      }
      doc.moveDown(0.5);
    }
    doc.moveDown(0.4);
  }

  if (input.notes) {
    need(40);
    label('Observaciones');
    body(input.notes);
    doc.moveDown(0.8);
  }

  // Signature of the professional and verification, kept together on one page.
  need(150);
  doc.moveDown(2.2);
  const signatureWidth = 220;
  doc
    .moveTo(MARGIN, doc.y)
    .lineTo(MARGIN + signatureWidth, doc.y)
    .lineWidth(0.7)
    .strokeColor('black')
    .stroke();
  doc.moveDown(0.3);
  doc
    .font('Helvetica-Bold')
    .fontSize(10.5)
    .fillColor('black')
    .text(printable(input.professional.name));
  const credentials = [
    input.professional.title ?? input.professional.specialty,
    input.professional.licenseNumber && `Registro: ${input.professional.licenseNumber}`,
  ]
    .filter(Boolean)
    .join(' · ');
  if (credentials)
    doc.font('Helvetica').fontSize(9.5).fillColor(MUTED).text(printable(credentials));
  doc.moveDown(1.2);

  rule();
  const top = doc.y;
  doc.image(qr, MARGIN, top, { width: QR_SIZE, height: QR_SIZE });
  const textX = MARGIN + QR_SIZE + 14;
  const textWidth = width - QR_SIZE - 14;
  doc
    .font('Helvetica-Bold')
    .fontSize(9.5)
    .fillColor('black')
    .text('Verificación del documento', textX, top, { width: textWidth });
  doc
    .font('Helvetica')
    .fontSize(9)
    .fillColor(MUTED)
    .text(
      'Escanea el código o entra en la dirección para comprobar que este documento fue emitido por el consultorio y sigue vigente.',
      textX,
      doc.y + 2,
      { width: textWidth },
    );
  doc.fillColor('black').text(printable(input.verification.url), textX, doc.y + 4, {
    width: textWidth,
  });
  doc
    .font('Helvetica-Bold')
    .fontSize(10)
    .text(`Código: ${input.verification.code}`, textX, doc.y + 4, { width: textWidth });

  doc.end();
  return finished;
}
