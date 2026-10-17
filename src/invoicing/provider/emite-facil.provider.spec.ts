import { ConfigService } from '@nestjs/config';
import { createHash } from 'node:crypto';
import { createServer, IncomingHttpHeaders, Server, ServerResponse } from 'node:http';
import { AddressInfo } from 'node:net';
import { EmiteFacilProvider } from './emite-facil.provider';
import { DocumentState, InvoiceBody, ProviderError } from './invoicing-provider';

const taxpayerId = '11111111-1111-4111-8111-111111111111';
const customerId = '22222222-2222-4222-8222-222222222222';
const productId = '33333333-3333-4333-8333-333333333333';
const documentId = '44444444-4444-4444-8444-444444444444';
const establishmentId = '55555555-5555-4555-8555-555555555555';
const tenant = { id: taxpayerId, name: 'Test tenant', status: 'ACTIVE', role: 'BILLER' };
const customer = {
  id: customerId,
  idType: '06',
  idNumber: 'PA1234567',
  name: 'Fiscal buyer',
  email: 'buyer@example.test',
  address: 'Quito',
  phone: null,
};
const product = {
  id: productId,
  sku: 'HCX.TEST',
  name: 'Service',
  unitPrice: '40.000000',
  ivaRateCode: '0',
};
const invoice: InvoiceBody = {
  taxpayerId,
  establishmentCode: '001',
  emissionPointCode: '002',
  customerId,
  lines: [{ productId, quantity: '1', unitPrice: '40.00', discount: '0.00' }],
  payments: [{ methodCode: '01', amount: '40.00' }],
};
const document = {
  id: documentId,
  documentType: '01',
  state: 'AUTHORIZED',
  environment: '1',
  taxpayerId,
  number: '001-002-000000001',
  sequence: '000000001',
  accessKey: '1'.repeat(49),
  issueDate: '2026-10-17',
  currency: 'USD',
  customer: { idType: '06', idNumber: 'PA1234567', name: 'Fiscal buyer' },
  subtotal: '40.00',
  totalDiscount: '0.00',
  taxes: [],
  totalTax: '0.00',
  total: '40.00',
  lines: [
    {
      lineNo: 1,
      productId,
      mainCode: 'HCX.TEST',
      description: 'Service',
      quantity: '1.000000',
      unitPrice: '40.000000',
      discount: '0.00',
      subtotal: '40.00',
      taxCode: '2',
      taxRateCode: '0',
      taxRate: '0.00',
      taxAmount: '0.00',
    },
  ],
  payments: [{ methodCode: '01', amount: '40.00' }],
  authorizationNumber: '1'.repeat(49),
  authorizedAt: '2026-10-17T15:00:00Z',
  customerId,
  replacesDocumentId: null,
  replacedByDocumentId: null,
};

