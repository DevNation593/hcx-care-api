# Rol de cajero — plan de implementación

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Un rol `CAJERO` que cobra, factura y maneja la caja sin acceso a agenda, pacientes ni historia clínica, en la API y en la web.

**Architecture:** La API agrega el valor `CAJERO` a `UserRole`, le da por rol los permisos de cobro en el catálogo y hace que `RolesGuard` admita en las rutas `@Roles('MASTER') + @RequirePermission` a un rol que tiene ese permiso por defecto (hoy solo admite los concedibles). Equipo, plataforma y la lista de sedes lo aceptan. La web lo ofrece en Equipo, lo lleva a `/cash` al entrar y lo mantiene dentro de caja, facturación, inventario y perfil.

**Tech Stack:** NestJS 11, Prisma 6, PostgreSQL, Jest + supertest; Next.js 14, React Query 5, Vitest + Testing Library.

**Spec:** `docs/superpowers/specs/2026-10-26-cashier-role-design.md` (en `hcx-care-api`).

## Global Constraints

- Ramas `feat/cashier-role` en `api/` y en `web/`, ya creadas desde `feat/product-inventory`. Nunca otra rama; no se hace push sin pedirlo; los PR irán contra `dev`.
- Permisos de `CAJERO` por rol, exactamente: `billing.view`, `billing.create`, `billing.adjust`, `cash.manage`. Concedible: `inventory.manage`. Ningún otro permiso lo menciona.
- El cajero no ocupa plaza del plan y no lleva perfil profesional.
- Rutas web del cajero: `/cash`, `/admin/billing`, `/inventory`, `/profile`; cualquier otra ruta del panel redirige a `/cash`.
- Mensaje de rol no asignable: «Solo se pueden asignar los roles Profesional, Asistente o Cajero.». Etiqueta de rol: «Cajero».
- Errores `{ statusCode, code, message }`; textos en español; comentarios en inglés.
- Sin dependencias nuevas.
- Archivos CRLF: editarlos con Edit. `npm run lint` de la API está roto (T-15): `npx prettier --check` sobre lo tocado. Tras cambiar `schema.prisma`, `npx prisma generate`.
- Base de datos desechable (embedded-postgres, puerto 54329; ver `.superpowers/sdd/2026-10-26-product-inventory/context.md`); nunca el `DATABASE_URL` de `api/.env`.
- Commits con el trailer `Co-Authored-By:` del modelo que los escribe.

## Review Focus

1. **Permiso retirado a un cajero:** si el titular le retira `billing.adjust`, un descuento responde 403 aunque `RolesGuard` ahora admita permisos del rol. Prueba en Task 1.
2. **Asistente o profesional sin el permiso:** el cambio de `RolesGuard` no abre `billing.view` a un asistente que no lo tiene por rol ni concedido. Prueba en Task 1.
3. **Cajero en una ruta clínica con permiso:** ninguna ruta de pacientes, citas, historia clínica, archivos, tratamientos ni consentimientos lo admite, ni siquiera las que piden un permiso. Prueba en Task 2 (matriz).
4. **Cambio de rol de un asistente con permisos concedidos a cajero:** sus restricciones y concesiones por usuario siguen aplicándose sobre los permisos del rol nuevo, y un permiso concedido que el cajero ya tiene por rol no lo duplica. Prueba en Task 2.
5. **Cajero que abre `/dashboard` o una URL clínica antes de que carguen los permisos:** no ve ni un instante el contenido clínico; la redirección ocurre antes de pintar la página. Prueba en Task 5.

---

## API (`api/`, rama `feat/cashier-role`)

### Task 1: Rol, permisos y guard

**Files:**
- Modify: `prisma/schema.prisma` (enum `UserRole`)
- Create: `prisma/migrations/20261027000000_cashier_role/migration.sql`
- Modify: `src/common/roles/role-compatibility.ts`, `src/common/permissions/permission-catalog.ts`, `src/common/guards/roles.guard.ts`
- Test: `src/common/roles/role-compatibility.spec.ts`, `src/common/permissions/permissions.spec.ts`, `src/common/guards/roles.guard.spec.ts` (crear si no existe)

**Interfaces:**
- Produces: `UserRole.CAJERO`; `CanonicalRole` incluye `'CAJERO'`; `isCashierRole(role: string): boolean` en `role-compatibility.ts`; `rolePermissions('CAJERO')` y `grantablePermissions('CAJERO')` según Global Constraints.
- Produces (`RolesGuard`): un rol fuera de `@Roles(...)` pasa si el permiso de la ruta está en `rolePermissions(user.role)` **o** en `grantablePermissions(user.role)`; si no hay `@RequirePermission`, sigue rechazando.

