/** Fiscal decimals stay strings so quantities, rates and totals never lose precision. */
export type Decimal = string;
export type ProviderEnvironment = '1' | '2';

export interface Tenant {
  id: string;
  name: string;
  status: 'ACTIVE' | 'SUSPENDED';
  role: 'OWNER' | 'ADMIN' | 'BILLER' | 'AUDITOR';
}

export interface Taxpayer {
  id: string;
  ruc: string;
  legalName: string;
  tradeName: string | null;
  headOfficeAddress: string;
  defaultEnvironment: ProviderEnvironment;
  accountingRequired: boolean;
  specialTaxpayerCode: string | null;
  withholdingAgentCode: string | null;
  rimpeRegime: 'NONE' | 'EMPRENDEDOR' | 'NEGOCIO_POPULAR';
  productionEnabledAt: string | null;
}

export interface Establishment {
  id: string;
  taxpayerId: string;
  code: string;
  address: string;
}

export interface EmissionPoint {
  id: string;
  establishmentId: string;
  code: string;
  enabled: boolean;
}

export interface TaxRate {
  taxCode: string;
  rateCode: string;
  description: string;
  rate: Decimal;
}

export interface CustomerProfile {
  idType: string;
  idNumber: string;
  name: string;
  email?: string | null;
  address?: string | null;
  phone?: string | null;
}

export interface Customer extends CustomerProfile {
  id: string;
  email: string | null;
  address: string | null;
  phone: string | null;
}

export interface ProductInput {
  sku: string;
  name: string;
  unitPrice: Decimal;
  ivaRateCode: string;
}

export interface Product extends ProductInput {
  id: string;
}

export interface InvoiceLine {
  productId: string;
  quantity: Decimal;
  unitPrice?: Decimal | null;
  discount?: Decimal | null;
}

export interface Payment {
  methodCode: string;
  amount: Decimal;
}

/** Wire request; no tenant, environment, customer overrides or clinical data. */
export interface InvoiceBody {
  taxpayerId: string;
  establishmentCode: string;
  emissionPointCode: string;
  customerId: string;
  issueDate?: string | null;
  currency?: string | null;
  lines: InvoiceLine[];
  payments: Payment[];
  replacesDocumentId?: string | null;
}

export type KnownDocumentState =
  | 'RESERVED'
  | 'GENERATED'
  | 'SIGNED'
  | 'SENDING'
  | 'RECEIVED'
  | 'AUTHORIZED'
  | 'XSD_INVALID'
  | 'SIGNATURE_FAILED'
  | 'RETURNED'
  | 'NOT_AUTHORIZED';

/** Unknown provider states remain visible so core can keep the request PROCESSING. */
export type DocumentState = KnownDocumentState | (string & { readonly __providerState?: never });

export interface IssuedDocument {
  id: string;
  state: DocumentState;
  /** Informational only. The adapter never fetches provider-supplied URLs. */
  statusUrl: string;
}

export interface DocumentLine {
  lineNo: number;
  productId: string;
  mainCode: string;
  description: string;
  quantity: Decimal;
  unitPrice: Decimal;
  discount: Decimal;
  subtotal: Decimal;
  taxCode: string;
  taxRateCode: string;
  taxRate: Decimal;
  taxAmount: Decimal;
}

export interface DocumentTax {
  taxCode: string;
  rateCode: string;
  rate: Decimal;
  base: Decimal;
  amount: Decimal;
}

export interface ProviderDocument {
  id: string;
  documentType: string;
  state: DocumentState;
  environment: ProviderEnvironment;
  taxpayerId: string;
  number: string;
  sequence: string;
  accessKey: string;
  issueDate: string;
  currency: string;
  customer: { idType: string; idNumber: string; name: string };
  subtotal: Decimal;
  totalDiscount: Decimal;
  taxes: DocumentTax[];
  totalTax: Decimal;
  total: Decimal;
  lines: DocumentLine[];
  payments: Payment[];
  authorizationNumber: string | null;
  authorizedAt: string | null;
  customerId: string;
  replacesDocumentId: string | null;
  replacedByDocumentId: string | null;
}

export type ArtifactKind =
  | 'xml-unsigned'
  | 'xml-signed'
  | 'sri-authorization'
  | 'xml-authorized'
  | 'ride';

/** Bytes have already been verified against the strong quoted ETag. */
export interface ProviderArtifact {
  bytes: Buffer;
  contentType: 'application/xml' | 'application/pdf';
  etag: string;
  sha256: string;
}

/** Authorized fiscal content, never copy these strings into logs or ProviderError. */
export interface SriMessage {
  identifier: string | null;
  message: string | null;
  additionalInfo: string | null;
  type: string | null;
}

export interface SriAttempt {
  id: string;
  operation: 'RECEPTION' | 'AUTHORIZATION';
  outcome: string | null;
  sriStatus: string | null;
  httpStatus: number | null;
  startedAt: string;
  completedAt: string | null;
  messages: SriMessage[];
}

export type ProviderErrorKind = 'transient' | 'data' | 'configuration';

/** Contains only adapter-controlled codes and numeric metadata, never upstream messages. */
export class ProviderError extends Error {
  readonly status?: number;
  readonly retryAfterMs?: number;

  constructor(
    readonly kind: ProviderErrorKind,
    readonly code: string,
    metadata: { status?: number; retryAfterMs?: number } = {},
  ) {
    super(`Invoicing provider: ${code}`);
    this.name = 'ProviderError';
    this.status = metadata.status;
    this.retryAfterMs = metadata.retryAfterMs;
  }
}

export interface InvoicingProvider {
  getTenant(): Promise<Tenant>;
  listTaxpayers(): Promise<Taxpayer[]>;
  listEstablishments(taxpayerId: string): Promise<Establishment[]>;
  listEmissionPoints(taxpayerId: string, establishmentId: string): Promise<EmissionPoint[]>;
  listTaxRates(): Promise<TaxRate[]>;
  /** Returns stored fiscal data unchanged; callers must compare it with their snapshot. */
  findCustomer(idType: string, idNumber: string): Promise<Customer | null>;
  createCustomer(profile: CustomerProfile): Promise<Customer>;
  findProduct(sku: string): Promise<Product | null>;
  createProduct(product: ProductInput): Promise<Product>;
  createInvoice(body: InvoiceBody, key: string): Promise<IssuedDocument>;
  getDocument(id: string): Promise<ProviderDocument>;
  getSriAttempts(id: string): Promise<SriAttempt[]>;
  getArtifact(id: string, kind: ArtifactKind): Promise<ProviderArtifact>;
}
