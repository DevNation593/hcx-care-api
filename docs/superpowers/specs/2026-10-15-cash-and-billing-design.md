# Caja y facturación (sub-proyecto B de HCX Cloud v2) — diseño

Fecha: 2026-10-15 · Repositorios: api y web · Rama: `feat/cash-and-billing` en cada uno, creada desde
`claude/compassionate-hopper-t6teqf` (sub-proyecto A)

Origen: *HCX Cloud — Estructura integral de implementación v2.0* (15-10-2026): M10, M11, RN-09 a
RN-14, RN-20, §6.2, §7.3, §8.2 y E2E-01 a E2E-07 y E2E-13. Ese documento se divide en
sub-proyectos, cada uno con su spec, su plan y su implementación:

| Sub-proyecto | Alcance | Estado |
|---|---|---|
| A. Núcleo clínico | Tratamientos, consentimiento, sesión de tratamiento y `compliance` | Implementado, sin fusionar |
| B0. Cuentas de servicio en `api-emite-facil` | Cliente de integración con scopes y `PUT /customers/{id}`. Spec propia en `backend-emite-facil` | Pendiente |
| **B1. Caja** | Perfiles fiscales, órdenes, pagos, caja por sucursal y elegibilidad (RN-10) | Este documento, plan 1 |
| **B2. Emisión** | Adaptador a `api-emite-facil`, solicitudes de factura asíncronas, webhooks, XML y RIDE; retiro de Faktur | Este documento, plan 2 |
| C. Operación | Turnos del personal y reportes | Pendiente |

## Objetivo

Que caja cobre y facture lo que se atendió, a nombre del paciente o de un tercero, sin ver datos
clínicos y sin poder facturar una atención que incumple su documentación obligatoria. La
factura electrónica la emite `api-emite-facil`, que reemplaza a Faktur; HCX no duplica lógica
fiscal.

Éxito: caja abre la caja de la sucursal, toma las sesiones atendidas de dos hermanos, elige como
receptor a la madre, registra un abono en efectivo y otro con tarjeta y pulsa «Emitir». Si una
sesión no tiene ficha o firma, el servidor responde 422 `TREATMENT_DOCUMENTATION_INCOMPLETE` con
lo que falta. Si todo está completo, la solicitud queda `REQUESTED`, emite-facil la autoriza, la
factura muestra el número de autorización, se descargan el XML y el RIDE, y las dos sesiones
quedan `BILLED`. Al cerrar la caja, el arqueo muestra lo esperado frente a lo contado.

## Decisiones tomadas

| Tema | Decisión |
|---|---|
| Autenticación ante emite-facil | Cliente de integración por empresa de emite-facil (`clientId` + secreto → JWT con scopes), que entrega B0. Nunca contraseñas de usuario |
| División del trabajo | B1 no depende de emite-facil. B0 se hace en paralelo en su repositorio. B2 se programa contra un simulador y se activa en una clínica real cuando B0 esté listo |
| Momento de la factura | Solo con saldo cero. Se admiten abonos parciales; la factura se pide con la orden pagada por completo y sus formas de pago salen de los pagos registrados |
| Ítems | Sesión de tratamiento (precio e IVA de su `TreatmentVersion`; es el único ítem al que se aplica RN-10) o concepto libre (consulta sin sesión, producto) con permiso propio |
| Pacientes por orden | Varios. Cada ítem de sesión trae su paciente; un concepto libre puede ir sin paciente |
| Faktur | Se retira en B1 (decisión del 2026-10-16: el proyecto ya no lo usa): sin cliente de Faktur ni emisión directa. Las facturas Faktur emitidas se siguen viendo como historial de solo lectura |
| Caja | A lo sumo una caja abierta por sucursal. Todo pago va a la caja abierta de la sucursal de la orden. Arqueo mínimo de efectivo al cerrar |
| Permisos | `billing.view` y `billing.create` se reusan; nuevos `cash.manage` y `billing.adjust`. Todos por defecto en MASTER y concedibles a PROFESIONAL y ASISTENTE. PROFESIONAL deja de tener `billing.*` por defecto (matriz §4) |
| Gate de cierre clínico | Nueva clave `billingGate.requireClinicalCompletion` en los requisitos de la versión del tratamiento; por defecto `true`, y las versiones existentes sin la clave se leen como `true` |
| Emisor | Se configura en la web de emite-facil (emisor, establecimientos, puntos, firma `.p12`, cliente de integración). HCX guarda la conexión y asigna un punto de emisión por sucursal. HCX nunca toca el `.p12` |
| Arquitectura de emisión | Solicitud en Postgres creada en la misma transacción que la evaluación; despachador programado con `FOR UPDATE SKIP LOCKED`; webhook firmado y reconciliador por consulta. Sin Redis |
| Anulaciones | No hay: emite-facil aún no emite notas de crédito. Una factura autorizada no se anula ni se reemplaza en B |

## B1 — Modelo de datos

Una migración aditiva, `20261016000000_cash_and_billing`. Todos los modelos nuevos llevan
`tenantId` con índice y las mismas políticas RLS que las tablas de A. El dinero es
`Decimal(10,2)`; las tarifas, `Decimal(5,2)`; las cantidades, `Decimal(12,6)`.

### Perfiles fiscales

`BillingProfile`

| Campo | Contenido |
|---|---|
| `kind` | `PERSON` o `COMPANY` |
| `idType` | Código SRI (ficha, tabla 6): `04` RUC, `05` cédula, `06` pasaporte, `07` consumidor final |
| `idNumber` | Identificación. Único `(tenantId, idType, idNumber)` |
| `legalName` | Nombre o razón social |
| `email`, `address?`, `phone?` | Contacto para el comprobante. `email` obligatorio salvo en `07` |
| `isActive` | Un perfil inactivo no se puede elegir para una orden nueva |
| `createdById`, `createdAt`, `updatedAt` | Trazas |

No tiene relación con `Encounter`, notas ni archivos, y crear un perfil nunca crea un paciente
(RN-11). No se cifra: es dato fiscal, no clínico.

