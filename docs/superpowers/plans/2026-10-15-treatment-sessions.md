# Núcleo clínico de tratamientos — plan de implementación

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Catálogo de tratamientos versionado, consentimiento versionado con firma y PDF, y sesión de tratamiento con estados gobernados por el servidor, fotos antes/después y cierre clínico, en la API y en la web.

**Architecture:** La API (NestJS + Prisma) agrega tres módulos: `consents` (plantillas), `treatments` (catálogo) y `treatment-sessions` (sesión, documentos de consentimiento y fotos). Cada sesión abre un `Encounter` de tipo `PROCEDURE` y guarda en él su ficha (`SpecialtyRecord`) y sus fotos (`PatientFile`), reutilizando el cifrado (`ClinicalCryptoService`), la auditoría (`ClinicalAuditService`) y el storage (`FILE_STORAGE`). Las reglas viven en funciones puras (`session-state.ts`, `session-requirements.ts`, `treatment-requirements.ts`) que los servicios invocan dentro de transacciones. La web (Next.js) agrega dos páginas de administración, una pestaña en el paciente y una página de atención paso a paso.

**Tech Stack:** NestJS 11, Prisma 6, PostgreSQL, pdfkit, Jest + supertest; Next.js 14, React Query 5, Tailwind, Vitest + Testing Library.

**Spec:** `docs/superpowers/specs/2026-10-15-treatment-sessions-design.md` (en `hcx-care-api`).

## Global Constraints

- Rama `claude/compassionate-hopper-t6teqf` en `hcx-care-api` y `hcx-care-client`; nunca otra.
- Prefijo de rutas `/api/v1/tenants/:tenantId`; las rutas de sesión usan `treatment-sessions`, nunca `sessions`.
- Errores con el formato existente `{ statusCode, code, message }`; los 422 de bloqueo agregan `missing: string[]`.
- Códigos de `missing` exactos: `FINALIZED_MEDICAL_FORM`, `SIGNED_APPLICABLE_CONSENT`, `BEFORE_PHOTOS`, `CLINICAL_NOTES`, `AFTER_PHOTOS`.
- Toda hora de firma, inicio, cierre y cancelación la pone el servidor (`new Date()`); los cuerpos de petición no traen fechas para esas transiciones.
- Contenido clínico cifrado con `ClinicalCryptoService`: `ConsentDocument.title/body`, `ConsentSignature.signerName/signerIdentification/relationship`, `ConsentEvent.reason`, `TreatmentSession.procedureNotes/cancellationReason`, bytes de firma y PDF.
- Toda lectura y escritura de sesión y documento queda en `AuditLog` vía `ClinicalAuditService` con entidades `TREATMENT_SESSION` y `CONSENT_DOCUMENT`.
- Sección `core.specialties` en todos los controladores nuevos (`@RequireSection('core.specialties')`).
- Textos de interfaz y mensajes de error en español; comentarios de código en inglés, como el resto del repo.
- Sin dependencias nuevas en ninguno de los dos repos.
- Commits terminan con las líneas de atribución de la sesión (`Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>` y `Claude-Session: https://claude.ai/code/session_01KBMj5NMXpNwT2FeqNQMzq2`).

## Review Focus

1. **Doble clic o reintento en firmar / iniciar / cerrar**: la segunda petición debe fallar con 409 (transición inválida o documento ya firmado), nunca crear una segunda firma ni un segundo PDF. Prueba en Task 7 y Task 8 (concurrencia optimista con `version`).
2. **Plantilla de consentimiento retirada o tratamiento editado mientras una sesión está abierta**: la sesión sigue usando la versión fijada al crearse y puede presentar y firmar. Prueba en Task 7.
3. **Fichero que dice ser JPG pero no lo es, o JPG truncado**: 400 `PATIENT_FILE_INVALID`, sin escribir en storage. Prueba en Task 3 y Task 8.
4. **Revocar un consentimiento reutilizado por otra sesión aún no iniciada**: esa otra sesión deja de cumplir `SIGNED_APPLICABLE_CONSENT` (start → 422) aunque su estado siga `CONSENTED`. Prueba en Task 8.
5. **Paciente sin fecha de nacimiento**: se permite firmar como `PATIENT` (no se puede afirmar que sea menor); con fecha de nacimiento de menor, 422 `CONSENT_REPRESENTATIVE_REQUIRED`. Prueba en Task 7.

---

## API (`hcx-care-api`)

### Task 1: Esquema, migración, permiso y cableado de Prisma

**Files:**
- Modify: `prisma/schema.prisma`
- Create: `prisma/migrations/20261015000000_treatment_sessions/migration.sql`
- Modify: `src/prisma/prisma.service.ts` (`bindRlsDelegates`, `cleanDatabase`)
- Modify: `src/clinical-access/clinical-audit.service.ts` (`CLINICAL_AUDIT_ENTITIES`)
- Modify: `src/common/permissions/permission-catalog.ts`
- Test: `src/common/permissions/permissions.spec.ts`

**Interfaces:**
- Produces (Prisma):
  - enums `ConsentTemplateVersionStatus { DRAFT PUBLISHED RETIRED }`, `ConsentDocumentStatus { PRESENTED SIGNED REFUSED REVOKED }`, `ConsentEventType { PRESENTED SIGNED REFUSED REVOKED }`, `ConsentSignerRole { PATIENT REPRESENTATIVE }`, `TreatmentSessionStatus { INTAKE_IN_PROGRESS READY_FOR_CONSENT CONSENTED IN_PROGRESS CLINICAL_COMPLETE CONSENT_REFUSED CONSENT_REVOKED CANCELLED NO_SHOW }`, `SessionMediaPhase { BEFORE AFTER OTHER }`.
  - `AuditEntity` += `TREATMENT_SESSION`, `CONSENT_DOCUMENT`.
  - models `Treatment`, `TreatmentVersion`, `ConsentTemplate`, `ConsentTemplateVersion`, `ConsentDocument`, `ConsentSignature`, `ConsentEvent`, `TreatmentSession` with the fields of the spec ("Modelo de datos"); ids `cuid()`; `price Decimal @db.Decimal(10,2)`, `taxRatePercent Decimal @db.Decimal(5,2)`; uniques `Treatment(tenantId,name)`, `TreatmentVersion(treatmentId,version)`, `ConsentTemplate(tenantId,name)`, `ConsentTemplateVersion(templateId,version)`, `ConsentSignature(documentId)`, `TreatmentSession(encounterId)`; indexes `(tenantId, patientId, createdAt)` on `TreatmentSession` and `ConsentDocument`, `(tenantId, isActive)` on `Treatment` and `ConsentTemplate`.
  - `TreatmentSession.version Int @default(1)`; `formRecordId String? @unique`; `consentDocumentId String?` (relation to `ConsentDocument`, `onDelete: Restrict`).
  - `PatientFile` += `treatmentSessionId String?` (relation, `onDelete: SetNull`, index) and `phase SessionMediaPhase?`.
  - Every FK to `Tenant` with `onDelete: Cascade`; FKs to `User` with `onDelete: Restrict`, like `Encounter`.
- Produces (permissions): catalog entry `{ key: 'treatments.manage', group: 'Tratamientos', label: 'Gestionar tratamientos y consentimientos', roles: ['MASTER'], grantable: ['PROFESIONAL', 'ASISTENTE'] }`; type `Permission` includes `'treatments.manage'`.

- [ ] **Step 1: Write the failing permission tests** in `permissions.spec.ts`:
  - `rolePermissions('MASTER')` contains `'treatments.manage'`; `rolePermissions('PROFESIONAL')` and `rolePermissions('ASISTENTE')` do not.
  - `grantablePermissions('PROFESIONAL')` and `grantablePermissions('ASISTENTE')` contain `'treatments.manage'`.
  - `effectivePermissions('ASISTENTE', [], ['treatments.manage'])` contains it.
