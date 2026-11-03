# Facturador electrónico propio (emisión directa al SRI)

Fecha: 2026-11-02. Reemplaza la integración con Emite Fácil de
`2026-10-15-cash-and-billing-design.md` (parte B2) y `2026-10-17-emite-facil-b2-contract.md`.

## Contexto y objetivo

Hoy HCX no habla con el SRI: delega en Emite Fácil (`D:/Proyectos Personales/backend-emite-facil`,
Java) mediante una API key por clínica. Emite Fácil genera el XML, firma con el `.p12`, envía al SRI
y arma el RIDE; HCX mantiene la cola `InvoiceRequest`, webhooks, sincronización de clientes y
productos (`InvoicingRef`) y la custodia cifrada del XML y el RIDE.

Objetivo: HCX emite **directamente** al SRI (esquema offline) sin ningún servicio intermedio. Cada
clínica es su propio emisor, con su RUC y su firma `.p12`, configurados por el rol MASTER.

**Éxito:** desde Caja, una orden pagada produce una factura autorizada por el SRI (ambiente de
pruebas y producción), con XML autorizado y RIDE descargables y enviados por correo al cliente, sin
depender de Emite Fácil.

## Decisiones tomadas

| Tema | Decisión |
|---|---|
| Datos previos | No hay facturas reales emitidas con Emite Fácil. Reemplazo limpio, sin migrar datos |
| Comprobantes | Solo factura (`01`, XSD 1.1.0) y reemisión de una rechazada. Nota de crédito y retenciones quedan fuera |
| Ejecución | Intento inline al solicitar la factura + endpoint de tick llamado cada minuto por un programador externo (Supabase `pg_cron` + `pg_net`). `@Cron` interno solo con `INVOICING_INTERNAL_SCHEDULER=true` |
| Correo | Envío automático del XML autorizado y el RIDE al email del cliente, con reintentos |
| Enfoque | Portar a TypeScript la lógica de Emite Fácil (XML, clave de acceso, XAdES-BES, SOAP, RIDE) dentro de `api/src/invoicing/` |

## Fuera de alcance

Nota de crédito, retenciones, guías de remisión, logo en el RIDE, reenvío manual de correo, emisión
en contingencia (tipo de emisión 2), facturas con XSD 2.x, migración de datos de Emite Fácil.

## Arquitectura

Todo en `api/src/invoicing/`. Las piezas de `sri/` son funciones puras o clientes sin estado, sin
Prisma ni Nest, probables por separado.

