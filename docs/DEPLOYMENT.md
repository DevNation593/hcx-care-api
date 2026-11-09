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

## Facturación electrónica propia con el SRI

La API firma y envía las facturas (código `01`, XSD `1.1.0`) directamente a los servicios web del SRI. Ya no hay proveedor externo ni webhook. Los únicos hosts permitidos son `celcer.sri.gob.ec` (ambiente `1`, pruebas) y `cel.sri.gob.ec` (ambiente `2`, producción); no se siguen redirecciones. Historial: el proveedor anterior (Emite Fácil) se retiró con la migración `20261102000100_drop_emite_facil`.

### Variables de entorno

| Variable | Obligatoria | Uso |
| --- | --- | --- |
| `CLINICAL_ENCRYPTION_KEYS` | Sí, también en desarrollo | Cifra el `.p12` y su contraseña, los mensajes del SRI y los archivos (XML firmado, XML autorizado, RIDE). Sin ella la facturación responde `INVOICING_ENCRYPTION_REQUIRED`. Conserve todas las claves de descifrado al rotar. |
| `INVOICING_TICK_SECRET` | Sí en Vercel | Secreto Bearer de `POST /api/v1/internal/invoicing/tick`. Sin la variable, o con menos de 32 caracteres, la ruta responde 404 y el arranque registra un aviso (sin el valor). Genérelo con `openssl rand -hex 32`. |
| `INVOICING_INTERNAL_SCHEDULER` | No (por defecto `false`) | `true` ejecuta el mismo trabajo cada 10 s dentro de la API (desarrollo y servidores persistentes). Déjela en `false` en Vercel. Se ignora con `NODE_ENV=test`. |
| `STORAGE_DRIVER` y relacionadas | Sí | Los XML, los RIDE y el `.p12` de cada emisor (cifrado; en la base solo quedan su clave, su SHA-256 y la contraseña cifrada) se guardan con el `FILE_STORAGE`/`STORAGE_DRIVER` existente: use un almacenamiento persistente y con respaldo. Si el almacenamiento no responde, la emisión se reintenta (`INVOICING_CERTIFICATE_UNAVAILABLE`); si el archivo cambió, la solicitud falla con `CERTIFICATE_INTEGRITY` y hay que volver a subir el `.p12`. |

La variable del proveedor anterior ya no existe y `BACKEND_PUBLIC_URL` ya no se usa para facturar; quítelas del entorno si siguen configuradas. Pruebas locales: configure `DATABASE_URL` y `DATABASE_URL_TEST` hacia una base desechable y ejecute `npx jest --config test/jest-e2e.json --runInBand test/invoicing.e2e-spec.ts`, que usa un SRI simulado (`SRI_TEST_BASE_URL`, solo con `NODE_ENV=test`). Nunca la apunte a una base de clínicas reales.

### Procedimiento de despliegue de las migraciones

La base de Supabase es compartida con las demostraciones y con producción. Las migraciones, en el orden en que se aplican, son `20261102000000_own_sri_issuer` (crea emisor, secuenciales y columnas nuevas), `20261102000100_drop_emite_facil` (elimina el proveedor anterior y sus datos), `20261102000200_restore_one_blocking_per_order` (restaura el índice de una sola solicitud pendiente o autorizada por orden) y `20261102000300_issuer_certificate_in_storage` (pasa el `.p12` del emisor al almacenamiento de archivos). La `20261102000300` borra cualquier certificado guardado en la base junto con su contraseña y sus metadatos: esos consultorios deben volver a subir el `.p12`, y sus solicitudes pendientes aún sin firmar terminan en `FAILED` con `INVOICING_CERTIFICATE_REQUIRED`. Haga primero una copia de seguridad de la base. Siga estos pasos en orden.

#### 1. Antes de desplegar: auditoría de solo lectura

```bash
npm run prisma:audit-emite-facil-removal
```

Con `DATABASE_URL` apuntando a producción. El script corre en una transacción `READ ONLY` e imprime solo conteos e identificadores de consultorio (nunca contenido de documentos): solicitudes del proveedor anterior por ambiente y estado, órdenes que volverán a `PAID`, sesiones que pasarán a `BILLING_FAILED`, cadenas SRI que se reinician y lo que se borrará por consultorio. Si las migraciones ya se aplicaron responde `{ "alreadyApplied": true }`.

