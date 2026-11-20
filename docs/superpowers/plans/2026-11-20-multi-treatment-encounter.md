# Atención con varios tratamientos — plan de implementación

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Que una atención (`Encounter`) contenga cero, uno o varios tratamientos (`TreatmentSession`), elegidos al iniciarla o añadidos después, y que cerrar la atención sea el único cierre.

**Architecture:** La relación `Encounter` → `TreatmentSession` pasa de 1:1 a 1:N. Los comandos de la sesión dejan de cerrar la atención; `closeEncounter` rechaza el cierre mientras queden sesiones sin terminar. La creación múltiple y el "no asistió" de la atención viven en `TreatmentSessionsService`, que ya depende de `EncountersService`, para no crear una dependencia circular. En la web, `EncounterPanel` se convierte en el único punto de inicio y se muestra en las pestañas Especialidades y Tratamientos.

**Tech Stack:** API: NestJS 11, Prisma 6, PostgreSQL, Jest. Web: Next.js 14, React 18, TanStack Query, Vitest + Testing Library.

**Spec:** `api/docs/superpowers/specs/2026-11-20-multi-treatment-encounter-design.md`

## Global Constraints

- Dos repos y dos PRs, ambos contra `dev`. Ramas `feat/multi-treatment-encounter` creadas desde `origin/dev` en `api` y en `web`. La copia local de `web/dev` está desactualizada: no partir de ella.
- La API se fusiona primero y debe ser compatible hacia atrás: `POST /patients/:id/treatment-sessions` con `treatmentId` (uno solo) responde el detalle de la sesión, igual que hoy.
- Máximo **10** tratamientos por petición, sin repetidos (400).
- Estados **sin terminar**: `INTAKE_IN_PROGRESS`, `READY_FOR_CONSENT`, `CONSENTED`, `IN_PROGRESS`. Todos los demás cuentan como terminados.
- Motivo por defecto de una atención abierta con tratamientos: los nombres de los tratamientos unidos por `", "`, recortados a 2000 caracteres. Tipo por defecto: `PROCEDURE`.
- Códigos de error nuevos: `ENCOUNTER_HAS_UNFINISHED_TREATMENTS` (409, con `treatmentSessionIds`), `ENCOUNTER_HAS_ACTIVITY` (409). Desaparece `ENCOUNTER_MANAGED_BY_SESSION`.
- Commits en inglés con prefijo convencional (`feat(api):`, `feat(web):`, `test(api):`). Código y comentarios en inglés; textos de interfaz en español.
- Cambio de esquema solo con una migración nueva en `prisma/migrations/`.
- Cada repo debe pasar su CI. API: `npm run lint`, `npm test -- --runInBand`, `npm run test:e2e -- --runInBand` (con un PostgreSQL desechable; ver memoria de entorno) y `npm run build`. Web: `npm run lint`, `npm run type-check`, `npm test` y `npm run build`.

## Review Focus

1. **Atenciones antiguas abiertas por una sesión** (tipo `PROCEDURE`, una sola sesión) que siguen abiertas tras el despliegue: deben poder cerrarse con `POST /encounters/:id/close` una vez terminada su sesión. → Prueba en la Task 4.
2. **Petición con un tratamiento de otra especialidad entre varios válidos:** no debe crear nada, ni la atención ni las demás sesiones. → Prueba en la Task 3.
3. **Añadir un tratamiento a una atención que otra pestaña acaba de cerrar:** debe responder 409 `ENCOUNTER_CLOSED`, sin sesiones sueltas. → Prueba en la Task 3.
4. **"Completar y cerrar" con la contraseña incorrecta:** la sesión no debe quedar completada (todo o nada). → Prueba en la Task 5.
5. **Tenant con la sección de tratamientos y sin la de especialidades:** debe poder listar y cerrar su atención, pero no crear registros de especialidad. → Prueba en la Task 2.

---

## API (`api/`)

### Task 1: Relación 1:N entre atención y sesiones