- [ ] **Step 2: Run** `npx jest src/common/permissions` — Expected: FAIL.
- [ ] **Step 3: Add the catalog entry.** Run the tests again — Expected: PASS.
- [ ] **Step 4: Edit `schema.prisma`** with the models above, then generate the migration against a scratch database: `DATABASE_URL=postgresql://postgres:postgres@localhost:5432/psic_clinic_test npx prisma migrate dev --name treatment_sessions --create-only`, rename the folder to `20261015000000_treatment_sessions`. The SQL must be additive only (no `DROP`, no `ALTER ... TYPE` on existing columns); `ALTER TYPE "AuditEntity" ADD VALUE` for the two new entities.
- [ ] **Step 5: Add delegates** `treatment`, `treatmentVersion`, `consentTemplate`, `consentTemplateVersion`, `consentDocument`, `consentSignature`, `consentEvent`, `treatmentSession` to `bindRlsDelegates`; in `cleanDatabase` delete `consentEvent`, `consentSignature`, then `treatmentSession`, `consentDocument` after `auditLog` and before `specialtyRecord`, and `treatmentVersion`, `treatment`, `consentTemplateVersion`, `consentTemplate` before `user`. Add `TREATMENT_SESSION` and `CONSENT_DOCUMENT` to `CLINICAL_AUDIT_ENTITIES`.
- [ ] **Step 6: Verify** `npx prisma validate && DATABASE_URL=postgresql://postgres:postgres@localhost:5432/psic_clinic_test npx prisma migrate reset --force --skip-seed && npx tsc --noEmit -p tsconfig.json` — Expected: all succeed; `npx jest src/common src/app.module.spec.ts src/app.wiring.spec.ts` PASS.
- [ ] **Step 7: Commit** `feat(api): add the treatment, consent and treatment-session schema`.

### Task 2: Reglas puras — requisitos, estados y evaluador

**Files:**
- Create: `src/treatments/treatment-requirements.ts`, `src/treatments/treatment-requirements.spec.ts`
- Create: `src/treatment-sessions/session-state.ts`, `src/treatment-sessions/session-state.spec.ts`
- Create: `src/treatment-sessions/session-requirements.ts`, `src/treatment-sessions/session-requirements.spec.ts`

**Interfaces:**
- Consumes: `TreatmentSessionStatus` from `@prisma/client` (Task 1).
- Produces:
  ```ts
  // treatment-requirements.ts
  export interface TreatmentRequirements {
    medicalForm: { required: boolean };
    informedConsent: { required: boolean; validityDays: number | null };
    photos: { minimumBefore: number; minimumAfter: number };
    clinicalNotes: { requiredForCompletion: boolean };
  }
  export const DEFAULT_REQUIREMENTS: TreatmentRequirements; // all false / 0 / null
  export function parseTreatmentRequirements(raw: unknown): TreatmentRequirements;
  // throws BadRequestException { statusCode: 400, code: 'TREATMENT_REQUIREMENTS_INVALID', message, issues: string[] }

  // session-state.ts
  export type SessionCommand = 'SAVE_FORM' | 'PRESENT_CONSENT' | 'SIGN_CONSENT' | 'REFUSE_CONSENT'
    | 'REVOKE_CONSENT' | 'UPLOAD_BEFORE' | 'UPLOAD_AFTER' | 'UPLOAD_OTHER' | 'START' | 'COMPLETE'
    | 'CANCEL' | 'NO_SHOW';
  export const TERMINAL_SESSION_STATUSES: readonly TreatmentSessionStatus[];
  export function allowedCommands(status: TreatmentSessionStatus, policy: TreatmentRequirements): SessionCommand[];
  export function assertCommandAllowed(status: TreatmentSessionStatus, command: SessionCommand, policy: TreatmentRequirements): void;
  // throws ConflictException { statusCode: 409, code: 'TREATMENT_SESSION_INVALID_TRANSITION', message, status, command }
  export function statusAfterIntake(policy: TreatmentRequirements, facts: { hasForm: boolean; hasApplicableConsent: boolean }):
    'INTAKE_IN_PROGRESS' | 'READY_FOR_CONSENT' | 'CONSENTED';

  // session-requirements.ts
  export type MissingRequirement = 'FINALIZED_MEDICAL_FORM' | 'SIGNED_APPLICABLE_CONSENT' | 'BEFORE_PHOTOS'
    | 'CLINICAL_NOTES' | 'AFTER_PHOTOS';
  export interface SessionFacts { hasForm: boolean; hasApplicableConsent: boolean; beforePhotos: number; afterPhotos: number; hasNotes: boolean }
  export function evaluateSession(policy: TreatmentRequirements, facts: SessionFacts): { start: MissingRequirement[]; complete: MissingRequirement[] };
  export function isConsentApplicable(
    doc: { status: ConsentDocumentStatus; signedAt: Date | null; templateVersionId: string },
    required: { templateVersionId: string; validityDays: number | null },
    now: Date,
    sameSession: boolean,
  ): boolean;
  export function requirementsMissing(missing: MissingRequirement[]): UnprocessableEntityException;
  // { statusCode: 422, code: 'TREATMENT_REQUIREMENTS_MISSING', message: 'La atención no cumple los requisitos del tratamiento.', missing }
  ```

Transition table for `allowedCommands` (the only source of truth):

| Status | Commands |
|---|---|
| `INTAKE_IN_PROGRESS` | `SAVE_FORM`, `UPLOAD_OTHER`, `CANCEL`, `NO_SHOW` |
| `READY_FOR_CONSENT` | `SAVE_FORM`, `PRESENT_CONSENT`, `SIGN_CONSENT`, `REFUSE_CONSENT`, `UPLOAD_OTHER`, `CANCEL`, `NO_SHOW`; plus `UPLOAD_BEFORE`, `START` when `!policy.informedConsent.required` |
| `CONSENTED` | `SAVE_FORM`, `REVOKE_CONSENT`, `UPLOAD_BEFORE`, `UPLOAD_OTHER`, `START`, `CANCEL`, `NO_SHOW` |
| `IN_PROGRESS` | `UPLOAD_AFTER`, `UPLOAD_OTHER`, `COMPLETE`, `CANCEL` |
| terminal | none |

`PRESENT_CONSENT`, `SIGN_CONSENT` and `REFUSE_CONSENT` are absent when `!policy.informedConsent.required`. `isConsentApplicable`: `SIGNED`, same `templateVersionId`, and (`sameSession` or `validityDays !== null && now - signedAt <= validityDays days`).

- [ ] **Step 1: Write failing tests.**
  - `treatment-requirements.spec.ts`: `parseTreatmentRequirements({})` equals `DEFAULT_REQUIREMENTS`; full example of the spec round-trips; rejects unknown top-level key `{ foo: 1 }`, unknown nested key, `validityDays: 0`, `validityDays: 3651`, `minimumBefore: 21`, `minimumBefore: -1`, `minimumBefore: 1.5`, `required: 'yes'`, non-object input — each with code `TREATMENT_REQUIREMENTS_INVALID`.
  - `session-state.spec.ts`: `it.each` over every status × command asserting membership per the table, for a policy with and without consent; `assertCommandAllowed('CLINICAL_COMPLETE','START',p)` throws with `code: 'TREATMENT_SESSION_INVALID_TRANSITION'` and `status: 'CLINICAL_COMPLETE'`; `statusAfterIntake` returns `INTAKE_IN_PROGRESS` (form required, missing), `READY_FOR_CONSENT` (form satisfied, no applicable consent; or consent not required), `CONSENTED` (consent required and applicable).
  - `session-requirements.spec.ts`: all-satisfied facts → `{ start: [], complete: [] }`; each requirement missing alone yields exactly its code in the right list; nothing required → empty lists with zero facts; `isConsentApplicable` true same session regardless of age, true at exactly `validityDays` days, false one millisecond later, false with `validityDays: null` on another session, false for `REVOKED`, `REFUSED`, `PRESENTED`, and for another `templateVersionId`.
