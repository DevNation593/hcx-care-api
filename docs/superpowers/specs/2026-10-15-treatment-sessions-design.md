# Núcleo clínico de tratamientos (sub-proyecto A de HCX Cloud v2) — diseño

Fecha: 2026-10-15 · Repositorios: api y web · Rama: `claude/compassionate-hopper-t6teqf` en cada uno

Origen: *HCX Cloud — Estructura integral de implementación v2.0* (15-10-2026). Ese documento se
divide en tres sub-proyectos, cada uno con su spec, su plan y su implementación:

| Sub-proyecto | Alcance | Estado |
|---|---|---|
| **A. Núcleo clínico** | Catálogo de tratamientos versionado, consentimiento versionado con firma y PDF, sesión de tratamiento con estados, fotos antes/después y cierre clínico | Este documento |
| B. Caja y facturación | Perfiles fiscales, órdenes, pagos, elegibilidad (422) y adaptador a `api-emite-facil`, que reemplaza a Faktur | Pendiente |
| C. Operación | Turnos del personal y reportes operativos | Pendiente |

## Objetivo

Digitalizar el recorrido en papel de una atención con procedimiento: elegir un tratamiento,
llenar la ficha que ese tratamiento exige, leer y firmar el consentimiento en una tablet, tomar
fotos antes, ejecutar el procedimiento, registrar notas y fotos después y cerrar. El servidor
decide qué falta y bloquea cada paso que no cumple la política del tratamiento; la interfaz
solo lo muestra.

Éxito: un profesional abre una atención de un tratamiento que exige ficha, consentimiento y
fotos; no puede iniciarla hasta cumplir todo (422 con lo que falta); el paciente firma en la
tablet y queda un PDF inmutable con el hash del texto aceptado; al cerrar, la atención queda
`CLINICAL_COMPLETE` con autor y hora del servidor, y todo aparece en la historia del paciente.

## Decisiones tomadas

| Tema | Decisión |
|---|---|
| Relación con `Encounter` | La sesión es una entidad nueva montada sobre un `Encounter` que abre al crearse. Ficha, notas y archivos se guardan en ese encounter con el cifrado y la auditoría existentes |
| Ficha | Un `SpecialtyRecord` del `FormDefinition` y la versión que fija el tratamiento. Se valida completa al guardarse; no hay guardado parcial en servidor |
| Consentimiento | Uno por sesión por defecto. `validityDays` en la versión del tratamiento permite reutilizar uno firmado y no revocado de una sesión anterior del mismo tratamiento |
| Firma | Imagen dibujada en tablet + firmante, rol, relación, declaraciones y evidencia (operador, IP, user-agent, hora del servidor). No se presenta como firma electrónica certificada |
| Rechazo y revocación | Rechazar deja la sesión en `CONSENT_REFUSED` (terminal). Revocar antes de iniciar deja `CONSENT_REVOKED` (terminal); revocar después no cambia la sesión pero impide reutilizar el documento |
| Quién opera la sesión | Cuentas con perfil profesional activo (`ClinicalProfileGuard`), como el resto del contenido clínico |
| Quién gestiona catálogo y plantillas | MASTER, o quien reciba el permiso nuevo `treatments.manage` |
| Sección | `core.specialties` (Módulos clínicos), ya activa en los planes; no se crea una sección nueva |
| Ruta | `treatment-sessions`, para no confundirla con las sesiones de autenticación |
| Fotos para publicidad | Se registra la autorización separada en la firma; esta fase no ofrece ningún uso publicitario |

## Modelo de datos

Una migración aditiva, `20261015000000_treatment_sessions`. No modifica ni elimina datos.

### Catálogo

`Treatment`

| Campo | Contenido |
|---|---|
| `tenantId` | Clínica |
| `name` | Único por tenant |
| `category` | Opcional, texto libre |
| `specialtyId` | Opcional. Si está, solo profesionales de esa especialidad abren sesiones |
| `isActive` | Un tratamiento inactivo no admite sesiones nuevas |
| `currentVersion` | Número de la versión vigente |

`TreatmentVersion` (inmutable: no hay update ni delete)

| Campo | Contenido |
|---|---|
| `treatmentId`, `version` | Único `(treatmentId, version)` |
| `price` | `Decimal(10,2)` |
| `taxRatePercent` | `Decimal(5,2)`, p. ej. `0` o `15` |
| `durationMinutes` | Duración estimada |
| `formDefinitionId`, `formVersion` | Ficha exigida (opcionales) |
| `consentTemplateVersionId` | Consentimiento exigido (opcional) |
| `requirements` | JSON validado por el servidor (abajo) |
| `createdById`, `createdAt` | Autor |