Validación en el servidor: cédula de 10 dígitos con provincia 01–24 o 30, tercer dígito 0–5 y
dígito verificador módulo 10; RUC de 13 dígitos terminado en `001`: si el tercer dígito es 0–5
(persona natural), los 10 primeros deben ser una cédula válida; si es 6 o 9 (sociedad pública o
privada) solo se valida el formato, sin dígito verificador, porque un falso rechazo impediría
facturar a una empresa real y emite-facil solo valida el formato; pasaporte de 3 a 20 caracteres
alfanuméricos; `07` solo con `9999999999999` y nombre `CONSUMIDOR FINAL`, y ninguna otra
identificación puede ser `9999999999999`. Fuera de eso, `422 BILLING_PROFILE_INVALID`.

`PatientBillingProfile`: `patientId`, `billingProfileId`, `isDefault`. Único
`(patientId, billingProfileId)`; a lo sumo un `isDefault` por paciente (índice parcial).

Migración de datos: por cada paciente vivo con `billingName` y `billingTaxId`, se crea (o reusa,
si la identificación ya existe en el tenant) un `BillingProfile` y se vincula como predeterminado
si el paciente aún no tiene uno. `billingTaxIdType` se traduce `RUC → 04`, `CEDULA → 05`,
`PASSPORT → 06`; una identificación inválida para su tipo se salta y se informa. Lo hace un
script idempotente (`npm run prisma:migrate-billing-profiles`), no la migración SQL, para poder
probarlo y repetirlo: se ejecuta al desplegar B1. Con Faktur retirado en B1, la API deja de
aceptar y devolver los campos `billing*` de `Patient` y la web deja de mostrarlos; no se borran
de la base.

### Caja

`CashRegisterSession`

| Campo | Contenido |
|---|---|
| `branchId` | Sucursal |
| `status` | `OPEN` o `CLOSED`. Índice único parcial `(branchId) WHERE status = 'OPEN'` |
| `openedById`, `openedAt`, `openingCash` | Apertura, con hora del servidor |
| `closedById?`, `closedAt?` | Cierre |
| `expectedCash?`, `countedCash?`, `difference?` | Arqueo, calculado al cerrar |
| `closingNote?` | Obligatoria si `difference` ≠ 0 |

`expectedCash = openingCash + Σ pagos CASH recibidos en esta caja (cualquiera sea su estado actual) − Σ pagos CASH devueltos desde esta caja`: un pago recibido y luego devuelto cuenta en ambos lados.
El resumen por forma de pago (`GET /cash-registers/:id`) se calcula; no se guarda.

### Órdenes

`Order`

| Campo | Contenido |
|---|---|
| `branchId` | Sucursal. Define la caja de sus pagos y el punto de emisión |
| `number` | Folio por tenant, secuencial, único `(tenantId, number)` |
| `status` | `OPEN → PAID → INVOICED`; `CANCELLED` |
| `billingProfileId?` | Receptor de la factura |
| `subtotal`, `discountTotal`, `taxTotal`, `total`, `paidTotal` | Calculados por el servidor |
| `createdById`, `cancelledById?`, `cancelledAt?`, `cancellationReason?` | Trazas |
| `version` | Concurrencia optimista; cada escritura incrementa |

`OrderItem`

| Campo | Contenido |
|---|---|
| `kind` | `TREATMENT_SESSION` o `FREE` |
| `treatmentSessionId?` | Único entre ítems de órdenes no canceladas (índice parcial) |
| `patientId?` | El de la sesión; opcional en `FREE` |
| `description` | Nombre del tratamiento o texto del concepto (1–300) |
| `quantity`, `unitPrice`, `discount`, `taxRatePercent` | Copiados de la `TreatmentVersion` en sesiones (cantidad 1); libres en `FREE` |
| `lineSubtotal`, `lineTax` | Calculados |
| `createdById`, `createdAt` | Trazas |

`Payment`

| Campo | Contenido |
|---|---|
| `orderId`, `cashRegisterSessionId` | Orden y caja en que se recibió |
| `method` | `CASH`, `DEBIT_CARD`, `CREDIT_CARD`, `TRANSFER`, `OTHER` |
| `amount` | > 0 |
| `reference?` | Voucher o número de transferencia (hasta 100) |
| `status` | `RECORDED` o `REFUNDED` |
| `idempotencyKey?` | Único `(tenantId, idempotencyKey)` |
| `receivedById`, `receivedAt` | Trazas |
| `refundedById?`, `refundedAt?`, `refundReason?`, `refundCashRegisterSessionId?` | Devolución |

### Reglas

- **Cálculo** (el mismo de emite-facil, ficha v2.34 9.16 y 9.17): `lineSubtotal = round2(quantity
  × unitPrice − discount)`; el IVA de cada tarifa se calcula sobre la suma de los `lineSubtotal`
  de esa tarifa y se redondea a 2 decimales; `lineTax` reparte ese IVA solo para mostrarlo. Se
  recalcula en cada cambio de ítems. `discount` no puede superar `quantity × unitPrice`.
- Agregar o quitar ítems, cambiar descuentos y cambiar el receptor exigen la orden `OPEN`. Ítems y
  descuentos, además, exigen que no tenga pagos vivos (`409 ORDER_NOT_EDITABLE`); el receptor se
  puede cambiar con pagos.
- Un ítem de sesión exige que la sesión sea del tenant, que no esté en otra orden viva
  (`409 SESSION_ALREADY_IN_ORDER`), que su estado no sea `CANCELLED`, `NO_SHOW`,
  `CONSENT_REFUSED`, `CONSENT_REVOKED`, `BILLING_PENDING` ni `BILLED`, y que su sucursal (si
  tiene) sea la de la orden. Se puede cobrar antes de que termine la atención; la factura es lo
  que se bloquea.
- Un ítem `FREE` y cualquier descuento exigen `billing.adjust`. La tarifa de un ítem `FREE` es
  0, 5 o 15 (`422 TAX_RATE_UNSUPPORTED` en otro caso), las tarifas vigentes del catálogo de
  emite-facil.
