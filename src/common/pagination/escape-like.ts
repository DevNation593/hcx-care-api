/**
 * Makes `%`, `_` and `\` in a search term match themselves in a LIKE pattern.
 *
 * Prisma's `contains` / `startsWith` / `endsWith` do not escape the LIKE wildcards: a term of "%" or
 * "_" would match every row. Pass every user-supplied term through this before using it there.
 */
export function escapeLike(term: string): string {
  return term.replace(/[\\%_]/g, '\\$&');
}
