import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import * as Sentry from '@sentry/nestjs';
import { buildSentryOptions } from './sentry-options';

/**
 * The real SDK (OpenTelemetry, HTTP server spans, event and envelope building) with an in-memory
 * transport: nothing is sent. These tests look at what really leaves the process, including the
 * `trace` header of each envelope, which the SDK computes from the live span and not from the event.
 */

const DSN = 'https://publickey@localhost.invalid/1';
const PATIENT_ID = '3f2b8c1e-9a4d-4e6f-8b7a-1c2d3e4f5a6b';

type Envelope = [Record<string, any>, Array<[Record<string, any>, Record<string, any>]>];

const sent: Envelope[] = [];
let server: http.Server;
let agent: http.Agent;
let port: number;
const ids = { errors: 0 };

const transactions = () =>
  sent.flatMap((envelope) => envelope[1]).filter(([header]) => header.type === 'transaction');

function request(path: string, headers: Record<string, string> = {}): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path, headers, agent }, (res) => {
      res.resume();
      res.on('end', () => resolve(res.statusCode ?? 0));
    });
    req.on('error', reject);
    req.end();
  });
}

const settle = async () => {
  await new Promise((resolve) => setTimeout(resolve, 50));
  await Sentry.flush(2000);
};

function useSampler(rate: string | undefined) {
  const options = buildSentryOptions({ SENTRY_DSN: DSN, SENTRY_TRACES_SAMPLE_RATE: rate });
  (Sentry.getClient()!.getOptions() as { tracesSampler?: unknown }).tracesSampler =
    options?.tracesSampler;
}

describe('real SDK with an in-memory transport', () => {
  const realRandom = Math.random;

  beforeAll(async () => {
    const options = buildSentryOptions({
      SENTRY_DSN: DSN,
      SENTRY_TRACES_SAMPLE_RATE: '1',
      VERCEL_ENV: 'production',
    })!;
    Sentry.init({
      ...options,
      transport: () => ({
        send: async (envelope: unknown) => {
          sent.push(envelope as Envelope);
          return {};
        },
        flush: async () => true,
      }),
    });
    // Created after init: the SDK instruments the HTTP server it finds.
    server = http.createServer((req, res) => {
      if (req.url?.includes('/boom')) {
        ids.errors++;
        Sentry.withScope((scope) => {
          scope.setTag('route', '/patients/:id/boom');
          Sentry.captureException(new Error('probe 500'));
        });
      }
      res.end('ok');
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    port = (server.address() as AddressInfo).port;
    agent = new http.Agent({ keepAlive: true });
  });

  afterAll(async () => {
    Math.random = realRandom;
    agent.destroy();
    await new Promise((resolve) => server.close(resolve));
    await Sentry.close(1000);
  });

  beforeEach(() => {
    sent.length = 0;
    Math.random = realRandom;
    useSampler('1');
  });

  it('an error captured in a sampled request carries no raw route in the envelope trace header', async () => {
    await request(`/api/v1/patients/${PATIENT_ID}/boom?search=ana`, {
      authorization: 'Bearer secret-token',
      cookie: 'refresh=secret-cookie',
    });
    await settle();

    const errorEnvelope = sent.find((envelope) => envelope[1].some(([h]) => h.type === 'event'))!;
    expect(errorEnvelope).toBeDefined();
    // The header is what the SDK computed from the live root span: it must not hold the route.
    expect(errorEnvelope[0].trace).toBeDefined();
    expect(errorEnvelope[0].trace).not.toHaveProperty('transaction');
    expect(JSON.stringify(errorEnvelope)).not.toContain(PATIENT_ID);
    expect(JSON.stringify(sent)).not.toContain('secret-token');
    expect(JSON.stringify(sent)).not.toContain('search=ana');
    // Still sampled and linked to the transaction: only the name was removed.
    expect(errorEnvelope[0].trace).toMatchObject({ sampled: 'true', public_key: 'publickey' });
  });

  it('the transaction of that request has no raw route in its payload or envelope header', async () => {
    await request(`/api/v1/patients/${PATIENT_ID}/boom`);
    await settle();

    expect(transactions()).toHaveLength(1);
    expect(JSON.stringify(sent)).not.toContain(PATIENT_ID);
    for (const envelope of sent) expect(envelope[0].trace ?? {}).not.toHaveProperty('user_segment');
  });

  it('with tracing at rate 0 a forced sentry-trace header does not sample anything', async () => {
    useSampler(undefined);

    for (let i = 0; i < 20; i++) {
      await request('/api/v1/ping', {
        'sentry-trace': 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-bbbbbbbbbbbbbbbb-1',
        baggage: 'sentry-sample_rand=0,sentry-sampled=true',
      });
    }
    await settle();

    expect(transactions()).toHaveLength(0);
  });

  it('health, the internal tick and docs are never traced, whatever the case or the slashes', async () => {
    for (const path of [
      '/health',
      '/API/V1/HEALTH',
      '/api/v1//health',
      '/api/v1/Internal/invoicing/tick',
      '/api/v1/DOCS',
    ]) {
      await request(path);
    }
    await settle();

    expect(transactions()).toHaveLength(0);
  });

  describe('the sampling decision comes from the API, not from the request headers', () => {
    const forged = {
      'sentry-trace': 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-bbbbbbbbbbbbbbbb',
      baggage: 'sentry-sample_rand=0',
    };

    it('Math.random below the rate samples and above it does not, whatever the baggage', async () => {
      useSampler('0.05');

      Math.random = () => 0.01;
      await request('/api/v1/ping', forged);
      await request('/api/v1/ping');
      await settle();
      expect(transactions()).toHaveLength(2);

      sent.length = 0;
      Math.random = () => 0.9;
      await request('/api/v1/ping', forged);
      await request('/api/v1/ping', {
        ...forged,
        baggage: 'sentry-sample_rand=0,sentry-sampled=true',
      });
      await settle();
      expect(transactions()).toHaveLength(0);
    });

    it('a client that sends sentry-sample_rand=0 does not get all its requests sampled (N=2000)', async () => {
      useSampler('0.05');
      // A deterministic generator: the test does not depend on luck.
      let seed = 123456789;
      Math.random = () => {
        seed = (seed * 1664525 + 1013904223) % 4294967296;
        return seed / 4294967296;
      };
      const N = 2000;

      for (let i = 0; i < N; i++) await request('/api/v1/ping', forged);
      await settle();

      const fraction = transactions().length / N;
      expect(fraction).toBeGreaterThan(0.03);
      expect(fraction).toBeLessThan(0.07);
    }, 60_000);
  });
});
