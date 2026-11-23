import * as Sentry from '@sentry/nestjs';
import type { ErrorEvent, EventHint, NodeOptions } from '@sentry/nestjs';
import {
  buildTracesSampler,
  flushTransactionAfterResponse,
  parseTracesSampleRate,
  scrubSamplingMetadata,
  scrubTransaction,
} from './sentry-tracing';

/**
 * Sentry options for the API: errors, plus sampled traces of slow requests only when
 * SENTRY_TRACES_SAMPLE_RATE is set; minimum data either way.
 *
 * Returns null when SENTRY_DSN is empty or missing so Sentry is never
 * initialized in local runs, CI or tests.
 */
export function buildSentryOptions(env: NodeJS.ProcessEnv): NodeOptions | null {
  const dsn = env.SENTRY_DSN?.trim();
  if (!dsn) return null;

  const tracesSampleRate = parseTracesSampleRate(env.SENTRY_TRACES_SAMPLE_RATE);

  return {
    dsn,
    environment: env.VERCEL_ENV || env.NODE_ENV || 'development',
    release: env.VERCEL_GIT_COMMIT_SHA || undefined,
    // Rate 0 (the default) keeps the SDK as it was before tracing existed, except for the sampler:
    // it decides by itself (`Math.random() < rate`) and ignores both the sampling decision of an
    // incoming `sentry-trace` header (`...-1`) and the `sample_rand` of its `baggage`. Both come
    // from headers any client can send, so without this one could sample all of its requests.
    tracesSampleRate: 0,
    tracesSampler: buildTracesSampler(tracesSampleRate),
    // At any rate: outgoing calls (SRI, storage, mail) must not receive `sentry-trace`/`baggage`.
    // They carry the trace id and the DSN public key, and the SDK adds them to every outgoing
    // request when tracing spans are enabled, even if the trace is not sampled (rate 0 included).
    tracePropagationTargets: [],
    ...(tracesSampleRate > 0 ? tracingOptions() : {}),
    sendDefaultPii: false,
    // Local variables of a stack frame would carry whatever the code was handling.
    includeLocalVariables: false,
    beforeBreadcrumb: dropBreadcrumb,
    beforeSend: scrubEvent,
    // Defense in depth, also at rate 0: a transaction never leaves without being scrubbed.
    beforeSendTransaction: scrubTransaction,
  };
}

/**
 * Prisma spans the integration of the SDK creates for each query. Only the operation and the
 * time of the query are useful to find a slow request; the rest is noise that multiplies the
 * size (and the cost) of every transaction.
 */
const IGNORED_PRISMA_SPANS = [
  'prisma:client:serialize',
  'prisma:engine:serialize',
  'prisma:engine:response_json_serialization',
  'prisma:client:detect_platform',
  'prisma:client:load_engine',
];

function tracingOptions(): NodeOptions {
  return {
    integrations: [
      Sentry.httpIntegration({
        incomingRequestSpanHook: (span, _request, response) =>
          flushTransactionAfterResponse(span, response),
      }),
      // Spans of the database layer; scrubTransaction removes the SQL text from them.
      Sentry.prismaIntegration({
        instrumentationConfig: { ignoreSpanTypes: IGNORED_PRISMA_SPANS },
      }),
    ],
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
    scrubSamplingMetadata(event);
  } catch {
    delete event.request;
    delete event.user;
    delete event.extra;
    delete event.transaction;
    delete event.sdkProcessingMetadata;
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
