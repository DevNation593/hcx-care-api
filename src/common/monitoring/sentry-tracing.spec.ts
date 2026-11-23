import type { Event } from '@sentry/nestjs';
import {
  buildTracesSampler,
  FLUSH_WAIT_LIMIT_MS,
  flushTransactionAfterResponse,
  isUntracedPath,
  maskIdentifiers,
  parseTracesSampleRate,
  scrubSamplingMetadata,
  scrubTransaction,
} from './sentry-tracing';
import { flushReports } from './error-reporter';

jest.mock('./error-reporter', () => ({
  flushReports: jest.fn().mockResolvedValue(undefined),
}));

const PATIENT_ID = '3f2b8c1e-9a4d-4e6f-8b7a-1c2d3e4f5a6b';
const EMAIL = 'ana.perez@example.com';
const CEDULA = '0912345678';

/** What the SDK builds for a request, with every kind of data that must not leave the API. */
function sensitiveTransaction(overrides: Partial<Event> = {}): Event {
  return {
    type: 'transaction',
    event_id: 'evt1',
    start_timestamp: 1000,
    timestamp: 1001.5,
    platform: 'node',
    environment: 'production',
    release: 'abc123',
    server_name: 'lambda-host-internal',
    modules: { express: '5.0.0' },
    transaction: 'GET /api/v1/patients/:patientId',
    transaction_info: { source: 'route' },
    user: { id: 'u1', email: EMAIL, ip_address: '203.0.113.9', username: 'Ana Perez' },
    tags: { tenantId: 't1', search: `paciente ${EMAIL}` },
    extra: { body: { name: 'Ana Perez', cedula: CEDULA } },
    breadcrumbs: [{ message: `GET /patients/${PATIENT_ID}` }],
    request: {
      method: 'GET',
      url: `https://api.example.com/api/v1/patients/${PATIENT_ID}?search=${EMAIL}`,
      query_string: `search=${EMAIL}&cedula=${CEDULA}`,
      headers: { authorization: 'Bearer secret-jwt', cookie: 'refresh=secret-cookie' },
      cookies: { refresh: 'secret-cookie' },
      data: { name: 'Ana Perez', cedula: CEDULA },
    },
    contexts: {
      trace: {
        trace_id: 'a'.repeat(32),
        span_id: 'b'.repeat(16),
        op: 'http.server',
        status: 'ok',
        origin: 'auto.http.otel.http',
        data: {
          'sentry.op': 'http.server',
          'sentry.source': 'route',
          'url.full': `https://api.example.com/api/v1/patients/${PATIENT_ID}?search=${EMAIL}`,
          'url.path': `/api/v1/patients/${PATIENT_ID}`,
          'http.url': `https://api.example.com/api/v1/patients/${PATIENT_ID}`,
          'http.target': `/api/v1/patients/${PATIENT_ID}?search=${EMAIL}`,
          'http.client_ip': '203.0.113.9',
          'http.user_agent': 'Mozilla/5.0 (Ana Perez laptop)',
          'http.query': `search=${EMAIL}`,
          'http.request.header.authorization': 'Bearer secret-jwt',
          'http.request.header.cookie.refresh': 'secret-cookie',
          'net.peer.ip': '10.0.0.7',
          'http.method': 'GET',
          'http.route': '/api/v1/patients/:patientId',
          'http.response.status_code': 200,
        },
      },
      response: { status_code: 200, headers: { 'set-cookie': 'refresh=secret-cookie' } },
      runtime: { name: 'node', version: 'v22.0.0', raw_description: 'node secret' },
      device: { name: 'lambda-host-internal', memory_size: 1024 },
      os: { name: 'Linux', kernel_version: '5.10' },
      cloud_resource: { 'cloud.provider': 'vercel' },
    },
    measurements: { 'custom.metric': { value: 1, unit: 'none' } },
    sdkProcessingMetadata: {
      normalizedRequest: { headers: { authorization: 'Bearer secret-jwt' } },
      dynamicSamplingContext: {
        trace_id: 'a'.repeat(32),
        public_key: 'pk',
        sample_rate: '0.1',
        sampled: 'true',
        transaction: `GET /api/v1/patients/${PATIENT_ID}`,
        user_segment: EMAIL,
      },
    },
    spans: [
      {
        span_id: 'c'.repeat(16),
        trace_id: 'a'.repeat(32),
        parent_span_id: 'b'.repeat(16),
        start_timestamp: 1000.1,
        timestamp: 1001.2,
        op: 'db',
        origin: 'auto.db.otel.prisma',
        status: 'ok',
        description: `SELECT "Patient"."id" FROM "Patient" WHERE "email" = '${EMAIL}' AND "cedula" = '${CEDULA}'`,
        data: {
          'db.system': 'postgresql',
          'db.query.text': `SELECT "Patient"."id" FROM "Patient" WHERE "email" = '${EMAIL}'`,
          'db.statement': `SELECT * FROM "Patient" WHERE "cedula" = '${CEDULA}'`,
          'db.query.params': JSON.stringify([EMAIL, CEDULA]),
          'sentry.op': 'db',
        },
      },
      {
        span_id: 'd'.repeat(16),
        trace_id: 'a'.repeat(32),
        parent_span_id: 'b'.repeat(16),
        start_timestamp: 1000.0,
        timestamp: 1001.3,
        origin: 'auto.db.otel.prisma',
        description: 'prisma:client:operation',
        data: { method: 'findMany', model: 'Patient', args: `{"where":{"email":"${EMAIL}"}}` },
      },
      {
        span_id: 'e'.repeat(16),
        trace_id: 'a'.repeat(32),
        parent_span_id: 'b'.repeat(16),
        start_timestamp: 1000.0,
        timestamp: 1000.5,
        op: 'http.client',
        description: `GET https://storage.example.com/object/patients/${PATIENT_ID}/consent.pdf?token=secret-token`,
        data: {
          'url.full': `https://storage.example.com/object/patients/${PATIENT_ID}/consent.pdf?token=secret-token`,
          'http.response.status_code': 200,
        },
      },
      {
        span_id: 'f'.repeat(16),
        trace_id: 'a'.repeat(32),
        parent_span_id: 'b'.repeat(16),
        start_timestamp: 1000.0,
        timestamp: 1000.1,
        op: 'db.redis',
        description: `GET session:${CEDULA}:${EMAIL}`,
        data: { 'db.system': 'redis', 'db.statement': `GET session:${CEDULA}` },
      },
      {
        span_id: '1'.repeat(16),
        trace_id: 'a'.repeat(32),
        parent_span_id: 'b'.repeat(16),
        start_timestamp: 1000.0,
        timestamp: 1000.1,
        op: 'request_handler.express',
        origin: 'auto.http.express',
        description: `/api/v1/patients/${PATIENT_ID}`,
        data: { 'express.type': 'request_handler', 'http.route': '/api/v1/patients/:patientId' },
      },
    ],
    ...overrides,
  } as Event;
}