- [ ] **Step 2: Run** `npx jest src/treatments src/treatment-sessions` — Expected: FAIL (modules missing).
- [ ] **Step 3: Implement the three files.**
- [ ] **Step 4: Run** the same command — Expected: PASS.
- [ ] **Step 5: Commit** `feat(api): add treatment requirements, session transitions and requirement evaluation`.

### Task 3: Texto del consentimiento, PDF y limpieza de metadatos JPG

**Files:**
- Create: `src/consents/consent-text.ts`, `src/consents/consent-text.spec.ts`
- Create: `src/consents/consent-pdf.ts`, `src/consents/consent-pdf.spec.ts`
- Create: `src/treatment-sessions/strip-jpeg-metadata.ts`, `src/treatment-sessions/strip-jpeg-metadata.spec.ts`

**Interfaces:**
- Produces:
  ```ts
  // consent-text.ts
  export const CONSENT_VARIABLES = ['paciente', 'identificacion', 'tratamiento', 'profesional', 'fecha'] as const;
  export type ConsentValues = Record<(typeof CONSENT_VARIABLES)[number], string>;
  export function renderConsentText(text: string, values: ConsentValues): string; // `{{ name }}` with optional spaces; unknown names left verbatim
  export function consentChecksum(title: string, body: string): string;          // sha256 hex of `${title}\n${body}`

  // consent-pdf.ts
  export interface ConsentPdfInput {
    clinic: { name: string; address?: string | null };
    patient: { name: string; identification?: string | null };
    treatment: { name: string; version: number };
    templateVersion: { version: number; checksum: string };
    title: string; body: string; checksum: string;
    signature: { png: Buffer; signerName: string; signerRole: 'PATIENT' | 'REPRESENTATIVE';
      signerIdentification?: string | null; relationship?: string | null;
      understood: boolean; questionsAnswered: boolean; marketingPhotos: boolean };
    operatorName: string;
    signedAt: Date;
    timezone: string; // tenant timezone, used to print signedAt
  }
  export function renderConsentPdf(input: ConsentPdfInput): Promise<Buffer>;

  // strip-jpeg-metadata.ts
  export function stripJpegMetadata(data: Buffer): Buffer;
  // non-JPEG (no FF D8 prefix) returned as is; removes every APP1 (FF E1) segment before SOS (FF DA);
  // throws Error('MALFORMED_JPEG') when a segment length runs past the end or SOS is never reached
  ```
- `renderConsentPdf` reuses the `printable` sanitizing approach of `src/record-documents/record-pdf.ts` (export it from there rather than copying) and sets `info.CreationDate = input.signedAt` so the same input gives the same bytes.

- [ ] **Step 1: Write failing tests.**
  - `consent-text.spec.ts`: renders all five variables, tolerates `{{ paciente }}`, leaves `{{otro}}` verbatim, replaces repeated occurrences; `consentChecksum('T','B')` equals `createHash('sha256').update('T\nB').digest('hex')`; changing one character changes the checksum.
  - `strip-jpeg-metadata.spec.ts`: a synthetic JPEG `FFD8 | FFE0 len=16 JFIF.. | FFE1 len=N 'Exif'.. | FFDB.. | FFDA .. FFD9` loses only the `FFE1` segment and keeps everything else byte-for-byte; a JPEG with two APP1 segments loses both; a PNG buffer is returned unchanged (same bytes); a truncated JPEG throws `MALFORMED_JPEG`.
  - `consent-pdf.spec.ts`: output starts with `%PDF`; two renders of the same input are byte-identical; output for a body with `—`, `“”` and an emoji renders without throwing.
- [ ] **Step 2: Run** `npx jest src/consents src/treatment-sessions/strip-jpeg-metadata.spec.ts` — Expected: FAIL.
- [ ] **Step 3: Implement**, exporting `printable` from `record-pdf.ts`.
- [ ] **Step 4: Run** the same command plus `npx jest src/record-documents` — Expected: PASS.
- [ ] **Step 5: Commit** `feat(api): render and fingerprint consent documents and strip photo metadata`.

### Task 4: Plantillas de consentimiento (`ConsentsModule`)

**Files:**
- Create: `src/consents/dto/consent-template.dto.ts`, `src/consents/consent-templates.service.ts`, `src/consents/consent-templates.service.spec.ts`, `src/consents/consent-templates.controller.ts`, `src/consents/consents.module.ts`
- Modify: `src/app.module.ts`

**Interfaces:**
- Consumes: `consentChecksum`, `CONSENT_VARIABLES` (Task 3); `treatments.manage` (Task 1).
- Produces:
  ```ts
  export class ConsentTemplatesService {
    list(tenantId: string): Promise<ConsentTemplateSummary[]>;          // versions without body
    get(tenantId: string, id: string): Promise<ConsentTemplateWithVersions>;
    create(tenantId: string, userId: string, dto: CreateConsentTemplateDto): Promise<ConsentTemplateWithVersions>; // name, title, body → version 1 DRAFT
    saveDraft(tenantId: string, userId: string, id: string, dto: SaveConsentDraftDto): Promise<ConsentTemplateWithVersions>; // updates the DRAFT or creates version currentVersion+1 as DRAFT
    publish(tenantId: string, userId: string, id: string): Promise<ConsentTemplateWithVersions>; // DRAFT → PUBLISHED, sets checksum, publishedAt, currentVersion
    retire(tenantId: string, versionId: string): Promise<ConsentTemplateVersion>;  // PUBLISHED → RETIRED
    /** Throws 400 TREATMENT_REQUIREMENTS_INVALID unless the version is the tenant's and PUBLISHED. */
    assertPublishedVersion(db: PrismaService | Prisma.TransactionClient, tenantId: string, versionId: string): Promise<ConsentTemplateVersion>;
  }
  ```
  DTOs: `CreateConsentTemplateDto { name (2–120), title (2–200), body (1–50000) }`, `SaveConsentDraftDto { title, body }`. `ConsentsModule` exports `ConsentTemplatesService`.
- Routes per the spec's "Plantillas de consentimiento" table. Writes: `@Roles('MASTER','PROFESIONAL','ASISTENTE')` + `@RequirePermission('treatments.manage')`; reads: `@Roles('MASTER','PROFESIONAL','ASISTENTE')`. Not found → 404 `CONSENT_TEMPLATE_NOT_FOUND`; editing or publishing when no `DRAFT` → 409 `CONSENT_VERSION_LOCKED`; retiring a non-`PUBLISHED` version → 409 `CONSENT_VERSION_LOCKED`; duplicate name → 409 `CONSENT_TEMPLATE_NAME_TAKEN`.

- [ ] **Step 1: Write failing service tests** (Prisma mocked as in `document-templates.service.spec.ts`): create stores version 1 `DRAFT` with null checksum; `publish` sets `checksum === consentChecksum(title, body)`, `status: 'PUBLISHED'`, `currentVersion: 1`; `saveDraft` after publish creates version 2 `DRAFT` and leaves version 1 untouched; `saveDraft` twice updates the same version-2 row; `publish` with no draft throws `CONSENT_VERSION_LOCKED`; `retire` of a `DRAFT` throws `CONSENT_VERSION_LOCKED`; another tenant's id throws 404.
- [ ] **Step 2: Run** `npx jest src/consents/consent-templates` — Expected: FAIL.
- [ ] **Step 3: Implement** service, DTOs, controller (`@ApiTags('consent-templates')`, `@RequireSection('core.specialties')`) and module; register in `AppModule`. Writes run in `this.prisma.$transaction` with `applyRlsContext`, as `EncountersService.transaction`.
- [ ] **Step 4: Run** the tests and `npx jest src/app.module.spec.ts src/app.wiring.spec.ts` — Expected: PASS.
- [ ] **Step 5: Commit** `feat(api): versioned consent templates`.