| Unidad | Responsabilidad | Depende de |
|---|---|---|
| `sri/access-key.ts` | Clave de acceso de 49 dígitos: `ddmmaaaa` + tipo `01` + RUC + ambiente + establecimiento + punto + secuencial (9) + código numérico (8) + tipo de emisión `1` + dígito verificador módulo 11 | nada |
| `sri/tax-catalog.ts` | Códigos SRI de IVA (impuesto `2`) por tarifa: 0 %, 5 %, 12 %, 13 %, 14 %, 15 %, no objeto, exento. Fuente: `backend-emite-facil/src/main/resources/db/migration/V3__catalogs_billing.sql` | nada |
| `sri/invoice-xml.ts` | XML de factura 1.1.0 (`infoTributaria`, `infoFactura` con `totalConImpuestos` y `pagos`, `detalles`, `infoAdicional` con email y teléfono) desde el snapshot y los datos del emisor. Raíz `<factura id="comprobante" version="1.1.0">`. Escape XML, decimales con punto y 2 dígitos (cantidad y precio unitario hasta 6). Cálculo igual al actual (ficha v2.34, 9.16 y 9.17). Port de `InvoiceXmlBuilder.java` y `XmlWriter.java` | `tax-catalog` |
| `sri/certificate.ts` | Abre el `.p12` con su contraseña, extrae clave privada RSA y certificado, valida vigencia y que el RUC del certificado (extensión o sujeto) coincida con el emisor | `node-forge` |
| `sri/xades-signer.ts` | Firma XAdES-BES según Anexo 14, port de `XadesBesSigner.java`: C14N inclusiva, RSA-SHA1, digests SHA-1, tres referencias (SignedProperties con su `Type`, KeyInfo, comprobante con transform enveloped), `SigningTime` en hora de Ecuador, `SigningCertificate`, `DataObjectFormat` (`text/xml`), `KeyInfo` con `X509Data` y `RSAKeyValue`, `SignatureValue` en una línea | `node-forge`, `@xmldom/xmldom`, `xml-crypto` (solo canonicalización) |
| `sri/xades-verifier.ts` | Verificador para pruebas y para comprobar la firma antes de guardarla. Port de `XadesVerifier.java` | igual |
| `sri/sri-client.ts` | SOAP `validarComprobante` (recepción, XML en base64) y `autorizacionComprobante` (por clave de acceso). URLs oficiales de `celcer.sri.gob.ec` (ambiente 1) y `cel.sri.gob.ec` (ambiente 2), solo esos hosts. Timeout 15 s. Port de `HttpSriGateway.java`, `SriSoapRequests.java` y `SriResponseParser.java` | `fetch`, `@xmldom/xmldom` |
| `sri/ride.ts` | RIDE PDF. Port de `delivery/RideLayout.java` | `pdfkit`, `bwip-js` |
| `issuer.service.ts` | Configuración del emisor, certificado, puntos de emisión y secuenciales. Reemplaza a `connection.service.ts` | Prisma, `ClinicalCryptoService`, `sri/certificate` |
| `invoice-emitter.ts` | Ejecuta los pasos de una emisión sobre una fila con lease (ver Flujo). Reemplaza a `invoice-resolver.ts` y al adaptador | `sri/*`, Prisma, storage |
| `invoice-delivery.service.ts` | Envío del correo con XML y RIDE adjuntos | `MailService`, storage |
| `invoice-worker.service.ts` | Se mantiene: claim con `FOR UPDATE SKIP LOCKED`, leases de 120 s, CAS y backoff. Delega cada fila en `invoice-emitter`. Expone `processOne(id, budgetMs)` y `tick(budgetMs)` | emitter, delivery |
| `invoicing-tick.controller.ts` | `POST /internal/invoicing/tick` | worker |

**Se elimina:** `provider/emite-facil.provider.ts` (+ spec), `provider/invoicing-provider.ts`,
`provider/webhook-signature.ts` (+ spec), `invoice-webhook.service.ts`, `invoice-resolver.ts`
(+ spec), `connection.service.ts` (+ spec), `InvoicingWebhookController`, la variable
`EMITE_FACIL_API_URL` y los códigos de error exclusivos del proveedor en `invoice-errors.ts`.

**Se conserva:** `invoice-requests.service.ts` (creación desde la orden, idempotencia del cliente,
límite mensual, reglas de bloqueo y cadena de reemplazo), `invoice-snapshot.ts`, `invoice-view.ts`,
`invoice-state.ts` (adaptado a las etapas SRI) y `invoice-artifacts.service.ts` (lectura y custodia
cifrada; la recolección pasa al emisor).

**Dependencias nuevas:** `node-forge`, `@xmldom/xmldom`, `xml-crypto`, `bwip-js`. Dev:
`xmllint-wasm`. Todas JS puro, sin binarios nativos, compatibles con el empaquetado de Vercel.

## Modelo de datos

Dos migraciones, para que el código compile en cada paso: una aditiva crea lo siguiente junto a lo
viejo, y otra elimina `InvoicingConnection`, `InvoicingRef` y los campos del proveedor. La de
borrado elimina las `InvoiceRequest` y `InvoiceRequestEvent` de Emite Fácil (solo de prueba) y
devuelve sus órdenes a `PAID` y sus sesiones facturadas a `BILLING_FAILED`, porque la base de
producción es la misma que usan las demos.

### `InvoicingIssuer` (una por tenant)

| Campo | Tipo | Nota |
|---|---|---|
| `id`, `tenantId` (único) | | |
| `ruc` | String | 13 dígitos, validado (módulo 10/11 según tipo, terminación `001`) |
| `legalName`, `tradeName?`, `headOfficeAddress` | String | |
| `accountingRequired` | Boolean | `obligadoContabilidad` SI/NO |
| `specialTaxpayerCode?`, `withholdingAgentCode?` | String | `contribuyenteEspecial`, `agenteRetencion` |
| `rimpeRegime` | enum `NONE`/`EMPRENDEDOR`/`NEGOCIO_POPULAR` | leyenda RIMPE en `infoTributaria` y RIDE |
| `environment` | String `'1'`/`'2'` | |
| `active` | Boolean | |
| `certificateEncrypted?` | String | bytes del `.p12` cifrados con `ClinicalCryptoService.encryptBuffer` del tenant, en base64 |
| `certificatePasswordEncrypted?` | String | |
| `certificateSubject?`, `certificateSerial?`, `certificateValidTo?`, `certificateSha256?` | | metadatos visibles; nunca el archivo ni la contraseña |
| `revision` | Int | CAS de configuración, como hoy |
| `createdAt`, `updatedAt` | | |

