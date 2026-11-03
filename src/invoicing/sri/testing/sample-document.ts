import { InvoiceDocument } from '../sri-types';

/** A valid two-line, two-payment invoice document used across the SRI specs. */
export function sampleDocument(overrides: Partial<InvoiceDocument> = {}): InvoiceDocument {
  return {
    environment: '1',
    issuer: {
      ruc: '1790012345001',
      legalName: 'Clínica Ejemplo S.A.',
      tradeName: 'Clínica Ejemplo',
      headOfficeAddress: 'Av. Amazonas N1-23, Quito',
      accountingRequired: true,
      specialTaxpayerCode: null,
      withholdingAgentCode: null,
      rimpeRegime: 'EMPRENDEDOR',
    },
    establishmentCode: '001',
    emissionPointCode: '002',
    establishmentAddress: 'Av. Amazonas N1-23, Quito',
    sequential: 123,
    accessKey: '0710202601179001234500110010020000001231234567816',
    issueDate: '2026-10-07',
    customer: {
      idType: '05',
      idNumber: '1710034065',
      name: 'Juan Pérez & Hijos',
      email: 'juan@example.com',
      address: 'Quito',
      phone: '0991234567',
    },
    lines: [
      {
        localId: 'a',
        code: 'PSI-01',
        name: 'Sesión de psicoterapia',
        quantity: '1.000000',
        unitPrice: '40.00',
        discount: '0.00',
        taxRatePercent: '0.00',
      },
      {
        localId: 'b',
        code: 'PRD-7',
        name: 'Cuaderno <A5>',
        quantity: '2.000000',
        unitPrice: '3.50',
        discount: '0.50',
        taxRatePercent: '15.00',
      },
    ],
    payments: [
      { methodCode: '01', amount: '20.00' },
      { methodCode: '19', amount: '27.48' },
    ],
    ...overrides,
  };
}