**Files:**
- Modify: `prisma/schema.prisma` (`Encounter.treatmentSession` → `treatmentSessions TreatmentSession[]`; `TreatmentSession.encounterId` sin `@unique`, con `@@index([encounterId])`)
- Create: `prisma/migrations/20261121000000_encounter_many_treatment_sessions/migration.sql`
- Modify: `src/encounters/encounters.service.ts` (todos los usos de `treatmentSession` en `include`/`select`)

**Interfaces:**
- Produces: `encounter.treatmentSessions` en Prisma; ninguna API cambia todavía.

- [ ] **Step 1:** Edita el esquema y genera la migración con `npx prisma migrate dev --create-only --name encounter_many_treatment_sessions`. El SQL debe ser solo `DROP INDEX "TreatmentSession_encounterId_key"; CREATE INDEX "TreatmentSession_encounterId_idx" ON "TreatmentSession"("encounterId");`.
- [ ] **Step 2:** Cambia `assertNotManagedBySession` para que lea `treatmentSessions` (`encounter.treatmentSessions.length > 0`) y ajusta el `include` de la línea ~632. Es temporal: la Task 4 lo elimina.
- [ ] **Step 3:** Ejecuta `npx prisma generate && npm run build && npm test -- --runInBand`. Resultado esperado: compila y todo pasa.
- [ ] **Step 4:** Commit `feat(api): let an encounter hold several treatment sessions`.

### Task 2: `RequireSection` con varias secciones ("cualquiera de")

**Files:**
- Modify: `src/common/decorators/require-section.decorator.ts`, `src/common/guards/section.guard.ts`
- Modify: `src/encounters/encounters.controller.ts` (handlers `list` y `close`)
- Test: `src/common/guards/section.guard.spec.ts`, `src/common/sections/section-matrix.spec.ts`

**Interfaces:**
- Produces: `RequireSection(key: SectionKey | readonly SectionKey[])`. Con una lista, la ruta pasa si **alguna** sección está en vigor; si ninguna, lanza el error que daría la primera.

- [ ] **Step 1: Pruebas que fallan**, en `section.guard.spec.ts`:
  - `passes when any listed section is in effect`: metadata `['core.clinical.specialties', 'core.treatments.sessions']` y solo la segunda en vigor → `true`.
  - `rejects with the first section's error when none is in effect`: ninguna en vigor → lanza la misma excepción que `assertSectionInEffect(..., 'core.clinical.specialties')`.

  En `section-matrix.spec.ts`, un `it.each` nuevo afirma que `EncountersController.list` y `EncountersController.close` llevan `['core.clinical.specialties', 'core.treatments.sessions']`, y que `start`, `update` y `remove` siguen con `'core.clinical.specialties'`. La comprobación de clase existente del controlador no cambia.
- [ ] **Step 2:** Ejecuta `npx jest src/common --runInBand`. Resultado esperado: FAIL.
- [ ] **Step 3:** Implementa: el guard normaliza a lista y prueba cada sección con `assertSectionInEffect`. Añade `@RequireSection(['core.clinical.specialties', 'core.treatments.sessions'])` en `list` y `close`.
- [ ] **Step 4:** Vuelve a ejecutar las pruebas. Resultado esperado: PASS.
- [ ] **Step 5:** Commit `feat(api): reach the encounter list and close from the treatment sessions section`.

### Task 3: Crear varias sesiones y añadirlas a una atención abierta

**Files:**
- Modify: `src/treatment-sessions/dto/treatment-session.dto.ts` (`CreateTreatmentSessionDto`)
- Modify: `src/treatment-sessions/treatment-sessions.service.ts` (`create`)
- Modify: `src/treatment-sessions/treatment-sessions.controller.ts` (documentación de Swagger)
- Test: `src/treatment-sessions/treatment-sessions.service.spec.ts`

