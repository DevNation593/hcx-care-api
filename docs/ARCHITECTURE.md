# Architecture Documentation

## System Overview

HCX Care is a **multi-tenant** backend system designed to manage health clinics and practitioners with:

- **Complete tenant isolation** (each clinic is a separate tenant)
- **Subscription-based seat licensing** (pay per psychologist)
- **Role-based access control** (TENANT_ADMIN, PSYCHOLOGIST, ASSISTANT)
- **Clinical compliance** (audit logging, restricted access)
- **Automated workflows** (appointment reminders, notifications)

## Core Architectural Patterns

### 1. Multi-Tenancy Model

**Strategy**: Row-Level Tenant Isolation

Every entity includes a `tenantId` foreign key. All queries are automatically scoped to the current user's tenant.

```typescript
// TenantGuard enforces isolation
@Injectable()
export class TenantGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const user = request.user;
    const tenantIdFromParams = request.params?.tenantId;
    
    // Validate tenant access
    if (tenantIdFromParams !== user.tenantId) {
      throw new ForbiddenException('Access denied: Tenant mismatch');
    }
    
    return true;
  }
}
```

**Benefits**:
- ✅ Simple to implement and reason about
- ✅ Good performance (single database)
- ✅ Easy to backup/restore per tenant
- ✅ Clear data boundaries