- Un pago exige la orden `OPEN`, la caja `OPEN` de su sucursal (`409 CASH_REGISTER_CLOSED`) y
  `amount ≤ total − paidTotal` (`422 PAYMENT_EXCEEDS_BALANCE`). Con saldo cero la orden pasa a
  `PAID`. Un pago con `Idempotency-Key` repetido devuelve el mismo pago; con otro cuerpo,
  `409 IDEMPOTENCY_KEY_REUSED`.
- Devolver un pago (`billing.adjust`, motivo obligatorio) solo en una orden `OPEN` o `PAID` sin
  solicitud de factura viva (`409 PAYMENT_NOT_REFUNDABLE`). La devolución sale de la caja abierta
  de la sucursal; si la orden estaba `PAID`, vuelve a `OPEN`.
- Cancelar una orden (motivo obligatorio) exige que no tenga pagos `RECORDED`. Sus sesiones
  quedan libres para otra orden.
- No hay borrado físico de perfiles, órdenes, ítems de órdenes con pagos, pagos ni cajas. Quitar
  un ítem de una orden sin pagos sí lo borra. Todo comando escribe `AuditLog` con
  `AuditEntity` nuevos `BILLING_PROFILE`, `ORDER`, `PAYMENT`, `CASH_REGISTER` e
  `INVOICE_REQUEST` (no son entidades clínicas).

### Estados nuevos de la sesión de tratamiento

`TreatmentSessionStatus` gana `BILLING_PENDING`, `BILLED` y `BILLING_FAILED`. Solo los cambian
los eventos de facturación de B2; ningún comando del cliente los escribe (RN-21).

```
CLINICAL_COMPLETE (o cualquier estado facturable) ─solicitud─▶ BILLING_PENDING ─autorizada─▶ BILLED
                                                                    └─rechazada/fallida─▶ BILLING_FAILED ─nueva solicitud─▶ BILLING_PENDING
```

- Las transiciones a estados de facturación solo se aplican a sesiones `CLINICAL_COMPLETE` o
  `BILLING_FAILED`. Una sesión facturada antes de cerrarse (tratamiento con
  `billingGate.requireClinicalCompletion: false`) conserva su estado clínico y su flujo; al
  cerrarse pasa a `CLINICAL_COMPLETE` y, si su factura ya está autorizada, B2 la pasa a `BILLED`
  en ese momento.
- Los tres estados nuevos cuentan como terminales para el flujo clínico de A
  (`TERMINAL_SESSION_STATUSES`) y `GET /treatment-sessions/:id/compliance` responde `missing: []`
  para ellos, como para `CLINICAL_COMPLETE`.
- El cierre clínico se lee de `completedAt` (que A fija al pasar a `CLINICAL_COMPLETE`), no del
  estado: una sesión `BILLING_FAILED` sigue contando como cerrada si lo estaba, y su
  elegibilidad se evalúa con los hechos clínicos, no con su estado de facturación.
- Una sesión `BILLING_PENDING` o `BILLED` no admite cancelar, no-show ni ningún comando clínico
  (`409 TREATMENT_SESSION_BILLED`). Una `BILLING_FAILED` tampoco admite cancelar mientras siga en
  una orden viva.
- No se agregan `READY_FOR_BILLING` (la elegibilidad se calcula) ni `CLOSED` (no hay conciliación
  posterior que lo dispare en B).

## B1 — Elegibilidad (RN-10)

`evaluateBillingEligibility(order, facts)` es una función pura. Los hechos se leen dentro de una
transacción serializable con las funciones de A (`loadSessionFacts`, `parseTreatmentRequirements`);
nunca vienen del cliente.

| Código | Tipo | Se agrega cuando |
|---|---|---|
| `FINALIZED_MEDICAL_FORM` | clínico | Un ítem de sesión exige ficha y la sesión no tiene `formRecordId` vivo |
| `SIGNED_APPLICABLE_CONSENT` | clínico | La sesión exige consentimiento y no tiene documento aplicable: si se inició, el fijado al iniciar (revocarlo después no invalida la atención hecha); si no, se evalúa como en `start` a la hora actual |
| `CLINICAL_COMPLETION` | clínico | `billingGate.requireClinicalCompletion` es `true` y la sesión no tiene `completedAt` |
| `SESSION_NOT_BILLABLE` | clínico | La sesión está `CANCELLED`, `NO_SHOW`, `CONSENT_REFUSED`, `CONSENT_REVOKED`, `BILLING_PENDING` o `BILLED` |
| `BILLING_PROFILE` | caja | La orden no tiene receptor, el perfil está inactivo, o es `07` con total > 50.00 USD |
| `INVOICE_ITEMS` | caja | La orden no tiene ítems o su total es 0.00 |
| `BALANCE_DUE` | caja | `paidTotal < total` |
| `INVOICING_NOT_CONFIGURED` | caja | La clínica no tiene conexión activa con emite-facil o la sucursal no tiene punto de emisión (se evalúa desde B2; en B1 nunca aparece) |

Resultado: `{ eligible, missing: string[], items: [{ itemId, patientName, codes: string[] }] }`.
`missing` es la unión sin repetidos; `items` dice qué sesión aporta cada código clínico, con el
nombre del paciente como única información personal (RN-09).

`billingGate` se agrega a la validación de `requirements` de A como clave opcional
`{ "requireClinicalCompletion": boolean }`. El editor de versión de tratamiento la muestra como
casilla marcada por defecto.

## B1 — API

Prefijo `/api/v1/tenants/:tenantId`. Errores con el formato actual `{ statusCode, code, message }`,
más `missing` e `items` en los 422 de elegibilidad. Las listas aceptan `page` y `pageSize`.

### Perfiles fiscales

| Método y ruta | Permiso | Resultado |
|---|---|---|
| `GET /billing-profiles?q=&active=` | `billing.view` | `q` busca por nombre o prefijo de identificación |
| `POST /billing-profiles` | `billing.create` | 201; `409 BILLING_PROFILE_DUPLICATE` |
| `GET /billing-profiles/:id` | `billing.view` | |
| `PATCH /billing-profiles/:id` | `billing.create` | Nombre, contacto, activo. `idType` e `idNumber` no cambian |
| `GET /patients/:patientId/billing-profiles` | `billing.view` | Perfiles vinculados |
| `POST /patients/:patientId/billing-profiles` | `billing.create` | `{ billingProfileId, isDefault? }` |
| `DELETE /patients/:patientId/billing-profiles/:profileId` | `billing.create` | Desvincula; el perfil sigue existiendo |

