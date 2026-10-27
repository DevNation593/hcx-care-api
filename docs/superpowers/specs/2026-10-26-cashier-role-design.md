# Rol de cajero — diseño

Fecha: 2026-10-26 · Repositorios: api y web · Ramas: `feat/cashier-role` en cada uno, creadas desde
`feat/product-inventory` (api #88, web #79), porque el permiso `inventory.manage` y la página
`/inventory` viven ahí

Primer subproyecto de los pendientes de cobro (tabla del 26 de octubre): 1) rol de cajero, 2)
recibo no fiscal, 3) reporte de ingresos, 4) notas de crédito y anulación, 5) paquetes y anticipos,
6) convenios y seguros. Cubre la parte «cajero» de T-20 en `TAREAS_PENDIENTES.md`.

## Problema

Hoy quien cobra en la caja es el titular o un asistente al que el titular concede, uno por uno, los
permisos de facturación y caja. Ese asistente sigue teniendo por su rol la agenda y el alta y
edición de pacientes, y la pantalla de pacientes muestra alergias, medicación y datos de seguro. Un
consultorio que contrata a una persona solo para cobrar no tiene cómo darle la caja sin darle
también la agenda y los datos de los pacientes.

## Objetivo

Un rol propio, `CAJERO`, que cobra, factura y maneja la caja desde el primer ingreso, y que no ve ni
toca agenda, pacientes ni historia clínica.

Éxito: el titular invita a «Cajero» desde Equipo; no se consume una plaza del plan. El cajero entra y
llega a la caja; abre la caja de su sede, toma las sesiones por cobrar, aplica un descuento, cobra,
emite la factura y cierra la caja con su arqueo. Su barra lateral muestra Caja y Facturación (e
Inventario solo si la plataforma se lo concede a su rol). Si escribe `/patients` o `/calendar` en la barra de
direcciones vuelve a la caja, y la API le responde 403 en esas rutas.

## Decisiones tomadas

| Tema | Decisión |
|---|---|
| Forma | Valor nuevo `CAJERO` de `UserRole`, no una plantilla de permisos sobre el asistente |
| Permisos por defecto | `billing.view`, `billing.create`, `billing.adjust` (descuentos, conceptos libres y devoluciones) y `cash.manage` |
| Permisos concedibles | `inventory.manage` |
| Nunca | Permisos de pacientes, agenda e historia clínica: ni por rol ni concedibles |
| Pacientes | No accede a `/patients` ni a la ficha. Lo que necesita para cobrar ya llega por las rutas de caja: el nombre del paciente en las sesiones por cobrar y en las órdenes, y los perfiles de facturación (`billing-profiles`, `patients/:id/billing-profiles`, con permisos de facturación) |
| Plaza del plan | No ocupa: solo cuentan los perfiles profesionales activos, y el cajero no lleva perfil profesional |
| Asignación | El titular lo asigna en Equipo como hoy asigna Profesional o Asistente. Conceder o retirar los permisos del cajero se hace por consultorio y por rol (`TenantRolePermission`), desde la tarjeta de permisos por rol del panel de plataforma; el titular no los ajusta persona por persona |
| Actividades | Una actividad de paciente solo se asigna al titular, a profesionales o a asistentes: asignarla a un cajero responde 400 `TASK_ASSIGNEE_NOT_ALLOWED`. Convertir en cajero a quien tiene actividades abiertas (pendientes o en curso) responde 409 `USER_HAS_OPEN_TASKS` hasta que se reasignen |
| Entrada en la web | El cajero aterriza en `/cash`. Fuera de `/cash`, `/admin/billing`, `/inventory` y `/profile` se le redirige a `/cash` |
| Móvil | Fuera de alcance: la app móvil no ofrece nada al cajero en esta entrega |

## API

### Modelo

- Migración `20261027000000_cashier_role`: `ALTER TYPE "UserRole" ADD VALUE 'CAJERO';`. Sin otros
  cambios de esquema.
- `src/common/roles/role-compatibility.ts`: `CanonicalRole` y `CANONICAL_ROLES` incluyen `'CAJERO'`;
  `isCashierRole(role)` junto a `isMasterRole` e `isProfessionalRole`.

### Permisos

En `src/common/permissions/permission-catalog.ts`:

| Permiso | `roles` | `grantable` |
|---|---|---|
| `billing.view` | `MASTER`, `CAJERO` | `PROFESIONAL`, `ASISTENTE` |
| `billing.create` | `MASTER`, `CAJERO` | `PROFESIONAL`, `ASISTENTE` |
| `billing.adjust` | `MASTER`, `CAJERO` | `PROFESIONAL`, `ASISTENTE` |
| `cash.manage` | `MASTER`, `CAJERO` | `PROFESIONAL`, `ASISTENTE` |
| `inventory.manage` | `MASTER` | `PROFESIONAL`, `ASISTENTE`, `CAJERO` |

Ningún otro permiso del catálogo menciona a `CAJERO`. Las rutas de caja, órdenes, pagos, perfiles de
facturación, facturación e inventario usan `@Roles('MASTER')` + `@RequirePermission(...)` y no
cambian. Lo que cambia es `RolesGuard` (`src/common/guards/roles.guard.ts`): hoy, a un rol fuera de la
lista solo lo deja pasar si el permiso de la ruta es **concedible** para ese rol; pasa a dejarlo pasar
también si el permiso es **de su rol** (`rolePermissions(role)`). `PermissionGuard` sigue teniendo la
última palabra y respeta lo que la plataforma haya retirado de su rol. Las rutas con listas de roles
explícitas (`'MASTER', 'ASISTENTE', 'PROFESIONAL'` y similares) no se tocan, así que el cajero queda
fuera de pacientes, citas, sedes, tratamientos, consentimientos, notas, registros y archivos.