### Task 5: Catálogo de tratamientos (`TreatmentsModule`)

**Files:**
- Create: `src/treatments/dto/treatment.dto.ts`, `src/treatments/treatments.service.ts`, `src/treatments/treatments.service.spec.ts`, `src/treatments/treatments.controller.ts`, `src/treatments/treatments.module.ts`
- Modify: `src/app.module.ts`

**Interfaces:**
- Consumes: `parseTreatmentRequirements` (Task 2), `ConsentTemplatesService.assertPublishedVersion` (Task 4).
- Produces:
  ```ts
  export interface TreatmentVersionInput {
    price: number; taxRatePercent: number; durationMinutes: number;
    formDefinitionId?: string | null; formVersion?: number | null;
    consentTemplateVersionId?: string | null; requirements?: unknown;
  }
  export class TreatmentsService {
    list(tenantId: string, filters: { active?: boolean }): Promise<TreatmentWithCurrent[]>;
    get(tenantId: string, id: string): Promise<TreatmentWithVersions>;
    create(tenantId: string, userId: string, dto: CreateTreatmentDto): Promise<TreatmentWithVersions>; // dto = { name, category?, specialtyId?, version: TreatmentVersionInput }
    update(tenantId: string, id: string, dto: UpdateTreatmentDto): Promise<TreatmentWithVersions>;     // name, category, specialtyId, isActive
    addVersion(tenantId: string, userId: string, id: string, dto: TreatmentVersionInput): Promise<TreatmentWithVersions>;
    /** The version a new session pins: current version of an active treatment. */
    currentVersionFor(db: PrismaService | Prisma.TransactionClient, tenantId: string, treatmentId: string): Promise<TreatmentVersion & { treatment: Treatment }>;
  }
  ```
  `TreatmentWithCurrent` = treatment row + `current: TreatmentVersion` with `requirements` parsed. `TreatmentsModule` exports `TreatmentsService`.
- Version validation (400 `TREATMENT_REQUIREMENTS_INVALID` with `issues`): `price` 0–999999.99 two decimals; `taxRatePercent` 0–100; `durationMinutes` 5–1440 integer; `medicalForm.required` ⇒ `formDefinitionId` + `formVersion` exist in the tenant (`FormDefinitionVersion`) and the form `isActive`; `formDefinitionId` without `formVersion` (or vice versa) is invalid; `informedConsent.required` ⇒ `consentTemplateVersionId` passes `assertPublishedVersion`; a consent version id without `informedConsent.required` is invalid.
- Routes per the spec's "Tratamientos" table; writes need `treatments.manage`; reads any tenant role (`MASTER`, `PROFESIONAL`, `ASISTENTE`). Errors: 404 `TREATMENT_NOT_FOUND`, 409 `TREATMENT_NAME_TAKEN`. `specialtyId` must be one of the tenant's specialties (`TenantSpecialty`), else 400 `TREATMENT_REQUIREMENTS_INVALID`.

- [ ] **Step 1: Write failing service tests**: create stores version 1 and `currentVersion 1`; `addVersion` stores version 2, bumps `currentVersion`, leaves version 1 unchanged; consent required without id → `TREATMENT_REQUIREMENTS_INVALID`; consent version `RETIRED` → same; form required with a version number that does not exist → same; `price: 10.005` → same; `currentVersionFor` on inactive treatment throws 409 `TREATMENT_INACTIVE`; another tenant's id → 404.
- [ ] **Step 2: Run** `npx jest src/treatments` — Expected: FAIL.
- [ ] **Step 3: Implement** service, DTOs (class-validator), controller (`@ApiTags('treatments')`) and module; register in `AppModule`.
- [ ] **Step 4: Run** the tests and the wiring specs — Expected: PASS.
- [ ] **Step 5: Commit** `feat(api): versioned treatment catalog with documentation requirements`.

### Task 6: Sesión — crear, listar, consultar, ficha y cumplimiento

**Files:**
- Modify: `src/encounters/encounters.service.ts`, `src/encounters/encounters.service.spec.ts`
- Modify: `src/specialty-records/specialty-records.service.ts`, `src/specialty-records/specialty-records.service.spec.ts`
- Create: `src/treatment-sessions/dto/treatment-session.dto.ts`, `src/treatment-sessions/treatment-sessions.service.ts`, `src/treatment-sessions/treatment-sessions.service.spec.ts`, `src/treatment-sessions/treatment-sessions.controller.ts`, `src/treatment-sessions/treatment-sessions.module.ts`, `src/treatment-sessions/session-facts.ts`
- Modify: `src/app.module.ts`

**Interfaces:**
- Consumes: Task 2 functions; `TreatmentsService.currentVersionFor` (Task 5).
- Produces:
  ```ts
  // encounters.service.ts — extracted from start()/close(); start() and close() call them
  openEncounter(tx: Prisma.TransactionClient, tenantId: string, patientId: string, actor: ClinicalActor,
    input: { encounterType: EncounterType; reason: string; appointmentId?: string; branchId?: string }): Promise<Encounter>;
  closeEncounter(tx: Prisma.TransactionClient, tenantId: string, encounterId: string, actor: ClinicalActor, summary?: string): Promise<Encounter>;
  // update/close/delete on an encounter with a TreatmentSession → 409 ENCOUNTER_MANAGED_BY_SESSION

  // specialty-records.service.ts
  writePinnedForm(tx: Prisma.TransactionClient, tenantId: string, patientId: string, actor: ClinicalActor,
    input: { encounterId: string; formDefinitionId: string; formVersion: number; data: unknown; recordId?: string | null }): Promise<{ id: string }>;
  // validates against FormDefinitionVersion (formDefinitionId, formVersion) — not currentVersion;
  // recordId set → correction of that record (version+1, audited before/after); else creates one

  // session-facts.ts
  loadSessionFacts(tx: Prisma.TransactionClient, session: TreatmentSession, policy: TreatmentRequirements,
    pinnedConsentVersionId: string | null, now: Date): Promise<SessionFacts & { applicableConsentId: string | null }>;

  // treatment-sessions.service.ts
  export class TreatmentSessionsService {
    list(tenantId: string, patientId: string, actor: ClinicalActor): Promise<SessionSummary[]>;
    create(tenantId: string, patientId: string, actor: ClinicalActor, dto: CreateTreatmentSessionDto): Promise<SessionDetail>;
    get(tenantId: string, sessionId: string, actor: ClinicalActor): Promise<SessionDetail>;
    saveForm(tenantId: string, sessionId: string, actor: ClinicalActor, dto: SaveSessionFormDto): Promise<SessionDetail>;
    compliance(tenantId: string, sessionId: string): Promise<{ status: TreatmentSessionStatus; missing: MissingRequirement[] }>;
    /** Loads the session for a command by its professional, checks the transition and returns it with its policy. */
    loadForCommand(tx: Prisma.TransactionClient, tenantId: string, sessionId: string, actor: ClinicalActor, command: SessionCommand):
      Promise<{ session: TreatmentSession; version: TreatmentVersion & { treatment: Treatment }; policy: TreatmentRequirements }>;
    /** Updates status with optimistic concurrency on `version`; 409 TREATMENT_SESSION_INVALID_TRANSITION when the row moved. */
    transition(tx: Prisma.TransactionClient, session: TreatmentSession, data: Prisma.TreatmentSessionUpdateInput): Promise<TreatmentSession>;
  }
  ```
  `SessionDetail` = session (decrypted) + `patient: { id, firstName, lastName, dateOfBirth, identificationNumber, guardianName, guardianRelationship, guardianIdentification }` + `treatment: { id, name, version }` + `policy` + `form: { formDefinitionId, formVersion, name, schema, data: Record<string, unknown> | null } | null` (present when the policy requires a form; `data` decrypted from `formRecordId`) + `consentDocuments` (without body) + `media` (PatientFile metadata with `phase`) + `requirements: { start, complete }` + `allowedCommands`.
  `CreateTreatmentSessionDto { treatmentId; appointmentId?; branchId? }`; `SaveSessionFormDto { data: Record<string, unknown> }`.