const SENSITIVE_VALUES = [
  PATIENT_ID,
  EMAIL,
  CEDULA,
  'Ana Perez',
  '203.0.113.9',
  '10.0.0.7',
  'secret-jwt',
  'secret-cookie',
  'secret-token',
  'authorization',
  'cookie',
  'search=',
  'cedula',
  'SELECT',
  'FROM "Patient"',
  'consent.pdf',
  'lambda-host-internal',
  'user_segment',
  'Mozilla',
];

describe('parseTracesSampleRate', () => {
  it.each([
    ['0.1', 0.1],
    ['0.05', 0.05],
    [' 0.5 ', 0.5],
    ['1', 1],
    ['1.0', 1],
    ['.25', 0.25],
  ])('accepts %p', (raw, expected) => {
    expect(parseTracesSampleRate(raw)).toBe(expected);
  });

  it.each([
    undefined,
    '',
    '   ',
    '0',
    'abc',
    '-0.1',
    '1.5',
    '2',
    '10',
    'NaN',
    'Infinity',
    '1e-1',
    '0x1',
    '5%',
    '0,1',
  ])('turns %p into 0 (tracing off)', (raw) => {
    expect(parseTracesSampleRate(raw)).toBe(0);
  });
});

describe('isUntracedPath', () => {
  it.each([
    '/health',
    '/api/v1/health',
    '/api/v1/internal/invoicing/tick',
    '/api/v1/internal/invoicing/tick?x=1',
    '/api/v1/docs',
    '/api/v1/docs/',
    '/api/v1/docs-json',
    '/api/v1/docs/swagger-ui.css',
    '/docs',
    // Express routes without distinguishing case and ignores repeated and trailing slashes.
    '/API/V1/HEALTH',
    '/api/v1//health',
    '//health',
    '/api/v1/health/',
    '/api/v1/Internal/invoicing/tick',
    '/api/v1/INTERNAL//invoicing/tick',
    '/api/v1/DOCS',
    '/api/v1/Docs-Json',
    '/api/v1/%64ocs',
  ])('skips %s', (path) => {
    expect(isUntracedPath(path)).toBe(true);
  });

  it.each([
    '/api/v1/patients/abc',
    '/api/v1/auth/login',
    '/api/v1/record-documents/1',
    '/api/v1/healthcare',
    '/api/v1/patients?search=health',
    '/api/v1/patients/%E0%A4%A',
  ])('traces %s', (path) => {
    expect(isUntracedPath(path)).toBe(false);
  });
});

