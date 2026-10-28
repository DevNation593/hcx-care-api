## Billing

The `/billing/invoices` routes preserve the read-only history of Faktur invoices.
New electronic invoices use the durable emite-facil request endpoints below. Historical
routes require a JWT, the `MASTER` role and the `billing.view` permission.

### List invoices

`GET /api/v1/tenants/:tenantId/billing/invoices`

### Get invoice

`GET /api/v1/tenants/:tenantId/billing/invoices/:invoiceId`

### Electronic invoicing (emite-facil)

All tenant routes require JWT and the `core.billing` section. Configuration is
restricted to MASTER. Request creation requires `billing.create`; list, detail and
downloads require `billing.view`. MASTER has these permissions by default; PROFESIONAL and
ASISTENTE can use invoice workflows when the platform grants them to their clinic role
through the existing RolesGuard/PermissionGuard. Configuration remains MASTER-only.

| Method | Path after `/api/v1/tenants/:tenantId` | Body / response |
| --- | --- | --- |
| GET | `/invoicing/connection` | Connection metadata or JSON null |
| PUT | `/invoicing/connection` | `{taxpayerId, apiKey?, active?, webhookSecret?}` -> metadata |
| POST | `/invoicing/test` | `{apiKey?}` -> `{tenant,taxpayers}`; 200, never saves credentials |
| GET | `/invoicing/options` | `{tenant,taxpayers:[{...taxpayer,establishments:[{...establishment,emissionPoints:[]}]}]}` |
| PUT | `/branches/:branchId/emission-point` | `{establishmentId,emissionPointId}` -> saved point with branchId and three-digit codes |
| POST | `/orders/:id/invoice-requests` | No body. Required `Idempotency-Key` header; 202 with durable request |
| GET | `/invoice-requests` | `{items,total,page,pageSize}` |
| GET | `/invoice-requests/:id` | Request plus safe event timeline |
| GET | `/invoice-requests/:id/xml` | Authorized XML bytes, `application/xml` |
| GET | `/invoice-requests/:id/ride` | RIDE PDF bytes, `application/pdf` |

List accepts `status=REQUESTED|PROCESSING|AUTHORIZED|REJECTED|FAILED`, `branchId`,
`orderId`, `patientId`, `page` (1-based, default 1), `pageSize` (1..100, default 20).
List/detail permit 120 requests/minute per caller for polling every five seconds.

Connection metadata: `{id,active,externalTenantId,taxpayerId,taxpayerName,taxpayerRuc,
environment,hasApiKey,hasWebhookSecret,revision,validatedAt,webhookUrl,points}`.
Environment is `'1'` (test) or `'2'` (production), read from the provider issuer.
`webhookUrl` is null if BACKEND_PUBLIC_URL is absent/invalid. No secret is returned.
Omit `apiKey` to reuse it; omit `webhookSecret` to preserve it, send `""` to remove it.
`active` defaults to true on PUT. A new key is tested before saving. Company/issuer
identity is immutable once any request exists; same-identity key rotation is supported.
Same-issuer environment refresh is allowed only without active/uncertain requests or
authorized artifacts awaiting collection. Identity changes before first use invalidate
branch points; key rotation and environment refresh preserve them and dispatch rechecks them.

Request responses expose `{id,orderId,orderNumber,branchId,billingProfileId,status,
requiresReconciliation,replacesInvoiceRequestId,externalDocumentId,externalState,number,
accessKey,authorizationNumber,authorizedAt,artifacts:{xml,ride},attempts,lastError,
requestedAt,finishedAt}`. Nullable fiscal values remain null until known. `lastError`
is null or `{code,message,attempts?}`; attempts contain actual SRI explanations, visible
only through GET/list/detail guarded by `billing.view`. Every POST response is an
acceptance receipt with `lastError:null`, including same-key and collision replays;
POST never decrypts stored errors and requires only `billing.create`. Detail additionally returns `events` with
`{id,type,source,detail,createdAt}`. No credentials, fiscal snapshots, storage keys or
leases are exposed. The exact typed contract and examples are in
`./superpowers/reports/2026-10-17-emite-facil-b2-backend.md`.

