# Atención con varios tratamientos — diseño

Fecha: 2026-11-20 · Repos: `api` y `web`

## Intención

Hoy la atención y el tratamiento se inician desde dos pestañas distintas del paciente:

- **Especialidades → "Iniciar atención"** abre un `Encounter` (tipo, cita, sede, motivo) donde se guardan los registros clínicos. La agenda ("Atender") lleva aquí.
- **Tratamientos → "Nueva atención"** abre una `TreatmentSession`, que crea **su propio** `Encounter` de tipo `PROCEDURE` y lleva al asistente (ficha, consentimiento, fotos, procedimiento).

Como solo puede haber una atención abierta por profesional y paciente (`ENCOUNTER_ALREADY_OPEN`), quien inicia la atención desde la agenda ya no puede abrir el tratamiento. El flujo se vuelve largo y confuso.

**Qué se quiere:** al iniciar una atención se eligen también sus tratamientos, **uno o varios**, en el mismo paso. La atención es el contenedor de la consulta: registros clínicos y tratamientos viven dentro de ella.

## Objetivos

- Un solo formulario de inicio de atención que permita elegir cero, uno o varios tratamientos.
- Poder añadir un tratamiento a una atención ya en curso.
- Cada tratamiento conserva su asistente actual (ficha, consentimiento, fotos, procedimiento) y su propia línea de cobro.
- Terminar, cancelar o rechazar el consentimiento de un tratamiento ya no cierra la atención.

## No objetivos

- Un asistente combinado para todos los tratamientos (opción B, descartada).
- Reutilizar la ficha médica entre tratamientos de la misma atención (posible mejora posterior; el consentimiento ya se reutiliza).
- Cambios en caja, órdenes o facturación: siguen trabajando por `TreatmentSession`.
- Migrar o fusionar las atenciones existentes.

## Anti-objetivos

- Que la caja o la facturación electrónica cambien de comportamiento.
- Que una cita quede como **cancelada** o **no asistió** cuando otro tratamiento de la misma atención sí se hizo.
- Que se pueda cerrar (firmar) una atención con un tratamiento a medias.
- Que la app móvil u otros clientes que usan `POST /patients/:id/treatment-sessions` como hoy dejen de funcionar.

## Enfoques considerados

- **A. Una atención, varios tratamientos, cada uno con su asistente — elegido.** La relación `Encounter` → `TreatmentSession` pasa de 1:1 a 1:N. Es un cambio acotado y no toca el dinero. Contra: si dos tratamientos piden la misma ficha, se llena dos veces.
- **B. Un único asistente que combina todos los tratamientos.** Es el recorrido más corto, pero obliga a rehacer estados, requisitos, el PDF del consentimiento y el cobro por sesión. Descartado por coste y riesgo en caja y facturación.
- **C. Unificar solo la pantalla.** Descartado: la regla de una atención abierta seguiría bloqueando el segundo tratamiento.

## Diseño

### Datos (API, migración nueva)

- `TreatmentSession.encounterId` deja de ser `@unique`. Se añade `@@index([encounterId])`.
- `Encounter.treatmentSession TreatmentSession?` pasa a `treatmentSessions TreatmentSession[]`.
- No se migran datos: cada sesión existente sigue con su atención propia, que es un caso válido de 1:N.

### Estados de un tratamiento dentro de la atención

- **Sin terminar:** `INTAKE_IN_PROGRESS`, `READY_FOR_CONSENT`, `CONSENTED`, `IN_PROGRESS`.
- **Terminados:** todos los demás (`CLINICAL_COMPLETE`, `CONSENT_REFUSED`, `CONSENT_REVOKED`, `CANCELLED`, `NO_SHOW`, `BILLING_*`).

### Reglas de la API

1. **Iniciar atención con tratamientos.** Se hace por la ruta de sesiones (punto 2), que además acepta `encounterType?` y `reason?` para la atención que abre. Así la web, con tratamientos elegidos, llama a `POST /treatment-sessions`, y sin tratamientos, a `POST /encounters` como hoy. En la misma transacción serializable abre la atención y crea una sesión por tratamiento, con la misma validación que hoy (versión vigente, `TREATMENT_SPECIALTY_MISMATCH`). Si un tratamiento falla, no se crea nada. Máximo 10 y sin repetidos (decisión mía).
   - *Ajuste al planificar:* `POST /encounters` no recibe `treatmentIds`. `TreatmentSessionsModule` ya depende de `EncountersModule`, y hacerlo al revés crearía una dependencia circular. Esta ruta ya exige la sección y los permisos de sesiones, y la persona ve lo mismo.
