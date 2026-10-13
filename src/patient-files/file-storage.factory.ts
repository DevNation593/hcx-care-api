import { ConfigService } from '@nestjs/config';
import { FileStorage, LocalFileStorage } from './file-storage';
import { SupabaseFileStorage } from './supabase-file-storage';

/**
 * The storage chosen with `STORAGE_DRIVER`: `local` (default) or `supabase`. A chosen driver
 * that is not fully configured fails here, at startup, instead of writing somewhere else.
 */
export function createFileStorage(config: ConfigService): FileStorage {
  const driver = config.get<string>('STORAGE_DRIVER') || 'local';
  if (driver === 'local') return new LocalFileStorage(config);
  if (driver === 'supabase') return new SupabaseFileStorage(config);
  throw new Error(`Unknown STORAGE_DRIVER "${driver}": use "local" or "supabase"`);
}
