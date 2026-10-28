# AGENTS.md — hcx-care-api

Guía para agentes de código (Codex / GPT) que trabajan o revisan PRs en este repositorio.
Las reglas de seguridad viven en [`SECURITY.md`](SECURITY.md); este archivo las referencia y no las repite.

## Contexto del proyecto

HCX Care es un SaaS **multi-tenant** para consultorios y clínicas de salud (psicología, estética y otras especialidades). Este repositorio es la API:

- NestJS 11 + TypeScript, Prisma 6 sobre PostgreSQL, Jest (unitarias y e2e), despliegue en Vercel.
- Cada consultorio es un `Tenant`; casi todas las tablas llevan `tenantId`.
- Maneja **datos clínicos sensibles** (notas clínicas, registros de especialidad, archivos de pacientes) y facturación electrónica.
- Documentación de referencia en `docs/`: `ARCHITECTURE.md` (guards, roles, secciones), `CLINICAL_DATA_PROTECTION.md` (cifrado), `API_ENDPOINTS.md`, `DEPLOYMENT.md`, `SUBSCRIPTION_*.md`.

### Mapa rápido

| Ruta | Qué contiene |
| --- | --- |
| `src/auth/` | Login, refresh con rotación, cambio y recuperación de contraseña, `JwtStrategy` |
| `src/common/guards/` | Guards globales: `JwtAuthGuard`, `PasswordChangeGuard`, `TenantGuard`, `RolesGuard`, `SubscriptionGuard`, `FeatureGuard`, `SectionGuard`, `PermissionGuard` |
| `src/common/decorators/` | `@Public()`, `@Roles()`, `@PlatformRoute()`, `@SessionRoute()`, `@RequireSection()`, `@CurrentUser()` |
| `src/common/permissions/` | Catálogo de permisos por rol (`permission-catalog.ts`) y `@RequirePermission()` |
| `src/clinical-access/` | Cifrado de campos clínicos, auditoría clínica, guards de perfil y especialidad |
| `src/platform/` | Panel del `ADMIN` de plataforma (`/platform/*`) |
| `src/prisma/` | `PrismaService` con contexto RLS |
| `prisma/` | `schema.prisma`, migraciones, seeds y scripts de verificación/migración de datos |
| `test/` | Pruebas e2e contra PostgreSQL real |

### Roles

`MASTER` (titular, uno por tenant), `PROFESIONAL`, `ASISTENTE`, `CAJERO` (sin acceso clínico ni a pacientes), `PACIENTE`, `ADMIN` (solo plataforma, nunca ve datos internos de un consultorio). `CLIENTE`, `PSICOLOGO` y `SOPORTE` son valores obsoletos: ningún código nuevo debe otorgarles permisos.

## Comandos

```bash
npm ci
npx prisma generate
npm run lint
npm test -- --runInBand
npm run test:e2e -- --runInBand   # requiere DATABASE_URL apuntando a un PostgreSQL desechable
npm run build
```

La CI (`.github/workflows/ci.yml`) ejecuta además los scripts `prisma:verify-*` y `prisma migrate deploy`. Un PR debe pasar todo lo anterior.

## Convenciones

- Los PRs se abren contra **`dev`**, nunca contra `main`.
- Commits en inglés con prefijo convencional (`feat(api):`, `fix(api):`, `test(api):`, `chore:`).
- Código y comentarios en inglés; documentación en `docs/` en español.
- Cada endpoint nuevo declara explícitamente su acceso: `@Roles()`, `@RequirePermission()`, `@RequireSection()` o `@PlatformRoute()` según corresponda. `@Public()` es la excepción y debe justificarse.
- DTOs con `class-validator`; el `ValidationPipe` global usa `whitelist` y `forbidNonWhitelisted`.
- Cambios de esquema solo mediante una migración nueva en `prisma/migrations/`. No se editan migraciones ya fusionadas.
- Toda lógica nueva lleva pruebas; los cambios de permisos o aislamiento entre tenants llevan una prueba que demuestre el rechazo (403/404), no solo el caso feliz.

## Review guidelines