Creation performs no provider HTTP call. Keep the same client key after a transport
failure; reusing it for the same order returns the same request, for another order 409.
Only a known safe FAILED or REJECTED request permits correction and a new key. Never
offer reissue/refund when `requiresReconciliation` is true, even if status is FAILED.
SIGNATURE_FAILED stays PROCESSING: correct/retry that same document in emite-facil;
HCX keeps reconciling it. Authorized invoices cannot be cancelled/refunded in HCX.

Errors use `{statusCode,code,message}` with controlled Spanish messages. Eligibility
422 uses the existing `{statusCode,code,message,missing,items}` billing eligibility
contract. Examples: INVOICING_NOT_CONFIGURED, INVOICE_LIMIT_REACHED,
INVOICE_REQUEST_IN_PROGRESS, INVOICE_RECONCILIATION_REQUIRED, ORDER_ALREADY_AUTHORIZED,
CUSTOMER_SYNC_REQUIRED. An unavailable artifact returns 404; integrity failures 503.

Public callback: `POST /api/v1/integrations/emite-facil/webhook/:connectionId` -> 204.
No JWT; requires authentic raw-body signature in `webhook-id`, `webhook-timestamp`,
`webhook-signature`, rejects invalid signatures/foreign company with 401. Limit300/min.
Register its URL and secret manually in emite-facil. No API-key subscription management
is attempted; minute reconciliation works without webhook.
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

# Effective permissions of the caller's clinic role. Other users cannot be inspected here.
GET /tenants/{tenantId}/users/me/permissions
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

The platform `ADMIN` sets permissions for each clinic role (`MASTER`, `PROFESIONAL`, `ASISTENTE`) through `PUT /platform/tenants/:tenantId/roles/:role/permissions`. Every user with that role in the clinic receives the same effective permissions. The `MASTER` cannot assign them, and its default permissions can be withdrawn. The catalog is in `src/common/permissions/permission-catalog.ts`; only the actions listed in `grantable` can be added to a role that lacks them by default. Clinical permissions cannot be granted to `ASISTENTE`. A denied action returns `403 PERMISSION_DENIED`.

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

#### Treatments, consents and treatment sessions

All of these routes need the section `core.specialties`. Under `/tenants/{tenantId}`. Errors keep the format `{ statusCode, code, message }`; the 422 that blocks a start or a completion adds `missing`, a list of `FINALIZED_MEDICAL_FORM`, `SIGNED_APPLICABLE_CONSENT`, `BEFORE_PHOTOS`, `CLINICAL_NOTES` and `AFTER_PHOTOS`. Writing the catalog takes the permission `treatments.manage`, which the MASTER has by default and the platform owner can assign to the PROFESIONAL or ASISTENTE role in this clinic. The routes of a session need a professional profile (`403 PROFESSIONAL_NOT_AUTHORIZED` without it) and `clinical_records.*`; the signature, the form, the photos and the transitions are the professional of the session only (`403 CLINICAL_RECORD_FORBIDDEN`).

**Consent templates.** A version is edited only while it is a draft; published, its text and fingerprint are fixed, and a change is a new version. Variables: `{{paciente}}`, `{{identificacion}}`, `{{tratamiento}}`, `{{profesional}}`, `{{fecha}}`.

| Method | Path | Who | Result | Errors |
|---|---|---|---|---|
| GET | `/consent-templates` | MASTER, PROFESIONAL, ASISTENTE | Templates with the state of each version, without the text | |
| POST | `/consent-templates` | MASTER + `treatments.manage` | 201, template with version 1 as a draft (`{ name, title, body }`) | 409 `CONSENT_TEMPLATE_NAME_TAKEN` |
| GET | `/consent-templates/{id}` | MASTER, PROFESIONAL, ASISTENTE | Template with the text of every version | 404 `CONSENT_TEMPLATE_NOT_FOUND` |
| PUT | `/consent-templates/{id}/draft` | MASTER + `treatments.manage` | Replaces the draft, or starts the next version as a draft (`{ title, body }`) | 404 `CONSENT_TEMPLATE_NOT_FOUND`, 409 `CONSENT_VERSION_LOCKED` |
| POST | `/consent-templates/{id}/publish` | MASTER + `treatments.manage` | 200, the draft is published | 409 `CONSENT_VERSION_LOCKED` without a draft |
| POST | `/consent-template-versions/{versionId}/retire` | MASTER + `treatments.manage` | 200, the version is retired; what already uses it keeps it | 409 `CONSENT_VERSION_LOCKED` |

