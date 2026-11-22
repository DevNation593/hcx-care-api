// Must be the first import of main.ts so Sentry can instrument the rest of the app.
import * as Sentry from '@sentry/nestjs';
import { buildSentryOptions } from './common/monitoring/sentry-options';

const options = buildSentryOptions(process.env);
if (options) Sentry.init(options);