Instrucciones para la revisión automática de PRs con Codex / GPT.

### Idioma y formato

- Escribe todos los comentarios de revisión **en español**.
- Cada hallazgo indica: severidad (`P0`–`P3`), archivo y línea, qué falla, un escenario concreto que lo demuestra y la corrección sugerida.
- Si un hallazgo viola una regla de `SECURITY.md`, cita su identificador (por ejemplo `SEC-API-01`).
- No resumas el PR ni felicites; reporta solo hallazgos accionables. Si no hay ninguno, dilo en una línea.

### Antes de revisar

1. Lee [`SECURITY.md`](SECURITY.md). Sus reglas son invariantes del sistema.
2. Si el cambio toca guards, permisos, roles o secciones, consulta `docs/ARCHITECTURE.md`.
3. Si toca notas clínicas, registros de especialidad o auditoría, consulta `docs/CLINICAL_DATA_PROTECTION.md`.

### Severidades

- **P0 — bloquea el merge.** Fuga de datos entre consultorios; acceso a datos clínicos sin permiso; endpoint sin autenticación que no debería ser público; dato clínico escrito sin cifrar; secreto o credencial en el código; inyección SQL; migración que borra o corrompe datos en producción.
- **P1 — debe corregirse antes del merge.** Rol o permiso incorrecto (por ejemplo, `CAJERO` alcanzando datos de pacientes, `ADMIN` alcanzando datos internos de un consultorio); falta de auditoría en una operación clínica; validación de entrada ausente; error de lógica de negocio (citas, facturación, caja, inventario, asientos del plan); migración no reversible o que rompe despliegues en curso; regresión sin prueba.
- **P2 — conviene corregir.** Casos borde, condiciones de carrera sin impacto de seguridad, N+1 en rutas calientes, manejo de errores que filtra detalles internos, pruebas faltantes para ramas nuevas.
- **P3 — menor.** Legibilidad o nombres. Repórtalos solo si el PR no tiene hallazgos de mayor severidad.

### Qué revisar con prioridad

1. **Aislamiento entre tenants.** Toda consulta Prisma sobre datos de un consultorio filtra por el `tenantId` del usuario autenticado (`@CurrentUser()`), no por uno recibido en el cuerpo, la query o un header. Revisa especialmente `findUnique`/`update`/`delete` por `id` sin `tenantId`, `include` que cruza relaciones y `$queryRaw`/`$executeRaw`.
2. **Autorización.** Rutas nuevas o modificadas con los decoradores correctos; ningún `@Public()` nuevo sin justificación; permisos coherentes con `permission-catalog.ts`; reglas de `MASTER` (único, no se desactiva ni cambia de rol) y de `ADMIN` (solo `/platform/*`) intactas.
3. **Datos clínicos.** Escritura cifrada y lectura descifrada mediante `ClinicalCryptoService`; auditoría clínica en crear, leer, actualizar y eliminar; ningún dato clínico ni PII en logs, mensajes de error, notificaciones push o correos.
4. **Migraciones Prisma.** SQL revisado: `DROP`, `ALTER ... TYPE`, `NOT NULL` sin valor por defecto, cambios de enum, índices únicos que pueden fallar con datos existentes. Si el cambio altera datos, debe existir un script de verificación o reconciliación como los de `prisma/verify-*.ts`.
5. **Lógica de negocio con dinero o inventario.** Facturación electrónica, caja (`cash-registers`), inventario y suscripciones: transacciones, idempotencia, redondeo y concurrencia.
6. **Pruebas.** Que existan y prueben el comportamiento real, incluidos los rechazos por rol y por tenant.

### Qué no reportar

- Formato o estilo que ya cubren ESLint y Prettier.
- Archivos generados o ajenos al PR: `dist/`, `node_modules/`, `.worktrees/`, `coverage/`, `storage/`, cliente de Prisma generado.
- Seeds y datos de demo (`prisma/seed*.ts`) por usar credenciales de prueba, salvo que acaben en producción.
- Preferencias personales sin impacto en corrección, seguridad o mantenimiento.
- Problemas preexistentes en código que el PR no toca, salvo que sean P0.