Rutas de uso general que el cajero necesita:

- `GET /branches` (lista de sedes para el selector de sucursal de la caja) hoy tiene
  `@Roles('MASTER', 'ASISTENTE', 'PROFESIONAL')`: se agrega `'CAJERO'` solo a esa ruta de lectura.
- Ya lo admiten sin cambios, porque no filtran por rol: `GET /tenants/:tenantId` (consultorio y
  secciones), la lista de personal, el uso de la suscripción, `GET /users/me/permissions`
  (`user-permissions.controller.ts`), las notificaciones propias y el perfil y la contraseña propios.
  Ninguna devuelve datos de pacientes. La e2e lo comprueba.

### Equipo y plataforma

- `src/users/users.service.ts`: `ASSIGNABLE_TEAM_ROLES` incluye `CAJERO`; el mensaje de error pasa a
  «Solo se pueden asignar los roles Profesional, Asistente o Cajero.». Un cajero se crea sin perfil
  profesional (igual que un asistente); pedir uno responde el mismo error que hoy para un asistente.
- `src/platform/platform-role-permissions.service.ts`: `CLINIC_ROLES` incluye `CAJERO`, así la
  plataforma puede retirar o conceder sus permisos por consultorio.
- Cambiar el rol de una persona a `CAJERO` mientras tiene actividades abiertas (`PENDING` o
  `IN_PROGRESS`) responde 409 `USER_HAS_OPEN_TASKS` («Reasigna las actividades abiertas de esta
  persona antes de convertirla en cajero.»), como `assertNoFutureAppointmentsForProfessional` con las
  citas.
- `src/tasks/tasks.service.ts`: el destinatario de una actividad debe ser `MASTER`, `ASISTENTE` o
  `PROFESIONAL`; si no, 400 `TASK_ASSIGNEE_NOT_ALLOWED` («Solo se pueden asignar actividades al
  titular, a profesionales o a asistentes.»). Así los recordatorios, con el nombre del paciente y el
  título, no llegan al cajero.

## Web

- `src/types/index.ts`: `UserRole.CAJERO`, y `ClinicRole`/`AssignableTeamRole`/`TenantTeamRole` lo
  incluyen. `ROLE_LABELS[CAJERO] = 'Cajero'`. `isCashierRole` en `src/types/guards.ts`.
- **Equipo** (`team-member-dialog.tsx`): la opción «Cajero» al invitar y editar, solo si el consultorio
  tiene activa la sección `core.billing.cash` (se mantiene al editar a un cajero existente); con ella se ocultan
  y vacían los campos de perfil profesional, como con «Asistente».
- **Plataforma** (`tenant-role-permissions-card.tsx`): la fila «Cajero».
- **Entrada**: tras iniciar sesión, un cajero va a `/cash`. En el layout del panel, si el usuario es
  cajero y la ruta no empieza por `/cash`, `/admin/billing`, `/inventory` ni `/profile`, se le
  redirige a `/cash` (incluido `/dashboard`, que consulta citas y actividades).
- **Barra lateral**: para el cajero solo Caja, Facturación e Inventario (cada uno con su sección y
  permiso, como hoy; las entradas salen de `CASHIER_PATHS`) y nada más; Dashboard no aparece.

## Fuera de alcance

- La app móvil para el cajero.
- Roles de contador y de enfermería, y permisos por sede (resto de T-20).
- Un buscador de pacientes reducido para la caja.

## Pruebas

API, unitarias:

- Matriz de roles (`role-matrix.spec.ts`): para cada ruta, `CAJERO` entra solo si la ruta pide uno de
  sus permisos; ninguna ruta de pacientes, citas, historia clínica, tratamientos, consentimientos,
  archivos, sedes en escritura, equipo, configuración, suscripción ni reportes clínicos lo admite.
- `permissions.spec.ts`: `rolePermissions('CAJERO')` es exactamente `billing.view`,
  `billing.create`, `billing.adjust`, `cash.manage`; `grantablePermissions('CAJERO')` es
  `inventory.manage`.
- `users.service`: invitar un cajero no consulta ni consume plazas; pedirle perfil profesional
  falla como hoy con un asistente.
- `platform-role-permissions`: `CAJERO` es un rol de consultorio válido.
- `tasks.service`: asignar una actividad a un cajero se rechaza con `TASK_ASSIGNEE_NOT_ALLOWED`.
- `users.service`: cambiar a cajero con actividades abiertas se rechaza con `USER_HAS_OPEN_TASKS`; sin
  ellas se permite.

API, e2e (`test/cashier-role.e2e-spec.ts`): el titular invita a un cajero; el cajero inicia sesión,
abre la caja, crea una orden con una sesión por cobrar, aplica un descuento, cobra y cierra la caja;
recibe 403 en `GET /patients`, `GET /appointments` y en una nota clínica (con el mensaje de rol
requerido); con `billing.adjust` retirado a su rol, el descuento recibe 403 `PERMISSION_DENIED`; el
titular no puede asignarle una actividad (400 `TASK_ASSIGNEE_NOT_ALLOWED`); conserva las lecturas
abiertas (personal, consultorio, uso de la suscripción y notificaciones propias, sin datos de
pacientes); el contador de plazas no cambió.

Web (Vitest): la opción «Cajero» en Equipo sin campos de perfil; la barra lateral del cajero; la
redirección desde `/dashboard` y `/patients` a `/cash`; la fila «Cajero» en la tarjeta de permisos de
plataforma.

## Entrega

- Ramas `feat/cashier-role` en api y web desde `feat/product-inventory`; los PR van contra `dev` y se
  fusionan después de api #88 y web #79.
- La API pasa unitarias, e2e, build y `prettier --check` en lo tocado; la web, lint, type-check,
  Vitest y build.