### Caja

| Método y ruta | Permiso | Resultado |
|---|---|---|
| `GET /cash-registers?branchId=&status=` | `billing.view` | Cajas, recientes primero |
| `POST /cash-registers/open` | `cash.manage` | `{ branchId, openingCash }` → 201; `409 CASH_REGISTER_ALREADY_OPEN` |
| `GET /cash-registers/:id` | `billing.view` | Con resumen por forma de pago y, si está cerrada, el arqueo |
| `POST /cash-registers/:id/close` | `cash.manage` | `{ countedCash, closingNote? }`; `422 CASH_CLOSING_NOTE_REQUIRED` |

### Órdenes y pagos

| Método y ruta | Permiso | Resultado |
|---|---|---|
| `GET /treatment-sessions/billable?branchId=&patientId=` | `billing.view` | Sesiones sin orden viva y en estado facturable: paciente (nombre e identificación), tratamiento, fecha, precio y `compliant` (sin detalle) |
| `GET /orders?status=&branchId=&q=` | `billing.view` | `q` por folio, receptor o paciente |
| `POST /orders` | `billing.create` | `{ branchId?, treatmentSessionIds?, billingProfileId? }` → 201. Sin `branchId`, la sucursal de las sesiones (deben coincidir). Sin receptor, el perfil predeterminado del paciente si todas las sesiones son de uno solo |
| `GET /orders/:id` | `billing.view` | Ítems, pagos, totales y solicitudes de factura |
| `POST /orders/:id/items` | `billing.create` (`FREE` y descuento: `billing.adjust`) | `{ version, kind, treatmentSessionId? \| description, quantity, unitPrice, taxRatePercent, patientId?, discount? }` |
| `DELETE /orders/:id/items/:itemId?version=` | `billing.create` | |
| `PATCH /orders/:id/items/:itemId` | `billing.adjust` | `{ version, discount }` |
| `PUT /orders/:id/billing-profile` | `billing.create` | `{ version, billingProfileId }` |
| `POST /orders/:id/cancel` | `billing.create` | `{ version, reason }` |
| `POST /orders/:id/payments` | `billing.create` | `{ method, amount, reference? }`, `Idempotency-Key` opcional → 201 |
| `POST /payments/:id/refund` | `billing.adjust` | `{ reason }` |
| `GET /orders/:id/billing-eligibility` | `billing.view` | `{ eligible, missing, items }` |

Las escrituras de órdenes con `version` desactualizada responden `409 ORDER_VERSION_CONFLICT`.
Las lecturas de caja no se auditan como acceso clínico; los comandos sí se auditan.

### Permisos

`PERMISSION_CATALOG`:

| Clave | Grupo | Roles por defecto | Concedible a |
|---|---|---|---|
| `billing.view` | Facturación | MASTER | PROFESIONAL, ASISTENTE |
| `billing.create` | Facturación | MASTER | PROFESIONAL, ASISTENTE |
| `billing.adjust` (nuevo) | Facturación | MASTER | PROFESIONAL, ASISTENTE |
| `cash.manage` (nuevo) | Caja | MASTER | PROFESIONAL, ASISTENTE |

Quitar `billing.*` de los permisos por defecto de PROFESIONAL cambia lo que hoy ve un profesional.
Para que nadie pierda acceso al desplegar, el mismo script de despliegue
(`npm run prisma:migrate-billing-profiles`) inserta una fila `UserPermission` con
`granted: true` de `billing.view` y de `billing.create` para cada PROFESIONAL activo que no
tenga ya una fila de ese permiso (una fila `granted: false` significa que el MASTER se lo quitó, y
se respeta). El MASTER decide después.

## B2 — Integración con `api-emite-facil`

### Lo que se supone de B0

La spec de B0 lo fija en `backend-emite-facil`; B2 depende solo de esto:

1. Cliente de integración por empresa: lo crea el `OWNER`, con `clientId` y un secreto que solo se
   muestra al crearlo o rotarlo. `POST /auth/token` con `grant_type=client_credentials` devuelve un
   JWT de esa empresa (sin `X-Tenant-Id`), con expiración y scopes `customers.write`,
   `products.write`, `invoices.issue`, `documents.read`, `webhooks.manage`. Cupo de peticiones
   propio del cliente.
2. `PUT /customers/{id}` para corregir nombre, correo, dirección y teléfono de un cliente.

Lo demás ya existe en emite-facil: catálogos, `POST /customers`, `POST /products`,
`POST /invoices` con `Idempotency-Key` y `replacesDocumentId`, `GET /documents/{id}`,
`GET /documents/{id}/artifacts/{kind}` y los webhooks firmados.

### Conexión por clínica

`InvoicingConnection` (una por tenant)

| Campo | Contenido |
|---|---|
| `provider` | `EMITE_FACIL` |
| `clientId` | Del cliente de integración |
| `clientSecret` | **Cifrado** con las claves de la API |
| `externalTenantId` | Empresa de emite-facil a la que pertenece el cliente de integración (`GET /tenants/current`) |
| `taxpayerId`, `taxpayerRuc`, `environment` | Emisor elegido y su ambiente (`1` pruebas, `2` producción), leídos de emite-facil |
| `webhookSubscriptionId`, `webhookSecret` | Suscripción creada por HCX; secreto **cifrado** |
| `status` | `ACTIVE` o `DISABLED` |
| `lastCheckedAt`, `lastError?` | Última prueba |

`BranchEmissionPoint`: `branchId` (único), `establishmentCode`, `emissionPointCode` (tres
dígitos cada uno).

La URL base de emite-facil es una sola por entorno (`EMITE_FACIL_API_URL`), no por clínica.