```json
{
  "medicalForm": { "required": true },
  "informedConsent": { "required": true, "validityDays": null },
  "photos": { "minimumBefore": 1, "minimumAfter": 1 },
  "clinicalNotes": { "requiredForCompletion": true }
}
```

Reglas al crear una versión: si `medicalForm.required`, el formulario y la versión deben existir
en el tenant y el formulario estar activo; si `informedConsent.required`, la versión de
consentimiento debe ser del tenant y estar `PUBLISHED`; `validityDays` es `null` o 1–3650;
mínimos de fotos 0–20. Cualquier otra clave se rechaza (`400 TREATMENT_REQUIREMENTS_INVALID`).

### Consentimientos

`ConsentTemplate`: `tenantId`, `name` (único por tenant), `isActive`, `currentVersion`.

`ConsentTemplateVersion`

| Campo | Contenido |
|---|---|
| `templateId`, `version` | Único `(templateId, version)` |
| `title`, `body` | Texto con variables `{{paciente}}`, `{{identificacion}}`, `{{tratamiento}}`, `{{profesional}}`, `{{fecha}}` |
| `checksum` | SHA-256 hex de `title + "\n" + body` |
| `status` | `DRAFT → PUBLISHED → RETIRED` |
| `publishedAt`, `retiredAt`, `createdById` | Trazas |

Solo un `DRAFT` editable por plantilla. Una versión `PUBLISHED` o `RETIRED` no se edita
(`409 CONSENT_VERSION_LOCKED`). Retirar no afecta a documentos ya firmados ni a versiones de
tratamiento que la referencian, pero impide crear versiones de tratamiento nuevas con ella.

`ConsentDocument`

| Campo | Contenido |
|---|---|
| `tenantId`, `patientId`, `treatmentSessionId`, `templateVersionId` | Vínculos |
| `title`, `body` | Texto ya resuelto que vio el paciente. **Cifrados** |
| `checksum` | SHA-256 del título y cuerpo resueltos, en claro |
| `status` | `PRESENTED → SIGNED | REFUSED`; `SIGNED → REVOKED` |
| `presentedAt`, `signedAt`, `refusedAt`, `revokedAt` | Hora del servidor |
| `pdfStorageKey`, `pdfChecksum` | PDF generado al firmar, cifrado en el storage de archivos |

`pdfStorageKey`, `pdfChecksum`, `checksum`, `title`, `body` y `templateVersionId` no cambian
después de firmar: el servicio no expone ninguna escritura sobre ellos.

`ConsentSignature` (una por documento firmado)

| Campo | Contenido |
|---|---|
| `signerRole` | `PATIENT` o `REPRESENTATIVE` |
| `signerName`, `signerIdentification`, `relationship` | **Cifrados**. `relationship` obligatorio para representante |
| `understood`, `questionsAnswered` | Deben ser `true` para firmar |
| `marketingPhotos` | Autorización separada de uso publicitario de fotos; por defecto `false` |
| `signatureStorageKey` | PNG de la firma, cifrado en storage |
| `operatorId`, `ipAddress`, `userAgent`, `signedAt` | Evidencia |

Si el paciente es menor de 18 años a la fecha del servidor, el firmante debe ser
`REPRESENTATIVE` (`422 CONSENT_REPRESENTATIVE_REQUIRED`).

`ConsentEvent`: `documentId`, `type` (`PRESENTED`, `SIGNED`, `REFUSED`, `REVOKED`), `reason`
(**cifrado**, obligatorio en rechazo y revocación), `actorId`, `createdAt`. Solo inserción.

### Sesión

`TreatmentSession`

| Campo | Contenido |
|---|---|
| `tenantId`, `patientId`, `professionalId`, `branchId?`, `appointmentId?` | Vínculos |
| `treatmentVersionId` | Versión del tratamiento fijada al crear |
| `encounterId` | Único. Encounter `PROCEDURE` que abre la sesión |
| `formRecordId?` | `SpecialtyRecord` de la ficha |
| `consentDocumentId?` | Consentimiento aplicable (de esta sesión o reutilizado) |
| `status` | Abajo |
| `startedAt`, `completedAt`, `cancelledAt` | Hora del servidor |
| `procedureNotes`, `cancellationReason` | **Cifrados** |
| `version` | Concurrencia optimista: cada transición incrementa |