describe('buildTracesSampler', () => {
  const requestContext = (path: string, overrides: Record<string, unknown> = {}) =>
    ({
      name: `GET ${path}`,
      attributes: { 'sentry.op': 'http.server', 'url.path': path },
      inheritOrSampleWith: (fallback: number) => fallback,
      ...overrides,
    }) as Parameters<ReturnType<typeof buildTracesSampler>>[0];

  const withRandom = (value: number, run: () => void) => {
    const spy = jest.spyOn(Math, 'random').mockReturnValue(value);
    try {
      run();
    } finally {
      spy.mockRestore();
    }
  };

  it('decides with Math.random against the rate and answers a boolean', () => {
    const sampler = buildTracesSampler(0.1);
    const context = requestContext(`/api/v1/patients/${PATIENT_ID}`);

    withRandom(0.01, () => expect(sampler(context)).toBe(true));
    withRandom(0.09, () => expect(sampler(context)).toBe(true));
    withRandom(0.1, () => expect(sampler(context)).toBe(false));
    withRandom(0.9, () => expect(sampler(context)).toBe(false));
  });

  it('samples every request at rate 1', () => {
    withRandom(0.999999, () =>
      expect(buildTracesSampler(1)(requestContext('/api/v1/x'))).toBe(true),
    );
  });

  it.each(['/health', '/api/v1/internal/invoicing/tick', '/api/v1/docs', '/api/v1/docs-json'])(
    'never samples %s',
    (path) => {
      withRandom(0, () => expect(buildTracesSampler(1)(requestContext(path))).toBe(false));
    },
  );

  it('falls back to the span name when the path attribute is missing', () => {
    const sampler = buildTracesSampler(1);
    const context = (name: string) =>
      ({ name, attributes: { 'sentry.op': 'http.server' } }) as Parameters<typeof sampler>[0];

    expect(sampler(context('GET /health'))).toBe(false);
    expect(sampler(context('GET /api/v1/patients/1'))).toBe(true);
  });

  it('never samples spans that are not an incoming request', () => {
    const sampler = buildTracesSampler(1);

    withRandom(0, () => {
      expect(sampler({ name: 'prisma:client:operation', attributes: {} } as never)).toBe(false);
      expect(
        sampler({ name: 'queue', attributes: { 'sentry.op': 'queue.process' } } as never),
      ).toBe(false);
      expect(sampler({ name: 'x' } as never)).toBe(false);
    });
  });

  it('ignores the decision, the rate and the sample_rand of the incoming trace', () => {
    const sampler = buildTracesSampler(0.05);
    const forged = {
      parentSampled: true,
      parentSampleRate: 1,
      normalizedRequest: { headers: { baggage: 'sentry-sample_rand=0' } },
    };

    withRandom(0.9, () => expect(sampler(requestContext('/api/v1/patients', forged))).toBe(false));
    withRandom(0.01, () => expect(sampler(requestContext('/api/v1/patients', forged))).toBe(true));
    withRandom(0.9, () =>
      expect(sampler(requestContext('/api/v1/patients', { parentSampled: false }))).toBe(false),
    );
  });

  it('samples nothing at rate 0, not even a forced incoming trace', () => {
    const sampler = buildTracesSampler(0);

    withRandom(0, () =>
      expect(sampler(requestContext('/api/v1/patients', { parentSampled: true }))).toBe(0),
    );
  });
});

