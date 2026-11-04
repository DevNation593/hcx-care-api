import { ExecutionContext, SetMetadata } from '@nestjs/common';
import { ThrottlerOptions } from '@nestjs/throttler';
import { timingSafeEqual } from 'crypto';

/**
 * Rate limiting of the public scheduler tick (SEC-API-05), built from the regular throttler:
 *
 *  - "tick-invalid" counts only requests whose secret is wrong or missing: 10 per minute per client,
 *    then 429.
 *  - "tick-valid" counts only requests carrying the right secret: a generous ceiling of its own, so
 *    the route is never unthrottled, yet a client that exhausted the invalid budget (someone else's
 *    junk behind a shared address) cannot lock the legitimate scheduler out.
 *  - the route is skipped by the global default throttler (it would count both kinds in one bucket),
 *    and these two skip every other route.
 *
 * Without INVOICING_TICK_SECRET the route answers 404 and nothing is counted, so the limiter
 * reveals nothing about whether a secret is configured.
 */
const TICK_ROUTE = 'invoicing:tick-route';
export const TickRoute = () => SetMetadata(TICK_ROUTE, true);

export const isTickRoute = (context: ExecutionContext): boolean =>
  Reflect.getMetadata(TICK_ROUTE, context.getHandler()) === true;

/** True when the Bearer value equals INVOICING_TICK_SECRET, compared in constant time. */
export function hasValidTickSecret(authorization?: string): boolean {
  const secret = process.env.INVOICING_TICK_SECRET;
  if (!secret) return false;
  const given = Buffer.from(authorization?.startsWith('Bearer ') ? authorization.slice(7) : '');
  const expected = Buffer.from(secret);
  // timingSafeEqual throws on different lengths, so those are rejected first.
  return given.length === expected.length && timingSafeEqual(given, expected);
}

/** First address of X-Forwarded-For (Vercel sets it to the real client), else the socket address. */
export function tickClient(req: Record<string, any>): string {
  const forwarded = req.headers?.['x-forwarded-for'];
  const first = (Array.isArray(forwarded) ? forwarded[0] : forwarded)?.split(',')[0]?.trim();
  return first || req.ip || 'unknown';
}

const authorizationOf = (context: ExecutionContext): string | undefined =>
  context.switchToHttp().getRequest().headers?.authorization;

// A request is counted by exactly one of the two tick throttlers; the rest are skipped.
const countsAsInvalid = (context: ExecutionContext) =>
  isTickRoute(context) &&
  !!process.env.INVOICING_TICK_SECRET &&
  !hasValidTickSecret(authorizationOf(context));
const countsAsValid = (context: ExecutionContext) =>
  isTickRoute(context) && hasValidTickSecret(authorizationOf(context));

export const INVALID_TICK_ATTEMPTS_PER_MINUTE = 10;
export const VALID_TICK_CALLS_PER_MINUTE = 30;

export const tickThrottlers: ThrottlerOptions[] = [
  {
    name: 'tick-invalid',
    ttl: 60_000,
    limit: INVALID_TICK_ATTEMPTS_PER_MINUTE,
    getTracker: tickClient,
    skipIf: (context) => !countsAsInvalid(context),
  },
  {
    name: 'tick-valid',
    ttl: 60_000,
    limit: VALID_TICK_CALLS_PER_MINUTE,
    getTracker: tickClient,
    skipIf: (context) => !countsAsValid(context),
  },
];