### `BranchEmissionPoint` (se conserva, ahora local)

`branchId` (único), `issuerId`, `establishmentCode` (3 dígitos), `emissionPointCode` (3 dígitos),
`establishmentAddress`. Único `(issuerId, establishmentCode, emissionPointCode)`: una serie
pertenece a una sola sucursal.

### `InvoiceSequence` (nueva)

`issuerId`, `establishmentCode`, `emissionPointCode`, `environment`, `next` (Int, empieza en 1).
Único por las cuatro primeras. El MASTER puede fijar el siguiente secuencial de un punto en el
ambiente actual, solo hacia arriba, por si la clínica ya facturaba con otro sistema. La reserva es
`UPDATE "InvoiceSequence" SET next = next + 1 ... RETURNING next - 1` dentro de la transacción del
paso de firma. Los huecos (por solicitudes rechazadas) son aceptables.

### `InvoiceRequest` (ajustes)

- `connectionId` pasa a `issuerId`.
- Fuera: `externalDocumentId`, `providerIdempotencyKey`, `providerBodyEncrypted`,
  `providerBodyHash`, `requiresReconciliation`.
- Nuevos: `sequential` (String de 9 dígitos), `signedXmlStorageKey`, `signedXmlSha256`,
  `emailedAt?`, `emailAttempts` (Int, 0).
- `accessKey` pasa a único por `(issuerId, accessKey)`.
- `externalState` guarda la etapa SRI: `SIGNED`, `RECEIVED`, `AUTHORIZED`, `RETURNED`,
  `NOT_AUTHORIZED`.
- `blockingInvoiceWhere` queda en `status in (REQUESTED, PROCESSING, AUTHORIZED)`: una solicitud
  firmada siempre está en `PROCESSING` hasta que el SRI responde, así que ya no hace falta
  `requiresReconciliation`.

`InvoiceRequestEvent`: se quitan `webhookEventId` y su índice único; `connectionId` pasa a
`issuerId`. Tipos de evento: `SIGNED`, `RECEIVED`, `AUTHORIZED`, `REJECTED`, `FAILED`,
`RETRY_SCHEDULED`, `ARTIFACT_STORED`, `EMAILED`, `EMAIL_FAILED`, `EMAIL_SKIPPED` (cliente sin email).

El `FiscalSnapshot` reemplaza `taxpayerId` por `issuerId` y añade los datos del emisor congelados al
solicitar (RUC, razón social, nombre comercial, direcciones, contabilidad, contribuyente especial,
RIMPE). El XML siempre sale del snapshot, nunca de la configuración viva.

## Flujo de emisión

### Disparo

1. `POST tenants/:t/orders/:id/invoice-requests` crea la solicitud `REQUESTED` como hoy (cambia
   `INVOICING_NOT_CONFIGURED`: exige emisor activo con certificado y punto en la sucursal) y confirma.
   Después, en la misma petición, `worker.processOne(id, 15000)` la reclama con lease y avanza los
   pasos hasta agotar el presupuesto. La respuesta trae el estado alcanzado. Si el claim falla
   porque otro proceso tiene el lease, responde el estado actual sin error.
2. `POST /internal/invoicing/tick` (sin JWT, fuera de los guards de tenant): exige
   `Authorization: Bearer <INVOICING_TICK_SECRET>` comparado con `timingSafeEqual`; sin la variable
   configurada responde 404. Ejecuta `worker.tick(45000)`: claims por lotes de lo pendiente
   (`REQUESTED`, `PROCESSING`, `AUTHORIZED` sin artefactos y correos pendientes) con
   `nextAttemptAt <= now`. Throttle propio de 6/min.
3. `@Cron` cada 10 s solo si `INVOICING_INTERNAL_SCHEDULER=true` y `NODE_ENV !== 'test'`, para
   desarrollo y servidores persistentes.