Al guardar la conexión (`PUT /invoicing/connection`, solo MASTER), HCX obtiene un token, lista los
emisores (`GET /taxpayers`) y valida el elegido, y crea su suscripción
(`POST /webhooks/subscriptions` con la URL pública de HCX y los eventos `document.authorized` y
`document.rejected`). Si la suscripción falla (p. ej. `409 WEBHOOKS_DISABLED`), la conexión queda
activa igual y el reconciliador es la vía de estado. `GET /invoicing/connection` nunca devuelve
secretos.

### Puerto y adaptador

`InvoicingProvider` (interfaz):
`listTaxpayers`, `listEstablishments`, `listEmissionPoints`, `listTaxRates`,
`upsertCustomer(profile)`, `ensureProduct(sku, name, unitPrice, ivaRateCode)`,
`createInvoice(request, idempotencyKey)`, `getDocument(id)`, `getArtifact(id, kind)`,
`subscribeWebhook(url, events)`.

`EmiteFacilProvider` lo implementa con `fetch`:

- Token por conexión cacheado en memoria hasta 60 s antes de su expiración. Un `401` renueva una
  vez y reintenta; un segundo `401` es error de configuración.
- `X-Correlation-ID` = id de la solicitud de factura, para cruzar logs.
- Errores clasificados: **transitorio** (red, timeout de 15 s, 5xx, 429 con `Retry-After`,
  `409` de idempotencia en vuelo), **datos** (`422` con su `errorCode`, `409 IDEMPOTENCY_KEY_REUSED`)
  y **configuración** (`401` persistente, `403`, `404` de emisor, establecimiento o punto,
  `EMISSION_POINT_DISABLED`).

### Sincronización

`InvoicingRef`: `connectionId`, `kind` (`CUSTOMER` o `PRODUCT`), `localId`, `externalId`,
`syncedHash` (hash de lo enviado). Único `(connectionId, kind, localId)`.

- Perfil fiscal → cliente. Sin referencia: `POST /customers`; si responde
  `409 CUSTOMER_ALREADY_EXISTS`, se busca con `GET /customers?q=<idNumber>`, se toma el de igual
  tipo y número y se enlaza. Con referencia y `syncedHash` distinto: `PUT /customers/{id}`.
- `TreatmentVersion` → producto. `sku` = id de la versión (25 caracteres), `name` = nombre del
  tratamiento, `unitPrice` = precio de la versión, `ivaRateCode` = el código de la tarifa con ese
  porcentaje en `GET /catalogs/tax-rates` (cacheado por conexión durante 1 h). La versión es
  inmutable: el producto nunca se actualiza. Si `POST /products` responde `409 PRODUCT_SKU_TAKEN`,
  se busca por `q=<sku>` y se enlaza.
- Ítem `FREE` → producto con `sku` = id del ítem y `name` = su descripción.
- La línea del comprobante lleva `productId`, `quantity`, `unitPrice` y `discount` del ítem.
- Formas de pago (ficha, tabla 24): `CASH → 01`, `DEBIT_CARD → 16`, `CREDIT_CARD → 19`,
  `TRANSFER → 20`, `OTHER → 20`. Los pagos `RECORDED` de la orden se agrupan por código; su suma
  es el total porque la orden está pagada.
- RN-20: el payload solo lleva receptor, nombres de tratamiento o concepto, importes y formas de
  pago. Nunca diagnósticos, notas, respuestas de ficha, fotos ni el nombre del paciente atendido.

### Solicitud de factura

`InvoiceRequest`

| Campo | Contenido |
|---|---|
| `orderId`, `connectionId`, `billingProfileId` | Vínculos |
| `status` | `REQUESTED`, `PROCESSING`, `AUTHORIZED`, `REJECTED`, `FAILED` |
| `clientIdempotencyKey` | La `Idempotency-Key` de caja; único `(tenantId, clientIdempotencyKey)` |
| `providerIdempotencyKey` | `hcx-<id>`; no cambia nunca |
| `snapshot` | JSON con receptor, establecimiento, punto, líneas y pagos tal como se enviaron |
| `replacesInvoiceRequestId?` | Solicitud `REJECTED` a la que reemplaza |
| `externalDocumentId?`, `externalState?` | Documento de emite-facil y su último estado literal |
| `number?`, `accessKey?`, `authorizationNumber?`, `authorizedAt?` | Datos del comprobante autorizado |
| `xmlStorageKey?`, `xmlSha256?`, `rideStorageKey?`, `rideSha256?` | Copias locales cifradas en el storage de archivos |
| `attempts`, `nextAttemptAt`, `lastError?` | Despacho |
| `requestedById`, `requestedAt`, `finishedAt?` | Trazas |

Índice único parcial: a lo sumo una solicitud `REQUESTED` o `PROCESSING` por orden.

`InvoiceRequestEvent`: `invoiceRequestId`, `type` (`REQUESTED`, `DISPATCHED`, `RETRY_SCHEDULED`,
`PROVIDER_STATE`, `AUTHORIZED`, `REJECTED`, `FAILED`, `ARTIFACT_STORED`), `source` (`API`,
`DISPATCHER`, `WEBHOOK`, `RECONCILER`), `detail` (JSON sin datos personales: estado, código y
mensaje del proveedor), `webhookEventId?` (único cuando existe), `createdAt`. Solo inserción.

Estados:

```
REQUESTED ─despachador─▶ PROCESSING ─webhook / reconciliador─▶ AUTHORIZED
    │                         └─ RETURNED · NOT_AUTHORIZED · XSD_INVALID · SIGNATURE_FAILED ─▶ REJECTED
    └─ error de datos o de configuración, o 24 h de transitorios ─▶ FAILED
```

Traducción de estados de emite-facil: `RESERVED`, `GENERATED`, `SIGNED`, `SENDING`, `RECEIVED` →
`PROCESSING`; `AUTHORIZED` → `AUTHORIZED`; `RETURNED`, `NOT_AUTHORIZED`, `XSD_INVALID`,
`SIGNATURE_FAILED` → `REJECTED`. Un estado desconocido deja la solicitud en `PROCESSING` y
escribe un evento.

### Flujo