- [ ] **Step 1: Write the failing tests.**
  - `permissions.spec.ts`: `rolePermissions('CAJERO')` es exactamente `['billing.view','billing.create','billing.adjust','cash.manage']` (orden del catálogo); `grantablePermissions('CAJERO')` es `['inventory.manage']`; ningún permiso clínico, de pacientes ni de agenda tiene `CAJERO` en `roles` ni en `grantable`.
  - `role-compatibility.spec.ts`: `toCanonicalRole('CAJERO') === 'CAJERO'`; `isCashierRole('CAJERO')` true, `isCashierRole('ASISTENTE')` false.
  - `roles.guard.spec.ts`: con `@Roles('MASTER')` + `@RequirePermission('billing.view')`, un `CAJERO` pasa (permiso de su rol); un `ASISTENTE` también pasa este guard como hoy (permiso concedible; el `PermissionGuard` decide después); con `@Roles('MASTER')` sin `@RequirePermission`, un `CAJERO` recibe 403; con `@Roles('MASTER','PROFESIONAL')` + `@RequirePermission('clinical_records.view')`, un `CAJERO` recibe 403.
  - Review Focus #1: en el spec del `PermissionGuard` existente (o en `roles.guard.spec.ts` si ahí se prueban juntos), un `CAJERO` con `billing.adjust` retirado (`UserPermission` con `granted: false`) recibe 403 en una ruta que pide `billing.adjust`.
  - Review Focus #2: un `ASISTENTE` sin concesión de `billing.view` recibe 403 en `GET /orders` (guard + permission guard).
- [ ] **Step 2: Run** `npx jest src/common` — Expected: FAIL.
- [ ] **Step 3: Implement.** Enum y migración (`ALTER TYPE "UserRole" ADD VALUE 'CAJERO';`, creada con `--create-only` contra la base desechable y renombrada), `npx prisma generate`; catálogo según Global Constraints; `isCashierRole`; `RolesGuard` con `rolePermissions(user.role).includes(permission) || grantablePermissions(user.role).includes(permission)` y su comentario actualizado.
- [ ] **Step 4: Run** `npx jest src/common src/users src/platform src/orders src/inventory src/app.module.spec.ts src/app.wiring.spec.ts` y `npx tsc --noEmit -p tsconfig.json` — Expected: PASS. Aplicar la migración a la base desechable con `migrate deploy` y verificar `migrate diff` vacío salvo índices/CHECK hechos a mano.
- [ ] **Step 5: Commit** `feat(api): add the cashier role and let roles reach routes their own permissions open`.

### Task 2: Equipo, plataforma, sedes y matriz de roles

**Files:**
- Modify: `src/users/users.service.ts` (`ASSIGNABLE_TEAM_ROLES`, `roleNotAssignable`), `src/platform/platform-role-permissions.service.ts` (`CLINIC_ROLES`), `src/branches/branches.controller.ts` (solo `GET /`)
- Test: `src/users/users.service.spec.ts` (o el spec donde se prueban invitaciones), `src/platform/platform-role-permissions.service.spec.ts`, `src/common/roles/role-matrix.spec.ts`, `src/users/user-permissions*.spec.ts`

**Interfaces:**
- Consumes: `UserRole.CAJERO`, `isCashierRole`, catálogo (Task 1).
- Produces: `ASSIGNABLE_TEAM_ROLES = [PROFESIONAL, ASISTENTE, CAJERO]`; mensaje de Global Constraints; `CLINIC_ROLES = ['MASTER','PROFESIONAL','ASISTENTE','CAJERO']`; `GET /branches` con `@Roles('MASTER','ASISTENTE','PROFESIONAL','CAJERO')`.