- `create`: in a serializable transaction — `currentVersionFor`; if `treatment.specialtyId` and it differs from `actor.specialtyId` → 403 `TREATMENT_SPECIALTY_MISMATCH`; `openEncounter` with `encounterType: 'PROCEDURE'`, `reason: treatment.name`; create the session with `status: statusAfterIntake(...)` using `loadSessionFacts`, `consentDocumentId` set when an earlier consent applies; audit `CREATE TREATMENT_SESSION`.
- `saveForm`: `SAVE_FORM` allowed; policy requires a form (else 409 `TREATMENT_SESSION_INVALID_TRANSITION`); `writePinnedForm` with the session's `formRecordId`; set `formRecordId`; if status was `INTAKE_IN_PROGRESS`, move to `statusAfterIntake`.
- Controller: `@UseGuards(ClinicalProfileGuard)`, `@RequireSection('core.specialties')`, roles `MASTER`, `PROFESIONAL`; reads `clinical_records.view`, writes `clinical_records.create`. Only the session's professional writes (403 `CLINICAL_RECORD_FORBIDDEN`). `compliance` lives on a separate handler without `ClinicalProfileGuard`, roles `MASTER`, `PROFESIONAL`, `ASISTENTE`, `@RequirePermission('billing.view')`, and returns only `{ status, missing }` where `missing` is `start` before `IN_PROGRESS` and `complete` after.

- [ ] **Step 1: Write failing tests.**
  - `encounters.service.spec.ts`: `close` on an encounter that has a treatment session throws `ENCOUNTER_MANAGED_BY_SESSION`; same for `update` and `delete`.
  - `specialty-records.service.spec.ts`: `writePinnedForm` validates against version 2 when the form's `currentVersion` is 3 (data valid for v2 only passes); invalid data → 422 `CLINICAL_RECORD_INVALID` as today; with `recordId` it bumps `version` and writes an `UPDATE` audit entry.
  - `treatment-sessions.service.spec.ts`: create with form required → `INTAKE_IN_PROGRESS` and an encounter of type `PROCEDURE`; create with no form and an applicable earlier consent (validityDays 30, signed 10 days ago) → `CONSENTED` with that `consentDocumentId`; specialty mismatch → 403; `saveForm` moves `INTAKE_IN_PROGRESS` → `READY_FOR_CONSENT`; `saveForm` on `IN_PROGRESS` → 409; another professional → 403; `compliance` returns `{ status, missing }` and no other keys; `transition` with a stale `version` → 409.
- [ ] **Step 2: Run** `npx jest src/encounters src/specialty-records src/treatment-sessions/treatment-sessions.service.spec.ts` — Expected: FAIL.
- [ ] **Step 3: Implement** the encounter extraction and guard, `writePinnedForm`, `session-facts.ts`, the service, DTOs, controller and module (imports `ClinicalAccessModule`, `TreatmentsModule`, `EncountersModule`, `SpecialtyRecordsModule`; export the needed services from those modules).
- [ ] **Step 4: Run** the same tests plus `npx jest` (whole unit suite) — Expected: PASS.
- [ ] **Step 5: Commit** `feat(api): treatment sessions on top of encounters, with pinned intake form`.

### Task 7: Documentos de consentimiento — presentar, firmar, rechazar, revocar y PDF

**Files:**
- Modify: `src/patient-files/patient-files.module.ts` (export `FILE_STORAGE`)
- Create: `src/treatment-sessions/dto/consent-document.dto.ts`, `src/treatment-sessions/consent-documents.service.ts`, `src/treatment-sessions/consent-documents.service.spec.ts`, `src/treatment-sessions/consent-documents.controller.ts`
- Modify: `src/treatment-sessions/treatment-sessions.module.ts`, `src/treatment-sessions/treatment-sessions.controller.ts`

**Interfaces:**
- Consumes: `loadForCommand`, `transition`, `loadSessionFacts` (Task 6); `renderConsentText`, `consentChecksum`, `renderConsentPdf` (Task 3); `FILE_STORAGE`.
- Produces:
  ```ts
  export class ConsentDocumentsService {
    present(tenantId: string, sessionId: string, actor: ClinicalActor): Promise<ConsentDocumentView>;      // includes decrypted title/body
    sign(tenantId: string, documentId: string, actor: ClinicalActor, dto: SignConsentDto): Promise<ConsentDocumentView>;
    refuse(tenantId: string, documentId: string, actor: ClinicalActor, dto: ConsentReasonDto): Promise<ConsentDocumentView>;
    revoke(tenantId: string, documentId: string, actor: ClinicalActor, dto: ConsentReasonDto): Promise<ConsentDocumentView>;
    pdf(tenantId: string, documentId: string, actor: ClinicalActor): Promise<{ fileName: string; data: Buffer }>;
  }
  export class SignConsentDto {
    signerRole: 'PATIENT' | 'REPRESENTATIVE';
    signerName: string;               // 2–200
    signerIdentification?: string;    // ≤ 30
    relationship?: string;            // ≤ 100, required for REPRESENTATIVE
    understood: boolean; questionsAnswered: boolean; marketingPhotos?: boolean;
    signature: string;                // 'data:image/png;base64,…', ≤ MAX_SIGNATURE_CHARS, PNG magic checked
  }
  export class ConsentReasonDto { reason: string } // 3–1000
  ```
- `present`: `PRESENT_CONSENT` allowed; reuse an existing `PRESENTED` document of the session (idempotent); else render the pinned `ConsentTemplateVersion` (even if since retired) with `ConsentValues` from patient (`firstName lastName`, `identificationNumber`), treatment name, professional name and today's date in the tenant timezone (`src/common/utils/timezone.ts`); store encrypted title/body + `checksum`; event `PRESENTED`; audit.
- `sign`: only `PRESENTED` documents (else 409 `CONSENT_DOCUMENT_INVALID_STATE`); `SIGN_CONSENT` allowed on its session; `understood && questionsAnswered` else 422 `CONSENT_DECLARATIONS_REQUIRED`; patient with `dateOfBirth` and age < 18 at server time with `PATIENT` → 422 `CONSENT_REPRESENTATIVE_REQUIRED`; `REPRESENTATIVE` without `relationship` → 400. In one serializable transaction: write signature PNG and PDF to storage under `${tenantId}/consents/${documentId}/signature` and `/pdf` (encrypted with `encryptBuffer`); create `ConsentSignature` with operator, `ipAddress`, `userAgent` from the actor; document → `SIGNED`, `signedAt`, `pdfStorageKey`, `pdfChecksum` (sha256 of the plain PDF); session → `CONSENTED` with `consentDocumentId`; event `SIGNED`; audit. Storage writes happen before the transaction and are removed if it fails, as in `PatientFilesService.upload`.
- `refuse`: only `PRESENTED`; document `REFUSED`, session `CONSENT_REFUSED`, encounter closed with `closeEncounter`; event with encrypted reason.
- `revoke`: only `SIGNED`; document `REVOKED`; if its own session is `CONSENTED` → `CONSENT_REVOKED` and encounter closed; any other session state is left alone. Revocation is allowed to the session's professional or the tenant `MASTER`.
- `pdf`: recompute sha256 of the decrypted bytes; mismatch → 500 `CONSENT_PDF_INTEGRITY`; audit `READ CONSENT_DOCUMENT`. Controller sends `application/pdf` with `Content-Disposition: attachment; filename="consentimiento-<id>.pdf"`, as `patient-files.controller.ts` does.
- Routes: `POST treatment-sessions/:id/consents`, `POST consent-documents/:id/sign|refuse|revoke`, `GET consent-documents/:id/pdf`, same guards as Task 6.