### Pasos (cada uno persiste su resultado y se puede retomar)

| Paso | Qué hace | Resultado |
|---|---|---|
| a. Preflight | Emisor activo, certificado presente, vigente y que abre, punto de la sucursal existe, ambiente del snapshot igual al del emisor | Falla: `FAILED` (configuración), orden liberada como hoy. Nada firmado |
| b. Firma | En una transacción con lease: reservar secuencial, construir clave de acceso y XML desde el snapshot, firmar, verificar la firma recién hecha, guardar el XML firmado cifrado en storage y fijar `sequential`, `accessKey`, `signedXmlStorageKey`, `signedXmlSha256` y `externalState=SIGNED` | `PROCESSING`. Si la transacción no confirma, se borra el archivo y el secuencial no se consume |
| c. Recepción | Antes de enviar, si ya hubo un intento, consultar la autorización por clave (paso d). Si el SRI no la conoce, enviar los bytes guardados | `RECIBIDA`: `RECEIVED`. `DEVUELTA` con mensaje 43 (clave registrada) o 70 (clave en procesamiento), como en `DocumentPipeline.java`: `RECEIVED`. Otra `DEVUELTA`: `REJECTED` |
| d. Autorización | `autorizacionComprobante(accessKey)` | `AUTORIZADO`: `AUTHORIZED` con `authorizationNumber`, `authorizedAt` y el XML autorizado. `NO AUTORIZADO`: `REJECTED`. Sin autorizaciones o `EN PROCESO`: reintento (inline: hasta 2 consultas con 3 s de espera; después, el tick) |
| e. Artefactos | XML autorizado (respuesta de autorización con el comprobante) y RIDE, cifrados en storage. Fijan `xmlStorageKey`/`rideStorageKey` como hoy | `AUTHORIZED`; un fallo aquí se reintenta y no toca la autorización |
| f. Correo | Si el cliente tiene email y hay artefactos: enviar ambos adjuntos | `emailedAt`; fallo: `emailAttempts + 1`, hasta 5 intentos con backoff, evento `EMAIL_FAILED` |

Al llegar a `AUTHORIZED` las sesiones de tratamiento pasan a `BILLED`; al llegar a `REJECTED` o
`FAILED` seguro la orden vuelve a `PAID` y las sesiones a `BILLING_FAILED`, igual que hoy.

### Regla de seguridad

Desde que existe XML firmado la solicitud **nunca** pasa a `FAILED`, nunca recibe otro secuencial
ni otra clave, y todo reenvío usa exactamente los bytes guardados (se verifica su SHA-256 antes de
enviar). La clave de acceso es la identidad única ante el SRI: reemplaza a la clave de idempotencia
del proveedor y a `requiresReconciliation`. Una solicitud firmada solo termina en `AUTHORIZED` o
`REJECTED` según lo que diga el SRI.

### Errores

| Tipo | Ejemplos | Efecto |
|---|---|---|
| Transitorio | red, timeout, HTTP 5xx, SOAP fault, `EN PROCESO`, sin autorizaciones | Reintento con `retryDelay` actual (30 s a 30 min). Antes de firmar, tras 24 h pasa a `FAILED` |
| Datos | `DEVUELTA` (salvo 43/70; incluye 45 «secuencial registrado», que no debería ocurrir con la reserva atómica), `NO AUTORIZADO` | `REJECTED`. Mensajes SRI (`identificador`, `mensaje`, `informacionAdicional`, `tipo`) cifrados en `lastErrorEncrypted`, visibles solo para quien tiene `billing.view`. Nunca en logs ni auditoría. Se permite reemitir con secuencial nuevo |
| Configuración | sin certificado, contraseña inválida, certificado vencido o de otro RUC, punto inexistente, emisor inactivo | Antes de firmar: `FAILED` y orden liberada. Después de firmar no aplica (el XML ya está firmado) |
| Integridad | el SHA-256 del XML guardado no coincide | Se detiene la fila con evento y error `INVOICE_SIGNED_XML_INTEGRITY`; requiere intervención. Nunca se refirma |

`ProviderError` se reemplaza por `SriError(kind, code, { status, retryAfterMs })` con la misma regla:
solo códigos propios y metadatos numéricos, nunca texto del SRI.

