import type { ErrorEvent, EventHint, NodeOptions } from '@sentry/nestjs';

/**
 * Sentry options for the API: errors only, minimum data.
 *
 * Returns null when SENTRY_DSN is empty or missing so Sentry is never
 * initialized in local runs, CI or tests.
 */
export function buildSentryOptions(env: NodeJS.ProcessEnv): NodeOptions | null {
  const dsn = env.SENTRY_DSN?.trim();
  if (!dsn) return null;

  return {
    dsn,
    environment: env.VERCEL_ENV || env.NODE_ENV || 'development',
    release: env.VERCEL_GIT_COMMIT_SHA || undefined,
    tracesSampleRate: 0,
    sendDefaultPii: false,
    beforeBreadcrumb: dropBreadcrumb,
    beforeSend: scrubEvent,
  };
}

/** Console logs and URLs may carry patient data: no breadcrumbs at all. */
function dropBreadcrumb(): null {
  return null;
}

/**
 * Removes everything that could carry patient data or credentials before an
 * event leaves the process. Never throws: if scrubbing itself fails, the
 * sensitive parts are dropped instead of sending the event untouched.
 */
export function scrubEvent(event: ErrorEvent, hint?: EventHint): ErrorEvent {
  try {
    scrubRequest(event);
    scrubUser(event);
    scrubPrismaMessage(event, hint);
  } catch {
    delete event.request;
    delete event.user;
    for (const exception of event.exception?.values ?? []) {
      exception.value = exception.type;
    }
  }
  return event;
}

function scrubRequest(event: ErrorEvent): void {
  const request = event.request;
  if (!request) return;

  const scrubbed: NonNullable<ErrorEvent['request']> = {};
  if (request.method) scrubbed.method = request.method;
  if (request.url) scrubbed.url = stripQueryAndFragment(request.url);
  event.request = scrubbed;
}

function stripQueryAndFragment(url: string): string {
  const end = url.search(/[?#]/);
  return end === -1 ? url : url.slice(0, end);
}

function scrubUser(event: ErrorEvent): void {
  if (!event.user) return;

  if (event.user.id !== undefined && event.user.id !== null) {
    event.user = { id: event.user.id };
  } else {
    delete event.user;
  }
}

/**
 * Prisma messages can embed the offending values (emails, names, clinical
 * fields). Replace them with the error class, the code and the field names.
 */
function scrubPrismaMessage(event: ErrorEvent, hint?: EventHint): void {
  const original: unknown = hint?.originalException;
  if (!isPrismaError(original)) return;

  const values = event.exception?.values;
  if (!values?.length) return;

  const replacement = describePrismaError(original);
  const matching = values.filter((exception) => exception.type === original.name);
  // Sentry orders chained exceptions oldest first: the thrown one is last.
  const targets = matching.length ? matching : [values[values.length - 1]];
  for (const exception of targets) {
    exception.value = replacement;
  }
}

interface PrismaErrorLike {
  name: string;
  code?: unknown;
  meta?: { target?: unknown; column?: unknown };
}

function isPrismaError(error: unknown): error is PrismaErrorLike {
  return (
    typeof error === 'object' &&
    error !== null &&
    typeof (error as { name?: unknown }).name === 'string' &&
    (error as { name: string }).name.startsWith('PrismaClient')
  );
}

function describePrismaError(error: PrismaErrorLike): string {
  const parts = [error.name];
  if (typeof error.code === 'string') parts.push(error.code);

  const fields = prismaFieldNames(error.meta);
  if (fields.length) parts.push(`(${fields.join(', ')})`);

  return parts.join(' ');
}

function prismaFieldNames(meta: PrismaErrorLike['meta']): string[] {
  const raw = meta?.target ?? meta?.column;
  const list = Array.isArray(raw) ? raw : [raw];
  return list.filter((field): field is string => typeof field === 'string' && field.length > 0);
}
