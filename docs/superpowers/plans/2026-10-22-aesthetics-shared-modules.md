# Estética sobre los módulos compartidos Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the aesthetic tables, routes, permissions, section and `businessKind` with an Estética specialty that runs on patients, appointments, treatments, consents, files and clinic forms, keeping health-only modules out of its reach.

**Architecture:** Estética becomes the catalog specialty `AESTHETICS`. Clinical module definitions gain `healthOnly`, and a single predicate `isHealthSpecialty(code)` decides who may use them; a guard applies the same rule to clinical notes and next session plans. One migration adds the specialty and drops everything aesthetic. The web loses its aesthetics screen and business-kind switches.

**Tech Stack:** NestJS 10, Prisma 6 / PostgreSQL, Jest + supertest (api); Next.js 14, React, TanStack Query, Zod, Vitest (web).

**Spec:** `docs/superpowers/specs/2026-10-22-aesthetics-shared-modules-design.md`

## Global Constraints

- Branch `feat/aesthetics-shared-modules` from `origin/main` in `api/` (already created, holds the spec) and in `web/`.
- Specialty: code `AESTHETICS`, name `Estética`, description `Procedimientos estéticos faciales y corporales.`, offered on every `PlanType`.
- `AESTHETIC_SPECIALTY_CODES = ['AESTHETICS']`; health-only modules: `general.soap-note`, `general.vital-signs`, `general.diagnoses`, `general.prescriptions`, `general.orders`, `general.referrals`, `general.certificates`.
- Health-only module refusal: 403 `CLINICAL_RECORD_FORBIDDEN`, message `Tu especialidad no puede registrar este módulo` (existing `clinicalRecordForbidden`).
- Clinical note / next session plan refusal: 403 `HEALTH_SPECIALTY_REQUIRED`.
- Health-only section: `core.clinicalNotes`.
- The UI keeps the word "pacientes" everywhere.
- Windows checkout: tracked files are CRLF; edit with the Edit tool. `npm run lint` in api is broken (ajv); use `npx prettier --check` on touched files.
- Never run the seed, migrations or e2e against the `DATABASE_URL` of `api/.env` (it is the remote Supabase). Use the disposable PostgreSQL described in the project memory (embedded-postgres on a free port, databases `psic_seed_check` and `psic_clinic_test`).

## Review Focus

- A mixed clinic (Estética + Medicina General): the physician still records SOAP and prescriptions and writes clinical notes; only the esthetician is refused. Tests in Tasks 1 and 2.
- A MASTER without a professional profile in a studio: the health guard must not turn every request into 403; it only refuses callers whose own profile is non-health. Test in Task 2.
- Alta with Estética plus another specialty: `core.clinicalNotes` stays on; only an aesthetic-only alta switches it off. Tests in Task 4 (api) and Task 7 (web).
- An old web client sending `core.aesthetics` or `businessKind` after the API ships: 400 `SECTION_UNKNOWN` / validation error, never a 500. Test in Task 3.
- A database that ran the previous release: the migration must succeed with leftover `Aesthetic*` rows and an `AESTHETIC_STUDIO` tenant, and that tenant must keep its users and `core.team`. Verification in Task 3.

---

## API (`api/`)

### Task 1: Health-only clinical modules

**Files:**
- Modify: `src/clinical-modules/module-builders.ts` (`ClinicalModuleDefinition`)
- Modify: `src/clinical-modules/clinical-module-registry.ts`
- Modify: `src/clinical-modules/definitions/general.ts` (the seven modules)
- Modify: `src/clinical-modules/clinical-modules.service.ts` (`listForTenant`)
- Modify: `src/specialty-records/specialty-records.service.ts:547-557` (GENERAL branch of the target resolution)
- Test: `src/clinical-modules/clinical-module-registry.spec.ts`, `src/clinical-modules/clinical-modules.service.spec.ts`, `src/specialty-records/specialty-records.service.spec.ts`

