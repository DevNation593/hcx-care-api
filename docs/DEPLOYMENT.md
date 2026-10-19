# Deployment Guide

## Platform control of clinic roles and modules

Deploy migration `20261018000000_platform_role_permissions` before deploying the new API and web. It creates `TenantRolePermission`, which is the source of truth for permissions of `MASTER`, `PROFESIONAL` and `ASISTENTE` in each clinic. The former per-user permission rows remain in the database for historical review but are no longer read or editable.

CI exercises the migration with legacy grants and revocations in a separate schema of the disposable test database through `npm run prisma:verify-platform-role-permissions`. The verification confirms that revocations become clinic-role restrictions, personal grants are not widened to a whole role, and historical rows remain available.

The migration deliberately avoids granting an action to an entire role because one user previously received it. Every old personal revocation becomes a revocation for that clinic role, so other users of the same role can temporarily lose that action. The platform owner should review the role settings for each clinic after deployment and reassign allowed actions in the platform panel. Review existing overrides before migration with this read-only query:

```sql
SELECT up."tenantId", u."role", up."permission", up."granted", COUNT(*) AS users
FROM "UserPermission" up
JOIN "User" u ON u."id" = up."userId" AND u."tenantId" = up."tenantId"
GROUP BY up."tenantId", u."role", up."permission", up."granted"
ORDER BY up."tenantId", u."role", up."permission", up."granted";
```

Apply the migration with `npx prisma migrate deploy` against the intended database, then deploy the API and web together. The clinic master can continue editing clinic settings and staff accounts, while section, specialty, clinical module and role permission assignments belong to the platform owner. Subscription feature flags follow the plan.

## Vercel and Supabase database connections

The shared Supabase pooler's session endpoint (port `5432`) limits concurrent clients
to its backend pool size. With serverless instances this can produce
`EMAXCONNSESSION: max clients reached in session mode` and HTTP 500 responses across
clinical modules, encounters and other database-backed routes.

When `VERCEL=1`, `PrismaService` uses the shared Supabase pooler's transaction endpoint
(port `6543`) with `pgbouncer=true`. It defaults the Prisma pool to
`connection_limit=1`, preserving an explicit connection limit, credentials and all
other URL parameters. For other PostgreSQL hosts, it only supplies the default pool
limit. The override is local to the runtime client: Prisma CLI and local processes
continue using the configured `DATABASE_URL` for migrations and development.

