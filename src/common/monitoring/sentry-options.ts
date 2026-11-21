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
    // Local variables of a stack frame would carry whatever the code was handling.
    includeLocalVariables: false,
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
    scrubExtraAndTransaction(event);
    scrubFrameVariables(event);
    scrubPrismaMessages(event, hint);
  } catch {
    delete event.request;
    delete event.user;
    delete event.extra;
    delete event.transaction;
    for (const exception of event.exception?.values ?? []) {
      exception.value = exception.type;
      for (const frame of exception.stacktrace?.frames ?? []) delete frame.vars;
    }
  }
  return event;
}

/**
 * Only the method survives: the route pattern already travels as the `route` tag, while a
 * path can carry ids or the verification code of a public document.
 */
function scrubRequest(event: ErrorEvent): void {
  const request = event.request;
  if (!request) return;

  const scrubbed: NonNullable<ErrorEvent['request']> = {};
  if (request.method) scrubbed.method = request.method;
  event.request = scrubbed;
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
 * `extra` holds the whole object when something that is not an Error is thrown
 * (`__serialized__`), and the transaction name is the raw route of the request.
 */
function scrubExtraAndTransaction(event: ErrorEvent): void {
  delete event.extra;
  delete event.transaction;
}

function scrubFrameVariables(event: ErrorEvent): void {
  for (const exception of event.exception?.values ?? []) {
    for (const frame of exception.stacktrace?.frames ?? []) delete frame.vars;
  }
}

const PRISMA_ERROR_PREFIX = 'PrismaClient';

/**
 * Prisma messages can embed the offending values (emails, names, clinical
 * fields). Replace them with the error class, the code and the field names.
 * Every exception of the chain is checked: a Prisma error can be the `cause` of another one.
 */
function scrubPrismaMessages(event: ErrorEvent, hint?: EventHint): void {
  const values = event.exception?.values;
  if (!values?.length) return;

  const original: unknown = hint?.originalException;
  const thrown = isPrismaError(original) ? original : undefined;
  let rewritten = false;
  for (const exception of values) {
    if (!exception.type?.startsWith(PRISMA_ERROR_PREFIX)) continue;
    // Code and field names are known only for the error that was thrown itself.
    exception.value =
      thrown && thrown.name === exception.type ? describePrismaError(thrown) : exception.type;
    rewritten = true;
  }
  // A Prisma error whose type was not captured as its class name: the thrown one is last.
  if (!rewritten && thrown) values[values.length - 1].value = describePrismaError(thrown);
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
    (error as { name: string }).name.startsWith(PRISMA_ERROR_PREFIX)
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