2. **Iniciar desde Tratamientos o añadir a una atención.** `POST /patients/:patientId/treatment-sessions` acepta `treatmentIds: string[]` y un `encounterId?` opcional. Se mantiene `treatmentId` (uno solo) por compatibilidad: debe venir uno de los dos, no ambos.
   - **Con `encounterId`:** añade las sesiones a esa atención, que debe ser del usuario, del paciente y estar abierta (`assertOpenEncounter`). Usa la cita y la sede de esa atención; si llegan `appointmentId` o `branchId` distintos, responde 400.
   - **Sin `encounterId`:** abre una atención con `encounterType` (por defecto `PROCEDURE`) y `reason` (por defecto, los nombres de los tratamientos separados por ", ", recortados a 2000 caracteres). Si el usuario ya tiene una atención abierta con el paciente, sigue respondiendo `ENCOUNTER_ALREADY_OPEN` con su `encounterId`; la web lo usa para ofrecer "añadir a la atención en curso".
   - La respuesta pasa a ser la lista de sesiones creadas. Para no romper clientes, cuando llega `treatmentId` (uno solo) se sigue devolviendo el detalle de esa sesión como hoy.
3. **Terminar, cancelar o rechazar/revocar el consentimiento de una sesión** cambia solo esa sesión y **ya no cierra la atención** (se quitan las llamadas a `closeEncounter` en `complete`, `cancel`, `refuseConsent` y `revokeConsent`). Las notas del procedimiento ya no se copian al resumen de la atención.
   - `cancel` ya no toca la cita. La cita se resuelve al cerrar la atención, como en una consulta normal.
   - **Completar y cerrar (decidido):** `complete` acepta `closeEncounter?: boolean`, `password?: string` y `encounterSummary?: string`. Con `closeEncounter: true`, verifica la contraseña (403 `SIGNATURE_PASSWORD_INVALID`), comprueba que no queden otras sesiones sin terminar (409 `ENCOUNTER_HAS_UNFINISHED_TREATMENTS`) y cierra y firma la atención en la misma transacción, con la misma firma que la ruta de cierre. Sin esos campos, solo completa la sesión.
4. **No asistió** pasa a ser una acción de la atención: `POST /patients/:patientId/encounters/:id/no-show`. Pasa a `NO_SHOW` todas sus sesiones sin terminar, deja la cita en `NO_SHOW` y cierra la atención. Solo se permite si ninguna sesión pasó de `CONSENTED` y la atención no tiene registros propios, es decir, registros que no sean la ficha de una de sus sesiones. Si no, 409 `ENCOUNTER_HAS_ACTIVITY`. La ruta vive en `TreatmentSessionsController` (sección de sesiones), por la misma razón de dependencias del punto 1, y se ofrece solo cuando la atención tiene tratamientos.
   - El endpoint actual `POST /treatment-sessions/:id/no-show` se mantiene y delega en el de la atención de esa sesión.
5. **Cerrar la atención** (`close`) se rechaza con 409 `ENCOUNTER_HAS_UNFINISHED_TREATMENTS` (con la lista de ids) mientras tenga sesiones sin terminar. Al cerrar, la cita pasa a atendida como hoy.
6. **`assertNotManagedBySession` desaparece**: una atención con tratamientos se edita, cierra y elimina por las rutas normales. Eliminar solo se permite si, además de no tener registros, no tiene sesiones. Así se evita borrar sesiones que pueden estar en una orden de caja.
7. **Secciones.** Un consultorio puede tener `core.treatments.sessions` activa sin `core.clinical.specialties` (que hoy protege todo `EncountersController`). Las rutas de atención que necesita el flujo de tratamientos (listar y cerrar) deben ser alcanzables con cualquiera de las dos secciones. Hoy `RequireSection(key)` recibe una sola sección, así que se extiende para aceptar una lista con lógica "cualquiera de" (decisión mía) y se usa en esas rutas. Crear y corregir registros sigue exigiendo `core.clinical.specialties`. Debe haber una prueba de que un tenant sin ninguna de las dos recibe el 403 de sección.
8. **Firma al cerrar:** el `contentHash` de la atención no incluye las sesiones, igual que hoy. Queda fuera de alcance.
9. **Auditoría:** cada sesión creada se audita como hoy. La atención con `treatmentIds` audita la atención y cada sesión.