**Interfaces:**
- Produces: `ClinicalModuleDefinition.healthOnly?: boolean`; `AESTHETIC_SPECIALTY_CODES: readonly ['AESTHETICS']`; `isHealthSpecialty(code: string | null | undefined): boolean` (true for any code not in the list, including `null`), all exported from `clinical-module-registry.ts`.

- [ ] **Step 1: Write the failing tests**

```ts
// clinical-module-registry.spec.ts
it('marks exactly the health-only general modules', () => {
  expect(GENERAL_MODULES.filter((m) => m.healthOnly).map((m) => m.moduleKey).sort()).toEqual([
    'general.certificates', 'general.diagnoses', 'general.orders', 'general.prescriptions',
    'general.referrals', 'general.soap-note', 'general.vital-signs',
  ]);
});
it('treats only AESTHETICS as a non-health specialty', () => {
  expect(isHealthSpecialty('AESTHETICS')).toBe(false);
  expect(isHealthSpecialty('PSYCHOLOGY')).toBe(true);
  expect(isHealthSpecialty(null)).toBe(true);
});

// clinical-modules.service.spec.ts — three cases with the existing mocks
// own profile AESTHETICS, tenant specialties [AESTHETICS]:
//   general.soap-note → { enabled: false, canRecord: false }; general.allergies → { enabled: true, canRecord: true }
// own profile AESTHETICS, tenant specialties [AESTHETICS, GENERAL_MEDICINE]:
//   general.soap-note → { enabled: true, canRecord: false }
// own profile GENERAL_MEDICINE, same tenant: general.soap-note → { enabled: true, canRecord: true }

// specialty-records.service.spec.ts
it('refuses a health-only module to an aesthetic professional', async () => {
  // actor.specialtyId resolves to code 'AESTHETICS'; dto.moduleKey 'general.soap-note'
  await expect(create()).rejects.toMatchObject({
    status: 403,
    response: { code: 'CLINICAL_RECORD_FORBIDDEN', message: 'Tu especialidad no puede registrar este módulo' },
  });
});
it('still lets a physician record a health-only module', async () => { /* code 'GENERAL_MEDICINE' → resolves */ });
```

- [ ] **Step 2: Run them to see them fail**

Run: `npx jest src/clinical-modules src/specialty-records`
Expected: FAIL (`healthOnly`, `isHealthSpecialty` undefined; SOAP accepted for AESTHETICS).

- [ ] **Step 3: Implement**

Add `healthOnly?: boolean` next to `allowedSpecialtyCodes` in `module-builders.ts`; set `healthOnly: true` on the seven definitions; export the constant and predicate from the registry. In `listForTenant`: `enabled` of a `healthOnly` GENERAL module is false when no active tenant specialty is health; `withinSpecialty` is false when `ownCode` is not health. In `specialty-records.service.ts` the GENERAL branch loads the own specialty code once when either `allowedSpecialtyCodes` or `healthOnly` is set, and throws the existing `clinicalRecordForbidden(...)` when `healthOnly && !isHealthSpecialty(code)`.

- [ ] **Step 4: Run them to see them pass**

