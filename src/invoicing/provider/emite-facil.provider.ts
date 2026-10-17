import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHash } from 'node:crypto';
import {
  ArtifactKind,
  Customer,
  CustomerProfile,
  DocumentLine,
  DocumentState,
  DocumentTax,
  EmissionPoint,
  Establishment,
  InvoicingProvider,
  InvoiceBody,
  IssuedDocument,
  Payment,
  Product,
  ProductInput,
  ProviderArtifact,
  ProviderDocument,
  ProviderError,
  SriAttempt,
  SriMessage,
  Taxpayer,
  TaxRate,
  Tenant,
} from './invoicing-provider';

type Parser<T> = (value: unknown) => T;
type JsonObject = Record<string, unknown>;

function invalidResponse(): never {
  throw new ProviderError('transient', 'INVALID_RESPONSE');
}

function record(value: unknown): JsonObject {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalidResponse();
  return value as JsonObject;
}

const text: Parser<string> = (value) => {
  if (typeof value !== 'string') invalidResponse();
  return value as string;
};
const boolean: Parser<boolean> = (value) => {
  if (typeof value !== 'boolean') invalidResponse();
  return value as boolean;
};
const integer: Parser<number> = (value) => {
  if (!Number.isSafeInteger(value) || (value as number) < 0) invalidResponse();
  return value as number;
};

function matching(pattern: RegExp): Parser<string> {
  return (value) => {
    const result = text(value);
    if (!pattern.test(result)) invalidResponse();
    return result;
  };
}

function boundedText(max: number, nonempty = false): Parser<string> {
  return (value) => {
    const result = text(value);
    if (
      result.length > max ||
      (nonempty && !result.trim()) ||
      /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(result)
    )
      invalidResponse();
    return result;
  };
}

const uuid = matching(/^[a-f\d]{8}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{12}$/i);
const decimal = matching(/^\d+(?:\.\d+)?$/);
const threeDigits = matching(/^\d{3}$/);

function enumeration<T extends string>(...allowed: T[]): Parser<T> {
  return (value) => {
    if (!allowed.includes(value as T)) invalidResponse();
    return value as T;
  };
}

function nullable<T>(parse: Parser<T>): Parser<T | null> {
  return (value) => (value === null ? null : parse(value));
}

function array<T>(parse: Parser<T>, max = 100000): Parser<T[]> {
  return (value) => {
    if (!Array.isArray(value) || value.length > max) invalidResponse();
    return (value as unknown[]).map(parse);
  };
}

function object<T>(shape: { [K in keyof T]: Parser<T[K]> }): Parser<T> {
  return (value) => {
    const source = record(value);
    const result: Partial<T> = {};
    for (const key of Object.keys(shape) as (keyof T)[]) {
      result[key] = shape[key](source[key as string]);
    }
    return result as T;
  };
}

