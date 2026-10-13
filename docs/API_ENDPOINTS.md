## Billing

All billing routes require a JWT and the `MASTER` or `PROFESIONAL` role. The
tenant must have fiscal data before an invoice can be issued.

### Issue invoice

`POST /api/v1/tenants/:tenantId/billing/invoices`

```json
{
  "subtotal": 149.99,
  "tax": 17.99,
  "description": "Suscripción Clinic Pro - septiembre 2026",
  "idempotencyKey": "subscription-tenant-period-2026-09"
}
```

The API creates a `PENDING` invoice, sends it to Faktur, and stores it as
`ISSUED` or `FAILED`. Reusing `idempotencyKey` returns the existing invoice.

### List invoices

`GET /api/v1/tenants/:tenantId/billing/invoices`

### Get invoice

`GET /api/v1/tenants/:tenantId/billing/invoices/:invoiceId`
# API Endpoints Reference

Base URL: `http://localhost:3000/api/v1`

## Authentication

All endpoints except the public ones (`/auth/login`, `/auth/refresh`, `/auth/forgot-password`, `/auth/reset-password`) require Bearer token authentication. There is no public signup: clinics are created by the platform `ADMIN` (see [Platform](#platform)).

```
Authorization: Bearer <access_token>
```

## Quick Start Flow

### 1. Create Tenant (platform ADMIN only)

Clinics are created with `POST /platform/tenants` by the platform `ADMIN`, who hands the temporary password to the owner (`MASTER`). The owner must change it on the first login. See [Platform](#platform).

### 2. Login

```bash
POST /auth/login
Content-Type: application/json

{
  "email": "titular@miclinica.com",
  "password": "<temporary or own password>"
}
```

Response:
```json
{
  "accessToken": "eyJhbGc...",
  "refreshToken": "eyJhbGc...",
  "user": {
    "id": "...",
    "email": "admin@miclinica.com",
    "firstName": "Juan",
    "lastName": "Pérez",
    "role": "MASTER",
    "tenantId": "...",
    "mustChangePassword": false
  }
}
```

### 3. Invite Psychologist

```bash
POST /tenants/{tenantId}/users/invite
Authorization: Bearer <token>
Content-Type: application/json

{
  "email": "doctora@miclinica.com",
  "firstName": "María",
  "lastName": "González",
  "phone": "+52 555 987 6543",
  "role": "PSYCHOLOGIST"
}
```

**If seat limit reached:**
```json
{
  "statusCode": 403,
  "error": "SEAT_LIMIT_REACHED",
  "message": "Seat limit reached. Current plan allows 1 psychologist(s). Please upgrade your plan.",
  "details": {
    "seatsPsychologistsMax": 1,
    "seatsPsychologistsUsed": 1,
    "planType": "BASIC"
  }
}
```

### 4. Create Patient

```bash
POST /tenants/{tenantId}/patients
Authorization: Bearer <token>
Content-Type: application/json

{
  "firstName": "Pedro",
  "lastName": "Martínez",
  "email": "pedro@email.com",
  "phone": "+52 555 111 2222",
  "dateOfBirth": "1985-06-15",
  "emergencyContact": "Ana Martínez",
  "emergencyPhone": "+52 555 333 4444"
}
```

### 5. Create Appointment (with Conflict Detection)

```bash
POST /tenants/{tenantId}/appointments
Authorization: Bearer <token>
Content-Type: application/json

{
  "patientId": "patient-id",
  "psychologistId": "psychologist-user-id",
  "title": "Sesión de terapia cognitivo-conductual",
  "startTime": "2024-03-15T10:00:00Z",
  "duration": 60,
  "location": "Consultorio 1",
  "isOnline": false
}
```

**Success Response:**
```json
{
  "id": "appointment-id",
  "startTime": "2024-03-15T10:00:00Z",
  "endTime": "2024-03-15T11:00:00Z",
  "status": "SCHEDULED",
  "patient": {
    "id": "...",
    "firstName": "Pedro",
    "lastName": "Martínez"
  },
  "psychologist": {
    "id": "...",
    "firstName": "María",
    "lastName": "González"
  }
}
```

**Conflict Response:**
```json
{
  "statusCode": 409,
  "error": "APPOINTMENT_CONFLICT",
  "message": "This time slot conflicts with existing appointment(s)",
  "conflicts": [
    {
      "id": "existing-appointment-id",
      "patient": "Juan Pérez",
      "startTime": "2024-03-15T09:30:00Z",
      "endTime": "2024-03-15T10:30:00Z"
    }
  ]
}
```

### 6. Create Clinical Note (with Audit Log)

```bash
POST /tenants/{tenantId}/clinical-notes
Authorization: Bearer <token>
Content-Type: application/json

{
  "patientId": "patient-id",
  "appointmentId": "appointment-id",
  "content": "Paciente refiere mejoría en síntomas de ansiedad. Se observa mejor manejo de técnicas de relajación.",
  "diagnosis": "Trastorno de ansiedad generalizada (F41.1)",
  "treatment": "Continuar con TCC, énfasis en exposición gradual",
  "observations": "Programar seguimiento en 2 semanas",
  "sessionDuration": 60
}
```

This automatically creates an audit log entry tracking the creation.

#### Clinical content rules

Clinical notes, specialty records and the clinical timeline require an **active professional profile** in the tenant. A `MASTER` without one, an inactive profile, `ASISTENTE` and `SOPORTE` receive `403 PROFESSIONAL_NOT_AUTHORIZED` (or the role guard's 403). Every professional of the tenant reads the shared history; only the author corrects or removes a record (`403 CLINICAL_RECORD_FORBIDDEN` otherwise). Every read, creation, correction and removal is written to the audit log with the actor, patient, IP and user agent.

```bash
# Correct a note: the reason is mandatory, the version is incremented and
# the previous state is kept in the audit log. patientId and appointmentId cannot change.
PATCH /tenants/{tenantId}/clinical-notes/{noteId}
{ "content": "Texto corregido", "changeReason": "Error de transcripción" }

# Remove a note: soft delete with a mandatory reason. The row is kept for audit.
DELETE /tenants/{tenantId}/clinical-notes/{noteId}
{ "reason": "Nota registrada en el paciente equivocado" }

# Shared timeline: appointments, notes and specialty records, newest first.
GET /tenants/{tenantId}/patients/{patientId}/clinical-timeline?type=CLINICAL_NOTE&specialtyId=...&professionalId=...&from=...&to=...
```

Specialty records can only be created under the author's own specialty.

#### Clinical modules, tenant forms and records

Every clinical record follows a **definition**: one version of a module the platform defines in code (`src/clinical-modules/definitions`) or of a form the clinic designed. The API validates the data against that definition, computes its calculated fields and stores the version used, so a record is always read with the definition it was written under.

```bash
# Every version of every module and tenant form. `canRecord` marks the versions the caller may
# write: enabled for the clinic, current, and within the caller's specialty.
#   scope GENERAL   -> any professional (general.vital-signs, general.diagnoses, general.allergies,
#                      general.orders, general.referrals, general.soap-note); general.prescriptions
#                      only for prescribing specialties
#   scope SPECIALTY -> professionals of that specialty, when the clinic has the module enabled
#   scope CUSTOM    -> forms of the clinic, served as custom.<formDefinitionId>
GET /tenants/{tenantId}/clinical-modules

# Create a record. `schemaVersion` is the version returned above. Calculated fields are ignored
# if sent. Invalid data answers 422 CLINICAL_RECORD_INVALID with `details: [{ field, message }]`.
POST /tenants/{tenantId}/patients/{patientId}/specialty-records
{ "moduleKey": "general.vital-signs", "schemaVersion": 1, "data": { "weightKg": 70, "heightCm": 170 } }

# Records carry `alerts: [{ level, message }]`, the alert rules of their definition they trigger.
GET /tenants/{tenantId}/patients/{patientId}/specialty-records?moduleKey=...

# Standing alerts of the patient: every allergy record and the latest record of each other module.
GET /tenants/{tenantId}/patients/{patientId}/specialty-records/alerts

# Correct (author only): validated against the version the record was written under.
PATCH /tenants/{tenantId}/patients/{patientId}/specialty-records/{recordId}
{ "data": { "weightKg": 69.5, "heightCm": 170 }, "changeReason": "Peso mal digitado" }

# Remove (author only): soft delete with a mandatory reason.
DELETE /tenants/{tenantId}/patients/{patientId}/specialty-records/{recordId}
{ "reason": "Paciente equivocado" }
```

A request without `schemaVersion` comes from a client older than the definitions: it is checked against the legacy version of the module when one exists (the previous required keys, any value), otherwise against the current one. Other codes: `400 CLINICAL_MODULE_UNKNOWN`, `409 CLINICAL_MODULE_VERSION_OUTDATED`.

```bash
# Forms designed by the clinic (MASTER writes; MASTER and PROFESIONAL read).
GET   /tenants/{tenantId}/form-definitions
POST  /tenants/{tenantId}/form-definitions
{ "name": "Ficha de lesión", "category": "Evaluación", "specialtyCode": null,
  "schema": { "sections": [{ "key": "injury", "title": "Lesión", "fields": [
    { "key": "pain", "label": "Dolor", "type": "scale", "min": 0, "max": 10, "required": true } ] }],
    "alerts": [{ "when": "pain >= 8", "level": "critical", "message": "Dolor intenso" }] } }

# Name, description, category, specialty and status change in place. A schema that differs from
# the current one is stored as the next version; earlier versions are never modified.
PATCH /tenants/{tenantId}/form-definitions/{formId}
```

Field types: `text`, `textarea`, `integer`, `decimal`, `date`, `time`, `checkbox`, `radio`, `select`, `multiselect`, `scale`, `table` (scalar columns) and `calculated`. Formulas and alert conditions use a small expression language that is parsed, never evaluated as code: field keys, numbers, `'text'`, `+ - * / ^`, comparisons, `and` / `or` / `not`, and `sum`, `avg`, `min`, `max`, `round`, `abs`. An invalid definition answers `400 FORM_DEFINITION_INVALID` with one issue per problem.

#### Encounters, branches, catalogs and permissions

```bash
# An encounter groups the records of one attention. One open encounter per professional and
# patient (409 ENCOUNTER_ALREADY_OPEN). With `appointmentId`, only the professional of the
# appointment can attend it; the appointment becomes IN_PROGRESS.
POST /tenants/{tenantId}/patients/{patientId}/encounters
{ "encounterType": "FIRST_VISIT", "reason": "Dolor lumbar", "appointmentId": "...", "branchId": "..." }
GET  /tenants/{tenantId}/patients/{patientId}/encounters

# Records created with `encounterId` are written into that open encounter (409 ENCOUNTER_CLOSED).
# Closing is the sign-off of the professional: no more records, and the appointment is COMPLETED.
POST   /tenants/{tenantId}/patients/{patientId}/encounters/{encounterId}/close   { "summary": "..." }
PATCH  /tenants/{tenantId}/patients/{patientId}/encounters/{encounterId}         # type or reason, while open
DELETE /tenants/{tenantId}/patients/{patientId}/encounters/{encounterId}         { "reason": "..." }  # only without records

# Branches. Every clinic has a main one. A PERSONAL tenant has a single active branch.
GET   /tenants/{tenantId}/branches
POST  /tenants/{tenantId}/branches               # MASTER
PATCH /tenants/{tenantId}/branches/{branchId}    # MASTER: fields, isActive, isMain
# Appointments accept `branchId` on create and update, and `?branchId=` on list.

# Catalogs: suggestions only, the fields stay free text.
GET   /tenants/{tenantId}/diagnosis-codes?search=f32&system=CIE10
GET   /tenants/{tenantId}/medications?search=ibu
POST  /tenants/{tenantId}/medications
PATCH /tenants/{tenantId}/medications/{medicationId}

# One record, to print it as a document.
GET /tenants/{tenantId}/patients/{patientId}/specialty-records/{recordId}

# Permissions: what the role allows and what was withdrawn from the user. `me` reads the caller.
GET /tenants/{tenantId}/users/{userId|me}/permissions
PUT /tenants/{tenantId}/users/{userId}/permissions    { "revoked": ["appointments.cancel"] }   # MASTER
```

```bash
# Clinical files of a patient: PDF, JPG or PNG up to 10 MB, checked by their content.
# Multipart fields: file, category (EXAMEN | IMAGEN | INFORME | CONSENTIMIENTO | RECETA | OTRO),
# description?, encounterId?. Stored encrypted; counted against the plan (413 STORAGE_LIMIT_REACHED).
GET    /tenants/{tenantId}/patients/{patientId}/files
POST   /tenants/{tenantId}/patients/{patientId}/files
GET    /tenants/{tenantId}/patients/{patientId}/files/{fileId}/download   # audited
DELETE /tenants/{tenantId}/patients/{patientId}/files/{fileId}            { "reason": "..." }  # uploader only

# Storage page of the account holder. File names are masked without a professional profile.
GET /tenants/{tenantId}/storage/breakdown
GET /tenants/{tenantId}/storage/files

# Professionals who attend in a branch. Tied to none, a professional attends in all of them;
# tied to some, appointments are booked only there (409 PROFESSIONAL_NOT_IN_BRANCH).
PUT /tenants/{tenantId}/branches/{branchId}/professionals   { "userIds": ["..."] }   # MASTER
```

Files live where `STORAGE_DRIVER` says: a private bucket of Supabase Storage (`supabase`: `SUPABASE_URL`, `SUPABASE_SECRET_KEY`, `SUPABASE_STORAGE_BUCKET`), or the disk of the API server under `STORAGE_LOCAL_PATH` (`local`, the default), which must be a persistent volume included in the backups. Downloads always go through the API, because the stored bytes are encrypted. Their bytes keep the encryption key they were written with, so a retired key stays in `CLINICAL_ENCRYPTION_KEYS` while files use it. Clinical notes also accept `encounterId`, and the clinical timeline returns `ENCOUNTER` entries.

The role still decides who may call a route. A permission can only be **withdrawn** from one user (`403 PERMISSION_DENIED` afterwards), never granted beyond the role, and the account holder cannot be restricted. The catalog is in `src/common/permissions/permission-catalog.ts`.

A permission can also be **granted** to one user when the catalog lists their role in `grantable` (today `billing.view` and `billing.create` for `ASISTENTE`): `PUT …/permissions { "revoked": [], "granted": ["billing.view"] }`. No clinical permission is grantable. Each entry of `GET …/permissions` carries `source`: `role` (can be withdrawn) or `grant` (can be given).

```bash
# Activity of the clinic: appointments by status and encounters by type, by branch and by
# professional. Up to a year (400 REPORT_RANGE_INVALID). Counts only, no clinical content.
GET /tenants/{tenantId}/reports/activity?from=2026-10-01T05:00:00.000Z&to=2026-11-01T05:00:00.000Z&branchId=   # MASTER

# Templates of the clinic for certificates and consents. Variables: {{paciente}}, {{identificacion}},
# {{edad}}, {{fecha}}, {{profesional}}, {{consultorio}}; any other is refused (400 TEMPLATE_VARIABLE_UNKNOWN).
GET   /tenants/{tenantId}/document-templates?moduleKey=general.consents   # professionals get the active ones
POST  /tenants/{tenantId}/document-templates    { "moduleKey": "general.certificates", "name": "...", "title": null, "body": "..." }   # MASTER
PATCH /tenants/{tenantId}/document-templates/{templateId}   { "isActive": false }   # MASTER

# Saves the record as a PDF (letterhead, signature block, QR) among the files of the patient. Returns the file.
POST /tenants/{tenantId}/patients/{patientId}/specialty-records/{recordId}/document

# Public, no token: checks a document by the code printed on it. 404 DOCUMENT_NOT_FOUND otherwise.
GET /public/documents/{code}
# → { code, status: VALID | WITHDRAWN, documentType, issuedAt, correctedAt, withdrawnAt, clinic,
#     specialty, professional: { name, title, licenseNumber }, patientInitials }
```

Every record carries a `verificationCode` (16 characters, printed as `ABCD-EFGH-JKMN-PQRS`); a record from before the codes receives one the first time it is read with `GET …/specialty-records/{recordId}`. The public check never returns the content of the record nor the name of the patient. Its QR points to `FRONTEND_URL/verify/{code}`.

Forms accept the field type `signature`: a PNG data URL (`data:image/png;base64,…`, up to 200 000 characters) checked by its bytes and stored encrypted with the rest of the record. It is not allowed as a table column.

The diagnosis catalog is loaded with `npm run catalog:import-diagnosis-codes -- <file.csv>` (`system,code,description`). Without a file it loads `prisma/data/diagnosis-codes.starter.csv`, a starter set that must be checked against the official classification before production use.

#### Patient identification

`identificationType` (`CEDULA`, `RUC`, `PASSPORT`, `OTHER`) and `identificationNumber` go together; the pair is unique among the live patients of the clinic (`409 PATIENT_IDENTIFICATION_TAKEN`, `400 PATIENT_IDENTIFICATION_INVALID`). `GET /tenants/{tenantId}/patients?search=` also matches the identification number and the phone. A patient under 18 needs `guardianName` (`422 PATIENT_GUARDIAN_REQUIRED`); the rule is checked on creation and whenever an update touches the birth date or the guardian.

`GET /tenants/{tenantId}/audit-logs` (MASTER) returns `changes: null`, `reason: null` and `contentRedacted: true` for clinical entries when the viewer has no active professional profile.

### 7. Create Next Session Plan

```bash
POST /tenants/{tenantId}/next-session-plans
Authorization: Bearer <token>
Content-Type: application/json

{
  "patientId": "patient-id",
  "objectives": "Trabajar exposición gradual a situaciones sociales",
  "techniques": "Reestructuración cognitiva, role-playing",
  "homework": "Registro de pensamientos automáticos en situaciones sociales",
  "notes": "Considerar incluir técnicas de mindfulness"
}
```

## Filtering & Querying

### List Appointments with Filters

```bash
GET /tenants/{tenantId}/appointments?psychologistId=user-id&status=SCHEDULED&from=2024-03-01T00:00:00Z&to=2024-03-31T23:59:59Z
```

Without `patientId` the list is a calendar, and each role sees a different one:

- `MASTER`: every professional, or one with `professionalId`.
- `PROFESIONAL`: only their own appointments.
- `ASISTENTE`: one professional at a time. `professionalId` is required; without it the
  answer is `400 APPOINTMENT_PROFESSIONAL_REQUIRED`.

With `patientId` the list belongs to the patient record: a professional of the treating team
also sees that patient's appointments with other professionals.

### Search Patients

```bash
GET /tenants/{tenantId}/patients?search=pedro
```

### List Users by Role

```bash
GET /tenants/{tenantId}/users?role=PSYCHOLOGIST&isActive=true
```

### Get Unread Notifications

```bash
GET /tenants/{tenantId}/notifications?unreadOnly=true
```

### Query Audit Logs

```bash
GET /tenants/{tenantId}/audit-logs?entity=CLINICAL_NOTE&userId=psychologist-id&from=2024-03-01&to=2024-03-31
```

## Working with Reminders

Reminders are sent automatically based on tenant settings.

### Tenant Reminder Configuration

Default rules: `["24h", "2h"]`

This means reminders are sent:
- 24 hours before appointment
- 2 hours before appointment

Configured in `TenantSettings.reminderRules`

## Platform

Routes under `/platform/*` belong to the platform administration panel. They require the `ADMIN` role, and the `ADMIN` must belong to the reserved platform tenant (`Tenant.isPlatform`); any other user receives `403`. They do not compare `:tenantId` with the caller's own tenant and never expose internal clinic data (patients, appointments, notes, invoices). Errors use the same shape as the rest of the API: `{ statusCode, code, message, ... }`.

`ADMIN` accounts are created by script (`npm run platform:create-admin`, see `DEPLOYMENT.md`), not by the API.

### Summary

| Route | Description |
|---|---|
| `GET /platform/summary` | `tenants: { active, suspended }`, `subscriptions: { trialing, active, pastDue, blocked }` (`blocked` = `UNPAID` + `CANCELED` + `INCOMPLETE`), `pendingPayments: { count, amount, currency }`, `trialsEndingSoon` (`id`, `name`, `trialEndsAt`), `recentTenants` (`id`, `name`, `planType`, `createdAt`). The platform tenant is excluded. |

### Tenants

| Route | Description |
|---|---|
| `GET /platform/tenants` | Paginated list. Query: `page`, `pageSize` (max 100, default 20), `search` (clinic name or email, owner name or email), `planType`, `status`, `isActive`. Returns `{ items, total, page, pageSize }`; each item has `id`, `name`, `tenantType`, `isActive`, `createdAt`, `master`, `planType`, `status`, `seatsPsychologistsUsed`/`seatsPsychologistsMax`, `activePatientsCount`/`maxActivePatients`. |
| `GET /platform/tenants/:tenantId` | Detail: `tenant`, `master` (with `mustChangePassword`), `subscription`, `usage` (`seatsPsychologistsUsed`, `activePatientsCount`, `monthlyNotificationsSent`), `specialties` and the eight `sections` with `enabled`. |
| `POST /platform/tenants` | Creates a clinic with its owner. Responds `201` with the detail shape. |
| `PATCH /platform/tenants/:tenantId` | Edits `name`, `email`, `phone`, `address`. |
| `PATCH /platform/tenants/:tenantId/subscription` | Changes the plan. Body: `planType`, `seatsPsychologistsMax?`, `maxActivePatients?`, `reason` (required). |
| `POST /platform/tenants/:tenantId/suspend` | Body `{ reason }` (required). Sets `Tenant.isActive = false` and revokes the refresh tokens of the users of the tenant. |
| `POST /platform/tenants/:tenantId/reactivate` | Sets `Tenant.isActive = true`. |
| `PUT /platform/tenants/:tenantId/sections` | Body `{ sections: string[] }`: the keys that stay enabled; every other section is stored with `enabled = false`. |
| `POST /platform/tenants/:tenantId/master/reset-password` | Body `{ temporaryPassword }` (min. 8 characters). Stores the hash, sets `mustChangePassword = true` and revokes the owner's refresh tokens. Responds `200` without a body. |
| `GET /platform/section-catalog` | The eight sections (key, name, dependencies) and the pre-checked sections for every plan and tenant type (`defaults`). |

Every route with `:tenantId` answers `404` if the clinic does not exist or is the platform tenant.

**Create body (`POST /platform/tenants`)**

```json
{
  "name": "Consultorio Demo",
  "email": "contacto@demo.test",
  "phone": "+593 99 999 9999",
  "address": "Quito",
  "tenantType": "CLINIC",
  "timezone": "America/Guayaquil",
  "locale": "es-EC",
  "masterFirstName": "Ana",
  "masterLastName": "Lopez",
  "masterEmail": "ana@demo.test",
  "temporaryPassword": "Temporal-2026",
  "planType": "TRIAL",
  "specialtyCodes": ["PSYCHOLOGY"],
  "sections": ["core.calendar", "core.patients"]
}
```

- `phone`, `address` and `sections` are optional. When `sections` is omitted, the pre-checked sections of the plan and tenant type are used.
- `temporaryPassword` has at least 8 characters and is stored exactly as typed. It is never logged or written to the audit log.
- `specialtyCodes` needs at least one code.
- Everything runs in one serializable transaction. A `TRIAL` plan starts `TRIALING` with a 14-day trial; a paid plan starts `ACTIVE` with a one-month period and no payment record. The owner is created with `mustChangePassword = true`.
- The owner email must be unique across the platform (`409` otherwise). The plan must match the tenant type (`400 PLAN_TYPE_MISMATCH`).

**Plan change**

- Applied immediately, without a payment. Limits and flags are recalculated from the plan; `seatsPsychologistsMax` and `maxActivePatients`, when sent, replace the plan values.
- If the current usage exceeds the new limits: `409 PLAN_BELOW_USAGE` and nothing changes.
- Cancels a pending scheduled plan change and the `PENDING` upgrade payments of the clinic.
- Does not touch the sections.

**Sections**

- A key outside the catalog: `400 SECTION_UNKNOWN`.
- An enabled section whose dependency is not enabled: `400 SECTION_DEPENDENCY` with `{ section, requires }`.
- Turning a section off does not delete data. A clinic owner cannot change `core.*` module keys (`403 SECTION_MANAGED_BY_PLATFORM`).
- Keys: `core.calendar`, `core.patients`, `core.tasks`, `core.clinicalNotes`, `core.specialties`, `core.billing`, `core.team`, `core.storage`.

### Subscription payments

| Route | Description |
|---|---|
| `GET /platform/subscription-payments?status=PENDING` | Payments of every clinic. |
| `POST /platform/subscription-payments/:paymentId/confirm` | Body `{ reference, note? }`. Applies the payment; idempotent for the same reference. |
| `POST /platform/subscription-payments/:paymentId/reject` | Body `{ reason }`. Closes the request without changes. |

### Legacy provider-managed access

| Route | Description |
|---|---|
| `GET /platform/legacy-access/pending` | Provider-managed professionals awaiting approval across all clinics. |
| `POST /platform/legacy-access/:tenantId/:userId/grant` | Grants access (`409 PROFESSIONAL_SEAT_LIMIT_REACHED` if no seat is left). |
| `POST /platform/legacy-access/:tenantId/:userId/revoke` | Revokes access. |

### Audit

Suspending, reactivating, editing the account, changing sections and resetting the owner password write an `AuditLog` entry (`tenantId` of the affected clinic, `userId` of the `ADMIN`). The password never appears in `changes`. Plan changes are recorded as `SubscriptionEvent`.

### Change own password

`POST /auth/change-password` (any authenticated user, including one with a temporary password)

```json
{ "currentPassword": "Temporal-2026", "newPassword": "MyOwnPassword1" }
```

Validates the current password (`401` if wrong), requires a new password of at least 8 characters that differs from the current one (`400 PASSWORD_UNCHANGED`), stores it and sets `mustChangePassword = false`. `POST /auth/reset-password` also clears the flag. The login and refresh responses include `user.mustChangePassword`.

### Access rules

- A user with `mustChangePassword = true` receives `403 PASSWORD_CHANGE_REQUIRED` on every route except the public ones, `POST /auth/logout`, `POST /auth/logout-all` and `POST /auth/change-password`. The flag is read from the database on each request, so a reset takes effect with the access token already issued.
- An `ADMIN` outside `/platform/*` receives `403 PLATFORM_ONLY`, except on those three session routes.
- A clinic section that is turned off (or has no row) answers `403 SECTION_NOT_ENABLED` with `{ section }`. Sections are enforced on appointments (`core.calendar`), patients (`core.patients`), tasks (`core.tasks`), clinical notes, timeline and next-session plans (`core.clinicalNotes`), specialty records and the handlers that change specialties or modules (`core.specialties`), billing (`core.billing`) and member management in users (`core.team`).
- `SOPORTE` has no platform or cross-tenant power.

### Removed routes

`POST /onboarding/tenants`, `POST /tenants`, `/subscription-payments/*`, `/admin/psychologists/*` and the `grant-access` / `revoke-access` handlers of users no longer exist. Their replacements are `POST /platform/tenants`, `/platform/subscription-payments/*` and `/platform/legacy-access/*`.

## Role-Based Access

### TENANT_ADMIN Can:
- ✅ Create/invite users (with seat limits)
- ✅ Update tenant settings
- ✅ View all clinical notes
- ✅ Delete clinical notes
- ✅ Access audit logs
- ✅ Manage subscriptions

### PSYCHOLOGIST Can:
- ✅ Create patients
- ✅ Create appointments
- ✅ Create clinical notes (own)
- ✅ Read own clinical notes
- ✅ Create/update session plans
- ✅ Manage tasks

### ASSISTANT Can:
- ✅ Create patients
- ✅ Create/update appointments
- ✅ Manage tasks
- ❌ Cannot create clinical notes
- ❌ Cannot read clinical notes

## Error Handling

### Common Error Codes

| Code | Error | Description |
|------|-------|-------------|
| 400 | Bad Request | Validation failed |
| 401 | Unauthorized | Invalid/expired token |
| 403 | Forbidden | Insufficient permissions or tenant mismatch |
| 404 | Not Found | Resource not found |
| 409 | Conflict | Duplicate resource or business rule violation |
| 429 | Too Many Requests | Rate limit exceeded |

### Platform and section errors

| Situation | Response |
|---|---|
| Non-`ADMIN` user on `/platform/*` | 403 |
| `ADMIN` outside the panel | 403 `PLATFORM_ONLY` |
| User with a temporary password | 403 `PASSWORD_CHANGE_REQUIRED` |
| Section turned off or without a row | 403 `SECTION_NOT_ENABLED` |
| Owner tries to change a `core.*` module key | 403 `SECTION_MANAGED_BY_PLATFORM` |
| Owner email already used | 409 |
| Unknown section key | 400 `SECTION_UNKNOWN` |
| Section dependency not satisfied | 400 `SECTION_DEPENDENCY` |
| Plan does not match the tenant type | 400 `PLAN_TYPE_MISMATCH` |
| Plan below the current usage | 409 `PLAN_BELOW_USAGE` |
| Clinic does not exist or is the platform tenant | 404 |
| New password equals the current one | 400 `PASSWORD_UNCHANGED` |

### Seat Limit Error

```json
{
  "statusCode": 403,
  "error": "SEAT_LIMIT_REACHED",
  "message": "Seat limit reached. Current plan allows X psychologist(s). Please upgrade your plan.",
  "details": {
    "seatsPsychologistsMax": 1,
    "seatsPsychologistsUsed": 1,
    "planType": "BASIC"
  }
}
```

### Appointment Conflict Error

```json
{
  "statusCode": 409,
  "error": "APPOINTMENT_CONFLICT",
  "message": "This time slot conflicts with existing appointment(s)",
  "conflicts": [...]
}
```

## Testing Endpoints

Use the Swagger UI for interactive testing:

```
http://localhost:3000/api/v1/docs
```

Or use cURL/Postman/Insomnia with the examples above.