describe('maskIdentifiers', () => {
  it('masks uuids, emails and long numbers', () => {
    expect(maskIdentifiers(`/patients/${PATIENT_ID}/x/${CEDULA}/${EMAIL}`)).toBe(
      '/patients/:id/x/:id/:email',
    );
    expect(maskIdentifiers('GET /api/v1/patients/:patientId')).toBe(
      'GET /api/v1/patients/:patientId',
    );
  });

  it.each([
    ['/x/099-123-4567', '/x/:id'],
    ['/x/+593 99 123 4567', '/x/:id'],
    ['/x/+593-99-123-4567/y', '/x/:id/y'],
    ['/x/(02) 234-5678', '/x/:id'],
    ['/x/0912.345.678', '/x/:id'],
    ['/x/091 234 5678?q=1', '/x/:id?q=1'],
    ['/x/1.234.567.890', '/x/:id'],
  ])('masks the whole number with separators in %s', (input, expected) => {
    expect(maskIdentifiers(input)).toBe(expected);
  });

  it.each([
    'GET /api/v1/patients/:patientId',
    'node v22.1.0',
    'version 1.2.3',
    'status 200 in 1.5s',
    'HTTP/1.1 404',
    '/api/v1/orders/2/items/3',
    'took 12.3 ms',
  ])('does not over-mask %s', (input) => {
    expect(maskIdentifiers(input)).toBe(input);
  });
});

describe('scrubSamplingMetadata', () => {
  it('keeps only the allowed keys of the dynamic sampling context and drops the rest', () => {
    const event = {
      sdkProcessingMetadata: {
        normalizedRequest: { headers: { authorization: 'Bearer secret-jwt' } },
        capturedSpanIsolationScope: { _user: { email: EMAIL } },
        dynamicSamplingContext: {
          trace_id: 'a'.repeat(32),
          public_key: 'pk',
          sample_rate: '1',
          sample_rand: '0.3',
          sampled: 'true',
          release: 'abc',
          environment: 'production',
          org_id: '1',
          transaction: `GET /api/v1/patients/${PATIENT_ID}`,
          user_segment: EMAIL,
          replay_id: 'r1',
        },
      },
    } as unknown as Event;

    scrubSamplingMetadata(event);

    expect(event.sdkProcessingMetadata).toEqual({
      dynamicSamplingContext: {
        trace_id: 'a'.repeat(32),
        public_key: 'pk',
        sample_rate: '1',
        sample_rand: '0.3',
        sampled: 'true',
        release: 'abc',
        environment: 'production',
        org_id: '1',
      },
    });
    expect(JSON.stringify(event)).not.toContain(PATIENT_ID);
  });

  it('removes the metadata when there is no sampling context', () => {
    const event = {
      sdkProcessingMetadata: { normalizedRequest: { url: `/patients/${PATIENT_ID}` } },
    } as unknown as Event;

    scrubSamplingMetadata(event);

    expect(event.sdkProcessingMetadata).toBeUndefined();
  });
});