Run: `npx jest src/clinical-modules src/specialty-records`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/clinical-modules src/specialty-records
git commit -m "feat(clinical-modules): keep health-only modules away from aesthetic professionals"
```

### Task 2: Health guard on clinical notes and next session plans

**Files:**
- Create: `src/clinical-access/health-specialty.guard.ts`
- Modify: `src/clinical-notes/clinical-notes.controller.ts` (`create`), `src/next-session-plans/next-session-plans.controller.ts` (`create`), and their modules if the guard needs `PrismaService` provided
- Test: `src/clinical-access/health-specialty.guard.spec.ts`

**Interfaces:**
- Consumes: `isHealthSpecialty` (Task 1).
- Produces: `HealthSpecialtyGuard implements CanActivate`, used with `@UseGuards(HealthSpecialtyGuard)` on the two `@Post()` handlers.

- [ ] **Step 1: Write the failing test** — `health-specialty.guard.spec.ts` with a mocked `professionalProfile.findFirst` (where `{ userId, isActive: true, user: { tenantId, isActive: true } }`, select `specialty.code`):
  - profile `AESTHETICS` → rejects `{ status: 403, response: { code: 'HEALTH_SPECIALTY_REQUIRED' } }`;
  - profile `GENERAL_MEDICINE` → `true`;
  - no profile (MASTER without one) → `true`;
  - a reflection test: `Reflect.getMetadata('__guards__', ClinicalNotesController.prototype.create)` and the same for `NextSessionPlansController.prototype.create` contain `HealthSpecialtyGuard`.
- [ ] **Step 2: Run it to see it fail** — `npx jest src/clinical-access/health-specialty.guard.spec.ts` → FAIL (module not found).
- [ ] **Step 3: Implement the guard** — message `Las especialidades no clínicas no registran notas clínicas ni planes de sesión.`; apply it to both `create` handlers only (reads unchanged).
- [ ] **Step 4: Run it and the controllers' specs** — `npx jest src/clinical-access src/clinical-notes src/next-session-plans` → PASS.
- [ ] **Step 5: Commit** — `feat(clinical-access): refuse clinical notes and session plans to non-health specialties`.

### Task 3: Remove the aesthetic module and `businessKind`; add Estética to the catalog

**Files:**
- Create: `prisma/migrations/20261022000000_aesthetics_on_shared_modules/migration.sql`
- Modify: `prisma/schema.prisma` (drop the six `Aesthetic*` models, both `Aesthetic*` enums, `TenantBusinessKind`, `Tenant.businessKind` and every back-relation to them on `Tenant` and `User`)
- Delete: `src/aesthetics/` (whole folder), `test/aesthetics.e2e-spec.ts`, `prisma/seed-aesthetic-studio.ts`
- Modify: `src/app.module.ts`, `src/prisma/prisma.service.ts` (aesthetic entries in the RLS model list and `cleanDatabase`)
- Modify: `src/common/sections/section-catalog.ts`, `src/common/guards/section.guard.ts`, `src/common/permissions/permission-catalog.ts`
- Modify: `src/platform/dto/create-platform-tenant.dto.ts`, `src/platform/platform-tenants.service.ts`, `src/platform/platform-tenants.controller.ts`, `src/platform/platform-role-permissions.service.ts`
- Modify: `src/users/users.service.ts`, `src/users/user-permissions.service.ts`, `src/professional-profiles/professional-profiles.service.ts`
- Modify: `prisma/seed.ts` (drop the aesthetic block of `clearDatabase`, the `seedAestheticStudio` call and `withTenantContext` import), `prisma/seed-helpers.ts` (drop `businessKind` and `withTenantContext`)
- Modify tests: `src/common/guards/section.guard.spec.ts`, `src/common/sections/section-catalog.spec.ts`, `src/common/permissions/permissions.spec.ts`, `src/common/permissions/role-permission-enforcement.spec.ts`, `src/platform/platform-access.controller.spec.ts`, `src/platform/platform-role-permissions.service.spec.ts`, `src/platform/platform-tenants.service.spec.ts`, `src/professional-profiles/professional-profiles.service.spec.ts`, `src/users/users.team.spec.ts`, `test/helpers/create-test-tenant.ts`, `test/specialty-onboarding-team.e2e-spec.ts`, `test/platform-admin.e2e-spec.ts`, `test/seed-coverage.spec.ts` (studio block), `test/seed-clinical-workflow.e2e-spec.ts` (studio block and the `+ 3` photo count)

**Interfaces:**
- Produces: `defaultSections(planType, tenantType)` and `validateSections(keys)` without `businessKind` (Task 4 adds the specialty argument); `SECTION_KEYS` without `core.aesthetics`; no `aesthetics.*` in `PERMISSION_CATALOG`; `PlatformTenantDetail` / list rows without `businessKind`.

- [ ] **Step 1: Write the migration** in this order (spec, "Modelo de datos y migración"):
  1. `INSERT INTO "Specialty" ("id","code","name","description","isActive","createdAt","updatedAt") VALUES ('specialty-aesthetics','AESTHETICS','Estética','Procedimientos estéticos faciales y corporales.',true,now(),now()) ON CONFLICT ("code") DO UPDATE SET "isActive" = true;`
  2. One `PlanSpecialty` row per `PlanType` value selecting the specialty id by code, `ON CONFLICT DO NOTHING` (check the table's unique key in `schema.prisma`).
  3. `DELETE FROM "TenantModule" WHERE "moduleKey" = 'core.aesthetics';` and `DELETE FROM "TenantRolePermission" WHERE "permission" LIKE 'aesthetics.%';`
  4. `DROP TABLE` the six tables children first (`AestheticPhoto`, `AestheticConsent`, `AestheticSession`, `AestheticBooking`, `AestheticService`, `AestheticClient`), then `DROP TYPE "AestheticBookingStatus", "AestheticPhotoPhase";`
  5. `ALTER TABLE "Tenant" DROP COLUMN "businessKind"; DROP TYPE "TenantBusinessKind";`
- [ ] **Step 2: Update `schema.prisma`, delete the folders and files listed, run `npx prisma generate`, then follow the compiler** (`npx tsc --noEmit -p tsconfig.json`) through every file listed until it is clean. Rules while doing so:
  - Platform alta again throws 400 `SPECIALTY_SELECTION_REQUIRED` for an empty `specialtyCodes`; `SPECIALTY_BUSINESS_KIND_MISMATCH` and `SECTION_BUSINESS_KIND_MISMATCH` disappear.
  - `getSectionCatalog().defaults` loses `businessKind` (one row per plan/tenant type).
  - Users and professional profiles go back to requiring a profile for every professional; the studio seat count branch goes away.
  - Test helpers and e2e specs that set `businessKind: 'MEDICAL'` or exclude `core.aesthetics` drop it.
- [ ] **Step 3: Add the old-client tests** — `section-catalog.spec.ts`: `validateSections(['core.aesthetics'])` throws 400 `SECTION_UNKNOWN`; `platform-tenants.service.spec.ts`: alta with `specialtyCodes: []` throws 400 `SPECIALTY_SELECTION_REQUIRED`. Remove the tests that only covered `businessKind` or aesthetic permissions.
- [ ] **Step 4: Run the unit suite** — `npx jest` → all suites pass (`seed-clear.spec.ts` included: no `aesthetic*` model left to empty).
- [ ] **Step 5: Verify the migration on the disposable PostgreSQL**
  - Create a fresh `psic_seed_check`. In a scratch worktree of `origin/main` (outside the repo, `git worktree add <scratch> origin/main`, then `npm ci`), run `npx prisma migrate deploy` and `npx ts-node prisma/seed.ts` against it: the previous seed leaves Aurora with `Aesthetic*` rows and an `AESTHETIC_STUDIO` tenant. Remove the worktree afterwards.
  - Back on this branch: `npx prisma migrate deploy` → applies `20261022000000_aesthetics_on_shared_modules`.
  - `npx prisma migrate diff --from-url "$URL" --to-schema-datamodel prisma/schema.prisma --script` → empty.
  - A query shows `Specialty` `AESTHETICS` active with one `PlanSpecialty` per plan, no `core.aesthetics` rows, and the former studio tenant still present with its users and `core.team` enabled.
- [ ] **Step 6: Commit** — `refactor!: drop the aesthetic module and business kind in favour of the Estética specialty`.

### Task 4: Section defaults by specialty

**Files:**
- Modify: `src/common/sections/section-catalog.ts`, `src/platform/platform-tenants.service.ts` (alta and `getSectionCatalog`), `prisma/seed-helpers.ts` (`createTenant` passes the codes of `spec.specialties`)
- Test: `src/common/sections/section-catalog.spec.ts`, `src/platform/platform-tenants.service.spec.ts`

**Interfaces:**
- Consumes: `isHealthSpecialty` (Task 1).
- Produces: `defaultSections(planType: PlanType, tenantType: TenantType, specialtyCodes: readonly string[] = []): SectionKey[]`; `SectionDefinition.healthOnly?: boolean` (true only on `core.clinicalNotes`); `getSectionCatalog()` returns `{ sections, defaults, nonHealthSpecialtyCodes: string[] }` with `nonHealthSpecialtyCodes = [...AESTHETIC_SPECIALTY_CODES]`.

- [ ] **Step 1: Write the failing tests**
  - `defaultSections('CLINIC_BASIC', 'CLINIC', ['AESTHETICS'])` does not contain `core.clinicalNotes`;
  - `defaultSections('CLINIC_BASIC', 'CLINIC', ['AESTHETICS', 'GENERAL_MEDICINE'])` and `defaultSections('CLINIC_BASIC', 'CLINIC')` contain it;
  - platform alta with `specialtyCodes: ['AESTHETICS']` and no `sections` stores `core.clinicalNotes` disabled; the same alta with `sections` including `core.clinicalNotes` stores it enabled;
  - `getSectionCatalog()` marks `core.clinicalNotes` with `healthOnly: true` and returns `nonHealthSpecialtyCodes: ['AESTHETICS']`.
- [ ] **Step 2: Run them to see them fail** — `npx jest src/common/sections src/platform/platform-tenants.service.spec.ts` → FAIL.
- [ ] **Step 3: Implement** — a section with `healthOnly` is dropped from the defaults when `specialtyCodes` is non-empty and none is health; the alta passes its normalized codes.
- [ ] **Step 4: Run them to see them pass**; also `npx jest test/seed-coverage.spec.ts`.
- [ ] **Step 5: Add to `test/platform-admin.e2e-spec.ts`** an alta with `specialtyCodes: ['AESTHETICS']` whose detail shows `core.clinicalNotes` disabled and `core.patients`, `core.calendar`, `core.specialties` enabled; run it on the disposable `psic_clinic_test` → PASS.
- [ ] **Step 6: Commit** — `feat(sections): leave clinical notes off for aesthetic-only clinics`.

### Task 5: Seed — Estudio Estético Aurora on the shared modules

**Files:**
- Create: `prisma/seed-aesthetic-studio.ts` (`seedAestheticStudio(ctx: SeedContext): Promise<SeedTenant>`)
- Modify: `prisma/seed.ts` (catalog upsert of `AESTHETICS`, call after `seedClinicalWorkflow`), `prisma/seed-helpers.ts` (`SeedSpecialtyKey` adds `'aesthetics'`, `SPECIALTY_MODULE_KEYS.aesthetics = specialtyModuleKeys('AESTHETICS')`), `prisma/seed-demo-files.ts` (keep `demoSkinPhoto`)
- Test: `test/seed-coverage.spec.ts`, `test/seed-clinical-workflow.e2e-spec.ts`

**Interfaces:**
- Consumes: `createTenant`, `createUser`, `createPatient`, `createAppointment`, `writeAudit`, `syncUsage` (seed-helpers); `renderConsentText`, `consentChecksum`, `renderConsentPdf` (src/consents); `parseTreatmentRequirements` (src/treatments); `demoSignature`, `demoSkinPhoto` (seed-demo-files).
- Produces: logins `titular.aurora@psic.com` (MASTER, no profile), `cosmiatra.aurora@psic.com` and `esteticista.aurora@psic.com` (PROFESIONAL, profile `aesthetics`), `recepcion.aurora@psic.com` (ASISTENTE).

Content is the spec's "Seed: Estudio Estético Aurora" table. Rows must match what the services write — read `TreatmentsService`, `ConsentTemplatesService`, `TreatmentSessionsService`, `ConsentDocumentsService` and `SessionMediaService` before writing them:
- each session opens a `PROCEDURE` `Encounter`; the ficha is a `SpecialtyRecord` of the `FormDefinition` version the treatment pins;
- a signed consent is a `ConsentDocument` (`SIGNED`, encrypted `title`/`body`, `checksum` from `consentChecksum`) plus a `ConsentSignature` whose signature PNG and the document PDF are stored encrypted (`pdfStorageKey`, `pdfChecksum`, `signatureStorageKey`);
- photos are `PatientFile` rows with `category: 'IMAGEN'`, `treatmentSessionId`, `phase: 'BEFORE' | 'AFTER'` and `encounterId`;
- text the API encrypts is left plain here: `encryptClinicalData` runs afterwards — extend it only if it does not already cover the consent and session columns, and say so in the commit.

- [ ] **Step 1: Write the failing `seed-coverage` tests** (`describe('aesthetic studio')`):
  - tenant `Estudio Estético Aurora` has only specialty `AESTHETICS`, `core.clinicalNotes` disabled;
  - every active profile in it is `AESTHETICS`, every `Treatment` in it has the `AESTHETICS` specialty id, `Radiofrecuencia corporal` is inactive;
  - session statuses are exactly `CLINICAL_COMPLETE` ×2, `READY_FOR_CONSENT` ×1, `CANCELLED` ×1; every `CLINICAL_COMPLETE` session whose version requires consent has a `SIGNED` document with a signature; the `READY_FOR_CONSENT` one has none;
  - the completed peeling has ≥1 `BEFORE` and ≥1 `AFTER` file and a form record; all stored bytes (photos, signature, PDF) exist in the fake storage and `storageUsedBytes` equals their sum;
  - no `SpecialtyRecord` in the tenant uses a `healthOnly` module.
- [ ] **Step 2: Run** `npx jest test/seed-coverage.spec.ts` → FAIL.
- [ ] **Step 3: Implement `seedAestheticStudio`** and wire it.
- [ ] **Step 4: Run** `npx jest test/seed-coverage.spec.ts test/seed-clear.spec.ts` → PASS.
- [ ] **Step 5: Extend `seed-clinical-workflow.e2e-spec.ts`** (`describe('aesthetic studio')`): as `cosmiatra.aurora`, list the patient's treatment sessions; download a session photo (PNG signature `89 50 4E 47`) and the consent PDF (`%PDF`); starting the `READY_FOR_CONSENT` session answers 422; creating a `general.soap-note` record answers 403 `CLINICAL_RECORD_FORBIDDEN`; creating a clinical note answers 403 `HEALTH_SPECIALTY_REQUIRED`. Keep the rerun test comparing stored files with `patientFile.count()` plus the consent PDFs and signatures.
- [ ] **Step 6: Run on the disposable DB** — `npx jest --config ./test/jest-e2e.json --runInBand test/seed-clinical-workflow.e2e-spec.ts test/platform-admin.e2e-spec.ts test/treatment-sessions.e2e-spec.ts` → PASS; then `npx ts-node prisma/seed.ts` twice against `psic_seed_check` → both print `✅ Seed completed successfully.`
- [ ] **Step 7: Update docs** — README seed line and `docs/DEPLOYMENT.md` "Load the Demo Data" mention the studio as an Estética clinic; mark `docs/superpowers/specs/2026-10-19-arrayanes-aesthetics.md` as superseded by the new spec in its first line.
- [ ] **Step 8: Commit** — `feat(seed): rebuild the Aurora studio on treatments, consents and patient files`.

## Web (`web/`)

### Task 6: Remove the aesthetics workspace

**Files:**
- Delete: `src/app/(dashboard)/aesthetics/page.tsx`, `src/features/aesthetics/` (both files), `src/lib/api/aesthetics-api.ts`, `src/types/aesthetics.ts`
- Modify: `src/app/(dashboard)/dashboard/page.tsx` (always the regular dashboard), `src/components/layout/sidebar.tsx` (no `isStudio`, no "Estética" entry; Dashboard always shown)
- Test: the sidebar and dashboard tests that exist; add one to the sidebar test if none checks it: no link to `/aesthetics` for any tenant

- [ ] **Step 1:** Write/adjust the sidebar test (no `/aesthetics` link, Dashboard present) → run `npx vitest run src/components/layout` → FAIL.
- [ ] **Step 2:** Delete and edit the files listed.
- [ ] **Step 3:** `npx vitest run src/components/layout src/app` and `npx tsc --noEmit` → PASS (type errors elsewhere are Task 7's files; fix only imports of the deleted modules here).
- [ ] **Step 4:** Commit — `refactor(web): remove the aesthetics workspace`.

### Task 7: Platform alta, sections and team without business kind

**Files:**
- Modify: `src/types/index.ts` (drop `TenantBusinessKind`, `'core.aesthetics'`, every `businessKind` field; `SectionCatalog` gains `nonHealthSpecialtyCodes: string[]` and section `healthOnly?: boolean`)
- Modify: `src/lib/validations/schemas.ts` (drop `businessKind`, the aesthetic team schemas, `'core.aesthetics'`; alta requires ≥1 specialty again)
- Modify: `src/features/platform/create-tenant-form.tsx`, `tenant-sections-card.tsx`, `tenant-detail.tsx` (clinical modules card always shown)
- Modify: `src/features/admin/team/team-member-dialog.tsx`, `team-manager.tsx` (no studio branches)
- Test: `src/features/platform/create-tenant-form.test.tsx`, `tenant-detail.test.tsx`, `src/features/admin/team/team-member-dialog.test.tsx`, `team-manager.test.tsx`

**Interfaces:**
- Consumes: `GET /platform/section-catalog` → `{ sections: { key, name, requires, healthOnly? }[], defaults, nonHealthSpecialtyCodes }` (Task 4).

- [ ] **Step 1: Write the failing tests**
  - create form: no "Tipo de negocio" control; checking only Estética unchecks Notas clínicas; adding Medicina General checks it again; the user can re-check it by hand and it is sent;
  - create form: submitting without a specialty shows the specialty error;
  - team dialog: creating a PROFESIONAL requires a specialty in every tenant;
  - tenant detail: the clinical modules card renders for every tenant.
- [ ] **Step 2: Run** `npx vitest run src/features/platform src/features/admin/team` → FAIL.
- [ ] **Step 3: Implement** — the form recomputes the default sections from the plan/tenant-type defaults, then removes sections with `healthOnly` when every selected code is in `nonHealthSpecialtyCodes`; it only does so when the specialty selection changes, so a manual re-check survives.
- [ ] **Step 4: Run** `npx vitest run` and `npx tsc --noEmit` and `npm run build` → PASS.
- [ ] **Step 5: Commit** — `refactor(web): drop the business kind from platform and team screens`.

## Delivery

### Task 8: Final verification and pull requests

- [ ] **Step 1:** api — `npx jest`, `npx tsc --noEmit -p tsconfig.json`, `npx prettier --check` on touched files, e2e of Task 5 Step 6 → all pass.
- [ ] **Step 2:** web — `npx vitest run`, `npx tsc --noEmit`, `npm run build` → all pass.
- [ ] **Step 3:** `grep -rniE "aesthetic|businessKind|core\.aesthetics" src prisma test` in api (excluding migrations and docs) and `src` in web → only the `AESTHETIC_SPECIALTY_CODES` / `nonHealthSpecialtyCodes` names remain.
- [ ] **Step 4:** Push both branches and open one PR per repo against `main`. Each body states the deploy order (web first, then API with its migration, then assign Estética to former studio tenants) and links the spec.
