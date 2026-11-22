import type { Event, NodeOptions } from '@sentry/nestjs';
import { flushReports } from './error-reporter';

/**
 * Performance tracing (slow requests) for the API.
 *
 * Privacy first: this is a clinical system, so a transaction leaves the process only after
 * `scrubTransaction` rebuilt it from an allowlist. Neither URLs, query strings, headers, cookies,
 * client IPs, SQL text nor ids of patients ever travel; only parametrized route patterns,
 * durations, operations and statuses do.
 */

type SpanJson = NonNullable<Event['spans']>[number];
type TracesSampler = NonNullable<NodeOptions['tracesSampler']>;

const RATE_PATTERN = /^(?:\d+(?:\.\d+)?|\.\d+)$/;

/**
 * `SENTRY_TRACES_SAMPLE_RATE`: a number in (0, 1]. Absent, empty, malformed, negative or
 * greater than 1 means 0 (tracing off): a typo must never switch sampling on at 100%.
 */
export function parseTracesSampleRate(raw: string | undefined): number {
  const text = raw?.trim();
  if (!text || !RATE_PATTERN.test(text)) return 0;
  const rate = Number(text);
  return rate > 0 && rate <= 1 ? rate : 0;
}

/**
 * Health checks, the internal invoicing tick and Swagger, under any API prefix. Express routes
 * without distinguishing case and ignores repeated or trailing slashes, so the match does too.
 */
const UNTRACED_PATH = /(?:^|\/)(?:health|internal|docs(?:-json|-yaml)?)(?:\/|$)/i;

function decoded(path: string): string {
  try {
    return decodeURIComponent(path);
  } catch {
    return path;
  }
}