const environment = enumeration('1', '2');
const state: Parser<DocumentState> = boundedText(60, true);
const tenant = object<Tenant>({
  id: uuid,
  name: text,
  status: enumeration('ACTIVE', 'SUSPENDED'),
  role: enumeration('OWNER', 'ADMIN', 'BILLER', 'AUDITOR'),
});
const taxpayer = object<Taxpayer>({
  id: uuid,
  ruc: text,
  legalName: text,
  tradeName: nullable(text),
  headOfficeAddress: text,
  defaultEnvironment: environment,
  accountingRequired: boolean,
  specialTaxpayerCode: nullable(text),
  withholdingAgentCode: nullable(text),
  rimpeRegime: enumeration('NONE', 'EMPRENDEDOR', 'NEGOCIO_POPULAR'),
  productionEnabledAt: nullable(text),
});
const establishment = object<Establishment>({
  id: uuid,
  taxpayerId: uuid,
  code: threeDigits,
  address: text,
});
const emissionPoint = object<EmissionPoint>({
  id: uuid,
  establishmentId: uuid,
  code: threeDigits,
  enabled: boolean,
});
const taxRate = object<TaxRate>({
  taxCode: text,
  rateCode: text,
  description: text,
  rate: decimal,
});
const customer = object<Customer>({
  id: uuid,
  idType: text,
  idNumber: text,
  name: text,
  email: nullable(text),
  address: nullable(text),
  phone: nullable(text),
});
const product = object<Product>({
  id: uuid,
  sku: text,
  name: text,
  unitPrice: decimal,
  ivaRateCode: text,
});
const issuedDocument = object<IssuedDocument>({ id: uuid, state, statusUrl: text });
const payment = object<Payment>({ methodCode: text, amount: decimal });
const documentLine = object<DocumentLine>({
  lineNo: integer,
  productId: uuid,
  mainCode: text,
  description: text,
  quantity: decimal,
  unitPrice: decimal,
  discount: decimal,
  subtotal: decimal,
  taxCode: text,
  taxRateCode: text,
  taxRate: decimal,
  taxAmount: decimal,
});
const documentTax = object<DocumentTax>({
  taxCode: text,
  rateCode: text,
  rate: decimal,
  base: decimal,
  amount: decimal,
});
const document = object<ProviderDocument>({
  id: uuid,
  documentType: text,
  state,
  environment,
  taxpayerId: uuid,
  number: text,
  sequence: text,
  accessKey: text,
  issueDate: text,
  currency: text,
  customer: object({ idType: text, idNumber: text, name: text }),
  subtotal: decimal,
  totalDiscount: decimal,
  taxes: array(documentTax),
  totalTax: decimal,
  total: decimal,
  lines: array(documentLine),
  payments: array(payment),
  authorizationNumber: nullable(text),
  authorizedAt: nullable(text),
  customerId: uuid,
  replacesDocumentId: nullable(uuid),
  replacedByDocumentId: nullable(uuid),
});
const sriMessage = object<SriMessage>({
  identifier: nullable(boundedText(20)),
  message: nullable(boundedText(2000)),
  additionalInfo: nullable(boundedText(2000)),
  type: nullable(boundedText(30)),
});
const sriAttempt = object<SriAttempt>({
  id: uuid,
  operation: enumeration('RECEPTION', 'AUTHORIZATION'),
  outcome: nullable(boundedText(30)),
  sriStatus: nullable(boundedText(60)),
  httpStatus: nullable(integer),
  startedAt: boundedText(40, true),
  completedAt: nullable(boundedText(40, true)),
  messages: array(sriMessage, 100),
});

const knownDataCodes = new Set([
  'MALFORMED_REQUEST',
  'VALIDATION_FAILED',
  'REQUEST_REJECTED',
  'IDEMPOTENCY_KEY_REQUIRED',
  'IDEMPOTENCY_KEY_INVALID',
  'IDEMPOTENCY_KEY_REUSED',
  'CUSTOMER_ALREADY_EXISTS',
  'PRODUCT_SKU_TAKEN',
  'IDENTIFICATION_TYPE_UNKNOWN',
  'IDENTIFICATION_INVALID',
  'TAX_RATE_UNKNOWN',
  'INVALID_ISSUE_DATE',
  'SEQUENCE_EXHAUSTED',
  'REPLACED_DOCUMENT_NOT_REJECTED',
  'REPLACED_DOCUMENT_OTHER_ISSUER',
  'DOCUMENT_ALREADY_REPLACED',
  'TAXPAYER_NOT_FOUND',
  'ESTABLISHMENT_NOT_FOUND',
  'EMISSION_POINT_NOT_FOUND',
  'EMISSION_POINT_DISABLED',
  'CUSTOMER_NOT_FOUND',
  'PRODUCT_NOT_FOUND',
  'PAYMENT_METHOD_UNKNOWN',
  'UNSUPPORTED_CURRENCY',
  'INVALID_LINE',
  'AMOUNT_TOO_LARGE',
  'INVALID_PAYMENT',
  'PAYMENTS_MISMATCH',
  'FINAL_CONSUMER_LIMIT_EXCEEDED',
  'PRODUCTION_NOT_ENABLED',
  'RIMPE_REGIME_UNSUPPORTED',
  'SEQUENCE_ALREADY_USED',
]);

function retryAfter(value: string | null): number | undefined {
  if (!value) return undefined;
  if (/^\d+$/.test(value)) {
    const milliseconds = Number(value) * 1000;
    return Number.isSafeInteger(milliseconds) ? milliseconds : undefined;
  }
  const date = Date.parse(value);
  return Number.isFinite(date) ? Math.max(0, date - Date.now()) : undefined;
}

