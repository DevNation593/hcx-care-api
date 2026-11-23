import { Prisma } from '@prisma/client';
import type { ErrorEvent, EventHint, NodeOptions } from '@sentry/nestjs';
import { buildSentryOptions, scrubEvent } from './sentry-options';
import { scrubTransaction } from './sentry-tracing';

describe('buildSentryOptions', () => {
  it('returns null without SENTRY_DSN', () => {
    expect(buildSentryOptions({})).toBeNull();
    expect(buildSentryOptions({ SENTRY_DSN: '' })).toBeNull();
  });

  it('uses VERCEL_ENV as environment and the commit SHA as release', () => {
    const options = buildSentryOptions({
      SENTRY_DSN: 'https://k@o0.ingest.sentry.io/1',
      VERCEL_ENV: 'production',
      NODE_ENV: 'production',
      VERCEL_GIT_COMMIT_SHA: 'abc123',
    });

    expect(options?.dsn).toBe('https://k@o0.ingest.sentry.io/1');
    expect(options?.environment).toBe('production');
    expect(options?.release).toBe('abc123');
  });

  it("falls back to NODE_ENV, then 'development'", () => {
    const dsn = 'https://k@o0.ingest.sentry.io/1';

    expect(buildSentryOptions({ SENTRY_DSN: dsn, NODE_ENV: 'staging' })?.environment).toBe(
      'staging',
    );
    expect(buildSentryOptions({ SENTRY_DSN: dsn })?.environment).toBe('development');
  });

  it('disables tracing, default PII and breadcrumbs', () => {
    const options = buildSentryOptions({ SENTRY_DSN: 'https://k@o0.ingest.sentry.io/1' });

    expect(options?.tracesSampleRate).toBe(0);
    expect(options?.sendDefaultPii).toBe(false);
    expect(options?.includeLocalVariables).toBe(false);
    expect(options?.beforeBreadcrumb?.({ category: 'console' }, undefined)).toBeNull();
    expect(options?.beforeSend).toBe(scrubEvent);
  });
});

describe('buildSentryOptions tracing', () => {
  const dsn = 'https://k@o0.ingest.sentry.io/1';
  const incomingRequest = (path: string) =>
    ({
      name: `GET ${path}`,
      attributes: { 'sentry.op': 'http.server', 'url.path': path },
      parentSampled: true,
      inheritOrSampleWith: (fallback: number) => fallback,
    }) as Parameters<NonNullable<NodeOptions['tracesSampler']>>[0];

  it.each([
    ['absent', undefined],
    ['empty', ''],
    ['zero', '0'],
    ['not a number', 'abc'],
    ['negative', '-0.5'],
    ['above one', '1.5'],
    ['a percentage', '10%'],
  ])('does not trace when the rate is %s', (_label, rate) => {
    const options = buildSentryOptions({ SENTRY_DSN: dsn, SENTRY_TRACES_SAMPLE_RATE: rate });

    expect(options?.tracesSampleRate).toBe(0);
    // Not even a forced `sentry-trace: ...-1` header makes a request sampled.
    expect(options?.tracesSampler?.(incomingRequest('/api/v1/patients'))).toBe(0);
    // Nothing is added to the SDK: no custom integrations. Propagation is off at any rate.
    expect(options?.integrations).toBeUndefined();
    expect(options?.tracePropagationTargets).toEqual([]);
  });

  it('samples incoming requests at the configured rate, never health, tick or docs', () => {
    const options = buildSentryOptions({ SENTRY_DSN: dsn, SENTRY_TRACES_SAMPLE_RATE: '0.05' });
    const sampler = options?.tracesSampler;

    const random = jest.spyOn(Math, 'random');
    try {
      random.mockReturnValue(0.01);
      expect(sampler?.(incomingRequest('/api/v1/patients/abc'))).toBe(true);
      expect(sampler?.(incomingRequest('/health'))).toBe(false);
      expect(sampler?.(incomingRequest('/api/v1/internal/invoicing/tick'))).toBe(false);
      expect(sampler?.(incomingRequest('/api/v1/docs'))).toBe(false);
      random.mockReturnValue(0.9);
      expect(sampler?.(incomingRequest('/api/v1/patients/abc'))).toBe(false);
    } finally {
      random.mockRestore();
    }
  });

  it('never propagates sentry-trace or baggage to outgoing calls, at any rate', () => {
    for (const rate of [undefined, '', '0', 'abc', '0.1', '1']) {
      const options = buildSentryOptions({ SENTRY_DSN: dsn, SENTRY_TRACES_SAMPLE_RATE: rate });

      expect(options?.tracePropagationTargets).toEqual([]);
    }
  });

  it('with tracing on: HTTP and Prisma integrations', () => {
    const options = buildSentryOptions({ SENTRY_DSN: dsn, SENTRY_TRACES_SAMPLE_RATE: '0.1' });
    const names = (options?.integrations as Array<{ name: string }>).map((i) => i.name);

    expect(options?.tracePropagationTargets).toEqual([]);
    expect(names).toEqual(['Http', 'Prisma']);
  });

  it('always scrubs transactions, at any rate', () => {
    for (const rate of [undefined, '0', '0.1']) {
      const options = buildSentryOptions({ SENTRY_DSN: dsn, SENTRY_TRACES_SAMPLE_RATE: rate });
      expect(options?.beforeSendTransaction).toBe(scrubTransaction);
    }
  });

  it('keeps privacy settings with tracing on', () => {
    const options = buildSentryOptions({ SENTRY_DSN: dsn, SENTRY_TRACES_SAMPLE_RATE: '1' });

    expect(options?.sendDefaultPii).toBe(false);
    expect(options?.includeLocalVariables).toBe(false);
    expect(options?.beforeBreadcrumb?.({ category: 'http' }, undefined)).toBeNull();
    expect(options?.beforeSend).toBe(scrubEvent);
  });
});

