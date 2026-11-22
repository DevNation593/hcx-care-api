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
      expect(Sentry.init).toHaveBeenCalledWith(buildSentryOptions(process.env));
    });
  });
});
