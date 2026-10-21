# Demo única y estudios estéticos Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Conservar solo la demo de Los Arrayanes, añadir medicina general y entregar una operación estética separada de los módulos médicos.

**Architecture:** La seed conserva un solo tenant demo; `businessKind` separa giros sin cambiar la capacidad `TenantType`. El estudio tiene tablas, rutas y permisos propios, con fotos cifradas en Storage y navegación propia.

**Tech Stack:** NestJS, Prisma/PostgreSQL, Jest, Next.js 14, React, Vitest.

**Spec:** `docs/superpowers/specs/2026-10-19-arrayanes-aesthetics.md`

## Global Constraints

- No ejecutar la seed contra producción.
- Las cuentas actuales conservan `MEDICAL` por defecto.
- Los estudios estéticos no obtienen módulos clínicos.
- Los permisos de cada rol se asignan desde plataforma.

---

### Task 1: Seed y Medicina General

**Files:** `prisma/seed.ts`, `prisma/seed-clinical-workflow.ts`, `prisma/seed-helpers.ts`, `test/seed-coverage.spec.ts`.

**Interfaces:** `seedDatabase(db, options)` sigue devolviendo `SeedResult`; el catálogo agrega la clave `generalMedicine` con código `GENERAL_MEDICINE`.

- [ ] Añadir una prueba que compruebe que los tenants no plataforma son exactamente `["Centro Médico Los Arrayanes"]` y que existe un perfil profesional con especialidad `GENERAL_MEDICINE`.
- [ ] Ejecutar `jest test/seed-coverage.spec.ts --runInBand`; comprobar que falla por cuentas demo sobrantes y ausencia del médico.
- [ ] Registrar Medicina General, el usuario de Los Arrayanes y retirar las llamadas a las otras seeds.
- [ ] Ejecutar la suite de seed y corregir expectativas de estados que pertenecían a las demos retiradas.

### Task 2: Giro y asignación de módulos

**Files:** `prisma/schema.prisma`, nueva migración, `src/common/sections/section-catalog.ts`, `src/common/guards/section.guard.ts`, `src/platform/{dto/create-platform-tenant.dto.ts,platform-tenants.service.ts}` y sus pruebas.

**Interfaces:** `TenantBusinessKind = MEDICAL | AESTHETIC_STUDIO`; `defaultSections(planType, tenantType, businessKind)` y `validateSections(keys, businessKind)`.

- [ ] Probar que un estudio recibe solo `core.aesthetics` y equipo si procede, que rechaza secciones médicas y que el guard las bloquea aunque exista una fila habilitada.
- [ ] Añadir el campo con default médico y una migración aditiva; generar Prisma Client.
- [ ] Permitir que plataforma cree estudios sin especialidades médicas y devuelva `businessKind` en listados y detalle.
- [ ] Probar creación y edición de módulos con ambos giros.

### Task 3: Operación estética en la API

**Files:** nuevos `src/aesthetics/*`, `prisma/schema.prisma`, nueva migración, `src/common/permissions/permission-catalog.ts`, `src/app.module.ts` y pruebas.

**Interfaces:** rutas `/tenants/:tenantId/aesthetics/{clients,bookings,services,sessions,consents,photos}`; todas requieren `core.aesthetics` y permisos `aesthetics.*`.

- [ ] Probar aislamiento entre tenants, referencias cruzadas inválidas, conflicto horario, consentimiento basado en el texto vigente del servicio y acceso a fotos según permiso.
- [ ] Crear tablas para cliente, reserva, servicio, sesión, consentimiento y foto con claves foráneas de tenant y migración RLS.
- [ ] Implementar DTO, servicio, controlador y almacenamiento cifrado para fotos, con respuestas sin `storageKey`.
- [ ] Ejecutar pruebas unitarias, integración local de migración y build de API.

### Task 4: Panel de dueño y vistas de estudio

**Files:** `web/src/types/index.ts`, `web/src/features/platform/*`, `web/src/components/layout/sidebar.tsx`, nueva ruta `web/src/app/(dashboard)/aesthetics/*`, cliente API y pruebas.

**Interfaces:** El alta y detalle de tenant muestran `businessKind`; la vista estética consume las rutas de Task 3.

- [ ] Probar selección de giro, catálogo filtrado, navegación estética y formularios principales.
- [ ] Implementar alta/edición de módulos compatible con el giro y ocultar especialidades médicas para estudios.
- [ ] Implementar listados y formularios de clientes, agenda, servicios, sesiones, consentimientos y fotos.
- [ ] Ejecutar Vitest, type-check y build web.

### Task 5: Verificación de entrega

**Files:** solo correcciones necesarias surgidas de pruebas.

- [ ] Ejecutar Prisma validate/generate, suites enfocadas, builds y comprobación de migración local.
- [ ] Revisar que el diff no contenga datos privados ni cambios de producción accidentales.
- [ ] Preparar commits y PRs de API y web; conservar la migración de producción pendiente de despliegue compatible.