**Interfaces:**
- Consumes: `EncountersService.openEncounter(tx, tenantId, patientId, actor, input)`, `assertOpenEncounter(tx, tenantId, encounterId, actor)` de `encounters.service.ts`.
- Produces:
  - `CreateTreatmentSessionDto`: `treatmentId?: string`; `treatmentIds?: string[]` (`@ArrayMinSize(1) @ArrayMaxSize(10) @ArrayUnique() @IsString({ each: true })`); `encounterId?: string`; `encounterType?: EncounterType`; `reason?: string` (`MaxLength(2000)`); `appointmentId?`; `branchId?`.
  - `TreatmentSessionsService.create(...)`: devuelve `Promise<SessionDetail | SessionDetail[]>`. Devuelve un `SessionDetail` cuando llega `treatmentId`, y `SessionDetail[]` (en el orden de `treatmentIds`) cuando llega `treatmentIds`.

- [ ] **Step 1: Pruebas que fallan:**
  - `creates one session per treatment on a new encounter`: `treatmentIds: [a, b]` → `openEncounter` se llama una vez con `encounterType: 'PROCEDURE'` y `reason: 'Toxina, Relleno'`; se crean 2 `treatmentSession` con el mismo `encounterId`; el resultado tiene longitud 2.
  - `uses the given type and reason for the new encounter`: con `encounterType: 'FIRST_VISIT'` y `reason: 'Valoración'` → `openEncounter` recibe esos valores.
  - `adds sessions to an open encounter of the caller`: con `encounterId` → `openEncounter` no se llama; las sesiones usan `appointmentId` y `branchId` de esa atención.
  - `rejects adding to a closed encounter`: la atención está cerrada → 409 `ENCOUNTER_CLOSED` y no se llama a `treatmentSession.create`.
  - `rejects an appointment or branch that differs from the encounter's`: `encounterId` + `appointmentId` o `branchId` distinto → 400.
  - `creates nothing when one treatment belongs to another specialty`: el segundo tratamiento tiene otra `specialtyId` → 403 `TREATMENT_SPECIALTY_MISMATCH` lanzado **antes** de `openEncounter`. Valida todas las versiones primero.
  - `requires exactly one of treatmentId and treatmentIds`: ninguno, o los dos → 400.
  - `keeps the single-session response for treatmentId`: devuelve un objeto, no una lista.
- [ ] **Step 2:** Ejecuta `npx jest src/treatment-sessions/treatment-sessions.service.spec.ts --runInBand`. Resultado esperado: FAIL.
- [ ] **Step 3:** Implementa:
  1. Resuelve todas las versiones vigentes y valida la especialidad de cada una.
  2. Obtén la atención: `assertOpenEncounter` si llega `encounterId`, `openEncounter` si no.
  3. Por cada versión, extrae el cuerpo actual de creación (`treatmentSession.create` + `loadSessionFacts` + `statusAfterIntake` + auditoría) a un método privado `openSessionIn(tx, encounter, version, actor)` y llámalo.
- [ ] **Step 4:** Vuelve a ejecutar las pruebas. Resultado esperado: PASS.
- [ ] **Step 5:** Commit `feat(api): open several treatment sessions in one encounter`.

### Task 4: La atención manda: cierre, eliminación y listado

**Files:**
- Modify: `src/encounters/encounters.service.ts` (`list`, `update`, `close`, `closeEncounter`, `delete`; se elimina `assertNotManagedBySession`)
- Test: `src/encounters/encounters.service.spec.ts`

**Interfaces:**
- Produces:
  - `list()` añade a cada atención `treatmentSessions: { id: string; status: TreatmentSessionStatus; treatment: { id: string; name: string } }[]`, ordenadas por `createdAt` (el nombre sale de `treatmentVersion.treatment`).
  - `closeEncounter(...)` lanza 409 `ENCOUNTER_HAS_UNFINISHED_TREATMENTS` con `treatmentSessionIds` si queda alguna sesión sin terminar. Exporta `UNFINISHED_SESSION_STATUSES` desde `src/treatment-sessions/session-state.ts`.

- [ ] **Step 1: Pruebas que fallan:**
  - `closes an encounter whose sessions are all finished`, que sirve también para atenciones antiguas: una sesión `CLINICAL_COMPLETE` → se cierra y la cita queda `COMPLETED`.
  - `refuses to close while a session is unfinished`: una sesión `IN_PROGRESS` → 409 `ENCOUNTER_HAS_UNFINISHED_TREATMENTS`, `treatmentSessionIds: [id]`.
  - `updates the reason of an encounter with sessions`: ya no responde `ENCOUNTER_MANAGED_BY_SESSION`.
  - `refuses to remove an encounter with sessions`: 409 `ENCOUNTER_HAS_RECORDS`.
  - `lists the treatment sessions of each encounter`.