describe('EmiteFacilProvider HTTP contract', () => {
  let server: Server;
  let baseUrl: string;
  let captured: { path: string; method: string; headers: IncomingHttpHeaders; body: string }[];
  let respond: (path: URL, response: ServerResponse, body: string) => void;

  const json = (response: ServerResponse, body: unknown, status = 200) => {
    response.writeHead(status, { 'content-type': 'application/json' });
    response.end(JSON.stringify(body));
  };
  const factory = (url = baseUrl) =>
    new EmiteFacilProvider({
      get: (name: string) => (name === 'EMITE_FACIL_API_URL' ? url : undefined),
    } as unknown as ConfigService);

  beforeEach(async () => {
    captured = [];
    respond = (_path, response) => json(response, tenant);
    server = createServer((request, response) => {
      const chunks: Buffer[] = [];
      request.on('data', (chunk: Buffer) => chunks.push(chunk));
      request.on('end', () => {
        const body = Buffer.concat(chunks).toString('utf8');
        captured.push({
          path: request.url!,
          method: request.method!,
          headers: request.headers,
          body,
        });
        respond(new URL(request.url!, 'http://localhost'), response, body);
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/v1`;
  });

  afterEach(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  });

  it('issues the minimum real JSON request with API key and stable idempotency key', async () => {
    respond = (_path, response) =>
      json(
        response,
        { id: documentId, state: 'RESERVED', statusUrl: `/api/v1/documents/${documentId}` },
        202,
      );
    const result = await factory()
      .client('opaque-test-key', 'hcx-correlation')
      .createInvoice(invoice, 'hcx-test');
    expect(result).toEqual({
      id: documentId,
      state: 'RESERVED',
      statusUrl: `/api/v1/documents/${documentId}`,
    });
    expect(captured[0].path).toBe('/api/v1/invoices');
    expect(captured[0].method).toBe('POST');
    expect(captured[0].headers['x-api-key']).toBe('opaque-test-key');
    expect(captured[0].headers['idempotency-key']).toBe('hcx-test');
    expect(captured[0].headers.authorization).toBeUndefined();
    expect(captured[0].headers['x-correlation-id']).toBe('hcx-correlation');
    expect(JSON.parse(captured[0].body)).toEqual(invoice);
  });

  it('isolates API keys between clients of the same injectable factory', async () => {
    const provider = factory();
    const a = provider.client('key-one');
    const b = provider.client('key-two');
    await b.getTenant();
    await a.getTenant();
    expect(captured.map((request) => request.headers['x-api-key'])).toEqual(['key-two', 'key-one']);
  });

  it('allows an unconfigured application to boot but rejects client creation safely', () => {
    const provider = factory('');
    expect(provider).toBeInstanceOf(EmiteFacilProvider);
    expect(() => provider.client('test')).toThrow(ProviderError);
  });

  it('preserves the configured proxy root and the single API prefix', async () => {
    await factory(`${baseUrl.replace('/api/v1', '')}/proxy/api/v1/`)
      .client('test')
      .getTenant();
    expect(captured[0].path).toBe('/proxy/api/v1/tenants/current');
  });

  it.each([
    '',
    'not a url',
    'ftp://localhost/api/v1',
    'https://user:secret@example.test/api/v1',
    'https://example.test/api/v1?key=secret',
    'https://example.test/api/v1#secret',
    'https://example.test',
    'https://example.test/api/v1/api/v1',
  ])('rejects unsafe or unprefixed base URL %s', (url) => {
    expect(() => factory(url).client('test')).toThrow(ProviderError);
    expect(captured).toHaveLength(0);
  });

  it('uses exact array option routes and keeps leading zero codes', async () => {
    const taxpayer = {
      id: taxpayerId,
      ruc: '1234567890001',
      legalName: 'Issuer',
      tradeName: null,
      headOfficeAddress: 'Quito',
      defaultEnvironment: '1',
      accountingRequired: false,
      specialTaxpayerCode: null,
      withholdingAgentCode: null,
      rimpeRegime: 'NONE',
      productionEnabledAt: null,
    };
    const establishment = { id: establishmentId, taxpayerId, code: '001', address: 'Quito' };
    const point = { id: documentId, establishmentId, code: '002', enabled: true };
    const rate = { taxCode: '2', rateCode: '4', description: '15%', rate: '15.00' };
    respond = (path, response) => {
      if (path.pathname.endsWith('/taxpayers')) return json(response, [taxpayer]);
      if (path.pathname.endsWith('/establishments')) return json(response, [establishment]);
      if (path.pathname.endsWith('/emission-points')) return json(response, [point]);
      json(response, [rate]);
    };
    const client = factory().client('test');
    expect(await client.listTaxpayers()).toEqual([taxpayer]);
    expect(await client.listEstablishments(taxpayerId)).toEqual([establishment]);
    expect(await client.listEmissionPoints(taxpayerId, establishmentId)).toEqual([point]);
    expect(await client.listTaxRates()).toEqual([rate]);
    expect(
      captured.some(
        (request) => request.path === `/api/v1/emission-points?establishmentId=${establishmentId}`,
      ),
    ).toBe(true);
  });

  it('fully reads option envelopes if a deployment paginates them', async () => {
    respond = (path, response) =>
      json(response, {
        items: [
          {
            taxCode: '2',
            rateCode: path.searchParams.get('page') === '1' ? '4' : '0',
            description: 'Rate',
            rate: '0.00',
          },
        ],
        page: Number(path.searchParams.get('page') || 0),
        size: 1,
        total: 2,
      });
    expect((await factory().client('test').listTaxRates()).map((rate) => rate.rateCode)).toEqual([
      '0',
      '4',
    ]);
    expect(captured).toHaveLength(2);
  });

  it('matches customer identity exactly across pages without changing existing fiscal data', async () => {
    respond = (path, response) =>
      json(response, {
        items:
          Number(path.searchParams.get('page')) === 0
            ? [
                { ...customer, idType: '04' },
                { ...customer, idNumber: 'PA12345678' },
              ]
            : [customer],
        page: Number(path.searchParams.get('page')),
        size: 2,
        total: 3,
      });
    expect(await factory().client('test').findCustomer('06', 'PA1234567')).toEqual(customer);
    expect(
      captured.map((request) => new URL(request.path, baseUrl).searchParams.get('page')),
    ).toEqual(['0', '1']);
    expect(captured.every((request) => request.method === 'GET')).toBe(true);
    expect(new URL(captured[0].path, baseUrl).searchParams.get('q')).toBe('PA1234567');
  });

  it('matches SKU exactly across pages and escapes the query', async () => {
    respond = (path, response) =>
      json(response, {
        items:
          Number(path.searchParams.get('page')) === 0
            ? [{ ...product, sku: 'HCX.TEST.extra' }]
            : [product],
        page: Number(path.searchParams.get('page')),
        size: 1,
        total: 2,
      });
    expect(await factory().client('test').findProduct('HCX.TEST')).toEqual(product);
    expect(captured).toHaveLength(2);
  });

  it('returns null only after all customer/product pages have no exact match', async () => {
    respond = (path, response) =>
      json(response, {
        items: path.pathname.endsWith('/customers')
          ? [{ ...customer, idNumber: 'PA12345678' }]
          : [{ ...product, sku: 'HCX.TEST.extra' }],
        page: Number(path.searchParams.get('page')),
        size: 1,
        total: 2,
      });
    const client = factory().client('test');
    expect(await client.findCustomer('06', 'PA1234567')).toBeNull();
    expect(await client.findProduct('HCX.TEST')).toBeNull();
    expect(captured).toHaveLength(4);
  });

  it.each([
    { items: [], page: 0, size: 100, total: 200 },
    { items: [customer], page: 1, size: 100, total: 1 },
    { items: [customer], page: 0, size: 0, total: 1 },
    { items: [customer], page: 0, size: 100, total: 100001 },
  ])('fails closed on incomplete, malformed or bounded pagination %#', async (body) => {
    respond = (_path, response) => json(response, body);
    await expect(factory().client('test').findCustomer('07', 'absent')).rejects.toBeInstanceOf(
      ProviderError,
    );
  });

  it('creates customers and products only with the current POST contract', async () => {
    respond = (path, response) =>
      json(response, path.pathname.endsWith('/customers') ? customer : product, 201);
    const client = factory().client('test');
    const profile = {
      idType: '06',
      idNumber: 'PA1234567',
      name: 'Fiscal buyer',
      email: 'buyer@example.test',
    };
    expect(await client.createCustomer(profile)).toEqual(customer);
    expect(
      await client.createProduct({
        sku: 'HCX.TEST',
        name: 'Service',
        unitPrice: '40',
        ivaRateCode: '0',
      }),
    ).toEqual(product);
    expect(captured.map((request) => request.method)).toEqual(['POST', 'POST']);
    expect(JSON.parse(captured[0].body)).toEqual(profile);
  });

  it.each<DocumentState>([
    'RESERVED',
    'GENERATED',
    'SIGNED',
    'SENDING',
    'RECEIVED',
    'AUTHORIZED',
    'XSD_INVALID',
    'SIGNATURE_FAILED',
    'RETURNED',
    'NOT_AUTHORIZED',
  ])('parses full document detail and state %s', async (state) => {
    respond = (_path, response) =>
      json(response, {
        ...document,
        state,
        authorizationNumber: state === 'AUTHORIZED' ? document.authorizationNumber : null,
        authorizedAt: state === 'AUTHORIZED' ? document.authorizedAt : null,
      });
    const result = await factory().client('test').getDocument(documentId);
    expect(result.state).toBe(state);
    expect(result.lines[0].quantity).toBe('1.000000');
    expect(result.sequence).toBe('000000001');
    expect(captured[0].path).toBe(`/api/v1/documents/${documentId}`);
  });

  it.each([
    { ...document, state: '' },
    { ...document, total: 40 },
    { ...document, lines: [{}] },
  ])('rejects malformed document contracts instead of casting JSON %#', async (body) => {
    respond = (_path, response) => json(response, body);
    await expect(factory().client('test').getDocument(documentId)).rejects.toMatchObject({
      kind: 'transient',
      code: 'INVALID_RESPONSE',
    });
  });

  it('preserves a bounded unknown provider state for conservative core reconciliation', async () => {
    respond = (_path, response) => json(response, { ...document, state: 'FUTURE_STATE' });
    expect((await factory().client('test').getDocument(documentId)).state).toBe('FUTURE_STATE');
  });

  it('returns authorized fiscal SRI explanation content using the exact attempts route', async () => {
    const attempts = [
      {
        id: documentId,
        operation: 'RECEPTION',
        outcome: 'RETURNED',
        sriStatus: 'DEVUELTA',
        httpStatus: 200,
        startedAt: '2026-10-17T15:00:00Z',
        completedAt: '2026-10-17T15:00:01Z',
        messages: [
          {
            identifier: '70',
            message: 'CLAVE DE ACCESO EN PROCESAMIENTO',
            additionalInfo: 'Detalle fiscal del SRI',
            type: 'ERROR',
          },
        ],
      },
      {
        id: customerId,
        operation: 'AUTHORIZATION',
        outcome: null,
        sriStatus: null,
        httpStatus: null,
        startedAt: '2026-10-17T14:00:00Z',
        completedAt: null,
        messages: [],
      },
    ];
    respond = (_path, response) => json(response, attempts);
    expect(await factory().client('test').getSriAttempts(documentId)).toEqual(attempts);
    expect(captured[0].path).toBe(`/api/v1/documents/${documentId}/sri-attempts`);
  });

  it.each([123, 'x'.repeat(4001)])(
    'rejects invalid or unbounded SRI explanation strings %#',
    async (message) => {
      respond = (_path, response) =>
        json(response, [
          {
            id: documentId,
            operation: 'RECEPTION',
            outcome: 'RETURNED',
            sriStatus: 'DEVUELTA',
            httpStatus: 200,
            startedAt: '2026-10-17T15:00:00Z',
            completedAt: null,
            messages: [{ identifier: '70', message, additionalInfo: null, type: 'ERROR' }],
          },
        ]);
      await expect(factory().client('test').getSriAttempts(documentId)).rejects.toMatchObject({
        kind: 'transient',
        code: 'INVALID_RESPONSE',
      });
    },
  );

  it('downloads raw artifact bytes and preserves the quoted SHA-256 ETag', async () => {
    const bytes = Buffer.from('%PDF-test\u0000');
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    respond = (_path, response) => {
      response.writeHead(200, { 'content-type': 'application/pdf', etag: `"${sha256}"` });
      response.end(bytes);
    };
    const result = await factory().client('test').getArtifact(documentId, 'ride');
    expect(result).toEqual({ bytes, contentType: 'application/pdf', etag: `"${sha256}"`, sha256 });
    expect(captured[0].path).toBe(`/api/v1/documents/${documentId}/artifacts/ride`);
  });

  it.each(['xml-unsigned', 'xml-signed', 'sri-authorization', 'xml-authorized'] as const)(
    'downloads %s as XML',
    async (kind) => {
      const bytes = Buffer.from('<xml/>');
      respond = (_path, response) => {
        response.writeHead(200, {
          'content-type': 'application/xml',
          etag: `"${createHash('sha256').update(bytes).digest('hex')}"`,
        });
        response.end(bytes);
      };
      expect((await factory().client('test').getArtifact(documentId, kind)).bytes).toEqual(bytes);
    },
  );

  it.each(['missing', 'unquoted', 'weak', 'mismatch', 'wrong-media'])(
    'rejects unverifiable artifact %s',
    async (variant) => {
      const hash = createHash('sha256').update('bytes').digest('hex');
      respond = (_path, response) => {
        response.writeHead(200, {
          'content-type': variant === 'wrong-media' ? 'text/html' : 'application/pdf',
          ...(variant === 'missing'
            ? {}
            : {
                etag:
                  variant === 'unquoted'
                    ? hash
                    : variant === 'weak'
                      ? `W/"${hash}"`
                      : variant === 'mismatch'
                        ? `"${'0'.repeat(64)}"`
                        : `"${hash}"`,
              }),
        });
        response.end('bytes');
      };
      await expect(factory().client('test').getArtifact(documentId, 'ride')).rejects.toMatchObject({
        kind: 'transient',
        code: 'INVALID_ARTIFACT',
      });
    },
  );

  it.each([
    [401, 'UNAUTHENTICATED', 'configuration', 'UNAUTHENTICATED'],
    [403, 'ROLE_FORBIDDEN', 'configuration', 'ROLE_FORBIDDEN'],
    [404, 'NOT_FOUND', 'data', 'NOT_FOUND'],
    [422, 'INVALID_ISSUE_DATE', 'data', 'INVALID_ISSUE_DATE'],
    [409, 'IDEMPOTENCY_KEY_REUSED', 'data', 'IDEMPOTENCY_KEY_REUSED'],
    [409, 'IDEMPOTENCY_IN_PROGRESS', 'transient', 'IDEMPOTENCY_IN_PROGRESS'],
    [409, 'CUSTOMER_ALREADY_EXISTS', 'data', 'CUSTOMER_ALREADY_EXISTS'],
    [409, 'PRODUCT_SKU_TAKEN', 'data', 'PRODUCT_SKU_TAKEN'],
    [429, 'RATE_LIMITED', 'transient', 'RATE_LIMITED'],
    [503, 'INTERNAL_ERROR', 'transient', 'PROVIDER_UNAVAILABLE'],
  ])(
    'classifies HTTP %s/%s without retaining response bodies',
    async (status: number, errorCode: string, kind: string, code: string) => {
      respond = (_path, response) =>
        json(
          response,
          {
            errorCode,
            detail: 'secret-key buyer@example.test',
            errors: [{ field: 'name', message: 'private name' }],
          },
          status,
        );
      const error: ProviderError = (await factory()
        .client('secret-key')
        .getTenant()
        .catch((caught: ProviderError) => caught)) as ProviderError;
      expect(error).toMatchObject({ kind, code, status });
      expect(error).toBeInstanceOf(ProviderError);
      expect(JSON.stringify(error) + error.message + error.stack).not.toMatch(
        /secret-key|buyer@example|private name/,
      );
      expect(error.cause).toBeUndefined();
    },
  );

  it('does not trust arbitrary upstream errorCode text as safe metadata', async () => {
    respond = (_path, response) => json(response, { errorCode: 'BUYER_SECRET_KEY' }, 422);
    await expect(factory().client('test').getTenant()).rejects.toMatchObject({
      code: 'VALIDATION_FAILED',
    });
  });

  it('parses Retry-After seconds', async () => {
    respond = (_path, response) => {
      response.writeHead(429, { 'retry-after': '12' });
      response.end('private error');
    };
    await expect(factory().client('test').getTenant()).rejects.toMatchObject({
      kind: 'transient',
      retryAfterMs: 12000,
    });
  });

  it('parses Retry-After HTTP dates', async () => {
    respond = (_path, response) => {
      response.writeHead(429, { 'retry-after': new Date(Date.now() + 30000).toUTCString() });
      response.end();
    };
    const error = (await factory()
      .client('test')
      .getTenant()
      .catch((caught: ProviderError) => caught)) as ProviderError;
    expect(error.retryAfterMs).toBeGreaterThan(28000);
    expect(error.retryAfterMs).toBeLessThanOrEqual(30000);
  });

  it('rejects redirects without forwarding the API key', async () => {
    const destinationRequests: string[] = [];
    const destination = createServer((request, response) => {
      destinationRequests.push(request.url!);
      response.end('{}');
    });
    await new Promise<void>((resolve) => destination.listen(0, '127.0.0.1', resolve));
    try {
      respond = (_path, response) => {
        response.writeHead(302, {
          location: `http://127.0.0.1:${(destination.address() as AddressInfo).port}/stolen`,
        });
        response.end();
      };
      await expect(factory().client('secret-key').getTenant()).rejects.toMatchObject({
        kind: 'configuration',
        code: 'REDIRECT_REJECTED',
      });
      expect(destinationRequests).toEqual([]);
    } finally {
      destination.closeAllConnections();
      await new Promise<void>((resolve) => destination.close(() => resolve()));
    }
  });

  it('converts transport failure into a safe transient error', async () => {
    respond = (_path, response) => response.destroy(new Error('private network error'));
    await expect(factory().client('secret-key').getTenant()).rejects.toMatchObject({
      kind: 'transient',
      code: 'NETWORK_ERROR',
    });
  });

  it('aborts a stalled response body after fifteen seconds', async () => {
    respond = (_path, response) => {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.write('{');
    };
    const start = Date.now();
    await expect(factory().client('test').getTenant()).rejects.toMatchObject({
      kind: 'transient',
      code: 'TIMEOUT',
    });
    expect(Date.now() - start).toBeGreaterThanOrEqual(14500);
    expect(Date.now() - start).toBeLessThan(17500);
  }, 20000);
});