describe('scrubTransaction', () => {
  it('keeps no sensitive value anywhere in the transaction', () => {
    const result = scrubTransaction(sensitiveTransaction());
    const text = JSON.stringify(result);

    for (const value of SENSITIVE_VALUES) expect(text).not.toContain(value);
  });

  it('keeps the parametrized name, duration, op, status and the Prisma model', () => {
    const result = scrubTransaction(sensitiveTransaction())!;

    expect(result.transaction).toBe('GET /api/v1/patients/:patientId');
    expect(result.transaction_info).toEqual({ source: 'route' });
    expect([result.start_timestamp, result.timestamp]).toEqual([1000, 1001.5]);
    expect(result.contexts?.trace).toMatchObject({
      op: 'http.server',
      status: 'ok',
      origin: 'auto.http.otel.http',
    });
    expect(result.contexts?.trace?.data).toEqual({
      'sentry.op': 'http.server',
      'sentry.source': 'route',
      'http.method': 'GET',
      'http.route': '/api/v1/patients/:patientId',
      'http.response.status_code': 200,
    });
    expect(result.contexts?.response).toEqual({ status_code: 200 });
    expect(result.request).toEqual({ method: 'GET' });
    expect(result.release).toBe('abc123');
    expect(result.measurements).toEqual({ 'custom.metric': { value: 1, unit: 'none' } });
  });

  it('removes user, tags, extra, breadcrumbs, server name, modules and other contexts', () => {
    const result = scrubTransaction(sensitiveTransaction())! as Record<string, unknown>;

    for (const key of ['user', 'tags', 'extra', 'breadcrumbs', 'server_name', 'modules']) {
      expect(result[key]).toBeUndefined();
    }
    expect(Object.keys(result.contexts as object).sort()).toEqual(['response', 'runtime', 'trace']);
    expect(result.contexts).toMatchObject({ runtime: { name: 'node', version: 'v22.0.0' } });
  });

  it('keeps the dynamic sampling context without the transaction name', () => {
    const result = scrubTransaction(sensitiveTransaction())!;

    expect(result.sdkProcessingMetadata).toEqual({
      dynamicSamplingContext: {
        trace_id: 'a'.repeat(32),
        public_key: 'pk',
        sample_rate: '0.1',
        sampled: 'true',
      },
    });
  });

  it('strips the SQL and its parameters from database spans but keeps time and Prisma operation', () => {
    const spans = scrubTransaction(sensitiveTransaction())!.spans!;

    const query = spans[0];
    expect(query.description).toBe('prisma:engine:db_query');
    expect(query.op).toBe('db');
    expect(query.status).toBe('ok');
    expect([query.start_timestamp, query.timestamp]).toEqual([1000.1, 1001.2]);
    expect(query.data).toEqual({ 'db.system': 'postgresql', 'sentry.op': 'db' });

    const operation = spans[1];
    expect(operation.description).toBe('prisma:client:operation');
    expect(operation.data).toEqual({ method: 'findMany', model: 'Patient' });

    const redis = spans[3];
    expect(redis.description).toBe('db.redis');
    expect(redis.data).toEqual({ 'db.system': 'redis' });
  });

  it('reduces an outgoing request to its method and host', () => {
    const outgoing = scrubTransaction(sensitiveTransaction())!.spans![2];

    expect(outgoing.description).toBe('GET storage.example.com');
    expect(outgoing.data).toEqual({ 'http.response.status_code': 200 });
  });

  it('keeps handler spans with their route pattern', () => {
    const handler = scrubTransaction(sensitiveTransaction())!.spans![4];

    // The fixture holds a raw path on purpose: the mask is the last line of defense.
    expect(handler.description).toBe('/api/v1/patients/:id');
    expect(handler.data).toEqual({
      'express.type': 'request_handler',
      'http.route': '/api/v1/patients/:patientId',
    });
  });

  describe('transaction name', () => {
    it('never keeps a raw path when no route matched (source url)', () => {
      const result = scrubTransaction(
        sensitiveTransaction({
          transaction: `POST /api/v1/patients/${PATIENT_ID}/notes`,
          transaction_info: { source: 'url' },
        }),
      )!;

      expect(result.transaction).toBe('POST <unmatched route>');
      expect(JSON.stringify(result)).not.toContain(PATIENT_ID);
    });

    it('does not trust a custom name either', () => {
      const result = scrubTransaction(
        sensitiveTransaction({
          transaction: `GET /patients/${PATIENT_ID}`,
          transaction_info: { source: 'custom' },
        }),
      )!;

      expect(result.transaction).toBe('GET <unmatched route>');
    });

    it('falls back to the request method, then to HTTP', () => {
      const withMethod = scrubTransaction(
        sensitiveTransaction({ transaction: '', transaction_info: { source: 'url' } }),
      )!;
      const without = scrubTransaction(
        sensitiveTransaction({
          transaction: '',
          transaction_info: undefined,
          request: undefined,
        }),
      )!;

      expect(withMethod.transaction).toBe('GET <unmatched route>');
      expect(without.transaction).toBe('HTTP <unmatched route>');
    });

    it('masks identifiers that slipped into a route-sourced name', () => {
      const result = scrubTransaction(
        sensitiveTransaction({ transaction: `GET /api/v1/patients/${PATIENT_ID}` }),
      )!;

      expect(result.transaction).toBe('GET /api/v1/patients/:id');
    });
  });

  it('handles a transaction without spans, contexts or request', () => {
    const result = scrubTransaction({
      type: 'transaction',
      transaction: 'GET /api/v1/tasks',
      transaction_info: { source: 'route' },
    } as Event)!;

    expect(result.transaction).toBe('GET /api/v1/tasks');
    expect(result.spans).toBeUndefined();
    expect(result.request).toBeUndefined();
    expect(result.contexts).toEqual({});
  });

  it('drops the transaction when scrubbing fails instead of sending it untouched', () => {
    const event = sensitiveTransaction();
    Object.defineProperty(event, 'spans', {
      get() {
        throw new Error('boom');
      },
      configurable: true,
    });

    expect(scrubTransaction(event)).toBeNull();
  });
});