- [ ] **Step 2:** Ejecuta `npx jest src/encounters --runInBand`. Resultado esperado: FAIL.
- [ ] **Step 3:** Implementa lo descrito en las Interfaces. `delete` cuenta `tx.treatmentSession.count({ where: { tenantId, encounterId } })` junto a los registros.
- [ ] **Step 4:** Vuelve a ejecutar las pruebas. Resultado esperado: PASS.
- [ ] **Step 5:** Commit `feat(api): close an encounter once its treatments are finished`.

### Task 5: Los comandos de la sesión dejan de cerrar la atención; completar y cerrar

**Files:**
- Modify: `src/treatment-sessions/treatment-sessions.service.ts` (`complete`, `cancel`, `detail`)
- Modify: `src/treatment-sessions/consent-documents.service.ts` (rechazo, líneas ~457, y revocación, ~539)
- Modify: `src/treatment-sessions/dto/treatment-session.dto.ts` (`CompleteTreatmentSessionDto`)
- Modify: `src/treatment-sessions/treatment-sessions.controller.ts` (`complete`: inyecta `SignerVerificationService`)
- Test: `treatment-sessions.service.spec.ts`, `consent-documents.service.spec.ts`, `treatment-sessions.controller.spec.ts` (créalo si no existe)

**Interfaces:**
- Produces:
  - `CompleteTreatmentSessionDto`: `closeEncounter?: boolean` (`@Transform(rawValue) @IsBoolean()`, como en el DTO de consentimientos); `password?: string` (`MaxLength(200)`); `encounterSummary?: string` (`MaxLength(5000)`).
  - `SessionDetail` añade `encounterStatus: 'OPEN' | 'CLOSED'` y `encounterSessions: { id: string; status: TreatmentSessionStatus; treatmentName: string }[]` (las demás sesiones de la misma atención, sin la propia).

- [ ] **Step 1: Pruebas que fallan:**
  - `completes without closing the encounter`: `closeEncounter` no se llama.
  - `cancels without touching the encounter or the appointment`: no hay `appointment.updateMany` ni `closeEncounter`.
  - `refusing or revoking a consent leaves the encounter open`, en `consent-documents.service.spec.ts`.
  - `completes and closes the encounter with its summary`: `closeEncounter: true, encounterSummary: 'Ok'` → `closeEncounter(tx, tenantId, encounterId, actor, 'Ok')` en la misma transacción.
  - `rolls back the completion when another session is unfinished`: `closeEncounter` lanza 409 → la transacción falla (no se devuelve detalle).
  - Controlador: `verifies the password before completing and closing`: `closeEncounter: true` y `signer.verify` rechaza → 403 y el servicio no se llama. Con `closeEncounter` ausente, `verify` no se llama.
  - `detail lists the other sessions of the encounter`.
- [ ] **Step 2:** Ejecuta `npx jest src/treatment-sessions --runInBand`. Resultado esperado: FAIL.
- [ ] **Step 3:** Implementa. En `complete`, las notas ya no se envían como resumen.
- [ ] **Step 4:** Vuelve a ejecutar las pruebas. Resultado esperado: PASS.
- [ ] **Step 5:** Commit `feat(api): finish a treatment without closing its encounter`.

### Task 6: "No asistió" de la atención

**Files:**
- Modify: `src/treatment-sessions/treatment-sessions.service.ts` (`noShowEncounter`, nuevo; `noShow` delega en él)
- Modify: `src/treatment-sessions/treatment-sessions.controller.ts` (ruta nueva)
- Test: `treatment-sessions.service.spec.ts`, `src/common/sections/section-matrix.spec.ts` (queda cubierta por la clase)

