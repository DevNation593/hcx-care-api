import PDFDocument from 'pdfkit';
import { printable } from '../record-documents/record-pdf';

export interface ConsentPdfInput {
  clinic: { name: string; address?: string | null };
  patient: { name: string; identification?: string | null };
  treatment: { name: string; version: number };
  templateVersion: { version: number; checksum: string };
  title: string;
  body: string;
  checksum: string;
  signature: {
    png: Buffer;
    signerName: string;
    signerRole: 'PATIENT' | 'REPRESENTATIVE';
    signerIdentification?: string | null;
    relationship?: string | null;
    understood: boolean;
    questionsAnswered: boolean;
    marketingPhotos: boolean;
  };
  operatorName: string;
  signedAt: Date;
  /** Tenant time zone, used to print signedAt. */
  timezone: string;
}

const MARGIN = 56;
const MUTED = '#555555';
const RULE = '#bbbbbb';
const SIGNATURE_FIT: [number, number] = [200, 80];

/** The moment of signing as the clinic reads it, falling back to UTC for an unknown zone. */
function formatSignedAt(date: Date, timeZone: string): string {
  const format = (zone: string) =>
    new Intl.DateTimeFormat('es-EC', {
      timeZone: zone,
      dateStyle: 'long',
      timeStyle: 'short',
    }).format(date);
  try {
    return format(timeZone);
  } catch {
    return format('UTC');
  }
}

const yesNo = (value: boolean) => (value ? 'Sí' : 'No');

/** Renders a signed informed consent as an A4 document; the same input gives the same bytes. */
export async function renderConsentPdf(input: ConsentPdfInput): Promise<Buffer> {
  const { signature } = input;
  const doc = new PDFDocument({
    size: 'A4',
    margin: MARGIN,
    info: {
      Title: printable(input.title),
      Author: printable(input.clinic.name),
      // Fixed dates keep the output reproducible.
      CreationDate: input.signedAt,
      ModDate: input.signedAt,
    },
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
  const line = (text: string) =>
    doc.font('Helvetica').fontSize(10.5).fillColor('black').text(printable(text), { width });

  // Letterhead
  doc.font('Helvetica-Bold').fontSize(15).fillColor('black').text(printable(input.clinic.name));
  if (input.clinic.address)
    doc.font('Helvetica').fontSize(9).fillColor(MUTED).text(printable(input.clinic.address));
  doc.moveDown(0.5);
  rule();

  // Title, patient and treatment
  doc.font('Helvetica-Bold').fontSize(14).fillColor('black').text(printable(input.title));
  doc.moveDown(0.8);
  label('Paciente');
  line(
    [
      input.patient.name,
      input.patient.identification && `Identificación: ${input.patient.identification}`,
    ]
      .filter(Boolean)
      .join('   ·   '),
  );
  doc.moveDown(0.5);
  label('Tratamiento');
  line(`${input.treatment.name} (versión ${input.treatment.version})`);
  doc.moveDown(0.8);
  rule();

  // Text the patient read and signed
  doc
    .font('Helvetica')
    .fontSize(10.5)
    .fillColor('black')
    .text(printable(input.body), { width, align: 'justify' });
  doc.moveDown(1.2);

  // Signature, declarations and fingerprint, kept together on one page.
  need(SIGNATURE_FIT[1] + 250);
  rule();
  label('Firma');
  doc.moveDown(0.3);
  doc.image(signature.png, MARGIN, doc.y, { fit: SIGNATURE_FIT });
  doc.y += SIGNATURE_FIT[1] + 6;
  doc.x = MARGIN;
  doc
    .moveTo(MARGIN, doc.y)
    .lineTo(MARGIN + SIGNATURE_FIT[0], doc.y)
    .lineWidth(0.7)
    .strokeColor('black')
    .stroke();
  doc.moveDown(0.3);
  doc
    .font('Helvetica-Bold')
    .fontSize(10.5)
    .fillColor('black')
    .text(printable(signature.signerName));
  const role =
    signature.signerRole === 'PATIENT'
      ? 'Paciente'
      : `Representante${signature.relationship ? ` (${signature.relationship})` : ''}`;
  const signer = [
    role,
    signature.signerIdentification && `Identificación: ${signature.signerIdentification}`,
  ]
    .filter(Boolean)
    .join(' · ');
  doc.font('Helvetica').fontSize(9.5).fillColor(MUTED).text(printable(signer));
  doc.moveDown(0.8);

  label('Declaraciones');
  line(`Comprendió la información: ${yesNo(signature.understood)}`);
  line(`Sus preguntas fueron respondidas: ${yesNo(signature.questionsAnswered)}`);
  line(`Autoriza el uso de fotografías con fines de difusión: ${yesNo(signature.marketingPhotos)}`);
  doc.moveDown(0.8);

  label('Firmado');
  line(formatSignedAt(input.signedAt, input.timezone));
  doc
    .font('Helvetica')
    .fontSize(9.5)
    .fillColor(MUTED)
    .text(`Registrado por ${printable(input.operatorName)}`);
  doc.moveDown(1);

  rule();
  doc.font('Helvetica').fontSize(8).fillColor(MUTED);
  doc.text(
    `Versión de la plantilla: ${input.templateVersion.version} · Huella de la plantilla: ${input.templateVersion.checksum}`,
    { width },
  );
  doc.text(`Huella del documento firmado (SHA-256): ${input.checksum}`, { width });

  doc.end();
  return finished;
}
