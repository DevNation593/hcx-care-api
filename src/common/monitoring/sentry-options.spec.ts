import { Prisma } from '@prisma/client';
import type { ErrorEvent, EventHint } from '@sentry/nestjs';
import { buildSentryOptions, scrubEvent } from './sentry-options';

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
    expect(options?.beforeBreadcrumb?.({ category: 'console' }, undefined)).toBeNull();
    expect(options?.beforeSend).toBe(scrubEvent);
  });
});

describe('scrubEvent', () => {
  it('removes request body, cookies, headers and query string', () => {
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

    expect(scrubEvent(event).request).toEqual({
      method: 'GET',
      url: 'https://x/api/v1/patients',
    });
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

  it('does not throw on an event without request, user or exception', () => {
    expect(() => scrubEvent({} as ErrorEvent)).not.toThrow();
  });
});
