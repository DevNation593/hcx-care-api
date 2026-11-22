import { ApiPropertyOptional } from '@nestjs/swagger';
import { plainToInstance, Transform, Type } from 'class-transformer';
import { IsInt, IsOptional, Max, Min, validateSync } from 'class-validator';
import { validationExceptionFactory } from '../errors/validation-errors';

export const DEFAULT_PAGE_LIMIT = 20;
export const MAX_PAGE_LIMIT = 100;
/** Keeps `skip` (page x limit) far inside the 32-bit range the query engine accepts. */
export const MAX_PAGE_NUMBER = 1_000_000;
/** A longer `search` is cut to this many characters instead of being rejected. */
export const MAX_SEARCH_LENGTH = 100;

/** An empty `?page=` / `?limit=` is "not sent" (Number('') would otherwise read as 0). */
const EmptyNumberToUndefined = () =>
  Transform(({ obj, key, value }: { obj: Record<string, unknown>; key: string; value: unknown }) =>
    obj[key] === '' ? undefined : value,
  );

/**
 * Query string of the lists that can be paged on the server.
 *
 * Paging is opt-in: a request without `page` and `limit` keeps the historical response (a bare
 * array), because the mobile app and other clients read it that way. Sending either one switches
 * the response to `{ data, meta }`.
 */
export class PaginationQueryDto {
  @ApiPropertyOptional({
    minimum: 1,
    default: 1,
    description:
      'Page number (1-based). Sending `page` or `limit` switches the response to `{ data, meta }`.',
  })
  @EmptyNumberToUndefined()
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(MAX_PAGE_NUMBER)
  page?: number;

  @ApiPropertyOptional({
    minimum: 1,
    maximum: MAX_PAGE_LIMIT,
    default: DEFAULT_PAGE_LIMIT,
    description:
      'Rows per page (1-100). Sending `page` or `limit` switches the response to `{ data, meta }`.',
  })
  @EmptyNumberToUndefined()
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(MAX_PAGE_LIMIT)
  limit?: number;
}

/**
 * Reads the list parameters of a request the way these endpoints always did: from a loose query
 * object that the global ValidationPipe does not check. A parameter this list does not know is
 * ignored, an empty one counts as not sent, and `search` is cut to MAX_SEARCH_LENGTH. Only the
 * known parameters that arrive with a value are validated, with the same 400 the pipe gives.
 */
export function parseListQuery<T extends object>(
  Dto: new () => T,
  raw: Record<string, unknown> | undefined,
  keys: readonly (keyof T & string)[],
): T {
  const picked: Record<string, unknown> = {};
  for (const key of keys) {
    const value = raw?.[key];
    if (value === undefined || value === '') continue;
    picked[key] =
      key === 'search' && typeof value === 'string' ? value.slice(0, MAX_SEARCH_LENGTH) : value;
  }
  const instance = plainToInstance(Dto, picked, { enableImplicitConversion: true });
  const errors = validateSync(instance, { whitelist: true });
  if (errors.length > 0) throw validationExceptionFactory(errors);
  return instance;
}

export interface PageRequest {
  page?: number;
  limit?: number;
}

export interface PageMeta {
  page: number;
  limit: number;
  total: number;
  totalPages: number;
}

export interface Paginated<T> {
  data: T[];
  meta: PageMeta;
}

/** True when the caller asked for a page, in which case the response gets the `{ data, meta }` shape. */
export function isPaginated(request: PageRequest | undefined): boolean {
  return request?.page !== undefined || request?.limit !== undefined;
}

/** The `skip`/`take` window of a page request; `page` defaults to 1 and `limit` to 20. */
export function pageWindow(request: PageRequest) {
  const page = request.page ?? 1;
  const limit = request.limit ?? DEFAULT_PAGE_LIMIT;
  return { page, limit, skip: (page - 1) * limit, take: limit };
}

export function pageMeta(total: number, page: number, limit: number): PageMeta {
  return { page, limit, total, totalPages: Math.ceil(total / limit) };
}