function httpError(status: number, body: unknown, retryAfterMs?: number): ProviderError {
  const source = body && typeof body === 'object' ? (body as JsonObject) : {};
  const upstream = typeof source.errorCode === 'string' ? source.errorCode : '';
  const metadata = { status, retryAfterMs };
  if (status === 401) return new ProviderError('configuration', 'UNAUTHENTICATED', metadata);
  if (status === 403)
    return new ProviderError(
      'configuration',
      ['ROLE_FORBIDDEN', 'TENANT_FORBIDDEN', 'API_KEY_NOT_ALLOWED'].includes(upstream)
        ? upstream
        : 'FORBIDDEN',
      metadata,
    );
  if (status === 404) return new ProviderError('data', 'NOT_FOUND', metadata);
  if (status === 429) return new ProviderError('transient', 'RATE_LIMITED', metadata);
  if (status >= 500) return new ProviderError('transient', 'PROVIDER_UNAVAILABLE', metadata);
  // Compatibility only: the audited service currently serializes concurrent requests, and does
  // not emit this separate code. KEY_REUSED must always remain a nonretryable data conflict.
  if (status === 409 && upstream === 'IDEMPOTENCY_IN_PROGRESS') {
    return new ProviderError('transient', 'IDEMPOTENCY_IN_PROGRESS', metadata);
  }
  return new ProviderError(
    'data',
    knownDataCodes.has(upstream)
      ? upstream
      : status === 422
        ? 'VALIDATION_FAILED'
        : status === 409
          ? 'CONFLICT'
          : 'REQUEST_REJECTED',
    metadata,
  );
}

function baseUrl(raw: unknown): string {
  try {
    if (typeof raw !== 'string' || !raw || raw.trim() !== raw) throw new Error();
    const url = new URL(raw);
    const path = url.pathname.replace(/\/$/, '');
    if (
      !['http:', 'https:'].includes(url.protocol) ||
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      !path.endsWith('/api/v1') ||
      path.includes('/api/v1/api/v1')
    )
      throw new Error();
    return `${url.origin}${path}`;
  } catch {
    throw new ProviderError('configuration', 'INVALID_API_URL');
  }
}

function pathId(id: string): string {
  try {
    return uuid(id);
  } catch {
    throw new ProviderError('data', 'INVALID_IDENTIFIER');
  }
}

async function readBytes(response: Response, limit: number): Promise<Buffer> {
  if (!response.body) return Buffer.alloc(0);
  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let length = 0;
  try {
    while (true) {
      const part = await reader.read();
      if (part.done) return Buffer.concat(chunks, length);
      length += part.value.byteLength;
      if (length > limit) {
        await reader.cancel();
        throw new ProviderError('transient', 'RESPONSE_TOO_LARGE');
      }
      chunks.push(Buffer.from(part.value));
    }
  } finally {
    reader.releaseLock();
  }
}

function parseJson(bytes: Buffer): unknown {
  try {
    return JSON.parse(bytes.toString('utf8'));
  } catch {
    return invalidResponse();
  }
}

/** A factory with global URL configuration only. Secrets live in each returned client. */

@Injectable()
export class EmiteFacilProvider {
  constructor(private readonly config: ConfigService) {}

  client(apiKey: string, correlationId?: string): InvoicingProvider {
    const url = baseUrl(this.config.get<string>('EMITE_FACIL_API_URL'));
    if (typeof apiKey !== 'string' || !apiKey.trim() || /[\x00-\x20\x7f]/.test(apiKey)) {
      throw new ProviderError('configuration', 'INVALID_API_KEY');
    }
    if (correlationId !== undefined && !/^[A-Za-z\d._:-]{1,100}$/.test(correlationId)) {
      throw new ProviderError('data', 'INVALID_CORRELATION_ID');
    }
    return new HttpInvoicingClient(url, apiKey, correlationId);
  }
}

class HttpInvoicingClient implements InvoicingProvider {
  constructor(
    private readonly url: string,
    private readonly apiKey: string,
    private readonly correlationId?: string,
  ) {}