**Interfaces:**
- Produces:
  - `POST tenants/:tenantId/patients/:patientId/encounters/:encounterId/no-show` en `TreatmentSessionsController`, con los mismos `@Roles` y `@RequirePermission` que `noShow`.
  - `noShowEncounter(tenantId, patientId, encounterId, actor): Promise<SessionDetail[]>`.

- [ ] **Step 1: Pruebas que fallan:**
  - `marks every unfinished session and the appointment as no-show and closes the encounter`.
  - `refuses when a session already started`: una sesión `IN_PROGRESS` → 409 `ENCOUNTER_HAS_ACTIVITY`.
  - `refuses when the encounter holds its own records`: hay un registro que no es `formRecordId` de ninguna sesión → 409 `ENCOUNTER_HAS_ACTIVITY`. Una ficha de sesión no bloquea.
  - `session no-show delegates to its encounter`.
- [ ] **Step 2:** Ejecuta `npx jest src/treatment-sessions --runInBand`. Resultado esperado: FAIL.
- [ ] **Step 3:** Implementa. Marca la cita `NO_SHOW` **antes** de `closeEncounter`, como hace hoy `noShow`.
- [ ] **Step 4:** Vuelve a ejecutar las pruebas. Resultado esperado: PASS.
- [ ] **Step 5:** Commit `feat(api): record a no-show for the whole encounter`.

### Task 7: e2e y documentación

**Files:**
- Modify: `test/treatment-sessions.e2e-spec.ts`
- Modify: `docs/API_ENDPOINTS.md`

- [ ] **Step 1:** Añade el caso e2e `two treatments in one encounter`:
  1. Inicia con `treatmentIds: [a, b]` y una cita.
  2. Completa A sin cerrar.
  3. Cierra la atención → 409 `ENCOUNTER_HAS_UNFINISHED_TREATMENTS`.
  4. Cancela B.
  5. Cierra la atención con contraseña → 200.

  Al final, la cita está `COMPLETED` y `GET` de sesiones cobrables muestra A.
- [ ] **Step 2:** Ejecuta `npm run test:e2e -- --runInBand test/treatment-sessions.e2e-spec.ts`. Resultado esperado: PASS.
- [ ] **Step 3:** Documenta en `API_ENDPOINTS.md` los campos y la ruta nuevos, y los códigos de error.
- [ ] **Step 4:** Ejecuta la CI completa de la API (Global Constraints). Commit `test(api): cover an encounter with two treatments`. Abre el PR contra `dev`.

---

## Web (`web/`)

### Task 8: Tipos, endpoints y hooks

**Files:**
- Modify: `src/types/clinical.ts` (`Encounter.treatmentSessions`), `src/types/treatments.ts` (`TreatmentSessionInput`, `TreatmentSessionDetail`)
- Modify: `src/lib/api/endpoints.ts` (`treatmentSessionsApi.create`, `complete`; nuevo `encounterNoShow`)
- Modify: `src/hooks/useTreatmentSessions.ts`, `src/hooks/useEncounters.ts`
- Test: `src/hooks/useTreatmentSessions.test.tsx`

**Interfaces:**
- Consumes: el contrato de las Tasks 3 a 6.
- Produces:
  - `TreatmentSessionInput = { treatmentIds: string[]; encounterId?: string; encounterType?: EncounterType; reason?: string; appointmentId?: string; branchId?: string }`
  - `treatmentSessionsApi.create(patientId, data): Promise<TreatmentSessionDetail[]>`
  - `treatmentSessionsApi.complete(id, input: { procedureNotes?: string; closeEncounter?: boolean; password?: string; encounterSummary?: string })`
  - `treatmentSessionsApi.encounterNoShow(patientId, encounterId)`
  - `useCreateTreatmentSessions(patientId)`: renombra `useCreateTreatmentSession` y actualiza sus usos.
  - `useEncounterNoShow(patientId)`: invalida las atenciones y las sesiones del paciente, y las citas.
  - `TreatmentSessionDetail.encounterStatus` y `encounterSessions`.

