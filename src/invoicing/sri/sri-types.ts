export type SriEnvironment = '1' | '2';
export type RimpeRegime = 'NONE' | 'EMPRENDEDOR' | 'NEGOCIO_POPULAR';

export interface IssuerSnapshot {
  ruc: string;
  legalName: string;
  tradeName: string | null;
  headOfficeAddress: string;
  accountingRequired: boolean;
  specialTaxpayerCode: string | null;
  withholdingAgentCode: string | null;
  rimpeRegime: RimpeRegime;
}

export interface CustomerProfile {
  idType: string;
  idNumber: string;
  name: string;
  email?: string | null;
  address?: string | null;
  phone?: string | null;
}

export interface Payment {
  methodCode: string;
  amount: string;
}

export interface DocumentLineInput {
  localId: string;
  code?: string;
  name: string;
  quantity: string;
  unitPrice: string;
  discount: string;
  taxRatePercent: string;
}

export interface InvoiceDocument {
  environment: SriEnvironment;
  issuer: IssuerSnapshot;
  establishmentCode: string;
  emissionPointCode: string;
  establishmentAddress: string;
  sequential: number;
  accessKey: string;
  /** YYYY-MM-DD */
  issueDate: string;
  customer: CustomerProfile;
  lines: DocumentLineInput[];
  payments: Payment[];
}

export interface SriMessage {
  identifier: string | null;
  message: string | null;
  additionalInfo: string | null;
  type: string | null;
}

export type SriErrorKind = 'transient' | 'data' | 'configuration';

/**
 * Error raised by the SRI integration. It carries only a kind, a stable code
 * and numeric metadata, never SRI texts, certificates or passwords.
 */
export class SriError extends Error {
  readonly status?: number;
  readonly retryAfterMs?: number;

  constructor(
    readonly kind: SriErrorKind,
    readonly code: string,
    metadata?: { status?: number; retryAfterMs?: number },
  ) {
    super(code);
    this.name = 'SriError';
    this.status = metadata?.status;
    this.retryAfterMs = metadata?.retryAfterMs;
  }
}