`PatientFile` gana `treatmentSessionId?` y `phase` (`BEFORE`, `AFTER`, `OTHER`, nulo para los
archivos existentes).

`AuditEntity` gana `TREATMENT_SESSION` y `CONSENT_DOCUMENT`; ambos entran en
`CLINICAL_AUDIT_ENTITIES`.

Todos los modelos nuevos llevan `tenantId` con índice y las mismas políticas RLS que las tablas
clínicas existentes.

## Estados de la sesión

```
INTAKE_IN_PROGRESS ─ficha─▶ READY_FOR_CONSENT ─firma─▶ CONSENTED ─start─▶ IN_PROGRESS ─complete─▶ CLINICAL_COMPLETE
        │                          │   └─(consentimiento no requerido)── start ──┘
        │                          ├─ refuse ─▶ CONSENT_REFUSED
        │                          └─ revoke ─▶ CONSENT_REVOKED   (también desde CONSENTED)
        └── cancel / no-show (desde cualquier estado previo a IN_PROGRESS) ─▶ CANCELLED / NO_SHOW
IN_PROGRESS ─ cancel (motivo obligatorio) ─▶ CANCELLED
```

- Al crear: si el tratamiento no exige ficha, la sesión nace en `READY_FOR_CONSENT`. Si además
  hay un consentimiento aplicable vigente (`validityDays`), queda `CONSENTED` con ese documento.
- Los estados de facturación (`READY_FOR_BILLING`, `BILLING_PENDING`, `BILLED`,
  `BILLING_FAILED`, `CLOSED`) se agregan en el sub-proyecto B.
- Un estado terminal (`CLINICAL_COMPLETE`, `CONSENT_REFUSED`, `CONSENT_REVOKED`, `CANCELLED`,
  `NO_SHOW`) cierra el encounter de la sesión.
- No hay escritura directa de `status`: solo comandos (RN-21). Una transición inválida responde
  `409 TREATMENT_SESSION_INVALID_TRANSITION` con `status` actual.
- El encounter de una sesión no se edita, cierra ni elimina desde `/encounters`
  (`409 ENCOUNTER_MANAGED_BY_SESSION`).

### Evaluador de requisitos

Una función pura `evaluateSession(policy, facts)` devuelve `{ missing: string[] }` para la
transición pedida. Los hechos se leen dentro de la transacción; nunca vienen del cliente.

| Código | Se exige para | Cuándo falta |
|---|---|---|
| `FINALIZED_MEDICAL_FORM` | start | Ficha requerida y la sesión no tiene `formRecordId` vivo |
| `SIGNED_APPLICABLE_CONSENT` | start | Consentimiento requerido y no hay documento `SIGNED` (no `REVOKED`) de la versión exigida, de esta sesión o de una anterior del mismo tratamiento del paciente firmada hace ≤ `validityDays` |
| `BEFORE_PHOTOS` | start | Fotos `BEFORE` vivas < `minimumBefore` |
| `CLINICAL_NOTES` | complete | Notas requeridas y vacías |
| `AFTER_PHOTOS` | complete | Fotos `AFTER` vivas < `minimumAfter` |

Start y complete corren en una transacción serializable y responden
`422 TREATMENT_REQUIREMENTS_MISSING` con `missing` si algo falta.

## API

Prefijo `/api/v1/tenants/:tenantId`. Errores con el formato actual `{ statusCode, code, message }`.

### Tratamientos

| Método y ruta | Quién | Resultado |
|---|---|---|
| `GET /treatments?active=` | cualquier usuario del tenant | Lista con la versión vigente |
| `POST /treatments` | `treatments.manage` | 201 con la versión 1 |
| `GET /treatments/:id` | cualquier usuario del tenant | Con todas sus versiones |
| `PATCH /treatments/:id` | `treatments.manage` | Nombre, categoría, especialidad, activo |
| `POST /treatments/:id/versions` | `treatments.manage` | 201; nueva versión vigente |

### Plantillas de consentimiento

