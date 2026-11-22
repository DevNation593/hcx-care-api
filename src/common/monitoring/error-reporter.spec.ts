import * as Sentry from '@sentry/nestjs';
import { flushReports, isReportingEnabled, reportError } from './error-reporter';

jest.mock('@sentry/nestjs');

const sentry = jest.mocked(Sentry);

function fakeScope() {
  return { setUser: jest.fn(), setTag: jest.fn() };
}

describe('error-reporter', () => {
  beforeEach(() => {
    jest.resetAllMocks();
  });

  it('isReportingEnabled mirrors Sentry.isInitialized', () => {
    sentry.isInitialized.mockReturnValue(true);
    expect(isReportingEnabled()).toBe(true);
    sentry.isInitialized.mockReturnValue(false);
    expect(isReportingEnabled()).toBe(false);
  });

  it('reportError is a no-op when Sentry is not initialized', () => {
    sentry.isInitialized.mockReturnValue(false);
    reportError(new Error('boom'), { source: 'http' });
    expect(sentry.captureException).not.toHaveBeenCalled();
    expect(sentry.withScope).not.toHaveBeenCalled();
  });

  it('reportError sets user id only, tags tenantId, source, method and route, and captures the error', () => {
    sentry.isInitialized.mockReturnValue(true);
    const scope = fakeScope();
    sentry.withScope.mockImplementation(((cb: (s: unknown) => void) => cb(scope)) as never);
    const error = new Error('boom');

    reportError(error, {
      source: 'http',
      userId: 'u1',
      tenantId: 't1',
      method: 'GET',
      route: '/api/v1/patients/:id',
    });

    expect(scope.setUser).toHaveBeenCalledWith({ id: 'u1' });
    expect(scope.setTag).toHaveBeenCalledWith('tenantId', 't1');
    expect(scope.setTag).toHaveBeenCalledWith('source', 'http');
    expect(scope.setTag).toHaveBeenCalledWith('method', 'GET');
    expect(scope.setTag).toHaveBeenCalledWith('route', '/api/v1/patients/:id');
    expect(sentry.captureException).toHaveBeenCalledWith(error);
  });

  it('reportError leaves out the user and tags that the context does not have', () => {
    sentry.isInitialized.mockReturnValue(true);
    const scope = fakeScope();
    sentry.withScope.mockImplementation(((cb: (s: unknown) => void) => cb(scope)) as never);

    reportError(new Error('boom'));

    expect(scope.setUser).not.toHaveBeenCalled();
    expect(scope.setTag).not.toHaveBeenCalled();
    expect(sentry.captureException).toHaveBeenCalledTimes(1);
  });

  it('reportError swallows errors thrown by Sentry', () => {
    sentry.isInitialized.mockReturnValue(true);
    sentry.withScope.mockImplementation(() => {
      throw new Error('sentry is down');
    });
    expect(() => reportError(new Error('boom'), { source: 'http' })).not.toThrow();

    sentry.withScope.mockImplementation(((cb: (s: unknown) => void) => cb(fakeScope())) as never);
    sentry.captureException.mockImplementation(() => {
      throw new Error('sentry is down');
    });
    expect(() => reportError(new Error('boom'))).not.toThrow();
  });

  it('flushReports calls Sentry.flush with 2000 by default and resolves even if flush rejects', async () => {
    sentry.flush.mockResolvedValue(true);
    await expect(flushReports()).resolves.toBeUndefined();
    expect(sentry.flush).toHaveBeenCalledWith(2000);

    sentry.flush.mockRejectedValue(new Error('network'));
    await expect(flushReports(500)).resolves.toBeUndefined();
    expect(sentry.flush).toHaveBeenLastCalledWith(500);
  });

  it('flushReports resolves even if Sentry.flush throws synchronously', async () => {
    sentry.flush.mockImplementation(() => {
      throw new Error('boom');
    });
    await expect(flushReports()).resolves.toBeUndefined();
  });
});
