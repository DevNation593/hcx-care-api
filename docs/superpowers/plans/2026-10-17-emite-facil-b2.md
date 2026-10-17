# Emite-facil B2 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox syntax for tracking.

**Goal:** Configurar emite-facil desde HCX y emitir comprobantes de órdenes pagadas con estados y artefactos durables.

**Architecture:** Puerto HTTP con API key, intención de factura y snapshot cifrados en PostgreSQL, worker con leases y reconciliación. La web usa endpoints de HCX; nunca accede al proveedor con credenciales.

**Tech Stack:** NestJS, Prisma/PostgreSQL, fetch, AES-256-GCM existente, Schedule, Next.js, React Query, Jest y Vitest.

**Spec:** `docs/superpowers/specs/2026-10-17-emite-facil-b2-contract.md` y las secciones B2/Web/Errores/Pruebas de `2026-10-15-cash-and-billing-design.md`.

## Global Constraints

- Autenticación mediante API key estática `X-Api-Key`; no se solicitan contraseñas de usuario, clientId, scopes ni canje de tokens.
- Una URL global `EMITE_FACIL_API_URL`, incluida su ruta `/api/v1`. No se aceptan URLs del proveedor por clínica.
- Se mantienen los comprobantes históricos de Faktur en solo lectura.
- Snapshot fiscal inmutable y cifrado; nunca datos clínicos ni nombres de pacientes atendidos.
- El reconciliador funciona sin webhook; no se administra ninguna suscripción con la API key.
- Trabajar solo en los worktrees `api/.worktrees/emite-facil-b2` y `web/.worktrees/emite-facil-b2`. No modificar repositorio del proveedor ni bases de producción.
- Pruebas unitarias en serie para API, máximo dos workers para web. No instalar nuevas dependencias si las actuales resuelven el trabajo.

### Task 1: Adaptador HTTP y contrato ejecutable

**Files:** Crear `api/src/invoicing/provider/{invoicing-provider.ts,emite-facil.provider.ts,emite-facil.provider.spec.ts,webhook-signature.ts,webhook-signature.spec.ts}`. Leer `docs/superpowers/emite-facil-contract-audit.md` y los controladores Java que cita.

**Interfaces:** Exportar `EmiteFacilProvider` inyectable, `client(apiKey: string, correlationId?: string): InvoicingProvider`. El puerto ofrece `getTenant`, `listTaxpayers`, `listEstablishments(taxpayerId)`, `listEmissionPoints(taxpayerId, establishmentId)`, `listTaxRates`, `findCustomer(idType,idNumber)`, `createCustomer(profile)`, `findProduct(sku)`, `createProduct(product)`, `createInvoice(body,key)`, `getDocument(id)`, `getSriAttempts(id)`, `getArtifact(id,kind)`. Exportar tipos explícitos de opciones, perfil, producto, factura, documento y artefacto. Exportar `ProviderError` con `kind: 'transient'|'data'|'configuration'`, `code`, `retryAfterMs?`; nunca mensajes o cuerpos con secretos. Exportar `verifyWebhookSignature(rawBody: Buffer, headers, secret, now?: Date): boolean`.

- [ ] Escribir y ejecutar prueba RED contra servidor HTTP local: la llamada envía X-Api-Key y clave de idempotencia y parsea el cuerpo real, sin JWT.

```ts
expect(captured.headers['x-api-key']).toBe(apiKey);
expect(captured.headers['idempotency-key']).toBe('hcx-test');
expect(captured.headers.authorization).toBeUndefined();
```

- [ ] Implementar endpoints exactos, paginación completa para catálogos, filtrado exacto para identificación/SKU, timeout de quince segundos y clasificación de 401/403/404, 422, 409 en vuelo/reutilizada, 429 con Retry-After, 5xx y errores de red. Rechazar base URL inválida y redirecciones; no enviar secretos a otros orígenes.
- [ ] Añadir pruebas de payload mínimo, errores sin filtración de claves/cuerpos, detalle y estados de documento, intentos SRI con mensajes, ETag, ausencia de PUT customers, firma múltiple válida, cuerpo modificado y timestamp vencido. Ejecutar GREEN y formato.
- [ ] Registrar comandos RED/GREEN e interfaces reales en reporte; commit de esta tarea.