**Trade-offs**:
- ⚠️ Need careful query filtering (always include tenantId)
- ⚠️ Shared database resources (can't isolate compute per tenant)
- ⚠️ Schema changes affect all tenants

### 2. Authentication & Authorization

**JWT Strategy with Refresh Token Rotation**

```
┌─────────────┐
│   Client    │
└──────┬──────┘
       │ 1. Login (email/password)
       v
┌─────────────────────┐
│   Auth Service      │
│  - Verify password  │
│  - Generate tokens  │
└──────┬──────────────┘
       │
       v
┌──────────────────────────┐
│  Access Token (15min)    │  ← Short-lived, for API calls
│  Refresh Token (7 days)  │  ← Long-lived, for renewal
└──────────────────────────┘
       │
       │ 2. API Request (with access token)
       v
┌─────────────────────┐
│  JwtAuthGuard       │
│  - Validate token   │
│  - Extract user     │
└──────┬──────────────┘
       │
       v
┌──────────────────────┐
│  PasswordChangeGuard │
│  - Temporary password│
└──────┬───────────────┘
       │
       v
┌─────────────────────┐
│  TenantGuard        │
│  - Check tenantId   │
│  - Platform routes  │
└──────┬──────────────┘
       │
       v
┌─────────────────────┐
│  RolesGuard         │
│  - Check role       │
└──────┬──────────────┘
       │
       v
┌─────────────────────┐
│  SubscriptionGuard  │
│  FeatureGuard       │
│  SectionGuard       │
└──────┬──────────────┘
       │
       v
   Execute endpoint
```

The global guards run in this order (`src/auth/auth.module.ts`): `JwtAuthGuard`, `PasswordChangeGuard`, `TenantGuard`, `RolesGuard`, `SubscriptionGuard`, `FeatureGuard`, `SectionGuard` (the throttler runs before all of them).

- `PasswordChangeGuard` answers `403 PASSWORD_CHANGE_REQUIRED` while the user has `mustChangePassword = true`, except on public routes and on routes marked `@SessionRoute()` (`POST /auth/logout`, `POST /auth/logout-all`, `POST /auth/change-password`). `JwtStrategy.validate` reads `mustChangePassword` and `isPlatformTenant` from the database on every request.
- `TenantGuard` on a `@PlatformRoute()` controller requires `role === 'ADMIN'` and a platform tenant, and does not compare `:tenantId` with the caller's tenant. Outside platform routes an `ADMIN` receives `403 PLATFORM_ONLY` (session routes excepted).
- `SubscriptionGuard`, `FeatureGuard` and `SectionGuard` do not apply to platform routes or to `@SessionRoute()` routes.
- `SectionGuard` reads `@RequireSection('core.<section>')` and answers `403 SECTION_NOT_ENABLED` when the clinic's `TenantModule` row is missing or disabled.

**Refresh Token Rotation**:
- Each refresh generates a new token pair
- Old refresh token is immediately revoked
- Tokens belong to a "family" (tracked by `familyId`)
- If a revoked token is used → entire family is revoked (security breach detected)

**Roles**:

`MASTER` es el titular de la cuenta del consultorio: hay exactamente uno por tenant (índice único parcial `User_tenantId_master_key`), lo crea el `ADMIN` de plataforma al dar de alta el consultorio y no puede cambiar de rol ni desactivarse. `ADMIN` es el administrador de la plataforma: solo accede a `/platform/*` y no concede acceso a datos internos de ningún consultorio. `SOPORTE` es un valor obsoleto sin poderes (sus funciones pasaron a `ADMIN`). `CLIENTE` y `PSICOLOGO` son valores obsoletos sin usuarios.

**Consultorio de plataforma**: el `ADMIN` pertenece a un consultorio reservado, `Tenant.isPlatform = true` (a lo sumo uno, índice único parcial `Tenant_isPlatform_key`). Lo crea `npm run platform:create-admin`; no tiene `TenantSettings`, `TenantSubscription` ni secciones, y los listados y el resumen del panel lo excluyen. Las rutas `/platform/*` (módulo `src/platform/`) llevan `@PlatformRoute()` y `@Roles('ADMIN')`.

**Secciones `core.*`**: qué partes de la app usa cada consultorio se guarda como filas de `TenantModule` con claves `core.calendar`, `core.patients`, `core.tasks`, `core.clinicalNotes`, `core.specialties`, `core.billing`, `core.team` y `core.storage`. El catálogo (claves, dependencias y premarcado por plan y tipo) vive en `src/common/sections/section-catalog.ts`. Solo el `ADMIN` las cambia (`PUT /platform/tenants/:tenantId/sections`); el titular recibe `403 SECTION_MANAGED_BY_PLATFORM` si intenta cambiar una clave `core.*`. `core.storage` no tiene `@RequireSection`: solo oculta la pantalla en la web.

### 3. Subscription & Seat Management

**Seat Enforcement Flow**:

```
User (TENANT_ADMIN) → Create PSYCHOLOGIST
                          ↓
              Check TenantSubscription
                          ↓
        ┌─────────────────┴─────────────────┐
        │                                   │
   seatsPsychologistsUsed               seatsPsychologistsUsed
   < seatsPsychologistsMax              >= seatsPsychologistsMax
        │                                   │
        v                                   v
   Create user                         Throw 403
   Increment seatsPsychologistsUsed    SEAT_LIMIT_REACHED
```

**Key Implementation**:

```typescript
private async checkSeatAvailability(tenantId: string) {
  const subscription = await this.prisma.tenantSubscription.findUnique({
    where: { tenantId },
  });

  if (subscription.seatsPsychologistsUsed >= subscription.seatsPsychologistsMax) {
    throw new ForbiddenException({
      error: 'SEAT_LIMIT_REACHED',
      message: `Seat limit reached. Current plan allows ${subscription.seatsPsychologistsMax} psychologist(s).`,
      details: { ... }
    });
  }
}
```

**Seat Tracking**:
- Only `PSYCHOLOGIST` role counts
- `TENANT_ADMIN` and `ASSISTANT` are free
- Deactivating a psychologist frees up a seat
- Changing role from/to PSYCHOLOGIST updates count

### 4. Appointment Conflict Detection

**Algorithm**:

```typescript
// Check if new appointment overlaps with existing ones
const conflicts = await prisma.appointment.findMany({
  where: {
    tenantId,
    psychologistId,
    status: { notIn: ['CANCELLED', 'NO_SHOW'] },
    OR: [
      // New starts during existing
      { startTime: { lte: newStart }, endTime: { gt: newStart } },
      // New ends during existing
      { startTime: { lt: newEnd }, endTime: { gte: newEnd } },
      // New contains existing
      { startTime: { gte: newStart }, endTime: { lte: newEnd } },
    ],
  },
});

if (conflicts.length > 0) {
  throw new ConflictException({ conflicts });
}
```

**Visualization**:

```
Existing:  |-------|
New:            |-------|  ❌ Overlaps

Existing:  |-------|
New:               |-------|  ✅ Back-to-back OK

Existing:     |-------|
New:       |-------------|  ❌ Contains existing
```

### 5. Clinical Notes Security & Audit

**Access Control**:
- Psychologists can only read/write their own notes
- TENANT_ADMIN can override (compliance requirement)
- Every access is logged in AuditLog

**Audit Trail**:

```typescript
await this.prisma.auditLog.create({
  data: {
    tenantId,
    userId,
    action: 'READ', // CREATE, READ, UPDATE, DELETE
    entity: 'CLINICAL_NOTE',
    entityId: noteId,
    changes: { ... }, // Before/after values
    ipAddress: req.ip,
    userAgent: req.headers['user-agent'],
  },
});
```

**Encryption at Rest** (always on, every plan):

Clinical note text, specialty record data and the clinical snapshots of the audit log are
encrypted by `ClinicalCryptoService` (`src/clinical-access/`) before they reach PostgreSQL and
decrypted when a service returns them.

Uses AES-256-GCM with:
- Random IV per value
- Authentication tag for integrity, bound to the tenant id
- Keys from `CLINICAL_ENCRYPTION_KEYS`, with key ids so keys can be rotated

Details, key handling and rotation: `docs/CLINICAL_DATA_PROTECTION.md`.

### 6. Background Jobs (BullMQ)

**Architecture**:

```
┌────────────────────┐
│  Scheduler Service │  (Cron: every 15 min)
└─────────┬──────────┘
          │
          v
┌──────────────────┐
│  BullMQ Queue    │  (Redis-backed)
│  "reminders"     │
└─────────┬────────┘
          │
          v
┌──────────────────────┐
│  Reminder Processor  │
│  - Find appointments │
│  - Send notifications│
│  - Track sent status │
└──────────────────────┘
```

**Reminder Logic**:

```typescript
// For each tenant with reminderEnabled
for (const hoursBefore of [24, 2]) {
  // Find appointments starting in ~hoursBefore hours
  const startTimeFrom = now + hoursBefore * 60min - 30min;
  const startTimeTo = now + hoursBefore * 60min + 30min;
  
  const appointments = find({
    startTime: { gte: startTimeFrom, lte: startTimeTo },
    reminderSent24h: hoursBefore === 24 ? false : undefined,
    reminderSent2h: hoursBefore === 2 ? false : undefined,
  });
  
  for (const appt of appointments) {
    sendNotification(appt);
    markReminderSent(appt, hoursBefore);
  }
}
```

**Job Configuration**:

```typescript
await queue.add('check-appointments', {}, {
  attempts: 3,
  backoff: {
    type: 'exponential',
    delay: 5000, // 5s, 25s, 125s
  },
});
```

### 7. Notifications (In-App + FCM)

**Dual Notification Strategy**:

1. **In-App**: Always stored in `NotificationLog`
2. **Push**: Optionally sent via FCM (if configured)

```typescript
// Create in-app notification
await prisma.notificationLog.create({ ... });

// Send push notification (if FCM configured)
if (firebaseApp && user.fcmToken) {
  await firebaseApp.messaging().send({
    token: user.fcmToken,
    notification: { title, body },
    data: { ... },
  });
}
```

**FCM Setup**:
- Requires Firebase service account credentials
- Frontend registers FCM token on login
- Token stored in user profile
- Notifications sent to all active user devices

## Data Flow Examples

### Creating a Tenant (platform ADMIN)

```
POST /platform/tenants
   │
   ├─> Guards: ADMIN of the platform tenant
   │
   ├─> Validate input (DTO), plan/tenant-type match, section keys and dependencies
   │
   ├─> Serializable transaction (advisory lock on the owner email, with retries):
   │   ├─> Check the owner email is unique across the platform (409)
   │   ├─> Create Tenant + TenantSettings
   │   ├─> Create TenantSubscription (TRIAL: 14 days; paid plan: ACTIVE, one month)
   │   ├─> Create MASTER user (mustChangePassword = true)
   │   ├─> Apply the specialty selection
   │   └─> Create the eight core.* TenantModule rows
   │
   └─> Return tenant, owner (no password), subscription and sections
```

### Creating a User (Invite Flow)

```
POST /tenants/:id/users/invite
   │
   ├─> [JwtAuthGuard] Verify token
   │
   ├─> [TenantGuard] Verify tenantId matches
   │
   ├─> [RolesGuard] Verify role = TENANT_ADMIN
   │
   ├─> If role = PSYCHOLOGIST:
   │   └─> Check seat availability
   │
   ├─> Transaction:
   │   ├─> Create User (isActive=false)
   │   └─> Increment seatsPsychologistsUsed
   │
   ├─> Send invitation email (TODO)
   │
   └─> Return user (without password)
```

### Appointment Reminder Worker

```
Every 15 minutes:
   │
   ├─> Query active tenants with reminderEnabled
   │
   ├─> For each tenant:
   │   ├─> Get reminder rules (e.g., ["24h", "2h"])
   │   │
   │   ├─> For each rule:
   │   │   ├─> Find appointments starting in ~rule hours
   │   │   ├─> Filter out already-sent reminders
   │   │   │
   │   │   ├─> For each appointment:
   │   │   │   ├─> Create in-app notification
   │   │   │   ├─> Send FCM push (if configured)
   │   │   │   └─> Mark reminderSent24h/2h = true
   │   │   │
   │   │   └─> Log success/failure
   │   │
   │   └─> Next tenant
   │
   └─> Report total sent
```

## Database Design Principles

### Normalization
- 3NF (Third Normal Form)
- Clear foreign key relationships
- Proper indexing on foreign keys and query columns

### Soft Deletes
- `deletedAt` timestamp for Patient (compliance)
- Keeps historical data intact
- Easy to restore

### Timestamps
- `createdAt` and `updatedAt` on all entities
- Audit trail support
- Query by date ranges

### Enums
- TypeScript types match Prisma enums
- Validated at runtime (class-validator)
- Type-safe in code

## Performance Considerations

### Database Optimization
- ✅ Indexes on foreign keys (tenantId, userId, patientId, etc.)
- ✅ Composite indexes for common queries (tenantId + startTime)
- ✅ Pagination on list endpoints (default limit: 50-100)
- ⚠️ N+1 queries prevented with Prisma includes

### Caching Strategy (Future)
- Redis cache for:
  - Tenant settings (TTL: 1 hour)
  - User profiles (TTL: 15 minutes)
  - Subscription limits (TTL: 5 minutes)
- Cache invalidation on updates

### Rate Limiting
- Global: 60 requests / minute
- Auth endpoints: 5 requests / minute
- Prevents brute-force attacks

## Scalability Path

### Horizontal Scaling
1. **API Servers**: Stateless → easy to add more instances
2. **Database**: Read replicas for reports/analytics
3. **Redis**: Redis Cluster for job queue distribution
4. **Background Workers**: Multiple worker instances processing jobs

### Vertical Scaling
- Increase database resources (CPU, RAM)
- Optimize queries with EXPLAIN ANALYZE
- Add materialized views for complex reports

### Monitoring
- Application Performance Monitoring (APM): DataDog, New Relic
- Log aggregation: ELK Stack, Grafana Loki
- Metrics: Prometheus + Grafana
- Health checks: `/health` endpoint

## Security Checklist

- ✅ JWT with refresh token rotation
- ✅ Password hashing (bcrypt, 10 rounds)
- ✅ Tenant isolation (enforced at guard level)
- ✅ Role-based access control
- ✅ Rate limiting on auth
- ✅ Input validation (class-validator)
- ✅ SQL injection prevention (Prisma parameterized queries)
- ✅ Audit logging for sensitive operations
- ⚠️ HTTPS required in production
- ⚠️ CORS configured (whitelist origins)
- ⚠️ Helmet.js for security headers (recommended)

## Compliance & GDPR

### Data Privacy
- Patient data belongs to tenant
- Tenant admins can export/delete all data
- Soft deletes preserve audit trail
- Clinical notes, specialty records and their audit snapshots encrypted at rest

### Audit Trail
- All clinical note accesses logged
- Immutable audit log (no deletes)
- Queryable by admin
- Retention policy (configurable)

### Right to be Forgotten
- Soft delete patient → marks deletedAt
- Hard delete (admin action) → removes from database
- Cascading deletes configured in Prisma schema

---

**Last Updated**: 2024-12-15