Termina con código **1** si `productionBlocking` es mayor que 0, es decir, si la migración abortaría. Eso significa que hay documentos del proveedor anterior en el ambiente de producción (`2`) autorizados, en proceso o con `requiresReconciliation`. En ese caso **no despliegue**: son posibles facturas reales. Resuélvalas con el proveedor anterior (confirmar que el SRI las autorizó o rechazó, y conservar sus XML/RIDE fuera de HCX si hacen falta) y repita la auditoría hasta que `productionBlocking` sea 0.

#### 2. Ventana de despliegue

Entre `npx prisma migrate deploy` y el momento en que la nueva compilación de la API recibe tráfico, la compilación anterior falla en todo lo que lee las columnas y tablas eliminadas, no solo en facturación: los reembolsos (`payments.service` lee `requiresReconciliation`), completar una sesión clínica (`treatment-sessions.service` selecciona todas las columnas de `InvoiceRequest`) y la elegibilidad de facturación de Caja (`eligibility-facts.ts` une la conexión eliminada). A la inversa, la compilación nueva falla contra la base sin migrar. Por eso esa ventana debe durar segundos:

1. Elija una hora de poco uso.
2. Compile la API nueva **sin promoverla**: `vercel deploy --prod --skip-domain` desde `api/`. La compilación no ejecuta migraciones (`prisma generate && nest build`). Anote la URL del despliegue que imprime. Si los despliegues de producción salen de Git, desactive antes «Auto-assign Custom Production Domains» en el proyecto para que el despliegue del merge tampoco se promueva solo.
3. Cuando ese despliegue esté `Ready`, ejecute `npx prisma migrate deploy` contra producción.
4. Inmediatamente después, `vercel promote <url del paso 2>`.
5. Verifique `GET /health` (queda fuera del prefijo `/api/v1`), una consulta de facturas, la facturación de una orden en Caja y completar una sesión (en un consultorio de demostración). Si desactivó la asignación automática de dominios, vuelva a activarla.

Si no puede compilar sin promover, programe una ventana de mantenimiento corta y avise a los consultorios: entre la migración y la promoción fallan los reembolsos, la facturación (también desde Caja) y completar sesiones clínicas.

#### 3. Si la guarda aborta la migración

La segunda migración comprueba, dentro de su propia transacción, que no queden documentos de producción del proveedor anterior; si los hay, falla con `Former provider requests in the production environment are authorized or pending; resolve them before removing the provider`. Los datos quedan **sin cambios**, pero Prisma marca la migración como fallida y bloquea nuevos despliegues. Después de resolver los documentos, ejecute antes de volver a desplegar:

```bash
npx prisma migrate resolve --rolled-back 20261102000100_drop_emite_facil
npx prisma migrate deploy
```

Si en cambio falló la primera migración, revise el error antes de marcarla; no la edite.

#### 4. Programación del tick (`pg_cron` + `pg_net`)

Las solicitudes pendientes (reintentos, consultas de autorización, artefactos y correos) se reanudan con `POST /api/v1/internal/invoicing/tick`, que Supabase llama cada minuto. Ejecute esto en el editor SQL del proyecto, sustituyendo `<INVOICING_TICK_SECRET>` por el valor configurado en Vercel:

```sql
create extension if not exists pg_cron;
create extension if not exists pg_net;
select cron.schedule('hcx-invoicing-tick', '* * * * *', $$
  select net.http_post(
    url := 'https://psychology-clinic-saas-api.vercel.app/api/v1/internal/invoicing/tick',
    headers := jsonb_build_object('Authorization', 'Bearer <INVOICING_TICK_SECRET>', 'Content-Type', 'application/json'),
    body := '{}'::jsonb,
    timeout_milliseconds := 55000);
$$);
```

El secreto queda guardado en el texto de la tarea; solo quien administra el proyecto de Supabase puede verlo. Para rotarlo, cambie la variable en Vercel, redespliegue y ejecute `select cron.unschedule('hcx-invoicing-tick');` seguido del bloque anterior con el valor nuevo.

