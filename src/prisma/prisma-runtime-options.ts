import type { Prisma } from '@prisma/client';

/** Keep CLI/local connections intact while bounding each Vercel instance's pool. */
export function prismaRuntimeOptions(
  env: NodeJS.ProcessEnv = process.env,
): Prisma.PrismaClientOptions {
  if (env.VERCEL !== '1' || !env.DATABASE_URL) return {};

  let url: URL;
  try {
    url = new URL(env.DATABASE_URL);
  } catch {
    return {};
  }
  if (!['postgres:', 'postgresql:'].includes(url.protocol)) return {};

  // Supabase's shared session pooler caps clients at the backend pool size.
  // Its transaction endpoint shares those connections across serverless instances.
  if (url.hostname.endsWith('.pooler.supabase.com') && ['', '5432', '6543'].includes(url.port)) {
    url.port = '6543';
    url.searchParams.set('pgbouncer', 'true');
  }
  if (!url.searchParams.has('connection_limit')) url.searchParams.set('connection_limit', '1');

  return { datasources: { db: { url: url.toString() } } };
}