### Task 2: Conexión, persistencia y flujo completo de emisión

**Files:** Modificar `api/prisma/schema.prisma`, agregar migración `20261017000000_emite_facil_b2/migration.sql`. Crear `api/src/invoicing/{invoicing.module.ts,invoicing.controller.ts,connection.service.ts,invoice-requests.service.ts,invoice-worker.service.ts,invoice-artifacts.service.ts,invoice-view.ts,invoice-snapshot.ts,dto/invoicing.dto.ts}` y tests adyacentes. Modificar `app.module.ts`, `main.ts`, `prisma/prisma.service.ts`, `orders/eligibility-facts.ts`, `orders/payments.service.ts`, `treatment-sessions/session-state.ts` y cierre clínico si corresponde, `subscription/subscription.service.ts`. Crear `test/invoicing.e2e-spec.ts`. Actualizar `.env.example`, `docs/API_ENDPOINTS.md`, `docs/DEPLOYMENT.md`.

**Interfaces:** Consumir puerto y tipos de Task 1. Exponer bajo `/tenants/:tenantId`: `GET/PUT invoicing/connection`, `POST invoicing/test`, `GET invoicing/options`, `PUT branches/:branchId/emission-point`, `POST orders/:id/invoice-requests` (202), `GET invoice-requests?status=&branchId=&orderId=&patientId=&page=&pageSize=`, `GET invoice-requests/:id`, `GET invoice-requests/:id/{xml,ride}`. Público firmado: `POST integrations/emite-facil/webhook/:connectionId` (204). Publicar tipos JSON concretos para Task 3 en reporte.

**Models:** InvoicingConnection (tenant único, API key cifrada, emisor/empresa/ambiente validados, webhook secreto cifrado, estado y revisión), BranchEmissionPoint (branch único, connection, IDs y códigos externos), InvoicingRef (connection/kind/localId único, externalId, syncedHash), InvoiceRequest (orden/clínica/conexión/perfil/actor, estados, claves cliente/proveedor, snapshot cifrado, referencia de reemplazo, datos externos, hashes/storage, reintentos y lease), InvoiceRequestEvent (solo inserción, webhookEventId único por conexión). Relaciones con tenant/order/profile/user; índices por tenant y cola e índice parcial de solicitud activa. No borrar modelos históricos. Las respuestas excluyen credenciales, snapshot y leases.

- [ ] Escribir pruebas RED de guardar conexión sin revelar secretos, API key inicial/reutilizada, error en punto ajeno, facturación no configurada, creación sin proveedor HTTP, misma clave/misma orden y distinta orden, orden ya autorizada, bloqueo mensual y transacción que actualiza sesiones sin pagos.

```ts
expect(result.status).toBe('REQUESTED');
expect(provider.createInvoice).not.toHaveBeenCalled();
expect(repeated.id).toBe(result.id);
expect(JSON.stringify(publicConnection)).not.toContain(apiKey);
```