La ruta está protegida por el secreto, comparado en tiempo constante, y por límites de peticiones por cliente (la IP es el primer valor de `X-Forwarded-For`, que Vercel fija con la IP real): los intentos con secreto ausente o incorrecto se limitan a 10 por minuto; agotados, todas las peticiones de ese cliente (incluida la del secreto correcto) responden 429 hasta que termina la ventana, y los demás clientes no se ven afectados. Las llamadas con el secreto válido tienen además su propio tope de 30 por minuto. Fuera de Vercel `X-Forwarded-For` lo controla el cliente, y el almacenamiento de los límites es en memoria por instancia (mejor esfuerzo en serverless). Los ticks concurrentes son seguros (`FOR UPDATE SKIP LOCKED` y presupuesto acotado de 45 s). Sin `INVOICING_TICK_SECRET` responde 404 (sin contar intentos); con un secreto incorrecto, 401.

Cómo revisar que corre:

```sql
select * from cron.job_run_details order by start_time desc limit 20;
```

`status = 'succeeded'` solo indica que se envió la petición. El resultado HTTP está en `net._http_response` (`select id, status_code, content, created from net._http_response order by created desc limit 20;`): debe ser 200 con un resumen del lote; 401 indica un secreto distinto y 404 que falta la variable en Vercel. Si hay filas con `status = 'failed'`, mire `return_message`.

`maxDuration` en Vercel: el tick usa un presupuesto de 45 s y el intento inline al crear una factura hasta 15 s, así que la función necesita **60 s**. En `api/` no hay `vercel.json` ni otra configuración de Vercel (la compilación la detecta Vercel desde `package.json` y el proyecto `hcx-care-api`), de modo que el valor se fija hoy en el panel: Project > Settings > Functions > Function Max Duration = 60 s, y se vuelve a desplegar. Si más adelante se versiona la configuración, sería la clave `functions.<archivo de la función>.maxDuration` de un `vercel.json` en `api/`. Compruebe que el plan de Vercel permite 60 s; con menos, el tick se corta a mitad del lote (es seguro, pero las facturas avanzan más lento).

#### 5. Prueba manual en `celcer` antes de pasar a producción

Ningún emisor debe pasar al ambiente `2` sin esta prueba con un certificado real. Hágala en un **consultorio de demostración desechable**, nunca con una venta real: la base es la de producción, una orden facturada queda `INVOICED` para siempre (no hay anulación ni nota de crédito) y la factura cuenta para el límite mensual del plan del consultorio.

1. En el consultorio de demostración, como `MASTER`, guarde el emisor con el RUC a probar y ambiente `1`, y suba el `.p12` real de prueba (el certificado de ese RUC y su contraseña; máx. 50 KB).
2. Defina el punto de emisión de una sucursal (establecimiento, punto, dirección y siguiente secuencial) y use `POST /invoicing/test`: debe confirmar que el certificado es válido y del RUC, y que los servicios del SRI responden.
3. Cree en ese consultorio una orden de prueba con un cliente ficticio, cóbrela, factúrela y espere el resultado (inline o por el tick). Debe llegar a `AUTHORIZED` con número y fecha de autorización, XML y RIDE descargables, y el correo al paciente si tiene email (use un correo propio).
4. Revise una factura rechazada de propósito (por ejemplo, con datos del cliente inválidos) para ver los mensajes del SRI y confirmar la reemisión con secuencial nuevo.
5. Solo entonces configure el emisor del consultorio real (mismo RUC y certificado) en el ambiente `2`, o cámbielo a `2` si ya existía. El cambio exige que no haya solicitudes `REQUESTED`/`PROCESSING` ni `AUTHORIZED` sin artefactos (`INVOICING_ENVIRONMENT_BUSY`). El RUC queda fijo tras la primera solicitud (`INVOICING_IDENTITY_LOCKED`).

**Secuenciales al pasar al ambiente `2`.** Los secuenciales se llevan por ambiente: al cambiar un emisor al ambiente `2`, cada punto de emisión empieza en el secuencial 1 aunque en pruebas haya llegado más lejos. Si el consultorio ya facturó en producción con otro sistema con ese establecimiento y punto, vuelva a definir el punto de emisión (`PUT /branches/:branchId/emission-point`) con `nextSequential` igual al último secuencial que emitió más uno, antes de la primera factura. Si no, el SRI la rechaza con el error 45 (secuencial registrado).

