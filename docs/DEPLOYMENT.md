# Deployment Guide

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
# Project Settings > API Keys; it skips every policy, so it never leaves the server.
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
