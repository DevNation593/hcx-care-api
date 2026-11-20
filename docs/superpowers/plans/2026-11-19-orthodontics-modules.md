# Ortodoncia dentro de Odontología Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Cuatro módulos clínicos de ortodoncia (`dentistry.ortho-*`) propiedad de Odontología, con su migración, demo, pruebas y sus nombres en la web.

**Architecture:** Definiciones nuevas en el motor de módulos existente (`module-builders`, renderer `FORM`), registradas en `CLINICAL_MODULES` con `specialtyCode: 'DENTISTRY'`. Una migración inserta las filas `SpecialtyModule`. Sin tablas, guards ni permisos nuevos.

**Tech Stack:** NestJS 11, Prisma 6 / PostgreSQL, Jest; Next.js + Vitest en `web/`.

**Spec:** `docs/superpowers/specs/2026-11-19-orthodontics-modules-design.md`

## Global Constraints

- Todos los módulos: `schemaVersion: 1`, `scope: 'SPECIALTY'`, `specialtyCode: 'DENTISTRY'`, `renderer: 'FORM'`, sin `alerts`, sin campos `calculated`.
- Claves de módulo exactas: `dentistry.ortho-assessment`, `dentistry.ortho-cephalometry`, `dentistry.ortho-treatment-plan`, `dentistry.ortho-control`.
- Valores de opciones en español en MAYÚSCULAS (convención de Ginecología); toda pregunta clínica de oclusión, análisis facial/funcional, higiene y cooperación ofrece su opción "no evaluado/a" o "no evaluable".
- Piezas: opciones FDI de `dentistry.ts` (permanentes y temporales).
- Código y comentarios en inglés; commits `feat(api):` / `test(api):` / `feat(web):` en inglés con la línea `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- Archivos rastreados son CRLF: editar con la herramienta Edit, no con parches `\n`.
- `npm run lint` está roto (T-15): usar `npx prettier --check` en los archivos tocados.
- Nunca correr migraciones, seed ni e2e contra el `DATABASE_URL` de `api/.env`; usar el PostgreSQL desechable (`embedded-postgres` en el scratchpad).

## Review Focus

1. Dentición mixta: piezas temporales (`55`, `75`, `85`) deben aceptarse en `extractionTeeth` y `debondedBrackets` — prueba en Task 1.
2. Overjet/overbite negativos (mordida invertida/abierta) deben aceptarse; fuera de rango se rechaza — prueba en Task 1.
3. Un valor que el formulario no define (`NORMAL` en clase molar) se rechaza en lugar de guardarse — prueba en Task 1.
4. Un profesional de otra especialidad no escribe módulos de ortodoncia (403) — prueba e2e en Task 2.
5. Alineador actual mayor que el total no se valida (el motor no tiene reglas entre campos); se acepta y queda como decisión documentada — prueba en Task 1 que lo fija para que un cambio sea consciente.

---

### Task 1: Definiciones de ortodoncia y migración

**Files:**
- Create: `src/clinical-modules/definitions/orthodontics.ts`
- Create: `src/clinical-modules/definitions/orthodontics.spec.ts`
- Create: `prisma/migrations/20261119000000_orthodontics_modules/migration.sql`
- Modify: `src/clinical-modules/definitions/dentistry.ts` (exportar `TOOTH_OPTIONS`)
- Modify: `src/clinical-modules/clinical-module-registry.ts` (importar y añadir `ORTHODONTICS_MODULES` tras `DENTISTRY_MODULES`)

**Interfaces:**
- Produces: `export const ORTHODONTICS_MODULES: ClinicalModuleDefinition[]` y las claves/campos de abajo, que Task 2 y Task 3 usan.

**Campos** (orden = orden en el formulario; `*` = `required: true`). Etiquetas en español a criterio del implementador.

`dentistry.ortho-assessment` — "Diagnóstico ortodóntico"
- Sección `reason`: `chiefComplaint*` longText; `dentition` select `PERMANENTE|MIXTA|TEMPORAL`.
- Sección `facial`: `facialProfile` `RECTO|CONVEXO|CONCAVO|NO_EVALUADO`; `facialSymmetry` `SIMETRICO|ASIMETRICO|NO_EVALUADO`; `lipCompetence` `COMPETENTE|INCOMPETENTE|NO_EVALUADO`; `smileNotes` longText.
- Sección `functional`: `breathing` `NASAL|ORAL|MIXTA|NO_EVALUADA`; `swallowing` `NORMAL|ATIPICA|NO_EVALUADA`; `habits` multiselect `SUCCION_DIGITAL|INTERPOSICION_LINGUAL|RESPIRACION_ORAL|ONICOFAGIA|BRUXISMO|OTRO`; `habitsNotes` text maxLength 300; `tmjNotes` longText.
- Sección `occlusion`: `molarClassRight`, `molarClassLeft`, `canineClassRight`, `canineClassLeft` `CLASE_I|CLASE_II|CLASE_III|NO_EVALUABLE`; `classIIDivision` `DIVISION_1|DIVISION_2|NO_APLICA`; `overjetMm` decimal min -10 max 20 unit `mm`; `overbiteMm` decimal min -10 max 15 unit `mm`; `crossbite` `PRESENTE|AUSENTE|NO_EVALUADA`; `crossbiteLocation` multiselect `ANTERIOR|POSTERIOR_DERECHA|POSTERIOR_IZQUIERDA`; `openBite` `ANTERIOR|POSTERIOR|AUSENTE|NO_EVALUADA`; `upperMidlineDirection` y `lowerMidlineDirection` `CENTRADA|DERECHA|IZQUIERDA|NO_EVALUADA`; `upperMidlineDeviationMm` y `lowerMidlineDeviationMm` decimal min 0 max 10 unit `mm`; `upperCrowding` y `lowerCrowding` `AUSENTE|LEVE|MODERADO|SEVERO|NO_EVALUADO`.
- Sección `records`: `recordsTaken` multiselect `FOTOS_EXTRAORALES|FOTOS_INTRAORALES|PANORAMICA|CEFALICA_LATERAL|MODELOS_ESCANEO`, help: los archivos se suben en Archivos del paciente.
- Sección `diagnosis`: `orthodonticDiagnosis*` longText; `observations` longText.

`dentistry.ortho-cephalometry` — "Análisis cefalométrico"
- `radiographDate` date; `analysisMethod` `STEINER|RICKETTS|MCNAMARA|OTRO`; `measurements` table maxRows 60 con columnas `measure*` text maxLength 80, `value*` decimal min -360 max 360, `unit*` text maxLength 20 (help: transcribir tal cual, el sistema no interpreta); `professionalInterpretation*` longText; `observations` longText.

`dentistry.ortho-treatment-plan` — "Plan ortodóntico"
- `treatmentGoals*` longText; `appliance*` `FIJA_METALICA|FIJA_ESTETICA|AUTOLIGADO|LINGUAL|ALINEADORES|REMOVIBLE|ORTOPEDICA_FUNCIONAL|OTRO`; `bracketPrescription` `ROTH|MBT|OTRA|NO_APLICA`; `slot` `SLOT_018|SLOT_022|NO_APLICA` (etiquetas `.018`, `.022`, `No aplica`); `arches` `SUPERIOR|INFERIOR|AMBAS`; `extractionsIndicated` `SI|NO|POR_DEFINIR`; `extractionTeeth` multiselect `TOOTH_OPTIONS`; `auxiliaries` multiselect `EXPANSOR|MINITORNILLOS|ELASTICOS_INTERMAXILARES|ARCO_TRANSPALATINO|BARRA_LINGUAL|OTRO`; `phases` table maxRows 10 con `phase*` text maxLength 100, `goal` text maxLength 300, `estimatedMonths` integer min 1 max 60, `status*` `PENDIENTE|EN_CURSO|COMPLETADA`; `estimatedDurationMonths` integer min 1 max 72; `plannedRetention` `FIJA|REMOVIBLE|AMBAS|POR_DEFINIR`; `estimatedCost` decimal min 0 max 1000000; `observations` longText.

`dentistry.ortho-control` — "Control ortodóntico"
- `visitType*` `INSTALACION|AJUSTE|RECEMENTADO|EMERGENCIA|RETIRO|CONTROL_RETENCION`; `upperArchwire`, `lowerArchwire` text maxLength 60; `ligatures` text maxLength 100; `elastics` text maxLength 200; `currentAligner`, `totalAligners` integer min 1 max 200; `debondedBrackets` multiselect `TOOTH_OPTIONS`; `hygiene`, `cooperation` `BUENA|REGULAR|DEFICIENTE|NO_EVALUADA`; `procedurePerformed*` longText; `patientInstructions` longText; `nextControlDate` date; `observations` longText.

- [ ] **Step 1: Escribir `orthodontics.spec.ts`** con el mismo helper `issuesOf`/`definitionOf` de `gynecology.spec.ts` (prefijo `dentistry.ortho-`) y estas pruebas:

```ts
it('lists the orthodontic modules among those dentistry owns', () => {
  expect(specialtyModuleKeys('DENTISTRY').sort()).toEqual([
    'dentistry.evolution', 'dentistry.odontogram', 'dentistry.ortho-assessment',
    'dentistry.ortho-cephalometry', 'dentistry.ortho-control',
    'dentistry.ortho-treatment-plan', 'dentistry.treatments',
  ]);
});
it('defines valid forms that raise no clinical alert and compute nothing', /* igual que gynecology */);
it('requires the reason and the diagnosis of an assessment', () =>
  expect(issuesOf('assessment', {}).map(({ field }) => field))
    .toEqual(['chiefComplaint', 'orthodonticDiagnosis']));