- [ ] Implementar migración y Prisma generate/validate, cifrado obligatorio para credenciales/snapshots, prueba de conexión, selección de emisor/puntos y metadata sin secretos. Probar API key nueva sin persistir hasta guardar. PUT conserva clave omitida y permite desactivar; cambio de empresa/emisor prohibido mientras existan solicitudes sin resolver, conservar o invalidar puntos según identidad externa y documentarlo.
- [ ] Implementar solicitud serializable e idempotente con índices y recuperación de colisiones, límites mensuales por raíces de reemplazo, snapshot de solo datos fiscales, elegibilidad real de conexión/sede. Validar pagos exactos agrupados `01/16/19/20`. Congelar orden INVOICED y sesiones BILLING_PENDING cuando requieren cierre, preservando posibilidad de cierre clínico si la política permite facturar antes; autorización convierte solo sesiones completadas a BILLED. Bloquear devolución mientras hay solicitud viva o autorizada, nueva emisión de orden autorizada y edición clínica prohibida en estados bloqueados.
- [ ] Worker cada 10 s: claim `FOR UPDATE SKIP LOCKED`, lease recuperable, llamadas fuera de transacción larga, CAS al persistir con clave hcx estable, referencias externas y hash. Error transitorio usa 30 s exponencial hasta 30 min/Retry-After; límite 24 h. Un fallo ambiguo de creación sigue recuperándose con la misma clave, sin liberar la orden a una factura duplicada. Cliente remoto desactualizado produce CUSTOMER_SYNC_REQUIRED; no PUT no soportado.
- [ ] Webhook con rawBody y firma real, aislamiento de empresa/documento, deduplicación durable y avance monotónico de estado. Reconciliación cada minuto para PROCESSING sin evento en dos minutos y artefactos autorizados pendientes. Rechazo/fallo seguro libera orden a PAID, mantiene pagos; reemplazo enlaza documento. Descargar artifacts con hash, cifrar en FILE_STORAGE, validar al leer y auditar. Reintentos no borran ni sobreescriben archivos válidos.
- [ ] Añadir pruebas de worker/red reintentable/429/lease, callbacks duplicados y fuera de orden, aislamiento, rechazo/reemplazo, perfil modificado, XML/RIDE y hash. E2E real con Postgres independiente y proveedor HTTP simulado, cron deshabilitado en tests e invocado explícitamente. Ejecutar focused GREEN, build, formato; full suite una vez al terminar. Documentar env y migración sin ejecutarla en base real. Commit y reporte.

### Task 3: Configuración y emisión en la web

**Files:** Crear `web/src/types/invoicing.ts`, `web/src/lib/api/invoicing-api.ts`, `web/src/hooks/useInvoicing.ts`, `web/src/features/billing/invoicing-settings.tsx`, `web/src/features/cash/{invoice-request-panel.tsx,invoices-tab.tsx}` y pruebas. Modificar `web/src/app/(dashboard)/admin/billing/page.tsx`, `web/src/features/cash/{cash-page.tsx,order-detail.tsx}`, historial de la ficha del paciente si la lista puede filtrar por patientId. Mantener componentes y tema actuales.

**Interfaces:** Usar JSON/endpoints publicados por Task 2. Header Idempotency-Key por solicitud; descargas autenticadas por apiClient Blob y URL temporal revocada. React Query con invalidación de orden, elegibilidad, listas y sesión. `InvoiceRequestPanel({order,eligibility})`, `InvoicesTab({branchId,patientId?})`, `InvoicingSettings()`.

- [ ] Prueba RED: MASTER puede probar key y guardar emisor sin devolver credenciales, selección y guardado de puntos, modo sin webhook. Otro rol no carga secretos ni endpoints MASTER. Mantener historial Faktur visible solo a roles autorizados y conservar pruebas existentes adaptándolas a B2.
- [ ] Formulario con key vacía/no rellenada, Probar conexión, selector de emisor/ambiente y Guardar; preservar key omitida, estado/error/reintentar, puntos por sede, URL copiable y secreto webhook opcional. No datos ficticios. Quitar aviso próximamente.
- [ ] Prueba RED: emisión deshabilitada sin elegibilidad, mismo UUID tras fallo de red y reintento, 422 mostrado con missing/items, refresco cada cinco segundos hasta estado final, descarga solo disponible si existe artefacto. Implementar sin éxito optimista ni perder clave en refetch fallido.

```ts
expect(secondHeaders['Idempotency-Key']).toBe(firstHeaders['Idempotency-Key']);
expect(screen.queryByText('Autorizada')).not.toBeInTheDocument();
```

- [ ] Añadir pestaña Facturas con filtros, paginación, estados y descargas. En orden mostrar progreso/datos finales, aviso de autorizada sin anulación, rechazo y volver a emitir con nueva clave después de respuesta final. Integrar nuevas facturas de paciente mediante filtro de servidor, sin depender de snapshots públicos.
- [ ] Ejecutar focused GREEN y luego Vitest completo, lint, type-check, build y diff self-review. Commit y reporte.

## Entrega

- [ ] Revisión de especificación y calidad por tarea; corregir hallazgos importantes antes de avanzar.
- [ ] Revisión final del conjunto API/web, migración y rutas de configuración; comprobaciones finales según cambios nuevos.
- [ ] Dejar cambios revisables en ambas ramas de feature; no publicar ni desplegar ni fusionar ramas compartidas sin instrucción específica.