1. **Caja pide la factura.** `POST /orders/:id/invoice-requests` (`billing.create`,
   `Idempotency-Key` obligatoria). En una transacción serializable: si la clave ya existe con la
   misma orden, devuelve esa solicitud; con otra orden, `409 IDEMPOTENCY_KEY_REUSED`. Si no,
   evalúa la elegibilidad (con `INVOICING_NOT_CONFIGURED`), aplica el límite mensual del plan
   (`monthlyElectronicInvoicesLimit`, contando las solicitudes del mes en `REQUESTED`,
   `PROCESSING` o `AUTHORIZED`; una rechazada y su reemplazo cuentan una vez), arma el
   `snapshot`, crea la solicitud `REQUESTED`, pasa la orden a `INVOICED` y sus sesiones a
   `BILLING_PENDING`. Responde 202 con la solicitud. El HTTP no llama a emite-facil.
2. **Despachador** (cada 10 s, `@nestjs/schedule`): toma hasta 10 solicitudes `REQUESTED` con
   `nextAttemptAt ≤ ahora` con `FOR UPDATE SKIP LOCKED`; sincroniza cliente y productos y llama a
   `POST /invoices` con `providerIdempotencyKey`. Éxito: guarda `externalDocumentId`, pasa a
   `PROCESSING`. Transitorio: `attempts + 1` y `nextAttemptAt` con espera exponencial (30 s,
   1 min, 2 min… hasta 30 min) o `Retry-After`; tras 24 h desde `requestedAt`, `FAILED`. Datos o
   configuración: `FAILED` con el código y mensaje del proveedor.
3. **Webhook** `POST /integrations/emite-facil/webhook/:connectionId` (público, sin JWT):
   verifica `webhook-signature` (`v1,` + HMAC-SHA256 de `webhook-id.webhook-timestamp.cuerpo`,
   acepta cualquiera de las firmas enviadas) con el secreto de la conexión y rechaza un
   `webhook-timestamp` a más de 5 minutos (`401` sin detalle). Si `webhook-id` ya está en
   `InvoiceRequestEvent`, responde 204 sin hacer nada. El `tenantId` del cuerpo debe ser el
   `externalTenantId` de la conexión. Busca la solicitud por `externalDocumentId` dentro del
   tenant de la conexión; si no hay ninguna (p. ej. `webhook.test`), registra el aviso en el log y
   responde 204.
   Aplica el estado solo si avanza (`PROCESSING → AUTHORIZED | REJECTED`); un aviso que haría
   retroceder o repetir un estado final solo escribe el evento. Responde 204 antes de descargar
   artefactos.
4. **Reconciliador** (cada minuto): consulta `GET /documents/{id}` de las solicitudes
   `PROCESSING` sin evento en los últimos 2 minutos (hasta 50 por vuelta, las más antiguas primero)
   y aplica el estado con la misma regla. También reintenta descargar artefactos pendientes.
5. **Al autorizar**: guarda número, clave de acceso, autorización y `authorizedAt`; las sesiones
   pasan a `BILLED`. Luego descarga `xml-authorized` y `ride`, verifica su SHA-256 con el `ETag`,
   los guarda cifrados y escribe `ARTIFACT_STORED`. Un fallo de descarga no cambia el estado: lo
   reintenta el reconciliador.
6. **Al rechazar o fallar**: las sesiones pasan a `BILLING_FAILED` y la orden vuelve a `PAID`; los
   pagos no se tocan (E2E-13). Caja corrige lo necesario (p. ej. el perfil) y pide otra factura.
   Si la última solicitud de la orden está `REJECTED` con `externalDocumentId`, la nueva lleva
   `replacesInvoiceRequestId` y se envía con `replacesDocumentId`. Una `FAILED` sin documento en
   emite-facil se reemplaza sin ese campo.

Una factura `AUTHORIZED` no se anula ni se reemplaza en B: emite-facil no emite notas de crédito.
La pantalla lo dice.

### API de B2

| Método y ruta | Permiso | Resultado |
|---|---|---|
| `GET /invoicing/connection` | MASTER | Conexión sin secretos, puntos por sucursal y estado del webhook |
| `PUT /invoicing/connection` | MASTER | `{ clientId, clientSecret?, taxpayerId }`; prueba y guarda |
| `GET /invoicing/options` | MASTER | Emisores, establecimientos y puntos leídos de emite-facil |
| `PUT /branches/:branchId/emission-point` | MASTER | `{ establishmentCode, emissionPointCode }` |
| `POST /orders/:id/invoice-requests` | `billing.create` | 202; `Idempotency-Key` obligatoria |
| `GET /invoice-requests?status=&branchId=` | `billing.view` | Para la pestaña de facturas y los pendientes o fallidos |
| `GET /invoice-requests/:id` | `billing.view` | Con eventos |
| `GET /invoice-requests/:id/xml`, `GET /invoice-requests/:id/ride` | `billing.view` | Copia local; `404 INVOICE_ARTIFACT_NOT_READY`; descarga auditada |
| `POST /integrations/emite-facil/webhook/:connectionId` | firma | 204 |

### Retiro de Faktur (en B1)

Decidido el 2026-10-16: el proyecto ya no usa Faktur, así que se retira en B1 sin esperar a B2.
Se eliminan `FakturClient`, `POST /billing/invoices`, la configuración de Faktur en los ajustes
de la clínica (`fakturApiKey`, `fakturEstablishment`… sobre `BillingSettings`) y las variables
`FAKTUR_*`; `GET /billing/invoices` y `GET /billing/invoices/:id` quedan como historial de solo
lectura (`billing.view`). `BillingSettings` e `Invoice` no se borran de la base. Entre el
despliegue de B1 y el de B2, HCX no emite comprobantes electrónicos. El límite mensual del plan
pasa a contar `InvoiceRequest` en B2.

### Ajustes pendientes para B2 (emite-facil cambió después de esta spec)

`api-emite-facil` publicó en `dev` (2026-10-16, rama `p11-api-keys`) su autenticación para otros
sistemas, distinta de lo supuesto en «Lo que se supone de B0». Antes de planificar B2 hay que
revisar esta sección con estos hechos:

