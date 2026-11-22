jest.mock('@sentry/nestjs');

describe('instrument', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    jest.resetModules();
    process.env = { ...originalEnv };
    delete process.env.SENTRY_DSN;
  });

  afterAll(() => {
    process.env = originalEnv;
  });

  it('does not call init without SENTRY_DSN', async () => {
    await jest.isolateModulesAsync(async () => {
      const Sentry = await import('@sentry/nestjs');
      await import('./instrument');

      expect(Sentry.init).not.toHaveBeenCalled();
    });
  });

  it('calls init once with the built options when SENTRY_DSN is set', async () => {
    process.env.SENTRY_DSN = 'https://k@o0.ingest.sentry.io/1';

    await jest.isolateModulesAsync(async () => {
      const Sentry = await import('@sentry/nestjs');
      const { buildSentryOptions } = await import('./common/monitoring/sentry-options');
      await import('./instrument');

      expect(Sentry.init).toHaveBeenCalledTimes(1);
      // The sampler is a new closure on every build: compare its behavior, not its identity.
      expect(Sentry.init).toHaveBeenCalledWith({
        ...buildSentryOptions(process.env),
        tracesSampler: expect.any(Function),
      });
    });
  });

  it('initializes without tracing when SENTRY_TRACES_SAMPLE_RATE is absent or invalid', async () => {
    process.env.SENTRY_DSN = 'https://k@o0.ingest.sentry.io/1';

    for (const rate of [undefined, '', '0', 'abc', '2', '-1']) {
      if (rate === undefined) delete process.env.SENTRY_TRACES_SAMPLE_RATE;
      else process.env.SENTRY_TRACES_SAMPLE_RATE = rate;

      await jest.isolateModulesAsync(async () => {
        const Sentry = await import('@sentry/nestjs');
        await import('./instrument');

        const options = (Sentry.init as jest.Mock).mock.calls[0][0];
        expect(options.tracesSampleRate).toBe(0);
        expect(options.integrations).toBeUndefined();
        expect(options.tracePropagationTargets).toEqual([]);
        const httpRequest = {
          name: 'GET /api/v1/patients',
          attributes: { 'sentry.op': 'http.server' },
        };
        expect(options.tracesSampler(httpRequest)).toBe(0);
      });
    }
  });

  it('samples incoming requests at SENTRY_TRACES_SAMPLE_RATE when it is valid', async () => {
    process.env.SENTRY_DSN = 'https://k@o0.ingest.sentry.io/1';
    process.env.SENTRY_TRACES_SAMPLE_RATE = '0.1';

    await jest.isolateModulesAsync(async () => {
      const Sentry = await import('@sentry/nestjs');
      await import('./instrument');

      const options = (Sentry.init as jest.Mock).mock.calls[0][0];
      const request = (path: string) => ({
        name: `GET ${path}`,
        attributes: { 'sentry.op': 'http.server', 'url.path': path },
      });
      const random = jest.spyOn(Math, 'random').mockReturnValue(0.01);
      expect(options.tracesSampler(request('/api/v1/patients'))).toBe(true);
      expect(options.tracesSampler(request('/health'))).toBe(false);
      random.mockRestore();
      expect(options.tracePropagationTargets).toEqual([]);
    });
  });
});