Deploy the API after this change so new Vercel instances use the runtime settings.
The clinical web change also requires deploying the web. No new schema migration is
needed for this connection fix. See the
[Supabase Prisma troubleshooting guide](https://supabase.com/docs/guides/database/prisma/prisma-troubleshooting#max-client-connections-reached).

## emite-facil electronic invoicing (B2)

Configure `EMITE_FACIL_API_URL` manually with the real provider host and full `/api/v1`
path. `.env.example` intentionally leaves it blank. It is global server configuration;
never accept a provider URL or expose an API key in the web client. No live provider
host was inferred or tested during implementation.

`CLINICAL_ENCRYPTION_KEYS` is required before saving a connection or invoice intent,
including development. It encrypts API keys, optional webhook secrets, immutable fiscal
intent, resolved provider JSON, SRI explanations and downloaded artifacts. Preserve all
decryption keys during rotation. Use the existing `FILE_STORAGE` driver with persistent,
backed-up storage; authorized invoices remain authorized while missing artifacts retry.

Deployment order: back up the intended database, run `npx prisma migrate deploy`, then
`npm run build` and restart API processes. New migration:
`20261017000000_emite_facil_b2`. It adds five models and a partial unique index blocking
duplicate live/authorized/uncertain requests per order; historical Faktur tables remain.
The migration was validated only on a disposable local PostgreSQL test database. No
production migration was executed by the implementation session.

The API scheduler dispatches every10 seconds and reconciles every minute, using durable
120-second recoverable leases and CAS. Multiple API replicas may run it concurrently.
Outbound calls occur outside long transactions. Retries use exponential30 seconds to
30 minutes, honoring Retry-After. After24h a pre-document request may show FAILED;
an uncertain result remains blocked and keeps recovering its identical body/key.
Do not manually clear `requiresReconciliation` or generate a new provider key for it.

MASTER tests/saves the API key in HCX and chooses issuer and branch emission points.
Company/issuer cannot change after first use. Key rotation is allowed for that identity.
Switching issuer environment1->2 requires no active/uncertain request and no authorized
artifacts pending. Save the same issuer again to refresh its provider environment.
Old rejected documents cannot be replaced across environments. Pending documents keep
their original environment snapshot and are rechecked before invoice POST.

Optional webhook: set `BACKEND_PUBLIC_URL` to the absolute public API root without
`API_PREFIX` (default `api/v1`). Missing/invalid base yields `webhookUrl:null`. Register
the returned callback URL in emite-facil using an authorized owner/admin session, then
paste its one-time `whsec_...` secret into HCX. The static API key cannot manage provider
webhook subscriptions. Raw body preservation is enabled; proxies must preserve bytes
and signature headers. Reconciliation works without webhook. Callback rate limit300/min;
protected list/detail polling120/min. No SRI certificates/retry management is added to HCX.

SIGNATURE_FAILED is recoverable on the same provider document. Correct its signing
configuration and use emite-facil's retry there; keep HCX PROCESSING and payment/reissue
locks until the same document reaches a known result. SRI explanations remain encrypted
and are shown only to authorized billing viewers, never copied into audit events/logs.

For local verification set both DATABASE_URL and DATABASE_URL_TEST to a dedicated test
database, JWT_ACCESS_SECRET/JWT_REFRESH_SECRET to disposable values, REDIS_URL empty,
and run `npx jest --config test/jest-e2e.json --runInBand test/invoicing.e2e-spec.ts`.
That suite uses a local HTTP simulator and explicit worker calls; worker cron wrappers
are disabled when NODE_ENV=test. Never point it at a real clinic database.

## Pre-Deployment Checklist

### Security
- [ ] Change all default secrets in `.env`
- [ ] Generate strong JWT secrets (min 32 characters)
- [ ] Configure CORS with allowed origins
- [ ] Set up HTTPS/TLS certificates
- [ ] Configure rate limiting
- [ ] Enable Helmet.js security headers
- [ ] Configure Firebase credentials for FCM

### Database
- [ ] Set up managed PostgreSQL instance
- [ ] Configure connection pooling
- [ ] Set up database backups
- [ ] Configure read replicas (optional)
- [ ] Run migrations

### Cache & Queue
- [ ] Set up managed Redis instance
- [ ] Configure Redis ACLs
- [ ] Set up Redis persistence (AOF + RDB)

### Monitoring
- [ ] Set up logging aggregation
- [ ] Configure APM (Application Performance Monitoring)
- [ ] Set up error tracking (Sentry, etc.)
- [ ] Configure health check endpoints

## Environment Variables (Production)

```env
# Application
NODE_ENV=production
PORT=3000

# Database
DATABASE_URL="postgresql://user:password@production-db-host:5432/dbname?schema=public&connection_limit=10"

# Redis
REDIS_URL=redis://:strong-redis-password@production-redis-host:6379

# JWT
JWT_ACCESS_SECRET=<generate-with-openssl-rand-base64-32>
JWT_REFRESH_SECRET=<generate-with-openssl-rand-base64-32>
JWT_ACCESS_EXPIRATION=15m
JWT_REFRESH_EXPIRATION=7d

# Firebase (FCM)
FCM_PROJECT_ID=your-production-project-id
FCM_PRIVATE_KEY="-----BEGIN PRIVATE KEY-----\n...\n-----END PRIVATE KEY-----\n"
FCM_CLIENT_EMAIL=firebase-adminsdk@your-project.iam.gserviceaccount.com

# Required: transactional e-mail (password reset and invitations).
# SMTP of the mail provider, the same values configured in Supabase
# (Authentication > Emails > SMTP Settings). Port 587 requires STARTTLS; 465 uses implicit TLS.
SMTP_HOST=<provider-smtp-host>
SMTP_PORT=587
SMTP_USER=<provider-smtp-user>
SMTP_PASS=<provider-smtp-password>
EMAIL_FROM="HCX Care <no-reply@yourdomain.com>"
# Alternative when SMTP_HOST is not set: an HTTP mail API that accepts
# { from, to, subject, html, text } with a Bearer key.
# EMAIL_API_URL=https://api.resend.com/emails
# EMAIL_API_KEY=<provider-api-key>
# Base URL of the web app: the links in the messages point here.
FRONTEND_URL=https://app.yourdomain.com

# Required: clinical data encryption (the API does not start in production without it).
# See CLINICAL_DATA_PROTECTION.md for generation, storage and rotation.
CLINICAL_ENCRYPTION_KEYS=<key-id>:<base64 of 32 random bytes>

# Required: where the clinical files are kept (already encrypted by the API).
# Create one private bucket in Supabase Storage, without policies. The secret key is in
# Project Settings > API Keys: use an sb_secret_ key or legacy service_role JWT, not an S3
# access secret or JWT signing secret. It skips every policy, so it never leaves the server.
# The API does not start when a value is missing. Without STORAGE_DRIVER the files go to
# the disk of the server (STORAGE_LOCAL_PATH), which then needs a persistent, backed-up volume.
STORAGE_DRIVER=supabase
SUPABASE_URL=https://<project-ref>.supabase.co
SUPABASE_SECRET_KEY=<secret-key>
SUPABASE_STORAGE_BUCKET=<private-bucket>

# CORS
CORS_ORIGINS=https://app.yourdomain.com,https://www.yourdomain.com
```

Generate strong secrets:
```bash
openssl rand -base64 32
```

### Moving existing clinical files to Supabase Storage

Keep `STORAGE_DRIVER=local` (or unset) until the copy has finished. The bucket must already
exist in the **same Supabase project as `DATABASE_URL`** and be private. `SUPABASE_URL` can use
the project's usual `https://<ref>.supabase.co` host or its direct
`https://<ref>.storage.supabase.co` host. Configure
`SUPABASE_URL`, `SUPABASE_SECRET_KEY`, `SUPABASE_STORAGE_BUCKET`, and the same
`CLINICAL_ENCRYPTION_KEYS` used by the production API in the migration environment.
Keep the secret key and clinical key outside version control.
Check `storage.objects` policies before copying: any `SELECT` or `ALL` policy that includes
the clinical bucket can allow reads despite `public=false`. A dedicated clinical bucket
should have no such policies.

```sql
SELECT policyname, roles, cmd, qual
FROM pg_policies
WHERE schemaname = 'storage' AND tablename = 'objects';
```

From the API directory, point the script at the existing, backed-up local storage directory:

```bash
STORAGE_MIGRATION_SOURCE_DIR=/absolute/path/to/storage npm run prisma:migrate-local-storage
STORAGE_MIGRATION_SOURCE_DIR=/absolute/path/to/storage npm run prisma:migrate-local-storage -- --execute
```

The first command is a dry run. It checks every database-referenced object, including
soft-deleted clinical files, and reports missing files and how many sources still contain
plaintext. The second command encrypts legacy plaintext files with the active clinical key,
uploads encrypted bytes, downloads each object to verify it, and can be rerun if interrupted.
It never deletes local files. Deploy the Storage API key fix while the API still uses local
storage. For the final copy, stop every API and worker process that can write local files;
keep writes paused until the new driver starts. Run `--execute` again during that pause and
require `verified` to equal `planned`. Then set `STORAGE_DRIVER=supabase` in the API's private
environment and restart the API and workers. Check a download through the API before resuming
writes. Keep the local volume until the new storage path is included in your backups.

## Deployment Options

### Option 1: Docker (Recommended)

#### 1. Build Production Image

```bash
docker build --target production -t psic-clinic-api:latest .
```

#### 2. Push to Registry

```bash
# Docker Hub
docker tag psic-clinic-api:latest yourusername/psic-clinic-api:latest
docker push yourusername/psic-clinic-api:latest

# AWS ECR
aws ecr get-login-password --region us-east-1 | docker login --username AWS --password-stdin <account>.dkr.ecr.us-east-1.amazonaws.com
docker tag psic-clinic-api:latest <account>.dkr.ecr.us-east-1.amazonaws.com/psic-clinic-api:latest
docker push <account>.dkr.ecr.us-east-1.amazonaws.com/psic-clinic-api:latest
```

#### 3. Deploy with Docker Compose (Production)

Create `docker-compose.prod.yml`:

```yaml
version: '3.8'

services:
  api:
    image: yourusername/psic-clinic-api:latest
    restart: always
    ports:
      - "3000:3000"
    environment:
      - NODE_ENV=production
      - DATABASE_URL=${DATABASE_URL}
      - REDIS_URL=${REDIS_URL}
      - JWT_ACCESS_SECRET=${JWT_ACCESS_SECRET}
      - JWT_REFRESH_SECRET=${JWT_REFRESH_SECRET}
      - FCM_PROJECT_ID=${FCM_PROJECT_ID}
      - FCM_PRIVATE_KEY=${FCM_PRIVATE_KEY}
      - FCM_CLIENT_EMAIL=${FCM_CLIENT_EMAIL}
    healthcheck:
      test: ["CMD", "curl", "-f", "http://localhost:3000/health"]
      interval: 30s
      timeout: 10s
      retries: 3
      start_period: 40s
    logging:
      driver: "json-file"
      options:
        max-size: "10m"
        max-file: "3"
```

Deploy:
```bash
docker-compose -f docker-compose.prod.yml up -d
```

### Option 2: AWS ECS (Elastic Container Service)

#### 1. Create Task Definition

```json
{
  "family": "psic-clinic-api",
  "networkMode": "awsvpc",
  "requiresCompatibilities": ["FARGATE"],
  "cpu": "512",
  "memory": "1024",
  "containerDefinitions": [
    {
      "name": "api",
      "image": "<account>.dkr.ecr.us-east-1.amazonaws.com/psic-clinic-api:latest",
      "portMappings": [
        {
          "containerPort": 3000,
          "protocol": "tcp"
        }
      ],
      "environment": [
        {
          "name": "NODE_ENV",
          "value": "production"
        }
      ],
      "secrets": [
        {
          "name": "DATABASE_URL",
          "valueFrom": "arn:aws:secretsmanager:region:account:secret:db-url"
        },
        {
          "name": "JWT_ACCESS_SECRET",
          "valueFrom": "arn:aws:secretsmanager:region:account:secret:jwt-access"
        }
      ],
      "logConfiguration": {
        "logDriver": "awslogs",
        "options": {
          "awslogs-group": "/ecs/psic-clinic-api",
          "awslogs-region": "us-east-1",
          "awslogs-stream-prefix": "api"
        }
      },
      "healthCheck": {
        "command": ["CMD-SHELL", "curl -f http://localhost:3000/health || exit 1"],
        "interval": 30,
        "timeout": 5,
        "retries": 3,
        "startPeriod": 60
      }
    }
  ]
}
```

#### 2. Create Service

```bash
aws ecs create-service \
  --cluster production-cluster \
  --service-name psic-clinic-api \
  --task-definition psic-clinic-api \
  --desired-count 2 \
  --launch-type FARGATE \
  --network-configuration "awsvpcConfiguration={subnets=[subnet-xxx, subnet-yyy],securityGroups=[sg-xxx],assignPublicIp=ENABLED}" \
  --load-balancers "targetGroupArn=arn:aws:elasticloadbalancing:...,containerName=api,containerPort=3000"
```

### Option 3: Kubernetes

#### 1. Create Deployment

`k8s/deployment.yaml`:

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: psic-clinic-api
spec:
  replicas: 3
  selector:
    matchLabels:
      app: psic-clinic-api
  template:
    metadata:
      labels:
        app: psic-clinic-api
    spec:
      containers:
      - name: api
        image: yourusername/psic-clinic-api:latest
        ports:
        - containerPort: 3000
        env:
        - name: NODE_ENV
          value: "production"
        - name: DATABASE_URL
          valueFrom:
            secretKeyRef:
              name: app-secrets
              key: database-url
        - name: JWT_ACCESS_SECRET
          valueFrom:
            secretKeyRef:
              name: app-secrets
              key: jwt-access-secret
        livenessProbe:
          httpGet:
            path: /health
            port: 3000
          initialDelaySeconds: 30
          periodSeconds: 10
        readinessProbe:
          httpGet:
            path: /health
            port: 3000
          initialDelaySeconds: 10
          periodSeconds: 5
        resources:
          requests:
            memory: "512Mi"
            cpu: "250m"
          limits:
            memory: "1Gi"
            cpu: "500m"
```

#### 2. Create Service

`k8s/service.yaml`:

```yaml
apiVersion: v1
kind: Service
metadata:
  name: psic-clinic-api
spec:
  type: LoadBalancer
  selector:
    app: psic-clinic-api
  ports:
  - port: 80
    targetPort: 3000
```

#### 3. Create Secrets

```bash
kubectl create secret generic app-secrets \
  --from-literal=database-url="postgresql://..." \
  --from-literal=jwt-access-secret="..." \
  --from-literal=jwt-refresh-secret="..."
```

#### 4. Deploy

```bash
kubectl apply -f k8s/deployment.yaml
kubectl apply -f k8s/service.yaml
```

### Option 4: Platform-as-a-Service (Heroku, Render, Railway)

#### Heroku Example

1. Install Heroku CLI and login
2. Create app:
```bash
heroku create psic-clinic-api
```

3. Add PostgreSQL:
```bash
heroku addons:create heroku-postgresql:standard-0
```

4. Add Redis:
```bash
heroku addons:create heroku-redis:premium-0
```

5. Set environment variables:
```bash
heroku config:set NODE_ENV=production
heroku config:set JWT_ACCESS_SECRET=<secret>
heroku config:set JWT_REFRESH_SECRET=<secret>
heroku config:set FCM_PROJECT_ID=<project-id>
# etc...
```

6. Deploy:
```bash
git push heroku main
```

7. Run migrations:
```bash
heroku run npm run prisma:migrate
```

## Database Setup

### 1. Run Migrations

```bash
# Production environment
DATABASE_URL="postgresql://..." npm run prisma:migrate deploy
```

### 1b. Platform administration panel rollout

The platform panel release needs a maintenance window. Deploy the API and the web together: an old web would offer the public signup against an endpoint that no longer exists (`POST /onboarding/tenants` and `POST /tenants` answer 404).

**Prerequisite:** load real contact data (WhatsApp or email) in `web/src/content/site.ts` (T-12). Without it the demo form is not shown and, with signup closed, the public site has no way to capture leads.

**Before applying the migration**, run this against the target database; it must return zero rows (the panel relies on there being no RLS policies):

```sql
SELECT * FROM pg_policies;
```

Steps:

1. Back up the database.
2. Stop the API.
3. `npx prisma migrate deploy`. Migration `20261006000000_platform_admin_sections` stacks on `20261003000000`, `20261004000000` and `20261005000000`, which have never been applied either.
4. Start the new API.
5. `npm run platform:create-admin` with `PLATFORM_ADMIN_EMAIL`, `PLATFORM_ADMIN_PASSWORD`, `PLATFORM_ADMIN_FIRST_NAME` and `PLATFORM_ADMIN_LAST_NAME` set (see `.env.example`).
6. `npm run prisma:verify-platform-sections`. Exit code 0 means nothing blocks the release.
7. Deploy the web.

Rollback: restore the backup.

Before production, run once against a disposable database (`DATABASE_URL_TEST`): the migration, the verification script and `npm run test:e2e`.

### 1c. Billing profiles (B1 cash register)

Right after `prisma migrate deploy` for B1, run once:

```bash
DATABASE_URL="postgresql://..." npm run prisma:migrate-billing-profiles
```

It turns the legacy billing fields of live patients into billing profiles linked as their default. It does not assign permissions; the platform administrator grants `billing.view` and `billing.create` to clinic roles when needed. Profiles are created on behalf of each tenant's MASTER user. It prints a JSON summary (never identification numbers); patients listed in `skippedInvalid` were not migrated, each with its reason: `EMAIL_MISSING` (no billing or patient email), `IDENTIFICATION_INVALID` (the number does not pass the SRI validation), `TAX_ID_TYPE_INVALID` (the patient has a tax id but its legacy type is missing or unknown) and `MASTER_MISSING` (the tenant has no MASTER user to own the profile; the patient is skipped until one exists and the script runs again). For each of them, create the profile in the patient's «Perfiles de facturación». It is idempotent, but it only needs to run once, at the B1 deploy.

Deploy the B1 web together with or before the B1 API. The B1 API rejects the fields the previous web sends (`billing*` on patient create/edit and `faktur*` on clinic settings answer 400 under `forbidNonWhitelisted`), so an old web against the new API breaks patient create/edit and clinic settings saves until the web is updated.

### 2. Generate Prisma Client

```bash
npm run prisma:generate
```

### 3. (Optional) Seed Development Data

```bash
# Only for staging/development
npm run prisma:seed
```

## SSL/TLS Configuration

### Using Nginx as Reverse Proxy

`/etc/nginx/sites-available/psic-clinic-api`:

```nginx
upstream api {
    server localhost:3000;
}

server {
    listen 80;
    server_name api.yourdomain.com;
    return 301 https://$server_name$request_uri;
}

server {
    listen 443 ssl http2;
    server_name api.yourdomain.com;

    ssl_certificate /etc/letsencrypt/live/api.yourdomain.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/api.yourdomain.com/privkey.pem;
    ssl_protocols TLSv1.2 TLSv1.3;
    ssl_ciphers HIGH:!aNULL:!MD5;

    location / {
        proxy_pass http://api;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_cache_bypass $http_upgrade;
    }
}
```

Enable and restart:
```bash
sudo ln -s /etc/nginx/sites-available/psic-clinic-api /etc/nginx/sites-enabled/
sudo nginx -t
sudo systemctl restart nginx
```

### Let's Encrypt Certificate

```bash
sudo apt-get install certbot python3-certbot-nginx
sudo certbot --nginx -d api.yourdomain.com
```

## Monitoring & Logging

### Health Check Endpoint

Already implemented in `main.ts`:

```
GET /health
```

Returns:
```json
{
  "status": "ok",
  "timestamp": "2024-03-15T10:00:00.000Z"
}
```

### Logging with Winston (Optional)

Install:
```bash
npm install winston nest-winston
```

Configure in `main.ts`:
```typescript
import { WinstonModule } from 'nest-winston';
import * as winston from 'winston';

const logger = WinstonModule.createLogger({
  transports: [
    new winston.transports.Console({
      format: winston.format.combine(
        winston.format.timestamp(),
        winston.format.json(),
      ),
    }),
  ],
});

app.useLogger(logger);
```

### Error Tracking with Sentry

Install:
```bash
npm install @sentry/node
```

Configure in `main.ts`:
```typescript
import * as Sentry from '@sentry/node';

Sentry.init({
  dsn: process.env.SENTRY_DSN,
  environment: process.env.NODE_ENV,
  tracesSampleRate: 0.1,
});
```

### APM with DataDog (Optional)

```bash
npm install dd-trace
```

Create `datadog.ts`:
```typescript
import tracer from 'dd-trace';

tracer.init({
  service: 'psic-clinic-api',
  env: process.env.NODE_ENV,
});

export default tracer;
```

Import FIRST in `main.ts`:
```typescript
import './datadog'; // Must be first
import { NestFactory } from '@nestjs/core';
```

## Scaling Strategies

### Horizontal Scaling

- **API Servers**: Run multiple instances behind load balancer
- **Background Workers**: Scale worker processes independently
- **Database**: Use read replicas for queries, primary for writes

### Vertical Scaling

- Increase container resources (CPU, RAM)
- Optimize database queries with indexes
- Use Redis caching for frequently accessed data

### Auto-Scaling (AWS ECS Example)

```bash
aws application-autoscaling register-scalable-target \
  --service-namespace ecs \
  --scalable-dimension ecs:service:DesiredCount \
  --resource-id service/cluster-name/service-name \
  --min-capacity 2 \
  --max-capacity 10

aws application-autoscaling put-scaling-policy \
  --policy-name cpu-scaling \
  --service-namespace ecs \
  --scalable-dimension ecs:service:DesiredCount \
  --resource-id service/cluster-name/service-name \
  --policy-type TargetTrackingScaling \
  --target-tracking-scaling-policy-configuration file://scaling-policy.json
```

`scaling-policy.json`:
```json
{
  "TargetValue": 75.0,
  "PredefinedMetricSpecification": {
    "PredefinedMetricType": "ECSServiceAverageCPUUtilization"
  },
  "ScaleInCooldown": 300,
  "ScaleOutCooldown": 60
}
```

## Backup & Disaster Recovery

### Database Backups

#### Automated Backups (PostgreSQL)

```bash
# Daily backup cron job
0 2 * * * pg_dump -h localhost -U postgres -d psic_clinic_prod > /backups/psic_$(date +\%Y\%m\%d).sql
```

#### AWS RDS Automated Backups

- Enable automated backups (retention: 7-35 days)
- Configure backup window during low traffic
- Test restore process monthly

### Restore Procedure

```bash
# Restore from backup
psql -h localhost -U postgres -d psic_clinic_prod < /backups/psic_20240315.sql
```

## CI/CD Pipeline

### GitHub Actions Example

`.github/workflows/deploy.yml`:

```yaml
name: Deploy to Production

on:
  push:
    branches:
      - main

jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v3
      - uses: actions/setup-node@v3
        with:
          node-version: '20'
      - run: npm ci
      - run: npm run test
      - run: npm run test:e2e

  build-and-deploy:
    needs: test
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v3
      
      - name: Build Docker image
        run: docker build --target production -t psic-clinic-api:${{ github.sha }} .
      
      - name: Push to ECR
        env:
          AWS_ACCESS_KEY_ID: ${{ secrets.AWS_ACCESS_KEY_ID }}
          AWS_SECRET_ACCESS_KEY: ${{ secrets.AWS_SECRET_ACCESS_KEY }}
        run: |
          aws ecr get-login-password --region us-east-1 | docker login --username AWS --password-stdin ${{ secrets.ECR_REPOSITORY }}
          docker tag psic-clinic-api:${{ github.sha }} ${{ secrets.ECR_REPOSITORY }}:latest
          docker push ${{ secrets.ECR_REPOSITORY }}:latest
      
      - name: Deploy to ECS
        run: |
          aws ecs update-service --cluster production --service psic-clinic-api --force-new-deployment
```

## Post-Deployment Verification

### 1. Check Health Endpoint

```bash
curl https://api.yourdomain.com/health
```

### 2. Test Authentication

```bash
curl -X POST https://api.yourdomain.com/api/v1/auth/login \
  -H "Content-Type: application/json" \
  -d '{"email":"admin@test.com","password":"test"}'
```

### 3. Verify Database Connection

Check logs for successful connection.

### 4. Test Background Jobs

Verify reminder jobs are running:
```bash
docker logs -f <container-id> | grep "Reminder check"
```

### 5. Monitor Error Rates

Check APM dashboard for:
- Response times
- Error rates
- Database query performance
- Redis hit rates

## Rollback Procedure

### Docker/ECS

```bash
# Revert to previous image
aws ecs update-service --cluster production --service psic-clinic-api --task-definition psic-clinic-api:<previous-revision>
```

### Kubernetes

```bash
# Rollback deployment
kubectl rollout undo deployment/psic-clinic-api

# Rollback to specific revision
kubectl rollout undo deployment/psic-clinic-api --to-revision=2
```

## Maintenance

### Database Maintenance

```sql
-- Vacuum and analyze
VACUUM ANALYZE;

-- Reindex
REINDEX DATABASE psic_clinic_prod;

-- Check table sizes
SELECT relname, pg_size_pretty(pg_total_relation_size(relid))
FROM pg_catalog.pg_statio_user_tables
ORDER BY pg_total_relation_size(relid) DESC;
```

### Redis Maintenance

```bash
# Check memory usage
redis-cli info memory

# Clear specific keys if needed
redis-cli FLUSHDB
```

---

**Last Updated**: 2024-12-15