El régimen RIMPE `NEGOCIO_POPULAR` se rechaza con `RIMPE_REGIME_UNSUPPORTED` hasta verificar el XSD oficial (el `factura_V1.1.0.xsd` incluido solo acepta «CONTRIBUYENTE RÉGIMEN RIMPE»), así que esos consultorios no pueden facturar aún.

### Operación: solicitudes firmadas y filas detenidas

- **Nunca edite a mano una solicitud firmada** (con `signedXmlStorageKey`) ni su XML firmado. Desde la firma la solicitud no pasa a `FAILED`, conserva su secuencial y su clave de acceso, y todo reenvío usa los bytes guardados, verificados con su SHA-256. No se vuelve a firmar. Termina solo en `AUTHORIZED` o `REJECTED` según el SRI.
- **Fallos transitorios** (red, timeout, 5xx, `EN PROCESO`, almacenamiento caído): se reintentan con espera de 30 s a 30 min. No requieren intervención.
- **Fila detenida por integridad.** Si el SHA-256 del XML firmado guardado no coincide, la fila queda en `PROCESSING`, con evento `INTEGRITY_HALTED`, error `INVOICE_SIGNED_XML_INTEGRITY` y `nextAttemptAt` en `9999-12-31`, de modo que ningún tick la toma. Para encontrarlas:

  ```sql
  select r."id", r."tenantId", r."status", r."accessKey", r."updatedAt"
  from "InvoiceRequest" r
  where r."nextAttemptAt" >= '9999-01-01'
  order by r."updatedAt" desc;
  ```

  Un fallo al leer el archivo (falta o el almacenamiento no responde) no la detiene: solo se reintenta.
- **Reanudar una fila detenida:** primero investigue por qué cambió el archivo (restaure el respaldo del almacenamiento o localice la alteración) y confirme con el SRI el estado de la clave de acceso. Solo cuando los bytes guardados vuelvan a coincidir con `signedXmlSha256`, ponga `nextAttemptAt` en la fecha actual (`update "InvoiceRequest" set "nextAttemptAt" = now() at time zone 'utc' where "id" = '<id>' and "tenantId" = '<tenantId>' and "status" = 'PROCESSING' and "nextAttemptAt" >= '9999-01-01';`); confirme que se actualizó exactamente 1 fila (`UPDATE 1`), si no, revise el id antes de repetir y el siguiente tick la retoma. Nunca refirme ni edite el XML firmado ni su hash.
- Los mensajes del SRI se guardan cifrados y solo los ve quien tiene `billing.view`; no aparecen en logs ni en auditoría.

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

# Antivirus for patient files (SEG-09, CA-015). With FILE_SCAN_DRIVER=clamav every upload is
# scanned by a ClamAV daemon (clamd) before it is stored; an infected file is refused (422) and,
# while clamd does not answer, uploads are refused (503) rather than stored unscanned. Files
# stored before are scanned at their next download. clamd must run outside Vercel (a small VM or
# container with clamav-daemon and freshclam), reachable only from the API, on TCP 3310.
# Without FILE_SCAN_DRIVER files are stored as NOT_SCANNED and the API says so in its log.
FILE_SCAN_DRIVER=clamav
CLAMAV_HOST=<clamd-host>
CLAMAV_PORT=3310
FILE_SCAN_TIMEOUT_MS=30000

# Two-factor sign-in. Each clinic decides in Configuración whether to require it for its
# account holder and professionals; this requires it for the platform administrators.
PLATFORM_ADMIN_MFA_REQUIRED=true
# The name authenticator apps show next to the account.
MFA_ISSUER=HCX Care

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
5. `npm run platform:create-admin -- --email <email> --first-name <name> --last-name <surname>` (add `--password <password>`, or take the generated one it prints once). The `PLATFORM_ADMIN_*` variables of `.env.example` still work in place of the flags.
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

### 3. (Optional) Load the Demo Data

The seed **deletes every row** (and the stored clinical files, session photos and signed consents)
of the database in `DATABASE_URL`, production included, and loads the demos: Centro Médico Los
Arrayanes and Estudio Estético Aurora, an Estética clinic on treatments, consents and patient files.
It prints that database's host when it starts. Every account it creates,
including `admin@plataforma.test`, uses the demo password; create the real platform administrator
afterwards with `npm run platform:create-admin`, since the seed deletes it too.

```bash
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