- Es una **API key estática** en `X-Api-Key: efk_<publicId>_<secreto>`, creada por un `OWNER` o
  `ADMIN` en emite-facil, sin caducidad y con rol `BILLER` (crea clientes, productos y facturas,
  consulta comprobantes, descarga XML y RIDE, lee emisores, establecimientos y puntos). No hay
  canje de token ni scopes.
- Una API key **no gestiona webhooks** (`403 ROLE_FORBIDDEN`): HCX no puede crear su suscripción;
  la crea el `OWNER` en emite-facil y pega su secreto `whsec_` en HCX, o B2 depende solo del
  reconciliador.
- Sigue sin existir **`PUT /customers/{id}`**: un perfil fiscal editado no se puede actualizar en
  emite-facil.

## Web

### Caja (`/cash`, escritorio y tablet)

Visible con `billing.view`; `cash.manage` agrega abrir y cerrar; nuevo submódulo «Caja» en el sidebar.

- Cabecera: selector de sucursal, estado de la caja y Abrir o Cerrar (`cash.manage`). Cerrar abre
  el arqueo: contado, esperado, diferencia, nota obligatoria si no cuadra y resumen por forma de
  pago.
- Pestaña «Por cobrar»: `treatment-sessions/billable` de la sucursal con paciente, tratamiento,
  fecha, precio e insignia «Completa» o «Falta documentación». Seleccionar una o varias y
  «Cobrar» crea la orden.
- Pestaña «Órdenes»: abiertas, pagadas y facturadas, con folio, receptor, total y saldo.
- Pestaña «Facturas» (B2): solicitudes con estado SRI, número y descarga; filtro de pendientes y
  fallidas.

### Orden (`/cash/orders/[id]`)

1. **Quién paga.** Paciente (sus perfiles vinculados), otro particular o empresa. Buscador de
   perfiles por nombre o identificación y alta rápida en un diálogo (validación de cédula y RUC en
   el cliente; la decisión es del servidor), con opción de vincular el perfil al paciente.
2. **Ítems.** Sesiones con su paciente (solo nombre); «Agregar sesión» desde las por cobrar;
   concepto libre y descuento por línea con `billing.adjust`. Totales del servidor.
3. **Pagos.** Registrar pago (forma, monto prellenado con el saldo, referencia); lista con
   devolución (`billing.adjust`, motivo); saldo.
4. **Checklist de emisión** desde `billing-eligibility`, con textos sin datos clínicos: «Falta la
   ficha de {paciente}», «Falta el consentimiento firmado de {paciente}», «La atención de
   {paciente} no está cerrada», «Elige quién recibe la factura», «Saldo pendiente: $12.00»,
   «Configura la facturación electrónica de la sucursal».
5. **Emitir** (B2): habilitado cuando `eligible`. Genera una `Idempotency-Key` por intento y la
   reusa si reintenta tras un fallo de red. Un 422 se muestra con su `missing`. La tarjeta de
   estado (Solicitada, En proceso, Autorizada, Rechazada con el mensaje del SRI, Fallida) se
   refresca cada 5 s mientras no sea final. Autorizada: número, autorización, descargar XML y
   RIDE. Rechazada o fallida: «Corregir y emitir de nuevo».

### Otras pantallas

- `/admin/billing`: conexión con emite-facil (`clientId`, secreto, emisor detectado, ambiente,
  probar), punto de emisión por sucursal y estado del webhook. Debajo, las facturas Faktur en
  solo lectura. Reemplaza la configuración de Faktur.
- Ficha del paciente: la sección de facturación muestra los perfiles vinculados (sustituye al
  formulario `billing*`) y sus órdenes y facturas; el botón «Facturar» lleva a caja.
- Atención (`/treatment-sessions/[id]`): insignia de `BILLING_PENDING`, `BILLED` o
  `BILLING_FAILED`.
- Editor de versión de tratamiento: casilla «Exigir cierre clínico para facturar» (`billingGate`).

Ninguna acción se muestra como hecha hasta que responde el servidor (E2E-15).

## Manejo de errores

| Código | HTTP | Cuándo |
|---|---|---|
| `TREATMENT_DOCUMENTATION_INCOMPLETE` | 422 | Pedir factura con algún código clínico en `missing`; lleva `missing` e `items` |
| `ORDER_NOT_BILLABLE` | 422 | Pedir factura con solo códigos de caja en `missing` |
| `BILLING_PROFILE_NOT_FOUND`, `ORDER_NOT_FOUND`, `PAYMENT_NOT_FOUND`, `CASH_REGISTER_NOT_FOUND`, `INVOICE_REQUEST_NOT_FOUND` | 404 | No existe en el tenant (otro tenant responde igual) |
| `BILLING_PROFILE_DUPLICATE` | 409 | Misma identificación en el tenant |
| `BILLING_PROFILE_INVALID` | 422 | Identificación inválida para su tipo |
| `CASH_REGISTER_ALREADY_OPEN` | 409 | Abrir con otra caja abierta en la sucursal |
| `CASH_REGISTER_CLOSED` | 409 | Pagar o devolver sin caja abierta; cerrar una caja cerrada |
| `CASH_CLOSING_NOTE_REQUIRED` | 422 | Arqueo con diferencia y sin nota |
| `ORDER_NOT_EDITABLE` | 409 | Cambiar ítems o descuentos con pagos vivos o fuera de `OPEN` |
| `ORDER_VERSION_CONFLICT` | 409 | `version` desactualizada |
| `ORDER_HAS_PAYMENTS` | 409 | Cancelar con pagos `RECORDED` |
| `SESSION_ALREADY_IN_ORDER` | 409 | La sesión está en otra orden viva |
| `TREATMENT_SESSION_NOT_BILLABLE` | 409 | Agregar a una orden una sesión en estado no facturable o de otra sucursal |
| `PAYMENT_EXCEEDS_BALANCE` | 422 | Pago mayor que el saldo |
| `TAX_RATE_UNSUPPORTED` | 422 | Concepto libre con tarifa distinta de 0, 5 o 15 |
| `ORDER_LINE_INVALID` | 422 | Cantidad ≤ 0, precio o descuento negativo, o descuento mayor que el bruto de la línea |
| `ORDER_BRANCH_MISMATCH` | 422 | Crear una orden con sesiones de sucursales distintas |
| `BILLING_PROFILE_INACTIVE` | 409 | Asignar o vincular un perfil inactivo |
| `IDEMPOTENCY_KEY_INVALID` | 400 | `Idempotency-Key` de más de 100 caracteres o con caracteres fuera de `[A-Za-z0-9._:-]` |
| `PAYMENT_NOT_REFUNDABLE` | 409 | Devolver con una solicitud de factura viva o ya devuelto |
| `IDEMPOTENCY_KEY_REQUIRED` | 400 | Pedir factura sin `Idempotency-Key` |
| `IDEMPOTENCY_KEY_REUSED` | 409 | Misma clave con otro cuerpo u otra orden |
| `INVOICE_REQUEST_IN_PROGRESS` | 409 | Ya hay una solicitud `REQUESTED` o `PROCESSING` para la orden |
| `INVOICE_LIMIT_REACHED` | 409 | Límite mensual del plan |
| `INVOICING_CONNECTION_INVALID` | 422 | Credenciales o emisor rechazados al guardar la conexión |
| `TREATMENT_SESSION_BILLED` | 409 | Comando clínico sobre una sesión `BILLING_PENDING` o `BILLED` |
| `INVOICE_ARTIFACT_NOT_READY` | 404 | XML o RIDE antes de tenerlos |
| (sin código) | 401 | Webhook con firma inválida o vencida; el detalle solo va al log |