describe('scrubEvent', () => {
  it('keeps no route, user or request in sdkProcessingMetadata: the SDK copies it to the envelope', () => {
    const event = {
      sdkProcessingMetadata: {
        normalizedRequest: { url: 'https://x/api/v1/patients/3f2b8c1e', headers: { cookie: 'c' } },
        capturedSpanScope: { _user: { email: 'a@b.c' } },
        dynamicSamplingContext: {
          trace_id: 'a'.repeat(32),
          public_key: 'pk',
          sampled: 'true',
          transaction: 'GET /api/v1/patients/3f2b8c1e-9a4d-4e6f-8b7a-1c2d3e4f5a6b',
          user_segment: 'a@b.c',
        },
      },
    } as unknown as ErrorEvent;

    const result = scrubEvent(event);

    expect(result.sdkProcessingMetadata).toEqual({
      dynamicSamplingContext: { trace_id: 'a'.repeat(32), public_key: 'pk', sampled: 'true' },
    });
  });

  it('removes sdkProcessingMetadata even when scrubbing fails', () => {
    const event = {
      sdkProcessingMetadata: { dynamicSamplingContext: { transaction: 'GET /patients/1234' } },
    } as unknown as ErrorEvent;
    Object.defineProperty(event, 'request', {
      get() {
        throw new Error('boom');
      },
      configurable: true,
    });

    expect(scrubEvent(event).sdkProcessingMetadata).toBeUndefined();
  });

  it('removes request body, cookies, headers, query string and url', () => {
    const event = {
      request: {
        method: 'GET',
        url: 'https://x/api/v1/patients?search=ana',
        data: { a: 1 },
        cookies: { s: '1' },
        headers: { authorization: 't' },
        query_string: 'search=ana',
      },
    } as unknown as ErrorEvent;

    expect(scrubEvent(event).request).toEqual({ method: 'GET' });
  });

  it('removes the transaction name', () => {
    const event = { transaction: 'GET /public/documents/ABC123' } as unknown as ErrorEvent;

    expect(scrubEvent(event).transaction).toBeUndefined();
  });

  it('removes extra, where a thrown non-Error object is serialized', () => {
    const event = {
      extra: { __serialized__: { details: 'Ana Pérez 0912345678' } },
    } as unknown as ErrorEvent;

    const result = scrubEvent(event);

    expect(result.extra).toBeUndefined();
    expect(JSON.stringify(result)).not.toContain('Ana');
  });

  it('removes local variables from every stack frame', () => {
    const event = {
      exception: {
        values: [
          { type: 'Error', stacktrace: { frames: [{ function: 'a', vars: { name: 'Ana' } }] } },
          { type: 'Error', stacktrace: { frames: [{ function: 'b', vars: { id: '0912' } }, {}] } },
          { type: 'Error' },
        ],
      },
    } as unknown as ErrorEvent;

    const result = scrubEvent(event);

    expect(JSON.stringify(result)).not.toContain('vars');
    expect(result.exception?.values?.[0].stacktrace?.frames?.[0].function).toBe('a');
  });

  it('keeps only user.id', () => {
    const event = {
      user: { id: 'u1', email: 'a@b.c', ip_address: '1.1.1.1', username: 'n' },
      tags: { tenantId: 't1' },
    } as unknown as ErrorEvent;

    const result = scrubEvent(event);

    expect(result.user).toEqual({ id: 'u1' });
    expect(result.tags).toEqual({ tenantId: 't1' });
  });

  it('rewrites Prisma messages to code and field names', () => {
    const known = new Prisma.PrismaClientKnownRequestError(
      'Unique constraint failed on the fields: (`email`) value ana@x.com',
      { code: 'P2002', clientVersion: 't', meta: { target: ['email'] } },
    );
    const knownEvent = {
      exception: { values: [{ type: 'PrismaClientKnownRequestError', value: known.message }] },
    } as unknown as ErrorEvent;

    const knownResult = scrubEvent(knownEvent, { originalException: known } as EventHint);

    expect(knownResult.exception.values[0].value).toBe(
      'PrismaClientKnownRequestError P2002 (email)',
    );
    expect(JSON.stringify(knownResult)).not.toContain('ana@x.com');

    const validation = new Prisma.PrismaClientValidationError('Invalid value "Ana"', {
      clientVersion: 't',
    });
    const validationEvent = {
      exception: {
        values: [{ type: 'PrismaClientValidationError', value: validation.message }],
      },
    } as unknown as ErrorEvent;

    const validationResult = scrubEvent(validationEvent, {
      originalException: validation,
    } as EventHint);

    expect(validationResult.exception.values[0].value).toBe('PrismaClientValidationError');
    expect(JSON.stringify(validationResult)).not.toContain('Ana');
  });

  it('rewrites a Prisma error that is the cause of a plain Error', () => {
    const cause = new Prisma.PrismaClientValidationError('Invalid value "Ana Pérez"', {
      clientVersion: 't',
    });
    const error = new Error('lookup failed', { cause });
    const event = {
      exception: {
        values: [
          { type: 'PrismaClientValidationError', value: cause.message },
          { type: 'Error', value: 'lookup failed' },
        ],
      },
    } as unknown as ErrorEvent;

    const result = scrubEvent(event, { originalException: error } as EventHint);

    expect(result.exception?.values?.[0].value).toBe('PrismaClientValidationError');
    expect(result.exception?.values?.[1].value).toBe('lookup failed');
    expect(JSON.stringify(result)).not.toContain('Ana');
  });

  it('drops the sensitive parts when scrubbing itself fails', () => {
    const event = {
      request: { method: 'GET' },
      user: { id: 'u1' },
      extra: { secret: 'Ana' },
      transaction: 'GET /x',
      exception: {
        values: [
          {
            type: 'Error',
            value: 'Ana',
            stacktrace: { frames: [{ vars: { n: 'Ana' } }] },
          },
        ],
      },
    } as unknown as ErrorEvent;
    Object.defineProperty(event, 'request', {
      get() {
        throw new Error('boom');
      },
      configurable: true,
    });

    const result = scrubEvent(event);

    expect(result.extra).toBeUndefined();
    expect(result.transaction).toBeUndefined();
    expect(result.user).toBeUndefined();
    expect(result.exception?.values?.[0].value).toBe('Error');
    expect(JSON.stringify(result)).not.toContain('Ana');
  });

  it('does not throw on an event without request, user or exception', () => {
    expect(() => scrubEvent({} as ErrorEvent)).not.toThrow();
  });
});
