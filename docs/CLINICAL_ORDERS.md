# Órdenes, resultados, revisión y seguimiento

Fase 3 del módulo de ginecología, aplicable a todas las especialidades de salud. Cubre los criterios de aceptación CA-006, CA-007 y CA-008 y las reglas RB-02, RB-03 y RB-15 de la especificación del módulo.

## Modelo

| Tabla | Qué guarda |
| --- | --- |
| `ClinicalOrder` | La solicitud (tipo, estudio, indicación, prioridad, profesional), su avance (muestra, envío, laboratorio y folio) y su cierre o anulación. |
| `ClinicalResult` | Cada versión del informe: texto, archivo del paciente y registro estructurado opcionales, quién lo registró, revisión y comunicación al paciente. |
| `ClinicalFollowUp` | Un pendiente clínico con responsable y fecha objetivo, ligado o no a una orden y a un resultado. |

Todo texto libre se guarda cifrado con las claves clínicas (`prisma:encrypt-clinical-data` también lo recifra al rotar claves). Cada lectura y cada cambio crea una entrada en la auditoría clínica, con el estado anterior y el posterior cifrados.

## Flujo de una orden

```text
ORDERED -> SAMPLE_COLLECTED -> SENT_TO_LAB -> PENDING_REVIEW -> REVIEWED -> PATIENT_CONTACTED -> COMPLETED
     \______________ CANCELLED / NOT_PERFORMED (solo sin resultado)
```

- Los pasos que el estudio no necesita se omiten: un resultado puede llegar desde `ORDERED`.
- **Registrar un resultado nunca lo da por revisado ni por comunicado** (CA-007): la orden pasa a `PENDING_REVIEW` y el resultado aparece en «Pendientes clínicos» (CA-006).
- Una nueva versión del informe no borra la anterior; si la anterior no se había revisado queda como `SUPERSEDED`. Solo se revisa y comunica la última versión.
- La revisión registra decisión (`NO_FURTHER_ACTION`, `FOLLOW_UP_REQUIRED`, `REPEAT_REQUIRED`), conducta, si requiere cita y quién revisó. Las dos últimas decisiones exigen un seguimiento con responsable y fecha. El sistema no interpreta resultados ni sugiere conductas.
- Una orden **no pasa de un resultado recibido a cerrada sin revisión**. Para cerrarla se exige: último resultado revisado, ningún seguimiento abierto y, si no se registró la comunicación con el paciente, una nota que explique por qué.
- Solo se anula una orden sin resultado.
- Cada comando lleva la `version` que el cliente leyó: si alguien la cambió, responde `409 CLINICAL_ORDER_VERSION_CONFLICT` y nada se sobrescribe (RB-15). La fila se bloquea durante el comando.

## Firma

La solicitud de la orden (tipo, estudio, indicación, prioridad, profesional y fecha) se firma igual que un registro: con su atención al cerrarla, o al guardarla si no pertenece a ninguna, para lo cual se pide la contraseña. La huella de la atención incluye las de sus órdenes solo cuando tiene órdenes, de modo que las atenciones firmadas antes conservan la suya. El avance posterior (muestra, resultados, revisión) no forma parte de lo firmado; cada versión de resultado guarda su propia huella SHA-256 al registrarse. Una atención con órdenes ya no se puede eliminar.

## Archivos de resultados

Un archivo que es el informe de un resultado no se puede eliminar (`409 PATIENT_FILE_IN_RESULT`): el resultado se quedaría sin su informe.

## Seguimientos

Se crean desde una revisión o a mano (por ejemplo, un control preventivo). El responsable es un profesional activo de una especialidad de salud, que es quien puede abrir la bandeja. Cambiar su texto, fecha o responsable exige `clinical_records.update`, como corregir una nota. Solo se cierran explícitamente, como realizados o cancelados y siempre con una nota. Cancelar, reprogramar o completar una cita no los toca (RB-02, CA-008), y la orden conserva sus resultados aunque la cita cambie (RB-03).

## Pendientes clínicos

`GET /clinical-inbox` reúne, del profesional (`scope=mine`) o de todo el consultorio (`scope=all`): resultados por revisar, órdenes sin resultado, resultados revisados sin comunicación y seguimientos abiertos. Cada lista trae 200 elementos por página, los más antiguos primero; `totals` dice cuántos hay en total y `page` trae los siguientes. Marca como vencido:

- un resultado sin revisar más de `TenantSettings.resultReviewAlertDays` días (por defecto 3);
- una orden sin resultado pasada su `resultDueAt`, que por defecto es la fecha de la orden más `orderResultAlertDays` (por defecto 15).

Ambos plazos los fija el consultorio en Configuración. Son señales operativas, no clasificaciones clínicas de urgencia. No se envía ningún aviso por correo, SMS ni push con contenido del resultado.

## Lo que queda fuera

- Importar resultados desde un laboratorio (integraciones).
- Mostrar órdenes y resultados en la línea clínica (`GET /clinical-timeline`) y en el móvil.
- El formulario antiguo «Orden» (`general.orders`) sigue legible y admite adendas, pero la web ya no lo ofrece para registros nuevos.