**Treatments.** Price and requirements live in immutable versions; a session pins the version it was opened with. `code` (1 to 20 of `A-Z 0-9 . _ -`, starting with a letter or digit, stored in uppercase, unique per clinic) is the main code (código principal) of the treatment's invoice lines. The provider cannot edit a product, so once a rename or a new tax rate no longer matches the product already created under the code, the line goes out as the code plus `.` and four hex characters.

| Method | Path | Who | Result | Errors |
|---|---|---|---|---|
| GET | `/treatments?active=` | MASTER, PROFESIONAL, ASISTENTE | Treatments with their current version | |
| POST | `/treatments` | MASTER + `treatments.manage` | 201, treatment with version 1 (`{ name, code, category?, specialtyId?, version: { price, taxRatePercent, durationMinutes, formDefinitionId?, formVersion?, consentTemplateVersionId?, requirements? } }`) | 400 `TREATMENT_REQUIREMENTS_INVALID` (with `issues`), 409 `TREATMENT_NAME_TAKEN`, 409 `TREATMENT_CODE_TAKEN` |
| GET | `/treatments/{id}` | MASTER, PROFESIONAL, ASISTENTE | Treatment with every version | 404 `TREATMENT_NOT_FOUND` |
| PATCH | `/treatments/{id}` | MASTER + `treatments.manage` | Name, code, category, specialty or `isActive` | 404 `TREATMENT_NOT_FOUND`, 409 `TREATMENT_NAME_TAKEN`, 409 `TREATMENT_CODE_TAKEN` |
| POST | `/treatments/{id}/versions` | MASTER + `treatments.manage` | 201, new version, which becomes the current one | 400 `TREATMENT_REQUIREMENTS_INVALID`, 409 `TREATMENT_VERSION_CONFLICT` |

`requirements` takes `medicalForm.required`, `informedConsent.{ required, validityDays }`, `photos.{ minimumBefore, minimumAfter }` and `clinicalNotes.requiredForCompletion`; keys left out take their defaults (nothing required).

**Treatment sessions.** A session lives on its own `PROCEDURE` encounter, which the encounter routes cannot edit, close or delete (`409 ENCOUNTER_MANAGED_BY_SESSION`). Status: `INTAKE_IN_PROGRESS` (waiting for the form) → `READY_FOR_CONSENT` → `CONSENTED` → `IN_PROGRESS` → `CLINICAL_COMPLETE`; `CONSENT_REFUSED`, `CONSENT_REVOKED`, `CANCELLED` and `NO_SHOW` end it. A treatment that requires no consent starts in `READY_FOR_CONSENT` and starts from there; a consent signed earlier by the patient for the same treatment, still within `validityDays`, puts a new session straight into `CONSENTED`. Every time (signature, start, completion, cancellation) is the server time and no body carries it. A command the status does not allow answers `409 TREATMENT_SESSION_INVALID_TRANSITION` with the current `status`.

