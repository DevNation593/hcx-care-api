import { createHash } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';

/** Name of the cookie that carries the refresh token of the web client. */
export const REFRESH_COOKIE_NAME = 'refresh_token';

/** Header that identifies the web client; being non-simple it also forces a CORS preflight. */
export const CLIENT_HEADER = 'x-client';
export const WEB_CLIENT = 'web';

/**
 * The refresh token is stored as the SHA-256 (hex) of the JWT, so a leak of the table does not
 * reveal tokens that can be presented to POST /auth/refresh. The token is a signed, high-entropy
 * JWT, so a fast hash is enough (no salt or slow KDF is needed against guessing).
 */
export function hashRefreshToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

/** Parses a `Cookie` request header into name/value pairs (the first occurrence of a name wins). */
export function parseCookieHeader(header: string | string[] | undefined): Record<string, string> {
  const cookies: Record<string, string> = {};
  const raw = Array.isArray(header) ? header.join(';') : header;
  if (!raw) return cookies;
  for (const pair of raw.split(';')) {
    const separator = pair.indexOf('=');
    if (separator < 0) continue;
    const name = pair.slice(0, separator).trim();
    if (!name || Object.prototype.hasOwnProperty.call(cookies, name)) continue;
    let value = pair.slice(separator + 1).trim();
    if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) {
      value = value.slice(1, -1);
    }
    try {
      cookies[name] = decodeURIComponent(value);
    } catch {
      cookies[name] = value;
    }
  }
  return cookies;
}

type RequestLike = Pick<IncomingMessage, 'headers'>;
type ResponseLike = Pick<ServerResponse, 'setHeader'>;

/** True when the request comes from the web client (`X-Client: web`). */
export function isWebClient(req: RequestLike): boolean {
  const value = req.headers[CLIENT_HEADER];
  const header = Array.isArray(value) ? value[0] : value;
  return typeof header === 'string' && header.trim().toLowerCase() === WEB_CLIENT;
}

/**
 * How many `refresh_token` cookies the request carries. A browser sends several only when
 * another cookie of the same name was planted for a parent domain or a sibling path (cookie
 * tossing), and which one wins is not under our control.
 */
function refreshCookieCount(req: RequestLike): number {
  const header = req.headers.cookie;
  const raw = Array.isArray(header) ? header.join(';') : header;
  if (!raw) return 0;
  return raw.split(';').filter((pair) => pair.split('=')[0].trim() === REFRESH_COOKIE_NAME).length;
}

/** True when the request carries more than one `refresh_token` cookie: none of them is trusted. */
export function hasAmbiguousRefreshCookie(req: RequestLike): boolean {
  return refreshCookieCount(req) > 1;
}

/** The refresh token sent as a cookie, if there is exactly one. */
export function readRefreshCookie(req: RequestLike): string | undefined {
  if (hasAmbiguousRefreshCookie(req)) return undefined;
  return parseCookieHeader(req.headers.cookie)[REFRESH_COOKIE_NAME] || undefined;
}

/**
 * Every non-empty `refresh_token` value of the request, several included. Only for revoking
 * (logout): revoking a planted token is harmless, while trusting one to authenticate is not.
 */
export function readAllRefreshCookies(req: RequestLike): string[] {
  const header = req.headers.cookie;
  const raw = Array.isArray(header) ? header.join(';') : header;
  if (!raw) return [];
  const values: string[] = [];
  for (const pair of raw.split(';')) {
    const separator = pair.indexOf('=');
    if (separator < 0 || pair.slice(0, separator).trim() !== REFRESH_COOKIE_NAME) continue;
    const { [REFRESH_COOKIE_NAME]: value } = parseCookieHeader(pair);
    if (value) values.push(value);
  }
  return values;
}

/** The cookie is only sent to the auth routes of the API: `/<API_PREFIX>/auth`. */
export function refreshCookiePath(): string {
  const prefix = (process.env.API_PREFIX || 'api/v1').replace(/^\/+|\/+$/g, '');
  return prefix ? `/${prefix}/auth` : '/auth';
}

/** `Secure` everywhere but local development and tests, which run over plain http. */
function secureCookies(): boolean {
  return process.env.NODE_ENV !== 'development' && process.env.NODE_ENV !== 'test';
}

function cookieAttributes(maxAgeSeconds: number): string {
  const attributes = [
    `Max-Age=${maxAgeSeconds}`,
    `Path=${refreshCookiePath()}`,
    'HttpOnly',
    'SameSite=Lax',
  ];
  if (secureCookies()) attributes.push('Secure');
  return attributes.join('; ');
}

/** `Set-Cookie` value that stores the refresh token until it expires. */
export function buildRefreshCookie(token: string, expiresAt: Date, now = Date.now()): string {
  const maxAge = Math.max(0, Math.floor((expiresAt.getTime() - now) / 1000));
  return `${REFRESH_COOKIE_NAME}=${encodeURIComponent(token)}; ${cookieAttributes(maxAge)}`;
}

/** `Set-Cookie` value that removes the cookie (same attributes, `Max-Age=0`). */
export function buildClearedRefreshCookie(): string {
  return `${REFRESH_COOKIE_NAME}=; ${cookieAttributes(0)}`;
}

export function setRefreshCookie(res: ResponseLike, token: string, expiresAt: Date): void {
  res.setHeader('Set-Cookie', buildRefreshCookie(token, expiresAt));
}

export function clearRefreshCookie(res: ResponseLike): void {
  res.setHeader('Set-Cookie', buildClearedRefreshCookie());
}