- [ ] **Step 1: Pruebas que fallan:** `useCreateTreatmentSessions` envía `treatmentIds` e invalida `PATIENT_TREATMENT_SESSIONS`, `PATIENT_ENCOUNTERS` y `APPOINTMENTS`. `useSessionCommand(...).complete` envía `{ procedureNotes, closeEncounter: true, password }` cuando se le pide.
- [ ] **Step 2:** Ejecuta `npx vitest run src/hooks/useTreatmentSessions.test.tsx`. Resultado esperado: FAIL.
- [ ] **Step 3:** Implementa lo descrito en las Interfaces.
- [ ] **Step 4:** Ejecuta `npx vitest run src/hooks && npm run type-check`. Resultado esperado: PASS.
- [ ] **Step 5:** Commit `feat(web): treatment session contract for several treatments per encounter`.

### Task 9: Iniciar la atención con tratamientos

**Files:**
- Modify: `src/features/patients/encounter-panel.tsx` (`StartEncounterForm`; `EncounterPanelProps` gana `mode: 'specialties' | 'treatments'`)
- Test: `src/features/patients/encounter-panel.test.tsx`

**Interfaces:**
- Consumes: `useCreateTreatmentSessions`, `useStartEncounter`, `useTreatments({ active: true })`, `useSections().isEnabled`.
- Produces: `EncounterPanel` con la prop `mode`. Al iniciar con un solo tratamiento, `router.push('/treatment-sessions/<id>')`.

- [ ] **Step 1: Pruebas que fallan:**
  - Modo `specialties` con la sección de sesiones activa: aparece un grupo de casillas "Tratamientos (opcional)".
    - Sin marcar ninguna → se llama `start` (ruta de atenciones).
    - Con dos marcadas → se llama `create` con `treatmentIds` de longitud 2, `encounterType` y `reason`, y no se navega.
    - Con una marcada → se navega a `/treatment-sessions/s1`.
  - Modo `specialties` con la sección de sesiones desactivada: no aparecen casillas.
  - Modo `treatments`: no hay tipo ni motivo; "Iniciar atención" está deshabilitado hasta marcar un tratamiento.
  - Al marcar el undécimo tratamiento, el formulario lo impide y muestra "Máximo 10 tratamientos por atención".
- [ ] **Step 2:** Ejecuta `npx vitest run src/features/patients/encounter-panel.test.tsx`. Resultado esperado: FAIL.
- [ ] **Step 3:** Implementa.
- [ ] **Step 4:** Vuelve a ejecutar las pruebas. Resultado esperado: PASS.
- [ ] **Step 5:** Commit `feat(web): choose the treatments when starting an encounter`.

### Task 10: La atención en curso con sus tratamientos

**Files:**
- Modify: `src/features/patients/encounter-panel.tsx`
- Test: `src/features/patients/encounter-panel.test.tsx`

**Interfaces:**
- Consumes: `Encounter.treatmentSessions`, `useCreateTreatmentSessions` (con `encounterId`), `useEncounterNoShow`, `SESSION_STATUS_LABELS`, `SESSION_STATUS_VARIANTS`.

- [ ] **Step 1: Pruebas que fallan:**
  - La atención en curso lista cada tratamiento con su estado y un enlace "Continuar" a `/treatment-sessions/<id>`.
  - "Añadir tratamiento" abre un diálogo con casillas, sin los tratamientos ya presentes en la atención, y envía `encounterId`.
  - Con una sesión sin terminar, "Cerrar atención" está deshabilitado y muestra "Termina o cancela: Toxina".
  - "No asistió" aparece solo si la atención tiene tratamientos y todos siguen antes de `IN_PROGRESS` (`INTAKE_IN_PROGRESS`, `READY_FOR_CONSENT` o `CONSENTED`). Confirmar llama a `encounterNoShow`; un 409 `ENCOUNTER_HAS_ACTIVITY` muestra el mensaje de la API.
  - En modo `treatments`, no aparecen "Eliminar atención" ni el formulario de registros.