- [ ] **Step 1: Write failing service tests**: present twice returns the same document id; present on a treatment without consent → 409 `TREATMENT_SESSION_INVALID_TRANSITION`; present uses the pinned version after the template's newer version is published (body of v2, not v3); sign stores `pdfChecksum === sha256(pdf)` and moves the session to `CONSENTED`; sign twice → second call 409 `CONSENT_DOCUMENT_INVALID_STATE` and no second storage write; declarations false → 422; minor + `PATIENT` → 422 `CONSENT_REPRESENTATIVE_REQUIRED`; no `dateOfBirth` + `PATIENT` → signs; signature not PNG → 400; refuse → `CONSENT_REFUSED` and encounter closed; revoke on `CONSENTED` → `CONSENT_REVOKED`; revoke after `IN_PROGRESS` leaves the session status; pdf with tampered bytes → `CONSENT_PDF_INTEGRITY`; storage write removed when the transaction throws.
- [ ] **Step 2: Run** `npx jest src/treatment-sessions/consent-documents` — Expected: FAIL.
- [ ] **Step 3: Implement** service, DTOs and controller; wire into `TreatmentSessionsModule`.
- [ ] **Step 4: Run** `npx jest src/treatment-sessions` — Expected: PASS.
- [ ] **Step 5: Commit** `feat(api): present, sign, refuse and revoke consents with an immutable PDF`.

### Task 8: Fotos y transiciones clínicas — media, start, complete, cancel, no-show

**Files:**
- Modify: `src/patient-files/patient-files.service.ts`, `src/patient-files/patient-files.service.spec.ts`
- Create: `src/treatment-sessions/session-media.service.ts`, `src/treatment-sessions/session-media.service.spec.ts`
- Modify: `src/treatment-sessions/treatment-sessions.service.ts`, `src/treatment-sessions/treatment-sessions.service.spec.ts`, `src/treatment-sessions/treatment-sessions.controller.ts`, `src/treatment-sessions/dto/treatment-session.dto.ts`

**Interfaces:**
- Consumes: Tasks 2, 3 (`stripJpegMetadata`), 6.
- Produces:
  ```ts
  // patient-files.service.ts — upload gains an optional last argument
  upload(tenantId, patientId, actor, part, dto, session?: { treatmentSessionId: string; phase: SessionMediaPhase }): Promise<PatientFileView>;

  export class SessionMediaService {
    upload(tenantId: string, sessionId: string, actor: ClinicalActor, part: UploadedFilePart | undefined,
      dto: { phase: SessionMediaPhase; description?: string }): Promise<PatientFileView>;
  }
  // TreatmentSessionsService additions
  start(tenantId: string, sessionId: string, actor: ClinicalActor): Promise<SessionDetail>;
  complete(tenantId: string, sessionId: string, actor: ClinicalActor, dto: { procedureNotes?: string }): Promise<SessionDetail>;
  cancel(tenantId: string, sessionId: string, actor: ClinicalActor, dto: { reason: string }): Promise<SessionDetail>;
  noShow(tenantId: string, sessionId: string, actor: ClinicalActor): Promise<SessionDetail>;
  ```
- `SessionMediaService.upload`: command `UPLOAD_BEFORE|UPLOAD_AFTER|UPLOAD_OTHER` by phase (refusal → 409 `SESSION_PHOTO_PHASE_NOT_ALLOWED` instead of the generic transition code); `BEFORE`/`AFTER` accept only `image/jpeg` and `image/png` (else 400 `PATIENT_FILE_INVALID`); JPEGs pass through `stripJpegMetadata` (a `MALFORMED_JPEG` error → 400 `PATIENT_FILE_INVALID`) before `PatientFilesService.upload` with `category: 'IMAGEN'` and `encounterId` of the session.
- `start`: serializable transaction; `START` allowed; `loadSessionFacts`; `evaluateSession(...).start` non-empty → `requirementsMissing`; else `IN_PROGRESS`, `startedAt: new Date()`, and `consentDocumentId` set to the applicable consent when required.
- `complete`: `COMPLETE` allowed; `procedureNotes` from the body (trimmed, ≤ 10000, encrypted) or the stored one; `evaluateSession(...).complete` with `hasNotes` from that value; non-empty → 422; else `CLINICAL_COMPLETE`, `completedAt`, notes stored, `closeEncounter(..., summary = notes)`.
- `cancel` (reason 3–1000, encrypted) and `noShow`: allowed per table; set `cancelledAt`; close the encounter; `noShow` marks the appointment `NO_SHOW` when present.
- Routes: `POST treatment-sessions/:id/media` (`FileInterceptor('file')`, same limits as `patient-files.controller.ts`), `POST treatment-sessions/:id/start|complete|cancel|no-show`.

- [ ] **Step 1: Write failing tests.**
  - `patient-files.service.spec.ts`: upload with a session context stores `treatmentSessionId` and `phase`.
  - `session-media.service.spec.ts`: `BEFORE` in `INTAKE_IN_PROGRESS` → 409 `SESSION_PHOTO_PHASE_NOT_ALLOWED`; `BEFORE` in `CONSENTED` stores a JPEG without its APP1 bytes; `AFTER` before `IN_PROGRESS` → 409; PDF with phase `BEFORE` → 400; JPEG mimetype with PNG bytes → 400 and nothing stored; truncated JPEG → 400.
  - `treatment-sessions.service.spec.ts`: start with every requirement missing → 422 with `missing` equal to `['FINALIZED_MEDICAL_FORM','SIGNED_APPLICABLE_CONSENT','BEFORE_PHOTOS']` (that order); start satisfied → `IN_PROGRESS` with `startedAt` set by the server; start while the reused consent was revoked by another session → 422 `SIGNED_APPLICABLE_CONSENT`; complete without notes and photos → 422 `['CLINICAL_NOTES','AFTER_PHOTOS']`; complete satisfied → `CLINICAL_COMPLETE` and encounter closed; start called twice → second 409; cancel from `IN_PROGRESS` requires a reason; no-show from `IN_PROGRESS` → 409.
- [ ] **Step 2: Run** `npx jest src/patient-files src/treatment-sessions` — Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `npx jest` (whole unit suite) and `npm run lint` — Expected: PASS, no lint errors.
- [ ] **Step 5: Commit** `feat(api): session photos and clinical transitions gated by the treatment requirements`.

### Task 9: e2e del recorrido y documentación de la API

**Files:**
- Create: `test/treatment-sessions.e2e-spec.ts`
- Modify: `docs/API_ENDPOINTS.md`, `README.md` (sección "Core endpoints": una línea que apunte a tratamientos y sesiones)

**Interfaces:**
- Consumes: every route of Tasks 4–8; fixtures as in `test/clinical-workflow.e2e-spec.ts` (`createTestTenant`, `UsersService.create`, `login`, local storage dir).

