import { assertE2eDatabaseSafety } from './helpers/assert-e2e-database';

const testDatabaseUrl = process.env.DATABASE_URL_TEST;

assertE2eDatabaseSafety(testDatabaseUrl);

process.env.NODE_ENV = 'test';
process.env.DATABASE_URL = testDatabaseUrl;
// The suites issue many requests from one address within seconds; the production
// rate limit (per handler) would reject them with 429 and hide the behaviour under test.
process.env.THROTTLE_LIMIT = '10000';
process.env.AUTH_THROTTLE_LIMIT = '10000';
// The suites create users at test addresses: they must never reach the mail provider of
// `.env`. The ones that check mail point EMAIL_API_URL at a fake endpoint.
process.env.SMTP_HOST = '';
process.env.EMAIL_API_URL = '';
// Nor the bucket of `.env`: the files of the suites stay on the local disk.
process.env.STORAGE_DRIVER = 'local';
// A throwaway key so the suites exercise the same encrypted path as production.
process.env.CLINICAL_ENCRYPTION_KEYS = `e2e:${Buffer.alloc(32, 7).toString('base64')}`;