it('requires what each other module cannot exist without', () => {
  expect(fields(issuesOf('cephalometry', {}))).toEqual(['professionalInterpretation']);
  expect(fields(issuesOf('treatment-plan', {}))).toEqual(['treatmentGoals', 'appliance']);
  expect(fields(issuesOf('control', {}))).toEqual(['visitType', 'procedurePerformed']);
});
it('keeps a class that could not be assessed and refuses one it does not define', () => {
  const base = { chiefComplaint: 'Apiñamiento', orthodonticDiagnosis: 'Clase II div 1' };
  expect(validateModuleData(definitionOf('assessment'),
    { ...base, molarClassRight: 'NO_EVALUABLE', facialProfile: 'NO_EVALUADO' }))
    .toEqual({ ...base, molarClassRight: 'NO_EVALUABLE', facialProfile: 'NO_EVALUADO' });
  expect(issuesOf('assessment', { ...base, molarClassRight: 'NORMAL' }))
    .toEqual([expect.objectContaining({ field: 'molarClassRight' })]);
});
it('accepts a negative overjet and overbite and refuses one out of range', () => {
  // -2.5 / -1 aceptados; overjetMm 25 → issue en 'overjetMm'
});
it('accepts primary teeth in mixed dentition and refuses a tooth that does not exist', () => {
  // control: debondedBrackets ['11','55','85'] aceptado; ['99'] → issue en 'debondedBrackets'
  // plan: extractionTeeth ['14','24','75'] aceptado
});
it('keeps cephalometric values as transcribed and requires each value', () => {
  // measurements [{ measure: 'ANB', value: 5.5, unit: '°' }] guardado igual;
  // [{ measure: 'SNA', unit: '°' }] → issue en 'measurements[0].value'
});
it('does not compare the current aligner with the total', () => {
  // control con currentAligner 30, totalAligners 20 → aceptado tal cual (sin reglas entre campos)
});
```

- [ ] **Step 2: Correr y ver que falla**

Run: `npx jest src/clinical-modules/definitions/orthodontics.spec.ts`
Expected: FAIL — `Cannot find module './orthodontics'`.

- [ ] **Step 3: Implementar `orthodontics.ts`** con un wrapper `orthodontics(definition)` análogo a `gynecology(...)` que fija `scope`, `specialtyCode: 'DENTISTRY'` y `renderer: 'FORM'`; exportar `TOOTH_OPTIONS` desde `dentistry.ts` y registrar `ORTHODONTICS_MODULES` en `clinical-module-registry.ts`. Comentario de cabecera: los campos registran lo evaluado, nada viene relleno ni se interpreta.

- [ ] **Step 4: Correr las pruebas del módulo y del registro**

Run: `npx jest src/clinical-modules`
Expected: `orthodontics.spec.ts` PASS; `clinical-module-registry.spec.ts` FAIL solo en "has a migration row for every specialty module added after the first catalog" (faltan las filas `('DENTISTRY', 'dentistry.ortho-…')`).

- [ ] **Step 5: Escribir la migración** `20261119000000_orthodontics_modules/migration.sql`: comentario en inglés (los módulos de ortodoncia se suman a Odontología; aún no hay consultorios, por lo que no hacen falta filas `TenantModule`) y un `INSERT INTO "SpecialtyModule" … FROM (VALUES ('DENTISTRY', 'dentistry.ortho-assessment'), …) … ON CONFLICT ("specialtyId", "moduleKey") DO NOTHING;` con la misma forma exacta que `20261108000000_gynecology_specialty` (sin el INSERT de `Specialty`).

- [ ] **Step 6: Correr la suite unitaria completa**

Run: `npx jest src test/seed-coverage.spec.ts test/demo-specialty-seed.spec.ts test/seed-demo-specialties.spec.ts`
Expected: PASS.

- [ ] **Step 7: Aplicar la migración en el PostgreSQL desechable**

Run (con `DATABASE_URL` del embebido en el entorno del proceso): `npx prisma migrate deploy` y luego `npx prisma migrate diff --from-url "$DATABASE_URL" --to-schema-datamodel prisma/schema.prisma --script`
Expected: migración aplicada; el diff no genera SQL (sin drift).

- [ ] **Step 8: Prettier y commit**

Run: `npx prettier --check src/clinical-modules`
```bash
git add src/clinical-modules prisma/migrations/20261119000000_orthodontics_modules docs/superpowers
git commit -m "feat(api): add orthodontic modules to dentistry"
```

---

### Task 2: Paciente de ortodoncia en la demo y prueba e2e

**Files:**
- Modify: `prisma/seed-clinical-workflow.ts` (paciente nuevo tras `lucia`, sección nueva tras la de Lucía)
- Modify: `test/seed-clinical-workflow.e2e-spec.ts` (prueba nueva tras la de ginecología)

**Interfaces:**
- Consumes: claves y campos de Task 1; helpers del seed `createPatient`, `createAppointment`, `openEncounter`, `writeRecord`, `closeEncounter`, `book`; profesional `esteban` (Odontólogo, Sede Norte, cuenta `odonto`).

- [ ] **Step 1: Escribir la prueba e2e** `'lets the dentist keep the orthodontic records of his patient'`:
  - `GET clinical-modules` como `odonto`: las cuatro claves `dentistry.ortho-*` presentes con `canRecord: true`.
  - `GET patientUrl('Sofía', 'specialty-records')` como `odonto`: `dentistry.ortho-assessment.data` coincide con `{ molarClassRight: 'CLASE_II', overjetMm: 6.5 }`; existe `dentistry.ortho-treatment-plan` con `appliance: 'AUTOLIGADO'`; existe un `dentistry.ortho-control` con `visitType: 'AJUSTE'`.
  - `POST` como `odonto` `{ password: DEMO_PASSWORD, moduleKey: 'dentistry.ortho-control', schemaVersion: 1, data: { visitType: 'EMERGENCIA', debondedBrackets: ['36'], procedurePerformed: 'Recementado de bracket 36.' } }` → 201 y `body.data` igual a lo enviado.
  - El mismo `POST` como `medicina` → 403; `GET` como `recepcion` → 403.

- [ ] **Step 2: Correr y ver que falla**

Run: `DATABASE_URL_TEST=…/psic_clinic_test REDIS_URL="" npx jest --config ./test/jest-e2e.json --runInBand test/seed-clinical-workflow.e2e-spec.ts -t orthodontic`
Expected: FAIL — `patients['Sofía']` indefinido (404/400).

- [ ] **Step 3: Sembrar a Sofía** — adolescente de 14 años (`dateOfBirth` 2012), cédula válida nueva, con representante legal (campos `guardian*`, obligatorios en menores), `{ current: [esteban] }`. Datos sintéticos:
  - Cita `COMPLETED` `book(esteban, -30, '11:00')`, Sede Norte, título "Valoración de ortodoncia"; encuentro `FIRST_VISIT`; registros `ortho-assessment` (Clase II derecha e izquierda, `classIIDivision: 'DIVISION_1'`, `overjetMm: 6.5`, `overbiteMm: 4`, perfil convexo, `upperCrowding: 'MODERADO'`, `breathing: 'NO_EVALUADA'`, registros tomados), `ortho-cephalometry` (Steiner, SNA/SNB/ANB en grados), `ortho-treatment-plan` (`AUTOLIGADO`, `MBT`, `SLOT_022`, `AMBAS`, `extractionsIndicated: 'NO'`, dos fases, 24 meses, `FIJA`). Cerrar encuentro.
  - Cita `COMPLETED` `book(esteban, -2, '11:00')`, título "Control de ortodoncia"; encuentro `CONTROL`; registro `ortho-control` `AJUSTE` con arcos, `hygiene: 'REGULAR'`, `nextControlDate` en +26 días. Cerrar encuentro.
  - Cita `SCHEDULED` `book(esteban, 26, '11:00')` "Control de ortodoncia".
  Elegir otros horarios si `book` choca con citas existentes de Esteban.

- [ ] **Step 4: Ajustar conteos** — buscar en `test/` aserciones que cuenten pacientes, citas o registros de Los Arrayanes y actualizar solo las que cambian por Sofía.

- [ ] **Step 5: Correr seed y e2e completos del flujo clínico**

Run: `npx jest test/seed-coverage.spec.ts` y luego el e2e de `seed-clinical-workflow.e2e-spec.ts` completo sobre una base recién creada.
Expected: PASS (`seed-coverage` valida cada registro sembrado contra su definición).

- [ ] **Step 6: Prettier y commit**

```bash
git add prisma/seed-clinical-workflow.ts test
git commit -m "test(api): seed an orthodontic patient in the demo clinic"
```

---

### Task 3: Nombres de los módulos en la web (repo `web/`, PR aparte)

**Files:**
- Modify: `web/src/features/admin/specialties/module-labels.ts`
- Test: el test existente de `module-labels` si lo hay; si no, uno nuevo junto al archivo.

- [ ] **Step 1:** En `web/`, `git fetch` y crear `feat/orthodontics-module-labels` desde `origin/dev`.
- [ ] **Step 2: Prueba** — `describeModule('dentistry.ortho-control').name === 'Control ortodóntico'` (y las otras tres con sus nombres: "Diagnóstico ortodóntico", "Análisis cefalométrico", "Plan ortodóntico"). Correr con Vitest y ver que falla.
- [ ] **Step 3:** Añadir las cuatro entradas con descripción de una línea, junto a las de `dentistry.*`.
- [ ] **Step 4:** Vitest del archivo PASS; `npx prettier --check` del archivo.
- [ ] **Step 5: Commit** `feat(web): name the orthodontic modules`.

---

### Cierre

- [ ] Suite unitaria completa de `api/` (`npx jest`), y build (`npm run build`).
- [ ] Confirmar con el usuario antes de hacer push y abrir los PRs contra `dev` (api y web).