- [ ] **Step 1: Write the e2e suite** with these cases (each `it` independent where possible; a JPEG fixture built in the test with an APP1 segment, a 1×1 PNG signature fixture):
  - Recorrido completo: plantilla → publicar → formulario → tratamiento con ficha, consentimiento y 1 foto antes/después y notas → sesión `INTAKE_IN_PROGRESS` → ficha → `READY_FOR_CONSENT` → presentar → firmar → `CONSENTED` → foto antes → start → `IN_PROGRESS` → foto después → complete con notas → `CLINICAL_COMPLETE`; `GET consent-documents/:id/pdf` 200 `application/pdf` whose sha256 equals the stored `pdfChecksum`; the session's encounter is `CLOSED`; the stored photo file under `STORAGE_LOCAL_PATH` is encrypted (does not contain `Exif`).
  - E2E-03: ficha guardada, sin firma → start 422 with `missing` containing `SIGNED_APPLICABLE_CONSENT`.
  - E2E-05: firmar sobre v1 (de la plantilla), publicar v2 → `GET treatment-sessions/:id` keeps the document's `templateVersionId` and `checksum`; the PDF still downloads with the same hash.
  - E2E-09: a professional of tenant B requesting tenant A's session and document ids under `/tenants/B/...` gets 404 `TREATMENT_SESSION_NOT_FOUND` / `CONSENT_DOCUMENT_NOT_FOUND`; under `/tenants/A/...` the existing `TenantGuard` answers 403; no response body contains the consent `title`.
  - E2E-10: firmar y revocar antes de start → session `CONSENT_REVOKED`; start → 409.
  - E2E-12: sign and start with a body carrying `signedAt`/`startedAt` in 2001 → stored times within 60 s of the test clock.
  - E2E-16: paciente de 10 años → firma como `PATIENT` 422 `CONSENT_REPRESENTATIVE_REQUIRED`; como `REPRESENTATIVE` con relación → 201/200.
  - Encounter guard: `POST /patients/:pid/encounters/:eid/close` on the session's encounter → 409 `ENCOUNTER_MANAGED_BY_SESSION`.
  - Compliance: an `ASISTENTE` granted `billing.view` gets `{ status, missing }` only.
- [ ] **Step 2: Run** `DATABASE_URL_TEST=postgresql://postgres:postgres@localhost:5432/psic_clinic_test npx prisma db push --skip-generate && DATABASE_URL_TEST=postgresql://postgres:postgres@localhost:5432/psic_clinic_test npx jest --config ./test/jest-e2e.json --runInBand test/treatment-sessions.e2e-spec.ts` — Expected: PASS (fix code, not tests, on failure).
- [ ] **Step 3: Run the full CI sequence locally:** `npm run lint && npm test -- --runInBand && npm run test:e2e -- --runInBand && npm run build` with `DATABASE_URL` and `DATABASE_URL_TEST` pointing to `psic_clinic_test` — Expected: all PASS.
- [ ] **Step 4: Document** every new route in `docs/API_ENDPOINTS.md` (method, path, who, result, error codes) in the existing table style.
- [ ] **Step 5: Commit and push** `test(api): end-to-end treatment session flow; docs` then `git push -u origin claude/compassionate-hopper-t6teqf`.

## Web (`hcx-care-client`)

### Task 10: Tipos, endpoints y hooks

**Files:**
- Create: `src/types/treatments.ts`
- Modify: `src/lib/constants.ts` (`API_ENDPOINTS`, `QUERY_KEYS`), `src/lib/api/endpoints.ts`
- Create: `src/hooks/useTreatments.ts`, `src/hooks/useConsentTemplates.ts`, `src/hooks/useTreatmentSessions.ts`, `src/hooks/useTreatmentSessions.test.tsx`

**Interfaces:**
- Produces:
  ```ts
  // types/treatments.ts — mirror the API JSON of Tasks 4–8
  export type TreatmentSessionStatus = 'INTAKE_IN_PROGRESS' | 'READY_FOR_CONSENT' | 'CONSENTED' | 'IN_PROGRESS'
    | 'CLINICAL_COMPLETE' | 'CONSENT_REFUSED' | 'CONSENT_REVOKED' | 'CANCELLED' | 'NO_SHOW';
  export type MissingRequirement = 'FINALIZED_MEDICAL_FORM' | 'SIGNED_APPLICABLE_CONSENT' | 'BEFORE_PHOTOS' | 'CLINICAL_NOTES' | 'AFTER_PHOTOS';
  export const SESSION_STATUS_LABELS: Record<TreatmentSessionStatus, string>;
  export const MISSING_REQUIREMENT_LABELS: Record<MissingRequirement, string>;
  export interface TreatmentRequirements { /* same shape as API */ }
  export interface Treatment, TreatmentVersion, ConsentTemplate, ConsentTemplateVersion,
    ConsentDocument, TreatmentSessionSummary, TreatmentSessionDetail, SessionMedia;
  export interface SignConsentInput { signerRole; signerName; signerIdentification?; relationship?; understood; questionsAnswered; marketingPhotos; signature }

  // endpoints.ts
  export const treatmentsApi = { list, get, create, update, addVersion };
  export const consentTemplatesApi = { list, get, create, saveDraft, publish, retire };
  export const treatmentSessionsApi = { listForPatient, create, get, saveForm, presentConsent, signConsent,
    refuseConsent, revokeConsent, consentPdf /* returns Blob */, uploadMedia /* FormData */, start, complete, cancel, noShow };

  // hooks
  useTreatments(filters?), useTreatment(id), useCreateTreatment(), useUpdateTreatment(), useAddTreatmentVersion(id)
  useConsentTemplates(), useConsentTemplate(id), useCreateConsentTemplate(), useSaveConsentDraft(id), usePublishConsent(id), useRetireConsentVersion()
  usePatientTreatmentSessions(patientId), useTreatmentSession(id), useCreateTreatmentSession(patientId),
  useSessionCommand(id)  // mutations: saveForm, presentConsent, signConsent, refuseConsent, revokeConsent, uploadMedia, start, complete, cancel, noShow
  ```
  Query keys: `TREATMENTS`, `TREATMENT(id)`, `CONSENT_TEMPLATES`, `CONSENT_TEMPLATE(id)`, `PATIENT_TREATMENT_SESSIONS(patientId)`, `TREATMENT_SESSION(id)`. Every session mutation invalidates `TREATMENT_SESSION(id)` and the patient's list. Mutations surface `error.message`; a 422 with `missing` keeps `missing` on the thrown `ApiError` (`details` or a `missing` field, per `src/lib/api/client.ts` error mapping).

- [ ] **Step 1: Write failing hook test** (`useTreatmentSessions.test.tsx`, mocking `apiClient` like `usePatientTeam.test.tsx`): `useSessionCommand(id).start` calls `POST …/treatment-sessions/:id/start` and invalidates `TREATMENT_SESSION(id)`; a rejected 422 exposes `missing` to the caller.
- [ ] **Step 2: Run** `npx vitest run src/hooks/useTreatmentSessions.test.tsx` — Expected: FAIL.
- [ ] **Step 3: Implement** types, endpoints, query keys and hooks.
- [ ] **Step 4: Run** the test and `npm run type-check` — Expected: PASS.
- [ ] **Step 5: Commit** `feat(web): treatment, consent and session API client`.

### Task 11: Administración — tratamientos y consentimientos

**Files:**
- Create: `src/app/(dashboard)/admin/treatments/page.tsx`, `src/features/admin/treatments/treatments-page.tsx`, `src/features/admin/treatments/treatment-version-form.tsx`, `src/features/admin/treatments/treatment-version-form.test.tsx`
- Create: `src/app/(dashboard)/admin/consents/page.tsx`, `src/features/admin/consents/consents-page.tsx`, `src/features/admin/consents/consent-template-editor.tsx`, `src/features/admin/consents/consent-template-editor.test.tsx`
- Modify: `src/components/layout/sidebar.tsx`

**Interfaces:**
- Consumes: Task 10 hooks; `useFormDefinitions` (existing, `src/hooks/useClinicalModules.ts`) for the form selector; `usePermissions().can('treatments.manage', …)`.
- Produces:
  ```ts
  export interface TreatmentVersionFormProps {
    initial?: TreatmentVersion;
    forms: { id: string; name: string; versions: number[] }[];
    consentVersions: { id: string; label: string }[]; // only PUBLISHED versions
    onSubmit: (input: TreatmentVersionInput) => void; submitting?: boolean;
  }
  export interface ConsentTemplateEditorProps { template?: ConsentTemplate; onSaveDraft(input: { title: string; body: string }): void; onPublish(): void; }
  ```