| Method | Path | Who | Result | Errors |
|---|---|---|---|---|
| GET | `/patients/{patientId}/treatment-sessions` | MASTER, PROFESIONAL (profile) | Sessions of the patient, newest first, without clinical text; audited | 404 patient |
| POST | `/patients/{patientId}/treatment-sessions` | MASTER, PROFESIONAL (profile) | 201, session on a new encounter (`{ treatmentId, appointmentId?, branchId? }`); the appointment becomes `IN_PROGRESS` | 403 `TREATMENT_SPECIALTY_MISMATCH`, 404 `TREATMENT_NOT_FOUND`, 409 `TREATMENT_INACTIVE`, 409 `ENCOUNTER_ALREADY_OPEN` |
| GET | `/treatment-sessions/{id}` | MASTER, PROFESIONAL (profile) | Session with its `professional` (`{ id, firstName, lastName }`), policy, form (schema and answers), consents (without body, with `pdfChecksum` and `signature`), `timezone` (`America/Guayaquil` when the clinic has none), photos, `requirements: { start, complete }` and `allowedCommands`, which is empty for anyone but the session professional (a MASTER keeps `REVOKE_CONSENT`); audited | 404 `TREATMENT_SESSION_NOT_FOUND` |
| PUT | `/treatment-sessions/{id}/form` | Session professional | The whole answers (`{ data }`), validated against the pinned form version; the first save moves the session on | 422 `CLINICAL_RECORD_INVALID`, 409 `TREATMENT_SESSION_INVALID_TRANSITION` (started, or no form required) |
| POST | `/treatment-sessions/{id}/consents` | Session professional | 201, the pinned consent rendered for the patient, with title and body; a presented one is returned again | 409 `CONSENT_NOT_REQUIRED`, 409 `TREATMENT_SESSION_INVALID_TRANSITION` |
| POST | `/treatment-sessions/{id}/media` | Session professional | 201, multipart `file`, `phase` (`BEFORE`, `AFTER`, `OTHER`), `description?`; BEFORE and AFTER take JPG or PNG, JPG loses its EXIF/XMP except the orientation; stored encrypted | 400 `PATIENT_FILE_INVALID`, 409 `SESSION_PHOTO_PHASE_NOT_ALLOWED`, 413 `STORAGE_LIMIT_REACHED` |
| POST | `/treatment-sessions/{id}/start` | Session professional | 201, `IN_PROGRESS`; no body | 422 `TREATMENT_REQUIREMENTS_MISSING` (with `missing`), 409 `TREATMENT_SESSION_INVALID_TRANSITION` |
| POST | `/treatment-sessions/{id}/complete` | Session professional | 201, `CLINICAL_COMPLETE`; `{ procedureNotes? }` is stored encrypted and becomes the summary of the closed encounter | 422 `TREATMENT_REQUIREMENTS_MISSING` (with `missing`), 409 `TREATMENT_SESSION_INVALID_TRANSITION` |
| POST | `/treatment-sessions/{id}/cancel` | Session professional | 201, `CANCELLED`; `{ reason }` required (3–1000 characters after trimming), stored encrypted. Its open appointment is cancelled when the procedure had not started and `COMPLETED` (the patient attended) when it had; the encounter closes | 400 validation, 409 `TREATMENT_SESSION_INVALID_TRANSITION` once ended |
| POST | `/treatment-sessions/{id}/no-show` | Session professional | 201, `NO_SHOW`; its open appointment is `NO_SHOW` and the encounter closes | 409 `TREATMENT_SESSION_INVALID_TRANSITION` once started or ended |
| GET | `/treatment-sessions/{id}/compliance` | MASTER, PROFESIONAL + `billing.view` (an ASISTENTE once granted it) | `{ status, missing }` only, no clinical content: what is missing to start, and after the start to complete; always `missing: []` once `CLINICAL_COMPLETE` (checked at the close) | 404 `TREATMENT_SESSION_NOT_FOUND` |

In the session detail each entry of `consentDocuments` carries `signature: { signerName, signerRole: PATIENT | REPRESENTATIVE, relationship: string | null } | null` (decrypted; `null` until it is signed; never the identification, the signature image, the operator or storage keys), and the detail carries `timezone`, the clinic's IANA time zone (`America/Guayaquil` when the tenant has no settings), in which to show the signature time.

The form of a session is fixed once it is `IN_PROGRESS` or ended: correcting or removing its record through `/specialty-records` answers `409 TREATMENT_SESSION_INVALID_TRANSITION`.

**Consent documents.** A document keeps the template version and the text it was presented with, whatever is published afterwards. Signing stores the drawn signature (PNG data URL) and a PDF, both encrypted, and the SHA-256 of the PDF (`pdfChecksum`); each download is checked against it.