  private async request<T>(
    path: string,
    parse: (bytes: Buffer, response: Response) => T,
    options: { body?: unknown; key?: string; status?: number; limit?: number } = {},
  ): Promise<T> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15000);
    try {
      const response = await fetch(`${this.url}${path}`, {
        method: options.body === undefined ? 'GET' : 'POST',
        redirect: 'manual',
        signal: controller.signal,
        headers: {
          'X-Api-Key': this.apiKey,
          Accept: 'application/json',
          ...(options.body === undefined ? {} : { 'Content-Type': 'application/json' }),
          ...(options.key === undefined ? {} : { 'Idempotency-Key': options.key }),
          ...(this.correlationId ? { 'X-Correlation-Id': this.correlationId } : {}),
        },
        ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
      });
      if (response.status >= 300 && response.status < 400) {
        await response.body?.cancel();
        throw new ProviderError('configuration', 'REDIRECT_REJECTED', { status: response.status });
      }
      if (!response.ok) {
        let errorBody: unknown;
        try {
          errorBody = parseJson(await readBytes(response, 65536));
        } catch {
          if (controller.signal.aborted) throw new ProviderError('transient', 'TIMEOUT');
          // An invalid error body must not hide the HTTP status or leak its text.
        }
        throw httpError(
          response.status,
          errorBody,
          retryAfter(response.headers.get('retry-after')),
        );
      }
      if (response.status !== (options.status ?? 200)) {
        await response.body?.cancel();
        return invalidResponse();
      }
      return parse(await readBytes(response, options.limit ?? 10 * 1024 * 1024), response);
    } catch (error) {
      if (error instanceof ProviderError) throw error;
      throw new ProviderError('transient', controller.signal.aborted ? 'TIMEOUT' : 'NETWORK_ERROR');
    } finally {
      clearTimeout(timeout);
    }
  }

  private json<T>(
    path: string,
    parser: Parser<T>,
    options?: { body?: unknown; key?: string; status?: number },
  ): Promise<T> {
    return this.request(path, (bytes) => parser(parseJson(bytes)), options);
  }

  /** Arrays are the audited catalog contract; envelopes are read completely if encountered. */
  private async list<T>(path: string, parser: Parser<T>): Promise<T[]> {
    const result: T[] = [];
    await this.pages(
      path,
      parser,
      (items) => {
        result.push(...items);
        return false;
      },
      true,
    );
    return result;
  }

  private async pages<T>(
    path: string,
    parser: Parser<T>,
    visit: (items: T[]) => boolean,
    allowArray = false,
  ): Promise<void> {
    let page = 0;
    let size = 100;
    let seen = 0;
    for (let count = 0; count < 1000; count++) {
      const separator = path.includes('?') ? '&' : '?';
      // Preserve exact bare-array catalog routes on the first request.
      const target =
        allowArray && page === 0 ? path : `${path}${separator}page=${page}&size=${size}`;
      const body = await this.json(target, (value) => value);
      if (Array.isArray(body)) {
        if (!allowArray || page !== 0 || body.length > 100000) return invalidResponse();
        visit(array(parser)(body));
        return;
      }
      const envelope = record(body);
      const items = array(parser)(envelope.items);
      const responsePage = integer(envelope.page);
      const responseSize = integer(envelope.size);
      const total = integer(envelope.total);
      if (
        responsePage !== page ||
        responseSize < 1 ||
        responseSize > 100 ||
        items.length > responseSize ||
        (page > 0 && responseSize !== size) ||
        total < page * responseSize + items.length
      )
        return invalidResponse();
      if (total > 100000) throw new ProviderError('transient', 'PAGINATION_LIMIT');
      const more = (page + 1) * responseSize < total;
      if (
        (more && items.length !== responseSize) ||
        (!items.length && total > page * responseSize)
      ) {
        throw new ProviderError('transient', 'INCOMPLETE_PAGINATION');
      }
      seen += items.length;
      if (seen > 100000) throw new ProviderError('transient', 'PAGINATION_LIMIT');
      if (visit(items) || !more) return;
      size = responseSize;
      page++;
    }
    throw new ProviderError('transient', 'PAGINATION_LIMIT');
  }

  getTenant(): Promise<Tenant> {
    return this.json('/tenants/current', tenant);
  }
  listTaxpayers(): Promise<Taxpayer[]> {
    return this.list('/taxpayers', taxpayer);
  }
  async listEstablishments(taxpayerId: string): Promise<Establishment[]> {
    const values = await this.list(
      `/taxpayers/${pathId(taxpayerId)}/establishments`,
      establishment,
    );
    if (values.some((value) => value.taxpayerId !== taxpayerId)) return invalidResponse();
    return values;
  }
  async listEmissionPoints(taxpayerId: string, establishmentId: string): Promise<EmissionPoint[]> {
    pathId(establishmentId);
    const establishments = await this.listEstablishments(taxpayerId);
    if (!establishments.some((value) => value.id === establishmentId)) {
      throw new ProviderError('data', 'ESTABLISHMENT_NOT_FOUND');
    }
    const values = await this.list(
      `/emission-points?establishmentId=${establishmentId}`,
      emissionPoint,
    );
    if (values.some((value) => value.establishmentId !== establishmentId)) return invalidResponse();
    return values;
  }
  listTaxRates(): Promise<TaxRate[]> {
    return this.list('/catalogs/tax-rates', taxRate);
  }
  async findCustomer(idType: string, idNumber: string): Promise<Customer | null> {
    if (
      typeof idType !== 'string' ||
      !/^\d{2}$/.test(idType) ||
      typeof idNumber !== 'string' ||
      !idNumber.trim() ||
      idNumber.length > 20 ||
      /[\x00-\x1f\x7f]/.test(idNumber)
    ) {
      throw new ProviderError('data', 'INVALID_CUSTOMER_IDENTITY');
    }
    let found: Customer | null = null;
    await this.pages(`/customers?q=${encodeURIComponent(idNumber)}`, customer, (items) => {
      found = items.find((value) => value.idType === idType && value.idNumber === idNumber) ?? null;
      return found !== null;
    });
    return found;
  }
  createCustomer(profile: CustomerProfile): Promise<Customer> {
    return this.json('/customers', customer, { body: profile, status: 201 });
  }
  async findProduct(sku: string): Promise<Product | null> {
    if (typeof sku !== 'string' || !/^[A-Za-z\d._-]{1,25}$/.test(sku))
      throw new ProviderError('data', 'INVALID_SKU');
    let found: Product | null = null;
    await this.pages(`/products?q=${encodeURIComponent(sku)}`, product, (items) => {
      found = items.find((value) => value.sku === sku) ?? null;
      return found !== null;
    });
    return found;
  }
  createProduct(input: ProductInput): Promise<Product> {
    return this.json('/products', product, { body: input, status: 201 });
  }
  createInvoice(body: InvoiceBody, key: string): Promise<IssuedDocument> {
    if (typeof key !== 'string' || !/^[A-Za-z\d._:-]{1,100}$/.test(key)) {
      throw new ProviderError('data', 'IDEMPOTENCY_KEY_INVALID');
    }
    return this.json('/invoices', issuedDocument, { body, key, status: 202 });
  }
  getDocument(id: string): Promise<ProviderDocument> {
    return this.json(`/documents/${pathId(id)}`, document);
  }
  getSriAttempts(id: string): Promise<SriAttempt[]> {
    return this.json(`/documents/${pathId(id)}/sri-attempts`, array(sriAttempt));
  }
  getArtifact(id: string, kind: ArtifactKind): Promise<ProviderArtifact> {
    if (
      !['xml-unsigned', 'xml-signed', 'sri-authorization', 'xml-authorized', 'ride'].includes(kind)
    ) {
      throw new ProviderError('data', 'INVALID_ARTIFACT_KIND');
    }
    return this.request(
      `/documents/${pathId(id)}/artifacts/${kind}`,
      (bytes, response) => {
        const contentType = response.headers
          .get('content-type')
          ?.split(';')[0]
          .trim()
          .toLowerCase();
        const expected = kind === 'ride' ? 'application/pdf' : 'application/xml';
        const etag = response.headers.get('etag');
        const sha256 = createHash('sha256').update(bytes).digest('hex');
        if (
          contentType !== expected ||
          !etag ||
          !/^"[a-f\d]{64}"$/.test(etag) ||
          etag !== `"${sha256}"`
        ) {
          throw new ProviderError('transient', 'INVALID_ARTIFACT');
        }
        return { bytes, contentType: expected, etag, sha256 };
      },
      { limit: 20 * 1024 * 1024 },
    );
  }
}
