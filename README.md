# HCX Care API

Backend API for a multi-tenant platform for health clinics and practitioners built with NestJS + Prisma + PostgreSQL.

## Requirements

- Node.js 20+
- PostgreSQL 15+
- Redis 7+ (optional, only for reminders queue/scheduler)

## Quick start

1. Install dependencies:
```bash
npm ci
```

2. Configure environment:
```bash
cp .env.example .env
```

3. Generate Prisma client:
```bash
npm run prisma:generate
```

4. Apply migrations (if available):
```bash
npm run prisma:migrate
```

5. Run development server:
```bash
npm run start:dev
```

## Core endpoints

- API docs: `GET /api/v1/docs`
- Health check: `GET /health`
- Auth login: `POST /api/v1/auth/login`
  - Requires: `email`, `password`
  - The tenant is resolved from the user's unique identity.
- Treatments, consent templates and treatment sessions (form, consent, photos, start and
  completion): `/api/v1/tenants/:tenantId/treatments`, `…/consent-templates`,
  `…/patients/:patientId/treatment-sessions`, `…/treatment-sessions/:id` and
  `…/consent-documents/:id`; see `docs/API_ENDPOINTS.md`.

## Environment notes

- `THROTTLE_TTL` accepts seconds by default (e.g. `60`).
- `REDIS_URL` enables scheduler + queue workers and configures their Redis connection.
- CORS accepts `CORS_ORIGINS` (comma-separated), fallback is `FRONTEND_URL`.
- Password reset and invitation emails are sent from `EMAIL_FROM` through the SMTP server of
  the mail provider (the same one configured in Supabase Auth):
  - `SMTP_HOST`, `SMTP_PORT` (587 by default), `SMTP_USER`, `SMTP_PASS`
  - or, when `SMTP_HOST` is not set, an HTTP mail API: `EMAIL_API_URL`, `EMAIL_API_KEY`
- Clinical files are kept encrypted where `STORAGE_DRIVER` says: `local` (default, under
  `STORAGE_LOCAL_PATH`) or `supabase`, a private bucket of Supabase Storage (`SUPABASE_URL`,
  `SUPABASE_SECRET_KEY`, `SUPABASE_STORAGE_BUCKET`).
- Electronic invoicing uses Faktur. The URL, path and environment are the same for every
  clinic and are read only from these variables; each clinic stores its own API key,
  establishment, emission point and numbering in its settings:
  - `FAKTUR_API_URL`: base URL supplied by Faktur
  - `FAKTUR_INVOICE_PATH`: invoice resource path, defaults to `/invoices`
  - `FAKTUR_ENVIRONMENT`: `TEST` or `PRODUCTION`. Required: no invoice is issued without it
  - `FAKTUR_API_KEY`: credential used only by clinics that have not stored their own
  - `FAKTUR_TIMEOUT_MS`: request timeout, defaults to `15000`

Before issuing an invoice, save `legalName`, `taxIdentificationType` and
`taxIdentificationNumber` on the tenant. The billing endpoint sends the
customer, totals and `X-Idempotency-Key` to Faktur and stores the provider
response and PDF/XML links returned by the provider.

Billing endpoints:
- `POST /api/v1/tenants/:tenantId/billing/invoices`
- `GET /api/v1/tenants/:tenantId/billing/invoices`
- `GET /api/v1/tenants/:tenantId/billing/invoices/:invoiceId`

After deploying the migration, apply it with `npx prisma migrate deploy`.

## Scripts

- `npm run start:dev`: start with watch mode
- `npm run build`: production build
- `npm run lint`: ESLint
- `npm test`: unit tests
- `npm run test:e2e`: e2e tests
- `npm run prisma:generate`: Prisma client
- `npm run prisma:migrate`: create/apply dev migrations
- `npm run prisma:seed`: **deletes every row** of the database in `DATABASE_URL` and loads the
  demo data set (one clinic per plan and subscription state); prints the demo logins when done

## Docker

Development:
```bash
docker compose up --build
```

Production image:
```bash
docker build --target production -t psic-clinic-api:latest .
```

## CI

GitHub Actions workflow at `.github/workflows/ci.yml` runs:
- lint
- unit tests
- e2e tests
- build