| Method | Path | Who | Result | Errors |
|---|---|---|---|---|
| POST | `/consent-documents/{id}/sign` | Session professional | 201, the document `SIGNED` with the same `signature: { signerName, signerRole, relationship }` as the session detail, session `CONSENTED` (`{ signerRole: PATIENT \| REPRESENTATIVE, signerName, signerIdentification?, relationship?, understood, questionsAnswered, marketingPhotos?, signature }`) | 400 `CONSENT_SIGNATURE_INVALID`, 400 `CONSENT_RELATIONSHIP_REQUIRED` (a representative), 422 `CONSENT_DECLARATIONS_REQUIRED`, 422 `CONSENT_REPRESENTATIVE_REQUIRED` (patient under 18 signing as `PATIENT`), 409 `CONSENT_DOCUMENT_INVALID_STATE` |
| POST | `/consent-documents/{id}/refuse` | Session professional | 201, `REFUSED`, session `CONSENT_REFUSED`, encounter closed (`{ reason }`) | 409 `CONSENT_DOCUMENT_INVALID_STATE` unless presented |
| POST | `/consent-documents/{id}/revoke` | Session professional or MASTER | 201, `REVOKED` (`{ reason }`); a `CONSENTED` session ends as `CONSENT_REVOKED` with its encounter closed; other sessions that reused it and are still `CONSENTED` return to `READY_FOR_CONSENT` | 409 `CONSENT_DOCUMENT_INVALID_STATE` unless signed |
| GET | `/consent-documents/{id}/pdf` | MASTER, PROFESIONAL (profile) with `clinical_records.view` | `application/pdf`; audited | 404 `CONSENT_DOCUMENT_NOT_FOUND`, 500 `CONSENT_PDF_INTEGRITY` |

Documents and sessions of another clinic answer `404 TREATMENT_SESSION_NOT_FOUND` / `CONSENT_DOCUMENT_NOT_FOUND` under the caller's own tenant, and `403` under the other tenant's id. Reads and writes of sessions and documents are audited (`TREATMENT_SESSION`, `CONSENT_DOCUMENT`).

#### Cash desk, orders and payments

All of these routes need the section `core.billing`. Under `/tenants/{tenantId}`. Errors keep the format `{ statusCode, code, message }`. "Who" lists the permission: `MASTER` has these permissions by default; only the platform `ADMIN` can change them for a clinic role or grant `billing.view`, `billing.create`, `billing.adjust` and `cash.manage` to `PROFESIONAL` or `ASISTENTE`. Lists take `page` and `pageSize`. Money travels as strings with 2 decimals; commands are audited, reads are not. An order is edited with its `version`: a stale one answers `409 ORDER_VERSION_CONFLICT`.

**Billing profiles.** Who receives the invoice, apart from the patient (a company is never a patient). `idType` is the SRI code: `04` RUC, `05` cédula, `06` passport, `07` final consumer. `idType` and `idNumber` never change.

| Method | Path | Who | Result | Errors |
|---|---|---|---|---|
| GET | `/billing-profiles?q=&active=` | `billing.view` | Profiles; `q` searches the name or the start of the identification | |
| POST | `/billing-profiles` | `billing.create` | 201, `{ kind: PERSON \| COMPANY, idType, idNumber, legalName, email?, address?, phone? }` (`email` is required unless `idType` is `07`) | 422 `BILLING_PROFILE_INVALID`, 409 `BILLING_PROFILE_DUPLICATE` |
| GET | `/billing-profiles/{id}` | `billing.view` | The profile | 404 `BILLING_PROFILE_NOT_FOUND` |
| PATCH | `/billing-profiles/{id}` | `billing.create` | Name, email, address, phone or `isActive`; `null` clears an optional field | 404 `BILLING_PROFILE_NOT_FOUND` |
| GET | `/patients/{patientId}/billing-profiles` | `billing.view` | Profiles linked to the patient | 404 patient |
| POST | `/patients/{patientId}/billing-profiles` | `billing.create` | `{ billingProfileId, isDefault? }`; a new default replaces the previous one | 404 `BILLING_PROFILE_NOT_FOUND`, 409 `BILLING_PROFILE_INACTIVE` |
| DELETE | `/patients/{patientId}/billing-profiles/{profileId}` | `billing.create` | 204, unlinks; the profile stays | 404 `BILLING_PROFILE_NOT_FOUND` |

**Cash registers.** One open register per branch. The cash count (`summary.expectedCash`) is the opening cash plus the cash payments recorded in the register, minus the cash refunded.