export function isUntracedPath(path: string): boolean {
  const clean = path.split(/[?#]/)[0].replace(/\/{2,}/g, '/');
  return UNTRACED_PATH.test(clean) || UNTRACED_PATH.test(decoded(clean));
}

function requestPath(attributes: Record<string, unknown>, name: string): string {
  for (const key of ['url.path', 'http.target']) {
    const value = attributes[key];
    if (typeof value === 'string' && value) return value;
  }
  // The root span of an incoming request is named "<METHOD> <path>".
  return name.replace(/^[A-Z]+\s+/, '');
}

/**
 * Samples only incoming HTTP requests (never background spans without a parent, such as the
 * queue or startup queries) with probability `rate`, and never the paths of `isUntracedPath`.
 *
 * The decision is taken here, with `Math.random()`, and returned as a boolean. Neither the
 * sampling decision of an incoming trace (`sentry-trace: ...-1`) nor its `sample_rand` (the
 * `baggage` entry `sentry-sample_rand=0`) can raise the fraction of sampled requests: both come
 * from headers any client can send. With a numeric rate the SDK would compare the incoming
 * `sample_rand` against it, and a client could sample all of its requests. The reported
 * `sample_rate` of a sampled trace is therefore 1, not `rate`.
 */
export function buildTracesSampler(rate: number): TracesSampler {
  if (rate <= 0) return () => 0;
  return (context) => {
    const attributes: Record<string, unknown> = context.attributes ?? {};
    if (attributes['sentry.op'] !== 'http.server') return false;
    if (isUntracedPath(requestPath(attributes, context.name ?? ''))) return false;
    return Math.random() < rate;
  };
}

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;
const EMAIL = /[^\s/@]+@[^\s/@]+\.[^\s/@]+/g;
/** Digits with spaces, dashes, dots, parentheses or a leading plus: phones and formatted ids. */
const SEPARATED_NUMBER = /\+?\(?\d[\d\s().-]*\d/g;
const LONG_NUMBER = /\d{4,}/g;
const MIN_SEPARATED_DIGITS = 7;

/**
 * Last line of defense: a route pattern has no ids, but a raw path must not slip through. Digits
 * separated by spaces, dashes, dots or parentheses (a phone, a formatted id) are masked as a
 * whole when they add up to 7 or more; versions (`1.2.3`), durations and status codes stay.
 */
export function maskIdentifiers(text: string): string {
  return text
    .replace(EMAIL, ':email')
    .replace(UUID, ':id')
    .replace(SEPARATED_NUMBER, (match) =>
      match.replace(/\D/g, '').length >= MIN_SEPARATED_DIGITS ? ':id' : match,
    )
    .replace(LONG_NUMBER, ':id');
}

const UNMATCHED = '<unmatched route>';

/**
 * Only a name that Sentry derived from the route pattern (`GET /api/v1/patients/:id`) is kept.
 * A name taken from the URL (no route matched: 400 before routing, 413, a wrong path) holds the
 * raw path, so it is reduced to the HTTP method.
 */
function parametrizedName(event: Event): string {
  const name = event.transaction ?? '';
  if (event.transaction_info?.source === 'route' && name) return maskIdentifiers(name);
  const method = /^[A-Z]+(?=\s)/.exec(name)?.[0] ?? event.request?.method?.toUpperCase();
  return `${method ?? 'HTTP'} ${UNMATCHED}`;
}

const BASE_DATA_KEYS = [
  'sentry.op',
  'sentry.origin',
  'sentry.source',
  'sentry.sample_rate',
  'http.request.method',
  'http.method',
  'http.response.status_code',
  'http.status_code',
  'http.route',
];

const TRACE_DATA_KEYS = new Set(BASE_DATA_KEYS);

/**
 * Span data is an allowlist too. Prisma's `model` and `method` (for example `Patient` and
 * `findMany`) say what was queried without saying for whom.
 */
const SPAN_DATA_KEYS = new Set([
  ...BASE_DATA_KEYS,
  'db.system',
  'db.operation',
  'db.operation.name',
  'db.collection.name',
  'db.sql.table',
  'model',
  'method',
  'express.type',
  'nestjs.type',
]);

function pick(source: object | undefined, allowed: ReadonlySet<string>): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(source ?? {})) {
    if (allowed.has(key) && value !== undefined) result[key] = value;
  }
  return result;
}

const PRISMA_SPAN_NAME = /^prisma:(?:client|engine):[a-z_]+$/;
const GENERIC_PRISMA_QUERY = 'prisma:engine:db_query';

function isDatabaseSpan(span: SpanJson): boolean {
  return (
    !!span.op?.startsWith('db') ||
    !!span.origin?.includes('.db.') ||
    Object.keys(span.data ?? {}).some((key) => key.startsWith('db.'))
  );
}

/** `GET https://host/path?token=x` becomes `GET host`: the path of a request may name a file. */
function describeHttpClient(description: string): string {
  const [method, target] = description.split(/\s+(.*)/s);
  if (!target) return maskIdentifiers(description);
  try {
    return `${method} ${new URL(target).host}`;
  } catch {
    return `${method} <url>`;
  }
}

/**
 * Prisma names its query spans after the SQL text (`SELECT ... WHERE "email" = $1`), and other
 * drivers do the same with the Redis key or the statement. A database span keeps only the name
 * of a Prisma operation (`prisma:client:operation`) or its kind; the SQL never leaves.
 */
function describe(span: SpanJson): string | undefined {
  const description = span.description;
  if (!description) return undefined;
  if (isDatabaseSpan(span)) {
    if (PRISMA_SPAN_NAME.test(description)) return description;
    return span.origin?.includes('prisma') ? GENERIC_PRISMA_QUERY : (span.op ?? 'db');
  }
  if (span.op?.startsWith('http.client') || /^[A-Z]+\s+https?:\/\//.test(description)) {
    return describeHttpClient(description);
  }
  return maskIdentifiers(description);
}

function scrubSpan(span: SpanJson): SpanJson {
  const scrubbed: SpanJson = {
    span_id: span.span_id,
    trace_id: span.trace_id,
    start_timestamp: span.start_timestamp,
    data: pick(span.data, SPAN_DATA_KEYS) as SpanJson['data'],
  };
  const description = describe(span);
  if (span.parent_span_id) scrubbed.parent_span_id = span.parent_span_id;
  if (span.timestamp !== undefined) scrubbed.timestamp = span.timestamp;
  if (span.op) scrubbed.op = span.op;
  if (description) scrubbed.description = description;
  if (span.status) scrubbed.status = span.status;
  if (span.origin) scrubbed.origin = span.origin;
  if (span.exclusive_time !== undefined) scrubbed.exclusive_time = span.exclusive_time;
  if (span.is_segment !== undefined) scrubbed.is_segment = span.is_segment;
  return scrubbed;
}

const TOP_LEVEL_KEYS = new Set([
  'type',
  'event_id',
  'timestamp',
  'start_timestamp',
  'platform',
  'release',
  'environment',
  'sdk',
  'measurements',
  'sdkProcessingMetadata',
]);

/** Dynamic sampling context: ids of the trace and settings only, never the transaction name. */
export const SAMPLING_CONTEXT_KEYS: ReadonlySet<string> = new Set([
  'trace_id',
  'public_key',
  'sample_rate',
  'sample_rand',
  'sampled',
  'release',
  'environment',
  'org_id',
]);

/**
 * Leaves in `sdkProcessingMetadata` only the dynamic sampling context, reduced to
 * `SAMPLING_CONTEXT_KEYS`. The SDK copies that context to the `trace` header of the envelope, and
 * for a sampled request it holds the name of the root span, which is created with the raw route
 * (`GET /api/v1/patients/<uuid>`), also for an ERROR event captured during the request. The rest
 * (`normalizedRequest`, the captured scopes) is dropped: it is only an input of the SDK and
 * the envelope is built without it.
 */
export function scrubSamplingMetadata(event: Event): void {
  const sampling = event.sdkProcessingMetadata?.dynamicSamplingContext;
  if (sampling) {
    event.sdkProcessingMetadata = {
      dynamicSamplingContext: pick(sampling, SAMPLING_CONTEXT_KEYS),
    } as NonNullable<Event['sdkProcessingMetadata']>;
  } else {
    delete event.sdkProcessingMetadata;
  }
}

const RUNTIME_CONTEXT_KEYS = new Set(['name', 'version']);

function scrubContexts(event: Event): Event['contexts'] {
  const contexts: NonNullable<Event['contexts']> = {};
  const trace = event.contexts?.trace;
  if (trace) {
    const { trace_id, span_id, parent_span_id, op, status, origin, data } = trace;
    contexts.trace = { trace_id, span_id, data: pick(data, TRACE_DATA_KEYS) } as NonNullable<
      NonNullable<Event['contexts']>['trace']
    >;
    if (parent_span_id) contexts.trace.parent_span_id = parent_span_id;
    if (op) contexts.trace.op = op;
    if (status) contexts.trace.status = status;
    if (origin) contexts.trace.origin = origin;
  }
  if (event.contexts?.runtime)
    contexts.runtime = pick(event.contexts.runtime, RUNTIME_CONTEXT_KEYS);
  const statusCode = event.contexts?.response?.status_code;
  if (typeof statusCode === 'number') contexts.response = { status_code: statusCode };
  return contexts;
}

/**
 * Rebuilds a transaction from an allowlist before it leaves the process. It never throws and
 * never lets an unscrubbed transaction through: when scrubbing fails the transaction is dropped
 * (null). What remains: the parametrized name, the method, durations, operations, statuses,
 * Prisma model and operation, `METHOD host` of outgoing calls, and the id of the trace.
 */
export function scrubTransaction<T extends Event>(event: T): T | null {
  try {
    const name = parametrizedName(event);
    const method = event.request?.method;
    const contexts = scrubContexts(event);
    const spans = event.spans?.map(scrubSpan);

    for (const key of Object.keys(event)) {
      if (!TOP_LEVEL_KEYS.has(key)) delete (event as Record<string, unknown>)[key];
    }
    event.transaction = name;
    event.transaction_info = { source: 'route' };
    event.contexts = contexts;
    if (spans) event.spans = spans;
    if (method) event.request = { method };
    scrubSamplingMetadata(event);
    return event;
  } catch {
    return null;
  }
}

interface ServerResponseLike {
  once(event: 'close', listener: () => void): unknown;
}

interface VercelRequestContext {
  waitUntil?: (task: Promise<unknown>) => void;
}

function vercelRequestContext(): VercelRequestContext | undefined {
  const holder = (globalThis as Record<symbol, unknown>)[Symbol.for('@vercel/request-context')] as
    { get?: () => VercelRequestContext | undefined } | undefined;
  try {
    return holder?.get?.();
  } catch {
    return undefined;
  }
}

/** The promise given to `waitUntil` never stays pending for longer than this. */
export const FLUSH_WAIT_LIMIT_MS = 10_000;

/**
 * A serverless function may freeze as soon as it answers, and a transaction is only built when
 * the response closes. For a sampled request, ask Vercel to keep the function alive until the
 * transaction is sent: `waitUntil` is registered NOW, inside the request (the Vercel context is
 * read synchronously, while it is active), with a promise that resolves once the response closed
 * and the flush ended, or after `FLUSH_WAIT_LIMIT_MS` if the response never closes. The response
 * itself is never delayed. Outside Vercel (a long-lived server) it does nothing: the SDK sends in
 * the background. Everything that can throw is guarded: tracing must never break a request nor
 * raise an uncaught exception.
 */
export function flushTransactionAfterResponse(
  span: { isRecording(): boolean },
  response: ServerResponseLike,
): void {
  try {
    if (!span.isRecording()) return;
    const context = vercelRequestContext();
    if (typeof context?.waitUntil !== 'function') return;

    const pending = new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, FLUSH_WAIT_LIMIT_MS);
      timer.unref?.();
      const finish = (): void => {
        clearTimeout(timer);
        resolve();
      };
      try {
        response.once('close', () => {
          // The SDK ends the span in its own `close` listener, registered after this one: wait one
          // tick so the transaction is already queued when the flush starts.
          try {
            setImmediate(() => {
              try {
                void flushReports().then(finish, finish);
              } catch {
                finish();
              }
            });
          } catch {
            finish();
          }
        });
      } catch {
        finish();
      }
    });
    context.waitUntil(pending);
  } catch {
    // Tracing must never break a request.
  }
}
