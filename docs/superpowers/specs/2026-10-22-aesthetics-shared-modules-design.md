# Estética sobre los módulos compartidos — diseño

Fecha: 2026-10-22 · Repositorios: api y web · Ramas: `feat/aesthetics-shared-modules` en cada uno

Reemplaza la parte estética de `2026-10-19-arrayanes-aesthetics.md` (PR api #69, web #64).

## Problema

El módulo de estética creó tablas, rutas, permisos y una sección propios (`Aesthetic*`,
`/aesthetics/*`, `aesthetics.*`, `core.aesthetics`) para lo que la plataforma ya tenía, y separó
los consultorios con un tipo de negocio (`Tenant.businessKind`) que cierra todo lo demás:

| Estética (duplicado) | Ya existente |
|---|---|
| `AestheticClient` | `Patient` con su equipo de profesionales |
| `AestheticBooking` | `Appointment` |
| `AestheticService` | `Treatment` + `TreatmentVersion` |
| `AestheticSession` | `TreatmentSession` sobre un `Encounter` |
| `AestheticConsent` | `ConsentTemplate` → `ConsentDocument` + `ConsentSignature` |
| `AestheticPhoto` | `PatientFile` ligado a la sesión |

El núcleo de tratamientos (`2026-10-15-treatment-sessions-design.md`) ya cubre el recorrido de un
procedimiento estético: ficha, consentimiento firmado con PDF, fotos antes y después y cierre.

## Objetivo

Un solo modelo. Lo que estética y salud comparten se usa una vez y cada consultorio lo activa de
forma independiente; lo médico no se ofrece a Estética.

Éxito:

- No quedan tablas, rutas, permisos, secciones ni pantallas propias de estética, ni `businessKind`.
- Un estudio es un consultorio con la especialidad Estética que usa pacientes, agenda,
  tratamientos, consentimientos, fotos, formularios y caja.
- Un profesional de Estética no ve ni puede crear registros médicos, tampoco en una clínica mixta.
- La seed muestra el Estudio Estético Aurora completo sobre esos módulos.

## Decisiones tomadas

| Tema | Decisión |
|---|---|
| Datos existentes en `Aesthetic*` | No hay datos reales: las tablas se borran sin migrar datos |
| Cómo encaja Estética | Especialidad del catálogo (`AESTHETICS`, "Estética"), como Psicología u Odontología |
| `businessKind` | Desaparece. Lo que usa cada consultorio lo deciden sus especialidades y sus secciones |
| Ficha estética | Formulario del consultorio (`FormDefinition`) hecho con el editor existente. Estética no agrega módulos clínicos en código, como Medicina General |
| Terminología | Se mantiene "pacientes" en todos los consultorios |
| Entrega | Una sola entrega por repositorio (reemplazo); primero la web, después el API |

## Qué se comparte y qué no

Compartido (un módulo, activado por consultorio): pacientes y su equipo, agenda y citas, sedes,
equipo y permisos por rol desde plataforma, catálogo de tratamientos, sesiones de tratamiento,
plantillas y documentos de consentimiento con firma y PDF, archivos y fotos del paciente,
formularios del consultorio, caja, órdenes, pagos y facturación, tareas y notificaciones. De los
módulos clínicos generales, Alergias (`general.allergies`) y Consentimiento informado
(`general.consents`).

Solo para especialidades de salud:

- Módulos clínicos generales `general.soap-note`, `general.vital-signs`, `general.diagnoses`,
  `general.prescriptions`, `general.orders`, `general.referrals` y `general.certificates`.
- Crear notas clínicas (sección `core.clinicalNotes`) y planes de próxima sesión.

## Modelo de datos y migración

Migración `20261022000000_aesthetics_on_shared_modules`, en este orden:

1. Inserta la especialidad `AESTHETICS` ("Estética", descripción "Procedimientos estéticos
   faciales y corporales.", activa) con `ON CONFLICT ("code") DO UPDATE SET "isActive" = true`, y
   una fila de `PlanSpecialty` por cada `PlanType` con `ON CONFLICT DO NOTHING`.
2. Borra las filas de `TenantModule` con `moduleKey = 'core.aesthetics'` y las de
   `TenantRolePermission` cuyo permiso empieza por `aesthetics.`.
3. Borra las tablas `AestheticPhoto`, `AestheticConsent`, `AestheticSession`, `AestheticBooking`,
   `AestheticService` y `AestheticClient` (sus políticas de RLS se van con ellas) y los enums
   `AestheticBookingStatus` y `AestheticPhotoPhase`.
4. Quita la columna `Tenant.businessKind` y el enum `TenantBusinessKind`.

Los consultorios `AESTHETIC_STUDIO` de prueba quedan solo con la sección Equipo; el dueño de la
plataforma les asigna Estética y sus secciones. Los bytes de fotos de prueba que hubiera en el
almacenamiento quedan sin fila que los apunte; no se limpian.

`prisma/schema.prisma` refleja lo mismo; `prisma migrate diff` contra la base migrada no debe
mostrar diferencias.

## API

### Se elimina

- `src/aesthetics/*`, su registro en `app.module.ts`, `test/aesthetics.e2e-spec.ts` y las
  referencias a modelos `aesthetic*` en `PrismaService` (modelos con RLS y `cleanDatabase`).
- En `section-catalog.ts`: `core.aesthetics`, `isSectionAllowedForBusinessKind` y el parámetro
  `businessKind` de `defaultSections` y `validateSections`; en `section.guard.ts`, la comprobación
  por tipo de negocio.
- En `permission-catalog.ts`: los permisos `aesthetics.*` e `isPermissionForBusinessKind`; en
  `platform-role-permissions.service.ts` y `user-permissions.service.ts`, el filtro por tipo.
- En plataforma (`create-platform-tenant.dto.ts`, `platform-tenants.service.ts`,
  `platform-tenants.controller.ts`): `businessKind` en alta, listado y detalle. Todo consultorio
  vuelve a exigir al menos una especialidad.
- En `users.service.ts` y `professional-profiles.service.ts`: las ramas de estudio. Un
  profesional vuelve a necesitar perfil con especialidad y ocupa plaza del plan.

### Se agrega

**Módulos solo para salud.** `ClinicalModuleDefinition` admite `healthOnly?: boolean`; las siete
definiciones listadas arriba lo llevan. En `clinical-module-registry.ts`:

```ts
/** Specialties that are not health care: they never get the health-only modules. */
export const AESTHETIC_SPECIALTY_CODES = ['AESTHETICS'] as const;
export function isHealthSpecialty(code: string | null): boolean;
```

- `ClinicalModulesService.listForTenant`: un módulo `healthOnly` tiene `canRecord: false` si la
  especialidad propia no es de salud, y `enabled: false` si ninguna especialidad activa del
  consultorio es de salud.
- `SpecialtyRecordsService` rechaza un módulo `healthOnly` cuando el profesional es de una
  especialidad no de salud, aunque la ruta se llame directamente, con el mismo 403
  `CLINICAL_RECORD_FORBIDDEN` ("Tu especialidad no puede registrar este módulo") que ya usa
  `allowedSpecialtyCodes` para la Receta.

**Notas clínicas y planes de próxima sesión.** Crear una nota clínica o un plan de próxima sesión
responde 403 `HEALTH_SPECIALTY_REQUIRED` a un profesional de una especialidad no de salud. Leer
sigue las reglas actuales del equipo del paciente.

**Secciones por defecto.** `defaultSections(planType, tenantType, specialtyCodes)`: si todas las
especialidades del alta son no de salud, `core.clinicalNotes` viene desactivada. Si la plataforma
envía `sections`, se respetan.

**Tratamientos de un estudio.** Se crean con `specialtyId` de Estética; el modelo actual ya limita
a esa especialidad quién abre sesiones.

## Web

### Se elimina

- `src/features/aesthetics/*`, `src/lib/api/aesthetics-api.ts`, `src/types/aesthetics.ts`, la
  ruta de estética del dashboard y su entrada en `sidebar.tsx`.
- El selector de tipo de negocio en `create-tenant-form.tsx`, el filtro por tipo en
  `tenant-sections-card.tsx` y `businessKind` en `types/index.ts` y en los esquemas de validación.
- La excepción de estudios en `team-member-dialog.tsx` y `team-manager.tsx`: crear un profesional
  pide especialidad.

### Cambia

- Alta de consultorio: si solo se marca Estética, Notas clínicas aparece desmarcada (mismo criterio
  que la API); se puede volver a marcar.
- Donde la web ofrezca módulos clínicos sin mirar `enabled` y `canRecord`, pasa a mirarlos.
- El grupo "Estética" de permisos por rol en plataforma desaparece solo, al salir del catálogo.

## Seed: Estudio Estético Aurora

Reescribe `prisma/seed-aesthetic-studio.ts` sobre los módulos compartidos. Los Arrayanes no cambia.

| Elemento | Contenido |
|---|---|
| Consultorio | Plan Clínica Básica, especialidad Estética, Notas clínicas desactivada |
| Equipo | Titular sin perfil profesional; cosmiatra y esteticista con perfil de Estética; recepción |
| Pacientes | 6, una archivada; equipo de profesionales asignado |
| Ficha | Formulario "Ficha estética facial" v1: fototipo, tipo de piel, zona a tratar, contraindicaciones, embarazo, medicación fotosensibilizante |
| Consentimientos | Plantillas "Peeling químico" y "Depilación láser", versión 1 publicada |
| Tratamientos (Estética) | Limpieza facial (sin requisitos); Peeling químico (ficha, consentimiento, 1 foto antes y 1 después, notas al cerrar); Depilación láser (consentimiento); Microdermoabrasión; Radiofrecuencia (inactivo) |
| Sesiones | Peeling `CLINICAL_COMPLETE` con ficha, consentimiento firmado (firma PNG y PDF), fotos y notas; depilación `CLINICAL_COMPLETE`; peeling `READY_FOR_CONSENT` (iniciarlo responde 409 `TREATMENT_SESSION_INVALID_TRANSITION`); una `CANCELLED` |
| Agenda | Citas pasadas ligadas a las sesiones, una cancelada y tres próximas |
| Cobro | No se siembra caja ni órdenes, igual que Los Arrayanes |

Lo cifrado se guarda como lo guarda la API; firma, PDF y fotos van al almacenamiento y cuentan en
`storageUsedBytes`. Se quita `withTenantContext` de la seed si ya no hay tablas con RLS forzado.

## Pruebas

API:

- Unitarias: los siete módulos `healthOnly` del catálogo; `canRecord`/`enabled` para Estética, salud
  y consultorio mixto; 403 al crear un registro `healthOnly`, una nota clínica o un plan de próxima
  sesión como esteticista, y éxito como médico de la misma clínica; `defaultSections` con solo
  Estética, mixto y secciones explícitas; alta de plataforma sin especialidad → 400. Se quitan las
  pruebas de estética y de `businessKind`.
- `seed-coverage`: el estudio tiene solo Estética, perfiles de Estética, tratamientos de Estética,
  sesiones en estados coherentes con sus requisitos, fotos guardadas y contadas, firma y PDF del
  consentimiento. `seed-clear` sigue cubriendo todas las tablas.
- E2E: el de la seed entra como la cosmiatra, lista sesiones, descarga una foto y el PDF del
  consentimiento, recibe 409 al iniciar la sesión sin consentimiento y 403 al crear una Nota SOAP o
  una receta. El de plataforma crea un consultorio solo de Estética y comprueba sus secciones.
- Migración: se aplica sobre una base local con datos `Aesthetic*` de prueba y un consultorio
  `AESTHETIC_STUDIO`; termina, Estética queda en el catálogo y `migrate diff` no muestra cambios.

Web: Vitest de alta de consultorio, tarjeta de secciones, diálogo de equipo y menú lateral;
type-check y build.

## Despliegue

1. Web: ya no llama a rutas de estética, así que funciona con el API actual.
2. API: corre la migración.
3. Plataforma: asignar Estética y secciones a los consultorios estéticos de prueba que existan.

Fuera de alcance: caja y órdenes en la seed, cambiar la terminología de la interfaz, un módulo
clínico de Estética en código.
