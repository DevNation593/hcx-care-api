# Política de seguridad — hcx-care-api

## Reportar una vulnerabilidad

No abras un issue público. Usa **Security → Report a vulnerability** en
[DevNation593/hcx-care-api](https://github.com/DevNation593/hcx-care-api/security/advisories/new)
(reporte privado de GitHub). Incluye el endpoint o archivo afectado, los pasos para reproducirlo y el impacto.

Solo recibe parches la rama `main` (producción) y `dev` (integración).

## Qué protegemos

| Activo | Por qué importa |
| --- | --- |
| Datos clínicos (`ClinicalNote`, `SpecialtyRecord`, archivos de pacientes, consentimientos) | Información de salud: su exposición daña al paciente y es una falta legal |
| Separación entre consultorios (`tenantId`) | Un consultorio jamás puede ver ni modificar datos de otro |
| Credenciales y sesiones (contraseñas, JWT, refresh tokens) | Dan acceso a todo lo anterior |
| Facturación electrónica, caja e inventario | Dinero y obligaciones tributarias |
| Secretos del entorno (`JWT_*`, `CLINICAL_ENCRYPTION_KEYS`, claves de Supabase, VAPID, Firebase, proveedor de facturación) | Comprometen todo el sistema |

## Reglas (invariantes)

Toda revisión de código, humana o automática, verifica estas reglas. Un cambio que viole una regla marcada **P0** no se fusiona.

### Aislamiento entre consultorios

- **SEC-API-01 (P0).** Toda consulta sobre datos de un consultorio se filtra por el `tenantId` del usuario autenticado (`@CurrentUser()`/`request.user`). Nunca por un `tenantId` recibido en el cuerpo, la query o un header. Un `findUnique`/`update`/`delete` por `id` debe comprobar que el registro pertenece al tenant (`where: { id, tenantId }` o verificación previa) y responder 404 si no.
- **SEC-API-02 (P0).** Las relaciones cargadas con `include`/`select` y las referencias recibidas en DTOs (`patientId`, `professionalId`, `branchId`, `productId`, …) se validan contra el mismo tenant antes de usarlas.
- **SEC-API-03 (P1).** El contexto RLS de PostgreSQL es una segunda capa, no la principal. Su `tenantId`, `userId` y `role` salen del JWT validado; un header enviado por el cliente (`x-user-id`, `x-user-role`, etc.) nunca decide autorización ni contexto.

### Autenticación y autorización

- **SEC-API-04 (P0).** Los guards globales (`JwtAuthGuard`, `PasswordChangeGuard`, `TenantGuard`, `RolesGuard`, `SubscriptionGuard`, `FeatureGuard`, `SectionGuard`, `PermissionGuard`) no se desactivan ni se reordenan sin una decisión documentada en `docs/ARCHITECTURE.md`.
- **SEC-API-05 (P0).** `@Public()` solo en rutas que lo necesitan (login, refresh, recuperación de contraseña, activación, verificación pública de documentos, webhooks, health). Una ruta pública nueva queda bajo el throttler global o un `@Throttle` más estricto, no devuelve datos clínicos ni PII más allá de lo imprescindible, y los webhooks verifican la firma con comparación en tiempo constante antes de procesar nada.
- **SEC-API-06 (P1).** Cada ruta nueva declara su acceso con `@Roles()`, `@RequirePermission()` (claves de `src/common/permissions/permission-catalog.ts`), `@RequireSection()` o `@PlatformRoute()`.
- **SEC-API-07 (P1).** `ADMIN` solo opera en `/platform/*` y no lee datos internos de un consultorio. `CAJERO` no accede a agenda, pacientes, tareas ni historia clínica. Los roles obsoletos (`CLIENTE`, `PSICOLOGO`, `SOPORTE`) no reciben permisos nuevos. `MASTER` sigue siendo único por tenant, no se desactiva y no cambia de rol.
- **SEC-API-08 (P1).** Contraseñas con `bcrypt`; nunca se devuelven, registran ni comparan en claro. Las respuestas de usuario usan `public-user-select.ts`. La rotación de refresh tokens con detección de reutilización (familia revocada) se conserva.
- **SEC-API-09 (P2).** Login, recuperación y activación no revelan si un correo existe y están limitados por `@Throttle`.

### Datos clínicos

- **SEC-API-10 (P0).** Los campos listados en `docs/CLINICAL_DATA_PROTECTION.md` se escriben cifrados con `ClinicalCryptoService` (AES-256-GCM con `tenantId` como dato autenticado) y se descifran solo al devolverlos. Un campo clínico nuevo se agrega a esa tabla y al cifrado, o el PR explica por qué no.
- **SEC-API-11 (P1).** Crear, leer, actualizar y eliminar datos clínicos deja registro en la auditoría clínica, y la propia auditoría guarda los valores cifrados.
- **SEC-API-12 (P0).** Ningún dato clínico ni PII (nombres de pacientes, diagnósticos, contenido de notas, documentos de identidad) aparece en logs, mensajes de excepción, notificaciones push, asuntos de correo ni nombres de archivo en el almacenamiento.
- **SEC-API-13 (P1).** Los archivos de pacientes se sirven solo tras comprobar tenant y permiso, con URLs firmadas de corta duración o descarga a través de la API; nunca con buckets públicos. Se validan tipo MIME y tamaño en la subida.

### Entrada, consultas y salida

- **SEC-API-14 (P0).** `$queryRaw`/`$executeRaw` solo con plantillas parametrizadas (`Prisma.sql`, tagged templates). Prohibido `$queryRawUnsafe`/`$executeRawUnsafe` con datos del usuario.
- **SEC-API-15 (P1).** Todo cuerpo, query y parámetro entra por un DTO con `class-validator`. No se desactiva `whitelist`/`forbidNonWhitelisted` del `ValidationPipe` global. Los listados tienen paginación con límite máximo.
- **SEC-API-16 (P2).** Los errores devuelven códigos de negocio (`SECTION_NOT_ENABLED`, `SEAT_LIMIT_REACHED`, …) sin trazas, SQL ni detalles internos.
- **SEC-API-17 (P1).** Los PDFs y plantillas de documentos no ejecutan contenido del usuario ni cargan recursos remotos arbitrarios (SSRF).

### Secretos y configuración

- **SEC-API-18 (P0).** Ningún secreto, token, clave o contraseña real en el código, en los tests, en `.env.example` ni en los logs. Las variables nuevas se documentan en `.env.example` con un valor de ejemplo inválido y en `docs/DEPLOYMENT.md`.
- **SEC-API-19 (P1).** En producción la API no arranca sin `CLINICAL_ENCRYPTION_KEYS`; ningún cambio debe introducir valores por defecto para secretos JWT u otras claves. CORS no admite `*` con credenciales; los orígenes con comodín solo se usan para entornos de vista previa.
- **SEC-API-20 (P2).** Dependencias nuevas: mantenidas, sin vulnerabilidades conocidas altas o críticas (`npm audit`) y justificadas en el PR.

### Migraciones y datos

- **SEC-API-21 (P0).** Una migración no borra columnas, tablas ni valores con datos en producción sin un paso previo de respaldo o migración de datos explicado en el PR.
- **SEC-API-22 (P1).** Las políticas RLS y los índices únicos parciales de seguridad (`User_tenantId_master_key`, `Tenant_isPlatform_key`) no se eliminan ni se relajan.

## Lista rápida por tipo de cambio

- **Endpoint nuevo:** SEC-API-01, 02, 05, 06, 07, 15, 16.
- **Notas clínicas, registros de especialidad, archivos o consentimientos:** SEC-API-10, 11, 12, 13.
- **Auth, sesiones o usuarios:** SEC-API-04, 08, 09.
- **Prisma (esquema, migraciones, SQL crudo):** SEC-API-14, 21, 22.
- **Configuración, despliegue o dependencias:** SEC-API-18, 19, 20.

## Pendientes conocidos

Riesgos identificados que aún no se resuelven. Una revisión no los reporta como nuevos salvo que el PR los empeore:

- `src/common/interceptors/rls-context.interceptor.ts` toma `x-user-id` y `x-user-role` de los headers cuando no hay usuario autenticado (rutas públicas). Contradice SEC-API-03; debe eliminarse ese fallback.
- La API no valida al arrancar que `JWT_ACCESS_SECRET`/`JWT_REFRESH_SECRET` existan y no sean valores de ejemplo (SEC-API-19); hoy solo `CLINICAL_ENCRYPTION_KEYS` se exige en producción.
- Campos médicos básicos de `Patient` (`allergies`, `currentMedication`, `notes`), `NextSessionPlan` y tareas siguen en texto plano (ver `docs/CLINICAL_DATA_PROTECTION.md`).
- Las verificaciones de infraestructura listadas en `docs/CLINICAL_DATA_PROTECTION.md` (cifrado en reposo del proveedor, TLS obligatorio, custodia de la clave) están sin confirmar.