### Web

- **Un solo panel de atención** (`EncounterPanel`, que se generaliza) al inicio de las pestañas **Especialidades** y **Tratamientos**: la que esté visible lo muestra.
  - **Con la sección de especialidades:** tipo, cita, sede, motivo y una lista de casillas **"Tratamientos (opcional)"** con los tratamientos activos, si la sección de sesiones está activa y hay catálogo.
  - **Solo con la sección de tratamientos:** el panel pide cita, sede y tratamientos (al menos uno). El tipo es `PROCEDURE` y el motivo, el de la API.
  - "Nueva atención" de la pestaña Tratamientos se sustituye por este panel. La lista de sesiones del paciente se queda debajo.
- **Al iniciar con exactamente un tratamiento**, se navega a su asistente, igual que hoy. Con varios, se queda en el panel.
- **El panel de la atención en curso** muestra sus tratamientos con estado y botón "Continuar", un botón **"Añadir tratamiento"** (diálogo con casillas) y **"No asistió"** cuando aplique. "Cerrar atención" se deshabilita y explica qué tratamientos faltan mientras haya alguno sin terminar.
- **El asistente** (`session-workflow`):
  - Al completar el **último tratamiento pendiente** de la atención, el diálogo ofrece dos botones: **"Completar y cerrar atención"**, con contraseña y resumen opcional en el mismo diálogo, y **"Completar y seguir en la atención"**. Si quedan otros pendientes, solo aparece "Completar".
  - Al terminar o cancelar, ofrece **"Siguiente tratamiento: X"** si quedan pendientes en la misma atención, y "Volver a la atención" (a la pestaña que corresponda).
  - Se quita el botón "No asistió" del asistente.
  - "Cancelar" ya no habla de cancelar la cita.
- **Agenda → "Atender":** lleva a `?tab=specialties` si esa sección está activa; si no, a `?tab=treatments`, siempre con `appointmentId`.
- **Si ya hay una atención abierta**, el panel la muestra en lugar del formulario. Ya no aparece el error `ENCOUNTER_ALREADY_OPEN` en la interfaz.
- Las mutaciones invalidan las atenciones, las sesiones del paciente y las citas.

### Pruebas

- **API, unitarias:** sesiones creadas con la atención, añadir a una atención abierta, ajena o cerrada (403/404/409), terminar o cancelar sin cerrar la atención, cierre bloqueado con sesiones sin terminar, completar y cerrar (contraseña errónea, otras sesiones pendientes, caso correcto), no asistió a nivel de atención, eliminar bloqueado con sesiones, compatibilidad de `treatmentId` único, 403 de sección y permiso al enviar `treatmentIds`.
- **API, e2e:** el flujo completo con dos tratamientos y una cita: iniciar, completar uno, cancelar otro, cerrar. La cita queda atendida y caja ve un tratamiento cobrable.
- **Web, Vitest:** el formulario con y sin tratamientos, el panel según secciones (el tenant sin la sección de tratamientos no ve las casillas), la navegación con uno o varios, "Cerrar" deshabilitado, "Siguiente tratamiento" y "Añadir tratamiento".

## Decisiones que tomé (revísalas)

- Máximo 10 tratamientos por atención.
- Con un solo tratamiento se va directo a su asistente; con varios, la persona se queda en el panel.
- "No asistió" solo antes de empezar cualquier procedimiento y sin registros.
- Cancelar un tratamiento ya no cancela la cita; la cita se resuelve al cerrar la atención.
- El panel aparece en ambas pestañas.
- Las atenciones antiguas abiertas por una sesión con la lógica vieja se cierran a mano tras el cambio, sin migración.

## Para el constructor

- Nombres exactos de DTOs y códigos de error nuevos, siguiendo los existentes.
- El orden de los PRs: primero API (migración + reglas, compatible hacia atrás), luego web. Ambos contra `dev`.