| Método y ruta | Quién | Resultado |
|---|---|---|
| `GET /consent-templates` | `treatments.manage` o profesional | Con sus versiones (sin cuerpo en el listado) |
| `POST /consent-templates` | `treatments.manage` | 201 con un `DRAFT` |
| `GET /consent-templates/:id` | `treatments.manage` o profesional | Con cuerpo de cada versión |
| `PUT /consent-templates/:id/draft` | `treatments.manage` | Crea o reemplaza el `DRAFT` |
| `POST /consent-templates/:id/publish` | `treatments.manage` | Publica el `DRAFT` (calcula `checksum`) |
| `POST /consent-template-versions/:versionId/retire` | `treatments.manage` | `RETIRED` |

### Sesiones (perfil profesional activo; toda lectura se audita)

| Método y ruta | Resultado |
|---|---|
| `GET /patients/:patientId/treatment-sessions` | Sesiones del paciente, recientes primero |
| `POST /patients/:patientId/treatment-sessions` | `{ treatmentId, appointmentId?, branchId? }` → 201 |
| `GET /treatment-sessions/:id` | Sesión, política, documentos, fotos y `requirements: { start: missing[], complete: missing[] }` |
| `PUT /treatment-sessions/:id/form` | `{ data }`; guarda o corrige la ficha antes de `IN_PROGRESS` |
| `POST /treatment-sessions/:id/consents` | Presenta el consentimiento exigido (idempotente si ya hay uno `PRESENTED`) |
| `POST /consent-documents/:id/sign` | Firma; genera el PDF |
| `POST /consent-documents/:id/refuse` | `{ reason }` |
| `POST /consent-documents/:id/revoke` | `{ reason }` |
| `GET /consent-documents/:id/pdf` | PDF firmado; descarga auditada |
| `POST /treatment-sessions/:id/media` | multipart `file`, `phase`, `description?` |
| `POST /treatment-sessions/:id/start` | `IN_PROGRESS` o 422 |
| `POST /treatment-sessions/:id/complete` | `{ procedureNotes? }` → `CLINICAL_COMPLETE` o 422 |
| `POST /treatment-sessions/:id/cancel` | `{ reason }` |
| `POST /treatment-sessions/:id/no-show` | `NO_SHOW` |
| `GET /treatment-sessions/:id/compliance` | `{ status, missing }` sin datos clínicos; roles con `billing.view` o perfil profesional |

Solo el profesional de la sesión escribe en ella (`403 CLINICAL_RECORD_FORBIDDEN`).

Fotos: `BEFORE` se admite con el consentimiento satisfecho y antes de `IN_PROGRESS`; `AFTER`
solo en `IN_PROGRESS`; `OTHER` mientras la sesión no sea terminal. `BEFORE` y `AFTER` aceptan
solo JPG o PNG. A los JPG se les quitan los segmentos EXIF/XMP (`APP1`) antes de cifrarlos.

### PDF del consentimiento

Generado con pdfkit, A4, junto a `record-pdf.ts`: datos de la clínica, paciente, tratamiento y
versión; título y cuerpo resueltos; imagen de la firma; firmante, rol y relación; declaraciones;
fecha y hora del servidor en la zona del tenant; operador; versión de plantilla y `checksum`
del texto. Se guarda cifrado y su SHA-256 queda en `pdfChecksum`. Descargarlo vuelve a calcular
el hash y responde `500 CONSENT_PDF_INTEGRITY` si no coincide.

## Permisos

`PERMISSION_CATALOG` gana `treatments.manage` (grupo "Tratamientos"): rol `MASTER`, concedible a
`PROFESIONAL` y `ASISTENTE`. Las acciones clínicas siguen con `clinical_records.view`,
`clinical_records.create` y `clinical_records.update`.

## Web

### Administración

- `/admin/treatments`: tabla del catálogo; crear y editar con un editor de versión (precio,
  impuesto, duración, ficha y versión, consentimiento, requisitos); historial de versiones con
  autor y fecha.
- `/admin/consents`: plantillas; editor del borrador con vista previa y variables; publicar y
  retirar; versiones con fecha y los primeros caracteres del `checksum`.

### Paciente

Pestaña "Tratamientos" en la ficha del paciente (visible con perfil profesional): lista de
sesiones con estado y botón "Nueva atención" (elige tratamiento y cita opcional) que lleva a
`/treatment-sessions/[id]`.

### Atención (`/treatment-sessions/[id]`, tablet primero)

Pasos: Ficha → Consentimiento → Fotos antes → Procedimiento → Fotos después → Cierre. Cada paso
muestra lo que el servidor declara faltante; los botones de iniciar y cerrar se habilitan según
`requirements`, pero la decisión es del servidor y sus 422 se muestran tal cual.