- [ ] **Step 2:** Ejecuta `npx vitest run src/features/patients/encounter-panel.test.tsx`. Resultado esperado: FAIL.
- [ ] **Step 3:** Implementa. La regla de "No asistió" la decide la API (409 `ENCOUNTER_HAS_ACTIVITY`); la interfaz solo oculta el botón cuando es evidente que no aplica y muestra el mensaje de la API.
- [ ] **Step 4:** Vuelve a ejecutar las pruebas. Resultado esperado: PASS.
- [ ] **Step 5:** Commit `feat(web): show and add the treatments of the encounter in course`.

### Task 11: El panel en ambas pestañas y el enlace de la agenda

**Files:**
- Modify: `src/features/treatment-sessions/patient-treatments-tab.tsx` (elimina `NewSessionDialog` y "Nueva atención"; muestra `EncounterPanel` encima de la lista)
- Modify: `src/features/patients/clinical-records-tab.tsx` (pasa `mode="specialties"`)
- Modify: `src/app/(dashboard)/patients/[id]/page.tsx` (`startAppointmentId` también para `tab=treatments`)
- Modify: `src/features/calendar/appointment-details-dialog.tsx` (pestaña según secciones)
- Test: `patient-treatments-tab.test.tsx`, `appointment-details-dialog.test.tsx` (si no existe, créalo)

- [ ] **Step 1: Pruebas que fallan:**
  - Con la sección de especialidades activa, la pestaña Tratamientos muestra el panel en modo `specialties`; sin ella, en modo `treatments`. Ya no existe el botón "Nueva atención".
  - "Atender" de la agenda enlaza a `?tab=specialties&appointmentId=…` con especialidades activa; si no, a `?tab=treatments&appointmentId=…`.
  - Un `CAJERO` sigue sin ver el enlace (regresión de rol).
- [ ] **Step 2:** Ejecuta las pruebas. Resultado esperado: FAIL.
- [ ] **Step 3:** Implementa.
- [ ] **Step 4:** Vuelve a ejecutar las pruebas. Resultado esperado: PASS.
- [ ] **Step 5:** Commit `feat(web): one place to start an encounter from either tab`.

### Task 12: Completar y cerrar desde el asistente

**Files:**
- Modify: `src/features/treatment-sessions/procedure-step.tsx`, `src/features/treatment-sessions/session-workflow.tsx`, `src/features/treatment-sessions/close-summary-step.tsx`
- Test: `procedure-step.test.tsx`, `session-workflow.test.tsx`

**Interfaces:**
- Consumes: `TreatmentSessionDetail.encounterSessions` y `encounterStatus`, `SignaturePasswordField` y `signaturePasswordError` de `src/features/patients/signature-password-field.tsx`.

- [ ] **Step 1: Pruebas que fallan:**
  - El botón del procedimiento dice "Completar tratamiento" (ya no "Cerrar atención").
  - Si ninguna `encounterSessions` está sin terminar, el diálogo de confirmación muestra:
    - "Completar y cerrar atención", con contraseña obligatoria y "Resumen de la atención" opcional, que envía `closeEncounter: true`.
    - "Completar y seguir en la atención", que no lo envía.
  - Una contraseña incorrecta muestra el error de `signaturePasswordError` y el diálogo sigue abierto.
  - Si queda otra sesión sin terminar, solo aparece "Completar".
  - Ya no existe el botón "No asistió" en el asistente. "Cancelar tratamiento" describe: "El tratamiento termina y el motivo queda registrado. La atención sigue abierta."
  - En el resumen final, si hay una sesión pendiente, aparece un enlace "Siguiente tratamiento: Relleno" a su asistente. Siempre aparece "Volver a la atención", que lleva a `/patients/<id>?tab=specialties` o `?tab=treatments` según las secciones. El enlace del encabezado usa la misma regla.
- [ ] **Step 2:** Ejecuta `npx vitest run src/features/treatment-sessions`. Resultado esperado: FAIL.
- [ ] **Step 3:** Implementa.
- [ ] **Step 4:** Vuelve a ejecutar las pruebas. Resultado esperado: PASS.
- [ ] **Step 5:** Ejecuta la CI completa de la web (Global Constraints). Commit `feat(web): complete a treatment and close its encounter in one step`. Abre el PR contra `dev`, indicando que depende del PR de la API.