| Method | Path | Who | Result | Errors |
|---|---|---|---|---|
| GET | `/cash-registers?branchId=&status=` | `billing.view` | Registers, newest first | |
| POST | `/cash-registers/open` | `cash.manage` | 201, `{ branchId, openingCash }` | 404 `BRANCH_NOT_FOUND`, 409 `CASH_REGISTER_ALREADY_OPEN` |
| GET | `/cash-registers/{id}` | `billing.view` | The register with its summary by payment method and, once closed, the count | 404 `CASH_REGISTER_NOT_FOUND` |
| POST | `/cash-registers/{id}/close` | `cash.manage` | 201, `{ countedCash, closingNote? }`; `difference` is counted minus expected | 404 `CASH_REGISTER_NOT_FOUND`, 409 `CASH_REGISTER_CLOSED`, 422 `CASH_CLOSING_NOTE_REQUIRED` (the count differs and there is no note) |

**Orders.** An order (`OPEN`, `PAID`, `CANCELLED`) groups treatment sessions and free items for one billing profile. The server computes the lines, the tax and the totals; prices of sessions come from the pinned treatment version.

When creating an order for a single patient without an explicit recipient, the patient's active default billing profile takes precedence. If there is no active default, the server reuses or creates a profile from the patient's registered identification, name, email, address and phone. Separately registered fiscal identity fields take precedence over personal identity fields. Creation uses the same validation as manual billing profiles; incomplete or invalid data leaves the order without a recipient so another person or company can still be selected. Existing profiles are not overwritten or reactivated. Orders for multiple patients require a recipient to be selected explicitly.

| Method | Path | Who | Result | Errors |
|---|---|---|---|---|
| GET | `/treatment-sessions/billable?branchId=&patientId=` | `billing.view` | Sessions in a billable state with no live order: `{ id, status, createdAt, completedAt, branchId, patient: { id, firstName, lastName, identificationNumber }, treatment: { id, name, version }, price, taxRatePercent, compliant }`. `compliant` says whether the clinical documentation is complete, without detail | |
| GET | `/orders?status=&branchId=&q=` | `billing.view` | Orders; `q` searches the number, the billing profile or the patient | |
| POST | `/orders` | `billing.create` | 201, `{ branchId?, treatmentSessionIds?, billingProfileId? }`. Without `branchId` the branch of the sessions is used. Without a profile, uses the single patient's active default profile or registered fiscal data as described above | 404 `TREATMENT_SESSION_NOT_FOUND`, 404 `BILLING_PROFILE_NOT_FOUND`, 409 `TREATMENT_SESSION_NOT_BILLABLE`, 409 `SESSION_ALREADY_IN_ORDER`, 409 `BILLING_PROFILE_INACTIVE`, 422 `ORDER_BRANCH_MISMATCH` |
| GET | `/orders/{id}` | `billing.view` | Items, payments, totals (`subtotal`, `discountTotal`, `taxTotal`, `total`, `paidTotal`, `balance`) and `version` | 404 `ORDER_NOT_FOUND` |
| POST | `/orders/{id}/items` | `billing.create` (a `FREE` item and a discount also need `billing.adjust`) | `{ version, kind: TREATMENT_SESSION \| FREE, treatmentSessionId? \| description, quantity?, unitPrice, taxRatePercent (0, 5 or 15), patientId?, discount? }` | 404 `ORDER_NOT_FOUND`, 409 `ORDER_NOT_EDITABLE`, 409 `ORDER_VERSION_CONFLICT`, 409 `SESSION_ALREADY_IN_ORDER`, 422 `TAX_RATE_UNSUPPORTED`, 422 `ORDER_LINE_INVALID` |
| DELETE | `/orders/{id}/items/{itemId}?version=` | `billing.create` | The order without the item | 409 `ORDER_NOT_EDITABLE`, 409 `ORDER_VERSION_CONFLICT` |
| PATCH | `/orders/{id}/items/{itemId}` | `billing.adjust` | `{ version, discount }` | 409 `ORDER_NOT_EDITABLE`, 409 `ORDER_VERSION_CONFLICT`, 422 `ORDER_LINE_INVALID` |
| PUT | `/orders/{id}/billing-profile` | `billing.create` | `{ version, billingProfileId }` | 404 `BILLING_PROFILE_NOT_FOUND`, 409 `BILLING_PROFILE_INACTIVE`, 409 `ORDER_VERSION_CONFLICT` |
| POST | `/orders/{id}/cancel` | `billing.create` | `{ version, reason }`; its sessions are released | 409 `ORDER_HAS_PAYMENTS`, 409 `ORDER_VERSION_CONFLICT` |
| GET | `/orders/{id}/billing-eligibility` | `billing.view` | `{ eligible, missing, items: [{ itemId, patientName, codes }] }`, computed from the server-side facts of the sessions. Clinical codes: `FINALIZED_MEDICAL_FORM`, `SIGNED_APPLICABLE_CONSENT`, `CLINICAL_COMPLETION`, `SESSION_NOT_BILLABLE`; cash codes: `BILLING_PROFILE`, `INVOICE_ITEMS`, `BALANCE_DUE` | 404 `ORDER_NOT_FOUND` |