## API

| Método y ruta | Rol | Cambio |
|---|---|---|
| `GET tenants/:t/invoicing/issuer` | MASTER | nuevo: emisor, metadatos del certificado (sin secretos), puntos con su siguiente secuencial |
| `PUT tenants/:t/invoicing/issuer` | MASTER | nuevo: datos tributarios, ambiente, activo. RUC fijo tras la primera solicitud (`INVOICING_IDENTITY_LOCKED`). Cambiar de ambiente exige no tener solicitudes `REQUESTED`/`PROCESSING` ni `AUTHORIZED` sin artefactos (`INVOICING_ENVIRONMENT_BUSY`) |
| `PUT tenants/:t/invoicing/issuer/certificate` | MASTER | nuevo: multipart `file` (`.p12`/`.pfx`, máx. 50 KB) + `password`. Valida y devuelve metadatos |
| `POST tenants/:t/invoicing/test` | MASTER | cambia: certificado válido y del RUC, más que los servicios del SRI del ambiente responden (GET del WSDL) |
| `PUT tenants/:t/branches/:branchId/emission-point` | MASTER | cambia: `{ establishmentCode, emissionPointCode, establishmentAddress, nextSequential? }` |
| `POST tenants/:t/orders/:id/invoice-requests` | igual | ahora devuelve el estado tras el intento inline |
| `GET invoice-requests`, `/:id`, `/:id/xml`, `/:id/ride` | igual | sin cambios de contrato salvo campos eliminados del proveedor |
| `POST /internal/invoicing/tick` | secreto | nuevo |
| `GET tenants/:t/invoicing/connection`, `PUT .../connection`, `GET .../options`, `POST integrations/emite-facil/webhook/:id` | | eliminados |

Todas las escrituras de configuración dejan auditoría (`CONNECTION_SAVED` pasa a `ISSUER_SAVED`,
`CERTIFICATE_REPLACED` con el SHA-256 y `EMISSION_POINT_SAVED`).

## RIDE

Port de `RideLayout.java` con `pdfkit` (fuentes estándar ya resueltas para Vercel en
`src/common/pdf/standard-fonts.ts`):

- Emisor: razón social, nombre comercial, RUC, matriz y establecimiento, contabilidad, contribuyente
  especial y leyenda RIMPE.
- Comprobante: número `001-001-000000123`, número de autorización, fecha y hora de autorización,
  ambiente, emisión normal, y la clave de acceso con código de barras Code128 (`bwip-js`).
- Cliente, detalle (código, descripción, cantidad, precio, descuento, total), subtotales por tarifa,
  IVA, total, formas de pago e información adicional.
- Enlace de validación del SRI.

## Correo

`MailService` recibe soporte de adjuntos (hoy solo envía HTML y texto). Plantilla
`invoiceMail` en `mail.templates.ts`: asunto «Factura 001-001-000000123 de <nombre comercial>»,
cuerpo breve sin datos clínicos, con el XML y el PDF adjuntos. Si el proveedor de correo no está
configurado, `send` devuelve `false`: cuenta como intento fallido y se registra el evento.

## Web

- `src/features/billing/invoicing-settings.tsx` se rehace con cuatro tarjetas:
  - **Emisor:** datos tributarios, ambiente (pruebas o producción) y activo.
  - **Firma electrónica:** subir `.p12` con contraseña; titular, serie, vencimiento y aviso si
    vence en menos de 30 días o ya venció.
  - **Puntos de emisión:** por sucursal, establecimiento, punto, dirección y siguiente secuencial.
  - **Probar:** resultado de `POST invoicing/test`.
- `src/features/cash/invoice-summary.tsx`: quita «corrige en emite-facil». Muestra los mensajes del
  SRI de una rechazada y la acción de reemitir existente.
- `src/types/invoicing.ts`, `src/lib/api/invoicing-api.ts` y `src/hooks/useInvoicing.ts` se adaptan.
- Pruebas: `src/features/cash/invoicing.test.tsx` y nuevas para la configuración.

## Seguridad

- El `.p12` y su contraseña se cifran con la clave del tenant (`ClinicalCryptoService`); sin cifrado
  configurado la facturación responde `INVOICING_ENCRYPTION_REQUIRED` como hoy. Nunca se devuelven,
  ni se registran en logs ni en auditoría.