- [ ] **Step 1: Write the failing tests.**
  - Invitar/crear un `CAJERO` funciona sin perfil profesional y no llama a la comprobación de plazas; pedirle un perfil profesional responde el mismo error que a un asistente; asignar `ADMIN` sigue respondiendo `ROLE_NOT_ASSIGNABLE` con el mensaje nuevo.
  - `describe(tenantId, 'CAJERO')` en plataforma devuelve los cuatro permisos del rol más `inventory.manage` como concedible.
  - Review Focus #4, en `src/common/permissions/permissions.spec.ts`: `effectivePermissions('CAJERO', ['patients.create'], ['billing.view'])` (restos de cuando el usuario era asistente) es exactamente `['billing.view','billing.create','billing.adjust','cash.manage']`: sin duplicados y sin permisos de pacientes. Y en el spec de `users.service`, cambiar el rol de un asistente a `CAJERO` conserva sus filas de `UserPermission` y su lectura de permisos efectivos da ese mismo resultado.
  - `role-matrix.spec.ts`, test `cashier reaches only billing, cash and inventory routes and the branch list`: recorre todos los handlers de todos los controladores (`controllerFiles`) y calcula los que admiten `CAJERO` (lista explícita de `@Roles` o permiso requerido en `rolePermissions('CAJERO')` ∪ `grantablePermissions('CAJERO')`). Afirma que cada uno pertenece a `OrdersController`, `PaymentsController`, `BillableSessionsController`, `CashRegistersController`, `BillingProfilesController`, `InvoicingController`, `BillingController`, `ProductsController`, `StockController`, `InventoryReportsController` o es `BranchesController.list`, y que ningún handler de pacientes, citas, encuentros, notas, registros, archivos, tratamientos, sesiones de tratamiento, consentimientos, tareas, plan de próxima sesión, usuarios, configuración, suscripción ni reportes lo admite (Review Focus #3).
- [ ] **Step 2: Run** `npx jest src/users src/platform src/common/roles src/branches` — Expected: FAIL.
- [ ] **Step 3: Implement** los cuatro cambios de Interfaces.
- [ ] **Step 4: Run** the same command — Expected: PASS. Si la matriz encuentra un handler de un controlador no listado que admite al cajero, detenerse y reportarlo (no ampliar la lista sin decisión).
- [ ] **Step 5: Commit** `feat(api): let the account holder assign cashiers and the platform tune them`.

### Task 3: E2E del cajero

**Files:**
- Create: `test/cashier-role.e2e-spec.ts`

**Interfaces:**
- Consumes: `createTestTenant`, `TEST_PASSWORD` (`test/helpers/create-test-tenant.ts`); arranque y datos de caja de `test/cash-and-billing.e2e-spec.ts` o `test/inventory.e2e-spec.ts` (tenant con secciones `core.billing.*`, sede, tratamiento y una sesión por cobrar).

- [ ] **Step 1: Write the e2e:** el titular crea un cajero con `POST /tenants/:tenantId/users` (`role: 'CAJERO'`, contraseña `TEST_PASSWORD`, como crea hoy un asistente) y, si queda invitado, lo activa con `POST /users/:userId/activate`; el número de profesionales activos que usa la comprobación de plazas (`TenantSubscription`/`UsageMetrics`, el mismo que lee `ProfessionalProfilesService.syncStoredSeatCount`) no cambia. El cajero inicia sesión y: `GET /branches` 200; `GET /tenants/:tenantId` 200; `GET /users/me/permissions` 200 con `effective` = los cuatro permisos; abre la caja; crea una orden con la sesión por cobrar; aplica un descuento (200); registra un pago; cierra la caja con arqueo. Recibe 403 en `GET /tenants/:tenantId/patients`, `GET /tenants/:tenantId/appointments` y `GET /tenants/:tenantId/clinical-notes`. Con `billing.adjust` retirado por el titular (`PUT /users/:id/permissions`), un nuevo descuento recibe 403. `GET /products` (inventario) responde 403 hasta que el titular le concede `inventory.manage`, y 200 después.
- [ ] **Step 2: Run** `DATABASE_URL_TEST=postgresql://postgres:postgres@localhost:54329/psic_clinic_test REDIS_URL="" npx jest --config ./test/jest-e2e.json --runInBand test/cashier-role.e2e-spec.ts` (aplicar antes `migrate deploy` a `psic_clinic_test`) — Expected: PASS.
- [ ] **Step 3: Run** `npx jest`, `npm run build` y `npx prettier --check` sobre lo tocado en Tasks 1–3 — Expected: PASS (las dos specs de migración conocidas pueden necesitar correr solas).
- [ ] **Step 4: Commit** `test(api): cashier end to end`.

---

## Web (`web/`, rama `feat/cashier-role`)

### Task 4: Tipos, Equipo y plataforma

**Files:**
- Modify: `src/types/index.ts` (`UserRole`, `TenantTeamRole`, `AssignableTeamRole`, `ClinicRole`), `src/types/guards.ts`, `src/lib/constants.ts` (`ROLE_LABELS`), `src/features/admin/team/team-member-dialog.tsx`, `src/features/platform/tenant-role-permissions-card.tsx`
- Test: `src/features/admin/team/*.test.tsx` (el de diálogo de miembro), `src/features/platform/*role-permissions*.test.tsx`

**Interfaces:**
- Produces: `UserRole.CAJERO = 'CAJERO'`; los tres tipos de rol de equipo/clínica lo incluyen; `isCashierRole(role: UserRole): boolean` en `guards.ts`; `ROLE_LABELS[UserRole.CAJERO] = 'Cajero'`.

- [ ] **Step 1: Write the failing tests:** el diálogo de Equipo ofrece la opción «Cajero»; elegirla oculta y vacía los campos de perfil profesional (como «Asistente») y envía `role: 'CAJERO'` sin perfil; editar a un cajero existente muestra «Cajero» seleccionado. La tarjeta de permisos por rol de plataforma muestra la fila «Cajero».
- [ ] **Step 2: Run** `npx vitest run src/features/admin/team src/features/platform` — Expected: FAIL.
- [ ] **Step 3: Implement.** En `handleRoleChange`, tratar `CAJERO` como hoy `ASISTENTE` (vaciar perfil).
- [ ] **Step 4: Run** the same command and `npm run type-check` — Expected: PASS (corregir cualquier `switch`/`Record` exhaustivo sobre `UserRole` que type-check señale).
- [ ] **Step 5: Commit** `feat(web): assign the cashier role from the team page`.

### Task 5: Entrada, rutas permitidas y barra lateral

**Files:**
- Create: `src/lib/cashier-routes.ts`, `src/lib/cashier-routes.test.ts`
- Modify: `src/lib/post-login-route.ts`, `src/lib/post-login-route.test.ts`, `src/lib/constants.ts` (`ROUTES.CASH = '/cash'` si no existe), `src/app/(dashboard)/layout.tsx`, `src/app/(dashboard)/dashboard-layout.test.tsx`, `src/components/layout/sidebar.tsx`, `src/components/layout/sidebar.test.tsx`

**Interfaces:**
- Consumes: `isCashierRole` (Task 4).
- Produces:
  - `CASHIER_PATHS = ['/cash', '/admin/billing', '/inventory', '/profile'] as const` y `isCashierPath(pathname: string): boolean` (coincide con la ruta exacta o con un prefijo seguido de `/`) en `cashier-routes.ts`.
  - `postLoginRoute(user)`: cambio de contraseña obligatorio primero (como hoy), luego `ADMIN` → `ROUTES.PLATFORM`, luego `CAJERO` → `ROUTES.CASH`, y `ROUTES.DASHBOARD` para los demás.
  - Layout del panel: un cajero se queda en el panel; si `!isCashierPath(pathname)`, `router.replace(ROUTES.CASH)` y no pinta los hijos mientras tanto (Review Focus #5). El resto de usuarios conserva la lógica actual (`homeRoute !== DASHBOARD` → salir del panel).
  - Barra lateral: para el cajero no aparece «Dashboard»; Caja, Inventario y Facturación siguen con su sección y permiso.

- [ ] **Step 1: Write the failing tests:**
  - `cashier-routes.test.ts`: `isCashierPath('/cash')`, `('/cash/orders/abc')`, `('/admin/billing')`, `('/inventory')`, `('/profile')` → true; `('/cashier')`, `('/dashboard')`, `('/patients')`, `('/admin/team')` → false.
  - `post-login-route.test.ts`: un `CAJERO` va a `/cash`; un `CAJERO` con `mustChangePassword` va al cambio de contraseña.
  - `dashboard-layout.test.tsx`: un cajero en `/dashboard` y en `/patients/123` es redirigido a `/cash` y el contenido hijo no se renderiza; un cajero en `/cash` y en `/inventory` ve la página; un `MASTER` en `/dashboard` sigue viéndola; un `ADMIN` sigue saliendo a `/platform`.
  - `sidebar.test.tsx`: un cajero con `billing.view` ve «Caja» y «Facturación», no ve «Dashboard», «Pacientes», «Agenda», «Clínica» ni «Administración»; con `inventory.manage` concedido ve «Inventario».
- [ ] **Step 2: Run** `npx vitest run src/lib src/app src/components/layout` — Expected: FAIL.
- [ ] **Step 3: Implement** según Interfaces (usar `usePathname()` en el layout).
- [ ] **Step 4: Run** `npm run lint && npm run type-check && npx vitest run && npm run build` — Expected: PASS.
- [ ] **Step 5: Commit** `feat(web): keep cashiers in the cash, billing and inventory pages`.

### Task 6: Verificación en el navegador (controlador)

- [ ] **Step 1:** Con la API de esta rama (build) contra la base desechable sembrada y la web en el puerto 4200: el titular de Aurora invita a un cajero desde Equipo; el cajero inicia sesión, llega a `/cash`, ve solo Caja y Facturación en la barra lateral, abre la caja y cobra una sesión; escribir `/patients` en la barra de direcciones lo devuelve a `/cash`. Registrar el resultado en el ledger.