- Sidebar: under the group of "Módulos clínicos", entries `Tratamientos` (`/admin/treatments`) and `Consentimientos` (`/admin/consents`), shown when `isEnabled('core.specialties') && can('treatments.manage', isMaster)`.
- The version form validates on the client what the API validates (price ≥ 0 two decimals, tax 0–100, duration 5–1440, form required ⇒ form + version chosen, consent required ⇒ consent version chosen) and shows the API's `issues` when it answers 400.
- The consent editor shows the five variables as insertable chips, a live preview with sample values, and for each version its number, status, date and the first 12 characters of `checksum`.

- [ ] **Step 1: Write failing tests**: version form blocks submit and shows "Elige la ficha" when the form requirement is on without a form; submits `requirements` exactly in the API shape with numbers (not strings); consent editor inserts `{{paciente}}` at the cursor and the preview shows the sample name; publish button disabled when there is no draft.
- [ ] **Step 2: Run** `npx vitest run src/features/admin/treatments src/features/admin/consents` — Expected: FAIL.
- [ ] **Step 3: Implement** pages, components and sidebar entries with the existing UI primitives (`Card`, `Button`, `Dialog`, `Input`, `Label`, `Textarea`, `Badge`).
- [ ] **Step 4: Run** the tests, `npm run lint` and `npm run type-check` — Expected: PASS.
- [ ] **Step 5: Commit** `feat(web): manage treatments and consent templates`.

### Task 12: Pestaña "Tratamientos" y página de atención (ficha y consentimiento)

**Files:**
- Modify: `src/app/(dashboard)/patients/[id]/page.tsx`
- Create: `src/features/treatment-sessions/patient-treatments-tab.tsx`, `src/features/treatment-sessions/patient-treatments-tab.test.tsx`
- Create: `src/app/(dashboard)/treatment-sessions/[id]/page.tsx`, `src/features/treatment-sessions/session-workflow.tsx`, `src/features/treatment-sessions/session-steps.ts`, `src/features/treatment-sessions/session-steps.test.ts`
- Create: `src/features/treatment-sessions/form-step.tsx`, `src/features/treatment-sessions/consent-step.tsx`, `src/features/treatment-sessions/consent-step.test.tsx`

**Interfaces:**
- Consumes: Task 10 hooks; `ClinicalModuleForm`, `initialModuleValues`, `toRecordData`, `issuesByField`, `SignaturePad` (existing).
- Produces:
  ```ts
  // session-steps.ts — pure, drives the stepper from the server's answer
  export type SessionStepId = 'form' | 'consent' | 'before' | 'procedure' | 'after' | 'close';
  export interface SessionStep { id: SessionStepId; label: string; state: 'done' | 'current' | 'pending' | 'skipped' | 'blocked'; missing: MissingRequirement[] }
  export function buildSessionSteps(session: TreatmentSessionDetail): SessionStep[];
  ```
  Step labels: `Ficha`, `Consentimiento`, `Fotos antes`, `Procedimiento`, `Fotos después`, `Cierre`. A step is `skipped` when the policy does not require it (`before`/`after` with minimum 0 stay visible as optional, state `done` when ≥ minimum).
- Tab "Tratamientos" (id `treatments`) in the patient page, visible when `canSeeClinical` and `isEnabled('core.specialties')`; lists sessions (treatment, date, `SESSION_STATUS_LABELS`) and "Nueva atención" (dialog: treatment from `useTreatments({ active: true })`, optional appointment of the patient) → navigates to `/treatment-sessions/[id]`.
- `ConsentStep`: renders the presented document's title and body in a scrollable region (`role="document"`, `aria-label="Texto del consentimiento"`); the signing form renders only after the region is scrolled to the end (or when its content does not overflow); signer fields prefilled from the patient (`guardianName`, `guardianRelationship`, `guardianIdentification` when the patient is a minor and role defaults to `REPRESENTATIVE`); checkboxes "Recibí la información y la comprendí", "Pude hacer preguntas y fueron respondidas", "Autorizo el uso publicitario de mis fotos (opcional)"; "Firmar" calls `signConsent` and shows "Firmado" only after the mutation resolves; "Rechazar" asks for a reason. A signed document shows signer, time and a "Descargar PDF" button (`consentPdf` → object URL).

- [ ] **Step 1: Write failing tests.**
  - `session-steps.test.ts`: `INTAKE_IN_PROGRESS` with form required → `form` current, others pending; `CONSENTED` with `requirements.start = ['BEFORE_PHOTOS']` → `before` current with that missing code; consent not required → `consent` skipped; `CLINICAL_COMPLETE` → all done or skipped.
  - `consent-step.test.tsx`: the signature pad is absent before scrolling and present after firing `scroll` to the bottom; with a mocked `signConsent` that rejects (network error) the text "Firmado" never appears and the error message is shown; submit sends `understood`/`questionsAnswered` true and the drawn PNG.
  - `patient-treatments-tab.test.tsx`: lists two sessions with their Spanish status labels; "Nueva atención" posts `{ treatmentId }` and calls `router.push('/treatment-sessions/<id>')`.
- [ ] **Step 2: Run** `npx vitest run src/features/treatment-sessions` — Expected: FAIL.
- [ ] **Step 3: Implement** the tab, the page shell (`session-workflow.tsx` with header: patient, treatment, status badge, stepper), `FormStep` (renders `session.form.schema` as `{ renderer: 'FORM', schema }`, starts from `session.form.data`, saves via `saveForm`, shows 422 issues by field) and `ConsentStep`.
- [ ] **Step 4: Run** the tests, `npm run lint`, `npm run type-check` — Expected: PASS.
- [ ] **Step 5: Commit** `feat(web): patient treatments tab and tablet intake and consent steps`.

### Task 13: Página de atención — fotos, procedimiento y cierre

**Files:**
- Create: `src/features/treatment-sessions/photos-step.tsx`, `src/features/treatment-sessions/photos-step.test.tsx`, `src/features/treatment-sessions/procedure-step.tsx`, `src/features/treatment-sessions/procedure-step.test.tsx`
- Modify: `src/features/treatment-sessions/session-workflow.tsx`

**Interfaces:**
- Consumes: Task 10 (`uploadMedia`, `start`, `complete`, `cancel`, `noShow`), Task 12 (`buildSessionSteps`).
- Produces: `PhotosStep({ session, phase: 'BEFORE' | 'AFTER' })`, `ProcedureStep({ session })`.
- `PhotosStep`: file input `accept="image/jpeg,image/png" capture="environment"`; uploads one file at a time and lists uploaded thumbnails metadata (name, time) — images themselves are not fetched in this task; shows "N de M fotos" against the minimum.
- `ProcedureStep`: "Iniciar procedimiento" enabled when `allowedCommands` includes `START`; on 422 shows each `missing` with `MISSING_REQUIREMENT_LABELS`; in `IN_PROGRESS` shows the notes textarea and "Cerrar atención" (sends `procedureNotes`), plus "Cancelar atención" (reason dialog). `NO_SHOW` button visible only while `allowedCommands` includes `NO_SHOW`.

- [ ] **Step 1: Write failing tests**: `photos-step` uploads with `phase=BEFORE` in the FormData and shows "1 de 1 fotos" after the mutation resolves; `procedure-step` shows "Falta el consentimiento firmado" when `start` rejects with `missing: ['SIGNED_APPLICABLE_CONSENT']`; "Cerrar atención" sends the typed notes; the start button is disabled when `START` is not in `allowedCommands`.
- [ ] **Step 2: Run** `npx vitest run src/features/treatment-sessions` — Expected: FAIL.
- [ ] **Step 3: Implement** both steps and mount them in `session-workflow.tsx`.
- [ ] **Step 4: Run** `npm run lint && npm run type-check && npm test` — Expected: PASS.
- [ ] **Step 5: Commit and push** `feat(web): session photos, procedure start and clinical close` then `git push -u origin claude/compassionate-hopper-t6teqf`.