- El cliente SOAP solo acepta los dos hosts oficiales y no sigue redirecciones.
- El parser XML de las respuestas no resuelve entidades externas ni DTD.
- El tick exige secreto; se valida en tiempo constante y no revela si la ruta existe sin
  configuración.

## Despliegue

- Variables: quitar `EMITE_FACIL_API_URL`; añadir `INVOICING_TICK_SECRET` e
  `INVOICING_INTERNAL_SCHEDULER` (opcional). `BACKEND_PUBLIC_URL` deja de usarse para facturación.
- Supabase: tarea `pg_cron` cada minuto que llama con `pg_net` a
  `https://<api>/api/v1/internal/invoicing/tick` con el secreto. La instrucción SQL exacta queda en
  `docs/DEPLOYMENT.md`; la ejecuta el usuario en su proyecto.
- Vercel: `maxDuration` del handler al menos 60 s para el tick y el intento inline.

## Pruebas

Unitarias (`npx jest`):

- `access-key`: vectores conocidos, dígito verificador (incluidos los casos 10 → 1 y 11 → 0).
- `invoice-xml`: para una entrada fija, salida idéntica a la de `InvoiceXmlBuilder.java` (fixture
  generado una vez desde el Java y guardado), y validación contra `factura_V1.1.0.xsd` con
  `xmllint-wasm`.
- `certificate`: `.p12` autofirmado generado en el test (válido, vencido, otro RUC, contraseña
  errónea).
- `xades-signer` + `xades-verifier`: firmar y verificar; alterar un byte del comprobante, de
  SignedProperties o de KeyInfo rompe la verificación; el XML firmado sigue validando contra la XSD
  (que incluye `xmldsig-core-schema.xsd`).
- `sri-client`: fixtures SOAP de RECIBIDA, DEVUELTA 43, DEVUELTA de datos, AUTORIZADO, NO
  AUTORIZADO, sin autorizaciones, SOAP fault, HTTP 503 y timeout; rechazo de hosts no oficiales.
- `ride`: genera un PDF que abre y contiene la clave de acceso y el número.
- `invoice-emitter` y worker: cada transición; tras `SIGNED` nunca `FAILED` ni secuencial nuevo; el
  reintento consulta la autorización antes de reenviar; carrera entre inline y tick (un solo lease);
  integridad del XML guardado; correo con reintentos limitados.
- `issuer.service`: RUC bloqueado tras la primera solicitud, cambio de ambiente ocupado, secuencial
  solo hacia arriba, serie única por emisor.

E2E (`test/invoicing.e2e-spec.ts`, PostgreSQL desechable): reescrito con un simulador SOAP local
que responde según la clave de acceso. Cubre configurar emisor, subir certificado, puntos, cobrar y
facturar con autorización inline, autorización diferida vía tick, rechazo con reemisión, timeout
ambiguo resuelto por clave registrada, límite mensual y descarga de XML y RIDE.

Manual, a cargo del usuario: una emisión real en el ambiente de pruebas del SRI (`celcer`) con un
certificado de pruebas real, y revisar el comprobante en el portal del SRI.

## Documentación

Actualizar `api/docs/DEPLOYMENT.md` (sección de facturación electrónica), `api/docs/API_ENDPOINTS.md`,
`api/.env.example` y `TAREAS_PENDIENTES.md` (fila de facturación del SRS).

## Entrega

Dos PRs contra `dev`: uno en `api/` (migración, módulo, pruebas, docs) y otro en `web/`
(configuración y resumen de factura). La web depende del contrato nuevo de la API; se fusionan en
ese orden.

## Riesgos

| Riesgo | Mitigación |
|---|---|
| La firma XAdES no es aceptada por el SRI pese a verificar localmente | Port fiel del Java que ya era el que se usaba, fixture comparado con su salida, validación XSD y prueba manual en `celcer` antes de producción |
| El SRI tarda o está caído | Paso de autorización reintentable; la clave registrada se reconoce; nada firmado se pierde ni se refirma |
| El tick externo deja de llamarse | Las facturas quedan `PROCESSING` visibles en Caja; el intento inline cubre el caso normal. Documentar cómo comprobar `cron.job_run_details` |
| Certificado vencido | Aviso en la web desde 30 días antes; el preflight lo bloquea antes de firmar |
