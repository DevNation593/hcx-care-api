import { ExecutionContext, SetMetadata } from '@nestjs/common';
import { ThrottlerGuard, ThrottlerOptions } from '@nestjs/throttler';
import type { ThrottlerRequest } from '@nestjs/throttler';
import { timingSafeEqual } from 'crypto';

/**
 * Rate limiting of the public scheduler tick (SEC-API-05), built from the regular throttler:
 *
 *  - "tick-invalid" counts only requests whose secret is wrong or missing: 10 per minute per client,
 *    then 429.
 *  - "tick-valid" counts only requests carrying the right secret, with a ceiling of its own (30 per
 *    minute). TickAwareThrottlerGuard also answers 429 to a valid secret once the client has used its
 *    10 invalid attempts in the window, so a right guess after the budget is not told apart from a
 *    wrong one; other clients are unaffected.
 *  - the route is skipped by the global default throttler (it would count both kinds in one bucket),
 *    and these two skip every other route.
 *
 * A secret shorter than 32 characters counts as unset: the route answers 404 and nothing is counted,
 * so the limiter reveals nothing about whether a secret is configured.
 *
 * Off Vercel X-Forwarded-For is client-controlled, so a client could rotate it to dodge the budget.
 * Storage is in memory per instance: on serverless the limits are best effort.
 */
const TICK_ROUTE = 'invoicing:tick-route';
export const TickRoute = () => SetMetadata(TICK_ROUTE, true);

export const isTickRoute = (context: ExecutionContext): boolean =>
  Reflect.getMetadata(TICK_ROUTE, context.getHandler()) === true;

export const MIN_TICK_SECRET_LENGTH = 32;

/** The configured secret, or undefined when unset or too short to be safe (treated as unset). */
export function configuredTickSecret(): string | undefined {
  const secret = process.env.INVOICING_TICK_SECRET;
  return secret && secret.length >= MIN_TICK_SECRET_LENGTH ? secret : undefined;
}

/** True when the Bearer value equals the tick secret, compared in constant time. */
export function hasValidTickSecret(authorization?: string): boolean {
  const secret = configuredTickSecret();
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
  isTickRoute(context) && !!configuredTickSecret() && !hasValidTickSecret(authorizationOf(context));
const countsAsValid = (context: ExecutionContext) =>
  isTickRoute(context) && hasValidTickSecret(authorizationOf(context));

export const INVALID_TICK_ATTEMPTS_PER_MINUTE = 10;
export const VALID_TICK_CALLS_PER_MINUTE = 30;

/** Throttler list shared by AppModule and the specs; `windowMs` is only shortened by tests. */
export function buildThrottlers(
  defaultThrottler: { ttl: number; limit: number },
  windowMs = 60_000,
): ThrottlerOptions[] {
  return [
    // The tick has its own throttlers; the default one never counts it.
    { ...defaultThrottler, skipIf: isTickRoute },
    {
      name: 'tick-invalid',
      ttl: windowMs,
      limit: INVALID_TICK_ATTEMPTS_PER_MINUTE,
      getTracker: tickClient,
      skipIf: (context) => !countsAsInvalid(context),
    },
    {
      name: 'tick-valid',
      ttl: windowMs,
      limit: VALID_TICK_CALLS_PER_MINUTE,
      getTracker: tickClient,
      skipIf: (context) => !countsAsValid(context),
    },
  ];
}

/**
 * ThrottlerGuard that, before counting a valid tick call, checks (without incrementing) whether the
 * client already used its invalid attempts, and answers 429 if so. It reads the in-memory storage of
 * the library; with any other storage the check is skipped and only the two buckets apply.
 */
export class TickAwareThrottlerGuard extends ThrottlerGuard {
  protected async handleRequest(props: ThrottlerRequest): Promise<boolean> {
    if (props.throttler.name === 'tick-valid') {
      const { req } = this.getRequestResponse(props.context);
      const tracker = await props.getTracker(req, props.context);
      const key = props.generateKey(props.context, tracker, 'tick-invalid');
      const record = (this.storageService as any).storage?.get?.(key);
      const used: number = record?.totalHits?.get('tick-invalid') ?? 0;
      if (record && used >= INVALID_TICK_ATTEMPTS_PER_MINUTE && record.expiresAt > Date.now()) {
        await this.throwThrottlingException(props.context, {
          limit: INVALID_TICK_ATTEMPTS_PER_MINUTE,
          ttl: props.ttl,
          key,
          tracker,
          totalHits: used,
          timeToExpire: Math.ceil((record.expiresAt - Date.now()) / 1000),
          isBlocked: true,
          timeToBlockExpire: Math.ceil((record.expiresAt - Date.now()) / 1000),
        });
      }
    }
    return super.handleRequest(props);
  }
}