**Payments.** A payment goes into the open register of the branch of the order; partial payments are allowed and the order is `PAID` when the paid total equals the total. A refund is possible only before invoicing and moves a `PAID` order back to `OPEN`.

| Method | Path | Who | Result | Errors |
|---|---|---|---|---|
| POST | `/orders/{id}/payments` | `billing.create` | 201, the order; `{ method: CASH \| DEBIT_CARD \| CREDIT_CARD \| TRANSFER \| OTHER, amount, reference? }`. Optional header `Idempotency-Key` (up to 100 characters of `[A-Za-z0-9._:-]`): a retry with the same key returns the order as it stands (not the original payment); the loser of two concurrent payments that each cover the full balance may get `409 ORDER_NOT_EDITABLE` | 400 `IDEMPOTENCY_KEY_INVALID`, 404 `ORDER_NOT_FOUND`, 409 `ORDER_NOT_EDITABLE`, 409 `CASH_REGISTER_CLOSED`, 409 `IDEMPOTENCY_KEY_REUSED`, 422 `PAYMENT_EXCEEDS_BALANCE` |
| POST | `/payments/{id}/refund` | `billing.adjust` | 200, the order; `{ reason }` | 404 `PAYMENT_NOT_FOUND`, 409 `PAYMENT_NOT_REFUNDABLE`, 409 `CASH_REGISTER_CLOSED` |

Orders, profiles, registers and payments of another clinic answer `404` (`ORDER_NOT_FOUND`, `BILLING_PROFILE_NOT_FOUND`, `CASH_REGISTER_NOT_FOUND`, `PAYMENT_NOT_FOUND`) under the caller's own tenant, and `403` under the other tenant's id.

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
| `GET /platform/summary` | `tenants: { active, suspended }`, `subscriptions: { trialing, active, pastDue, blocked }` (`blocked` = `UNPAID` + `CANCELED` + `INCOMPLETE`), `pendingPayments: { count, amount, currency }`, `trialsEndingSoon` (`id`, `name`, `trialEndsAt`), `recentTenants` (`id`, `name`, `planName`, `createdAt`). The platform tenant is excluded. |

### Tenants