## Pruebas

Unitarias (Jest):

- `evaluateBillingEligibility`: cada código, sesiones de dos pacientes, consentimiento revocado
  antes y después del inicio, `billingGate` ausente y `false`, sesión `BILLING_FAILED`.
- Cálculo de totales con descuentos y dos tarifas, contra los ejemplos de la doc de emite-facil.
- Arqueo y resumen por forma de pago.
- Validación de cédula, RUC (natural, privada, pública), pasaporte y consumidor final.
- Mapeo de formas de pago y de tarifas; agrupación de pagos.
- Traducción de estados de emite-facil y regla de «solo avanza».
- Verificación de firma del webhook con el vector de la doc de emite-facil, dos firmas tras rotar
  y aviso vencido.
- Despachador con un proveedor falso: éxito, transitorio con espera, 429 con `Retry-After`, datos,
  configuración y tope de 24 h.
- Transiciones de sesión con los estados nuevos y `TREATMENT_SESSION_BILLED`.

e2e (Postgres, `test/cash-and-billing.e2e-spec.ts`), con un simulador de emite-facil en proceso
(servidor HTTP local que implementa las rutas usadas, guarda los payloads y firma webhooks). El
despachador y el reconciliador se invocan explícitamente en la prueba, nunca por temporizador:

- E2E-01: sesión completa → orden → dos pagos → solicitud → despacho → webhook autorizado; XML y
  RIDE descargables con hash correcto; sesión `BILLED`.
- E2E-02: sin ficha → 422 `TREATMENT_DOCUMENTATION_INCOMPLETE` con `FINALIZED_MEDICAL_FORM`.
- E2E-03: con ficha y sin firma → 422 con `SIGNED_APPLICABLE_CONSENT`.
- E2E-04: factura a una empresa; el expediente del paciente no cambia y el simulador afirma que el
  payload no lleva el nombre del paciente ni datos clínicos.
- E2E-06: dos solicitudes con la misma clave y dos despachos de la misma solicitud → una solicitud
  y un comprobante en el simulador.
- E2E-07: webhook repetido, `rejected` después de `authorized` y firma inválida → estado intacto.
- E2E-13: simulador caído → reintento programado; luego rechazo → `BILLING_FAILED`, pagos intactos;
  nueva solicitud con `replacesDocumentId` → autorizada.
- Caja: pagar sin caja → 409; cerrar con diferencia sin nota → 422; con nota → arqueo correcto.
- Tenants: un usuario de otro tenant recibe 404 en orden, perfil, caja y solicitud, y un webhook
  firmado con el secreto de otra conexión no toca la solicitud.
- Permisos: un ASISTENTE sin `billing.adjust` no agrega conceptos libres ni descuentos.
- Migración de perfiles: un paciente con `billing*` termina con su perfil predeterminado.

Web (Vitest): checklist por código; Emitir deshabilitado y 422 mostrado tal cual; refresco del
estado hasta un final; un fallo de red no marca la factura como emitida; el arqueo con diferencia
pide nota; alta rápida de perfil valida la cédula.

Contra emite-facil real: prueba manual documentada contra su pila local con el SRI simulado,
cuando B0 esté listo. No forma parte del CI de HCX.

## Fuera de alcance

- Notas de crédito, anulación y corrección de facturas autorizadas.
- Facturas con saldo pendiente, cuentas por cobrar y crédito.
- Anticipos aplicados a sesiones, paquetes y planes multisesión.
- Conciliación bancaria de tarjetas y transferencias.
- Envío de la factura por correo desde HCX (emite-facil ya lo hace).
- Convenios, seguros y copagos.
- Configurar emisor, establecimientos, puntos o firma desde HCX.
- Turnos y reportes (sub-proyecto C).

## Entrega

- Rama `feat/cash-and-billing` en `hcx-care-api` y en el cliente web, creada desde
  `claude/compassionate-hopper-t6teqf`. Si A se fusiona antes, se rebasa sobre `dev`.
- Plan B1: modelo, perfiles y su migración, caja, órdenes, pagos, elegibilidad, permisos,
  `billingGate`, pantalla de caja sin Emitir. Plan B2: conexión, adaptador, sincronización,
  solicitudes, despachador, webhook, reconciliador, artefactos, Emitir en la web y retiro de
  Faktur.
- Spec B0 aparte en `backend-emite-facil`.
- La API pasa pruebas unitarias, e2e y build, y `prettier --check` en los archivos tocados (el lint
  está roto por T-15). La web pasa lint, type-check y Vitest.
