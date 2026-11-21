import * as Sentry from '@sentry/nestjs';

/**
 * What identifies an error without carrying data: ids and route patterns only.
 * Never pass emails, names, bodies, headers or query strings.
 */
export interface ReportContext {
  source?: string;
  userId?: string;
  tenantId?: string;
  method?: string;
  route?: string;
}

const DEFAULT_FLUSH_TIMEOUT_MS = 2000;

/** True when Sentry was initialized (only happens with SENTRY_DSN). */
export function isReportingEnabled(): boolean {
  return Sentry.isInitialized();
}

/** Sends an error to Sentry. A no-op without Sentry; it never throws. */
export function reportError(error: unknown, context: ReportContext = {}): void {
  try {
    if (!isReportingEnabled()) return;
    Sentry.withScope((scope) => {
      if (context.userId) scope.setUser({ id: context.userId });
      if (context.tenantId) scope.setTag('tenantId', context.tenantId);
      if (context.source) scope.setTag('source', context.source);
      if (context.method) scope.setTag('method', context.method);
      if (context.route) scope.setTag('route', context.route);
      Sentry.captureException(error);
    });
  } catch {
    // Reporting must never break the request or the job that failed.
  }
}

/**
 * Waits until the pending events are sent (a serverless function may freeze once it replies).
 * Never rejects: a slow or failing Sentry only costs the timeout.
 */
export async function flushReports(timeoutMs: number = DEFAULT_FLUSH_TIMEOUT_MS): Promise<void> {
  try {
    await Sentry.flush(timeoutMs);
  } catch {
    // Ignored on purpose: see above.
  }
}