| Route | Description |
|---|---|
| `GET /platform/tenants` | Paginated list. Query: `page`, `pageSize` (max 100, default 20), `search` (clinic name or email, owner name or email), `planId`, `status`, `isActive`. Returns `{ items, total, page, pageSize }`; each item has `id`, `name`, `tenantType`, `isActive`, `createdAt`, `master`, `plan` (`id`, `code`, `name`), `status`, `seatsPsychologistsUsed`/`seatsPsychologistsMax`, `activePatientsCount`/`maxActivePatients`. |
| `GET /platform/tenants/:tenantId` | Detail: `tenant`, `master` (with `mustChangePassword`), `subscription` (`plan`, status and dates, every value the plan gives, `overriddenFields` and `monthlyTotal`), `usage`, `specialties`, `sections` (each with `source`: `PLAN` or `OVERRIDE`) and clinical `modules`. |
| `POST /platform/tenants` | Creates a clinic with its owner. Responds `201` with the detail shape. |
| `PATCH /platform/tenants/:tenantId` | Edits `name`, `email`, `phone`, `address`. |
| `PATCH /platform/tenants/:tenantId/subscription` | Changes the plan. Body: `planId`, `trialDays?` (1-365), `reason` (required). |
| `PUT /platform/tenants/:tenantId/subscription/overrides` | Body `{ values, reset?, reason }`: sets price and limit values for this clinic apart from its plan (`values`), or puts them back on the plan (`reset`). `400 OVERRIDE_INVALID` / `OVERRIDE_CONFLICT` / `OVERRIDE_EMPTY`. |
| `POST /platform/tenants/:tenantId/suspend` | Body `{ reason }` (required). Sets `Tenant.isActive = false` and revokes the refresh tokens of the users of the tenant. |
| `POST /platform/tenants/:tenantId/reactivate` | Sets `Tenant.isActive = true`. |
| `PUT /platform/tenants/:tenantId/sections` | Body `{ sections: string[] }`: the module and submodule keys that stay enabled; every other one is stored with `enabled = false`. A row that differs from what the plan gives is stored as `OVERRIDE` and survives plan edits. |
| `GET /platform/tenants/:tenantId/roles/:role/permissions` | Effective permissions and the configurable catalog for `MASTER`, `PROFESIONAL` or `ASISTENTE`. |
| `PUT /platform/tenants/:tenantId/roles/:role/permissions` | Body `{ allowed: string[] }`: replaces the effective permissions of the role in this clinic; changes are audited. |
| `GET /platform/specialty-catalog` | Active specialties and their clinical modules. |
| `PUT /platform/tenants/:tenantId/specialties` | Body `{ specialtyCodes: string[] }`: assigns clinic specialties and their modules, answers the resulting monthly price (the plan price is not changed) and records an audit entry. |
| `PATCH /platform/tenants/:tenantId/modules/:moduleKey` | Body `{ enabled: boolean }`: enables or disables an assigned clinical module and records an audit entry. |
| `POST /platform/tenants/:tenantId/master/reset-password` | Body `{ temporaryPassword }` (min. 8 characters). Stores the hash, sets `mustChangePassword = true` and revokes the owner's refresh tokens. Responds `200` without a body. |
| `GET /platform/section-catalog` | The modules and submodules (key, name, parent, dependencies, health-only mark) and `nonHealthSpecialtyCodes`. Each plan says which keys it includes. |
| `GET /platform/plans` | Every plan, archived ones included, with `modules` and `clinicsCount`. |
| `POST /platform/plans` | Creates a plan: `code`, `name`, `description?`, `tenantType`, `sortOrder?`, prices, limits, `trialDays` and `modules`. `409 PLAN_CODE_TAKEN`. |
| `PATCH /platform/plans/:planId` | Edits a plan (not its code). Every clinic on it takes the new values and modules at once, except its overrides. `409 PLAN_IN_USE` when changing the type of a plan with clinics. |
| `POST /platform/plans/:planId/archive` / `restore` | An archived plan keeps its clinics but cannot be assigned (`409 PLAN_ARCHIVED`). |

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
  "planId": "plan_profesional",
  "trialDays": 14,
  "specialtyCodes": ["PSYCHOLOGY"]
}
```

- `phone`, `address`, `trialDays` and `sections` are optional. Without `trialDays` the plan's own apply; `0` starts a paid month. Without `sections` the clinic gets what the plan includes (health-only submodules off when every specialty is aesthetic); with them, what differs from the plan is stored as an override.
- `temporaryPassword` has at least 8 characters and is stored exactly as typed. It is never logged or written to the audit log.
- `specialtyCodes` needs at least one code.
- Everything runs in one serializable transaction. With trial days the clinic starts `TRIALING`; without them `ACTIVE` with a one-month period and no payment record. The owner is created with `mustChangePassword = true`.
- The owner email must be unique across the platform (`409` otherwise). The plan must exist (`404 PLAN_NOT_FOUND`), not be archived (`409 PLAN_ARCHIVED`) and match the tenant type (`400 PLAN_TYPE_MISMATCH`).

**Plan change**

- Applied immediately, without a payment. Price, limits and modules become the new plan's, and the clinic's overrides are dropped.
- With `trialDays` the clinic tries the plan; without them it pays from today, or keeps a paid period that is still running.
- A limit below current usage deletes nothing: the clinic just cannot add more.

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
- A clinic section that is turned off (or has no row) answers `403 SECTION_NOT_ENABLED` with `{ section }`. Sections are enforced on appointments (`core.calendar`), patients (`core.patients`), tasks (`core.tasks`), clinical notes, timeline and next-session plans (`core.clinicalNotes`), specialty records and clinical workflows (`core.specialties`), billing (`core.billing`), member management (`core.team`), and files and storage (`core.storage`). The platform owner manages section and module assignments through `/platform/*`.
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