- Ficha: reutiliza `clinical-module-form` con el esquema de la versión exigida.
- Consentimiento: texto completo en un panel con desplazamiento; el formulario de firma
  aparece cuando el lector llega al final. Datos del firmante (prellenados desde el paciente o
  su tutor), rol, relación, casillas de comprensión y de fotos publicitarias, y `signature-pad`.
  Rechazar pide motivo.
- Fotos: captura con la cámara (`accept="image/*" capture="environment"`) o archivo.
- Ninguna acción se muestra como guardada hasta que el servidor responde; un fallo de red deja
  el paso pendiente con el error visible (E2E-15).

## Manejo de errores

| Código | HTTP | Cuándo |
|---|---|---|
| `TREATMENT_NOT_FOUND`, `TREATMENT_SESSION_NOT_FOUND`, `CONSENT_DOCUMENT_NOT_FOUND` | 404 | No existe en el tenant (otro tenant responde igual) |
| `TREATMENT_INACTIVE` | 409 | Sesión de un tratamiento inactivo |
| `TREATMENT_SPECIALTY_MISMATCH` | 403 | El profesional no es de la especialidad del tratamiento |
| `TREATMENT_REQUIREMENTS_INVALID` | 400 | Política mal formada o referencias inválidas |
| `CONSENT_VERSION_LOCKED` | 409 | Editar una versión publicada o retirada |
| `CONSENT_NOT_REQUIRED` | 409 | Presentar en un tratamiento sin consentimiento |
| `CONSENT_DECLARATIONS_REQUIRED` | 422 | `understood` o `questionsAnswered` en falso |
| `CONSENT_REPRESENTATIVE_REQUIRED` | 422 | Paciente menor firmado como `PATIENT` |
| `TREATMENT_SESSION_INVALID_TRANSITION` | 409 | Comando no permitido en el estado actual |
| `TREATMENT_REQUIREMENTS_MISSING` | 422 | Start o complete con requisitos pendientes; lleva `missing` |
| `SESSION_PHOTO_PHASE_NOT_ALLOWED` | 409 | Foto de una fase fuera de su momento |
| `ENCOUNTER_MANAGED_BY_SESSION` | 409 | Operar el encounter de una sesión desde `/encounters` |

## Pruebas

Unitarias (Jest):

- `evaluateSession`: cada código de `missing`, vigencia por `validityDays`, revocado no cuenta.
- Tabla de transiciones: cada comando válido e inválido por estado.
- Validación de `requirements` y de referencias.
- Checksum de plantilla y documento; render de variables.
- Eliminación de `APP1` en JPG (con y sin EXIF, PNG intacto).
- Generación del PDF (se produce y su hash es estable para la misma entrada).

e2e (Postgres, `test/treatment-sessions.e2e-spec.ts`):

- Recorrido completo: crear → ficha → presentar → firmar → foto antes → start → notas y foto
  después → complete; PDF descargable con hash correcto; encounter cerrado.
- E2E-03: con ficha y sin firma, start responde 422 `SIGNED_APPLICABLE_CONSENT`.
- E2E-05: firmar sobre v2, publicar v3; el documento firmado sigue en v2 con su `checksum`.
- E2E-09: usuario de otro tenant recibe 404 en la sesión y en el PDF.
- E2E-10: revocar antes de iniciar deja `CONSENT_REVOKED` y start responde 409.
- E2E-12: la hora de firma y de inicio es la del servidor aunque el cliente envíe otra.
- E2E-16: paciente menor exige representante.

Web (Vitest): paso a paso según `requirements`; el formulario de firma no aparece antes de leer
el texto; un error de red no marca la firma como hecha; editor de versión de tratamiento.

## Fuera de alcance

- Cobros, facturación y reemplazo de Faktur por `api-emite-facil` (sub-proyecto B).
- Turnos y reportes (sub-proyecto C).
- Guardado parcial de la ficha en servidor.
- Firma electrónica certificada, portal del paciente y envío de copia del consentimiento.
- Verificación pública del PDF del consentimiento por código QR.
- Uso publicitario de fotos y anotaciones sobre imágenes.
- Paquetes y planes multisesión.

## Entrega

Commits en `claude/compassionate-hopper-t6teqf` de `hcx-care-api` y `hcx-care-client`. La API
pasa lint, pruebas unitarias, e2e y build; la web pasa lint, type-check y Vitest.