describe('flushTransactionAfterResponse', () => {
  const REQUEST_CONTEXT = Symbol.for('@vercel/request-context');
  const holder = globalThis as unknown as Record<symbol, unknown>;

  afterEach(() => {
    delete holder[REQUEST_CONTEXT];
    jest.useRealTimers();
    jest.clearAllMocks();
  });

  function respond() {
    let onClose: (() => void) | undefined;
    const response = {
      once: jest.fn((_event: 'close', listener: () => void) => {
        onClose = listener;
      }),
    };
    return { response, close: () => onClose?.() };
  }

  const nextTick = () => new Promise<void>((resolve) => setImmediate(resolve));

  it('registers waitUntil during the request, before the response closes', () => {
    const waitUntil = jest.fn();
    holder[REQUEST_CONTEXT] = { get: () => ({ waitUntil }) };
    const { response } = respond();

    flushTransactionAfterResponse({ isRecording: () => true }, response);

    expect(waitUntil).toHaveBeenCalledTimes(1);
    expect(waitUntil.mock.calls[0][0]).toBeInstanceOf(Promise);
    expect(flushReports).not.toHaveBeenCalled();
  });

  it('reads the Vercel context synchronously, not when the response closes', async () => {
    const waitUntil = jest.fn();
    const get = jest.fn(() => ({ waitUntil }));
    holder[REQUEST_CONTEXT] = { get };
    const { response, close } = respond();

    flushTransactionAfterResponse({ isRecording: () => true }, response);
    expect(get).toHaveBeenCalledTimes(1);

    // By the time the response closes the request context may be gone.
    holder[REQUEST_CONTEXT] = { get: () => undefined };
    close();
    await nextTick();

    expect(get).toHaveBeenCalledTimes(1);
    expect(waitUntil).toHaveBeenCalledTimes(1);
  });

  it('flushes after the response closes and then resolves the task of waitUntil', async () => {
    let task: Promise<unknown> | undefined;
    holder[REQUEST_CONTEXT] = { get: () => ({ waitUntil: (p: Promise<unknown>) => (task = p) }) };
    const { response, close } = respond();
    const done = jest.fn();

    flushTransactionAfterResponse({ isRecording: () => true }, response);
    void task!.then(done);
    await nextTick();
    expect(done).not.toHaveBeenCalled();

    close();
    // The flush waits one tick so the SDK can queue the transaction first.
    expect(flushReports).not.toHaveBeenCalled();
    await nextTick();
    await nextTick();

    expect(flushReports).toHaveBeenCalledTimes(1);
    expect(done).toHaveBeenCalledTimes(1);
  });

  it('does not leave the task pending when the response never closes', async () => {
    jest.useFakeTimers();
    let task: Promise<unknown> | undefined;
    holder[REQUEST_CONTEXT] = { get: () => ({ waitUntil: (p: Promise<unknown>) => (task = p) }) };
    const done = jest.fn();

    flushTransactionAfterResponse({ isRecording: () => true }, respond().response);
    void task!.then(done);
    await jest.advanceTimersByTimeAsync(FLUSH_WAIT_LIMIT_MS - 1);
    expect(done).not.toHaveBeenCalled();
    await jest.advanceTimersByTimeAsync(2);

    expect(done).toHaveBeenCalledTimes(1);
    expect(flushReports).not.toHaveBeenCalled();
  });

  it('does nothing for a request that is not sampled', () => {
    const waitUntil = jest.fn();
    holder[REQUEST_CONTEXT] = { get: () => ({ waitUntil }) };
    const { response } = respond();

    flushTransactionAfterResponse({ isRecording: () => false }, response);

    expect(response.once).not.toHaveBeenCalled();
    expect(waitUntil).not.toHaveBeenCalled();
  });

  it('does nothing outside Vercel', async () => {
    const { response, close } = respond();

    flushTransactionAfterResponse({ isRecording: () => true }, response);
    close();
    await nextTick();

    expect(response.once).not.toHaveBeenCalled();
    expect(flushReports).not.toHaveBeenCalled();
  });

  it('does nothing when the Vercel context has no waitUntil', () => {
    holder[REQUEST_CONTEXT] = { get: () => ({}) };
    const { response } = respond();

    flushTransactionAfterResponse({ isRecording: () => true }, response);

    expect(response.once).not.toHaveBeenCalled();
  });

  it('never throws, nor raises an uncaught exception, if waitUntil throws', async () => {
    const uncaught = jest.fn();
    process.on('uncaughtException', uncaught);
    try {
      holder[REQUEST_CONTEXT] = {
        get: () => ({
          waitUntil: () => {
            throw new Error('waitUntil exploded');
          },
        }),
      };
      const { response, close } = respond();

      expect(() =>
        flushTransactionAfterResponse({ isRecording: () => true }, response),
      ).not.toThrow();
      expect(() => close()).not.toThrow();
      await nextTick();
      await nextTick();

      expect(uncaught).not.toHaveBeenCalled();
    } finally {
      process.off('uncaughtException', uncaught);
    }
  });

  it('never throws if the context, the span or the response fail', async () => {
    holder[REQUEST_CONTEXT] = {
      get: () => {
        throw new Error('boom');
      },
    };
    const { response, close } = respond();

    expect(() =>
      flushTransactionAfterResponse(
        {
          isRecording: () => {
            throw new Error('boom');
          },
        },
        response,
      ),
    ).not.toThrow();
    expect(() =>
      flushTransactionAfterResponse({ isRecording: () => true }, response),
    ).not.toThrow();
    expect(() => close()).not.toThrow();

    holder[REQUEST_CONTEXT] = { get: () => ({ waitUntil: jest.fn() }) };
    const broken = {
      once: () => {
        throw new Error('boom');
      },
    };
    expect(() => flushTransactionAfterResponse({ isRecording: () => true }, broken)).not.toThrow();
    await nextTick();
    expect(flushReports).not.toHaveBeenCalled();
  });
});
