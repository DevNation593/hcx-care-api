# B2: contrato actualizado de emite-facil

Complementa `2026-10-15-cash-and-billing-design.md`, secciones B2, Web, Errores y Pruebas. La instrucción del usuario de implementar B2 autoriza ese alcance. Los hechos del repositorio `backend-emite-facil` prevalecen sobre las suposiciones de B0. Ver `../emite-facil-contract-audit.md`.

## Conexión y seguridad

- Una URL global `EMITE_FACIL_API_URL`, incluida su ruta `/api/v1`. No se aceptan URLs del proveedor por clínica.
- Autenticación mediante API key estática `X-Api-Key`; no se solicitan contraseñas de usuario, clientId, scopes ni canje de tokens.
- Una conexión por clínica, credenciales y secreto webhook cifrados con claves de la API. Se exige cifrado configurado al guardar credenciales. Las respuestas y auditorías nunca contienen secretos ni snapshots fiscales completos.
- El titular prueba una API key, elige el emisor detectado y guarda la conexión. El servidor valida el emisor, su ambiente, establecimientos y puntos contra el proveedor. Cada sede asigna un establecimiento y punto válidos de ese emisor.
- Webhook opcional: el titular lo crea en emite-facil y pega su secreto en HCX. HCX muestra la URL de recepción, obtenida de `BACKEND_PUBLIC_URL` y `API_PREFIX`. La API key no intenta administrar suscripciones. El reconciliador funciona sin webhook.
- La firma webhook se verifica sobre los bytes originales con la implementación real del proveedor, tolerancia de cinco minutos y comparación constante. Se valida además empresa, conexión y documento.

## Emisión y persistencia

- POST de solicitud crea una intención durable en transacción serializable; no llama al proveedor en la petición HTTP. Idempotencia por clínica y orden, índice parcial de una solicitud activa por orden y límite mensual del plan.
- Snapshot fiscal inmutable y cifrado: receptor, emisor, punto, líneas, pagos. Nunca incluye diagnósticos, fichas, fotos, notas ni nombres de pacientes atendidos; el nombre del receptor sí es necesario.
- Despachador cada diez segundos, reclamación de filas con `FOR UPDATE SKIP LOCKED`, lease recuperable y CAS al finalizar. Clave externa estable `hcx-<id>`. Errores transitorios se reintentan con espera hasta treinta minutos; se respeta Retry-After y se termina tras veinticuatro horas de incertidumbre. Las respuestas del proveedor no se guardan completas en eventos o logs.
- Reconciliador cada minuto para solicitudes en proceso sin actividad en dos minutos. Estados finales no retroceden. Autorización bloquea nueva emisión de esa orden. Rechazo devuelve orden a PAID y sesiones a BILLING_FAILED sin modificar pagos; nueva solicitud referencia documento rechazado. Fallos ambiguos con documento reservado no permiten una segunda emisión mientras no se aclare el resultado.
- Cliente existente: búsqueda exacta por tipo y número; productos por SKU. El proveedor no tiene actualización de clientes: una discrepancia fiscal se informa como `CUSTOMER_SYNC_REQUIRED` para corregirla en emite-facil; no se emite silenciosamente con datos antiguos.
- XML autorizado y RIDE se descargan, verifican contra SHA-256 del ETag, cifran y conservan con el storage existente. La descarga autorizada se audita. Un artefacto pendiente no revoca una autorización y se reintenta por reconciliación.
- Se mantienen los comprobantes históricos de Faktur en solo lectura. No se agregan notas de crédito, anulaciones de comprobantes autorizados, gestión de firmas ni configuración de emisores en HCX.

## Interfaz

`/admin/billing`: configuración para MASTER, API key en campo de contraseña, prueba, emisor/ambiente, puntos por sede, URL y secreto webhook opcional, historial antiguo debajo. Secretos guardados se muestran solo como presentes y no se rellenan.

`/cash`: pestaña Facturas con filtros y estados. En la orden, Emitir exige elegibilidad; conserva clave al reintentar un fallo de red, muestra el 422 del servidor y consulta cada cinco segundos mientras haya solicitud activa. Número, autorización y descargas al autorizar; rechazo/fallo visible y posibilidad de corregir y volver a solicitar con nueva clave. Se explicita que una autorizada no se anula desde HCX. No hay éxito optimista.

## Verificación

Pruebas del adaptador contra HTTP local, errores y firma; conexión y validación de puntos; transacciones de solicitud, idempotencia, límite, aislamiento de clínica, rechazos, reintentos, leases, estados finales y artefactos. Pruebas web de configuración, permiso MASTER, clave conservada en fallos de red, 422, estados y descargas. Migración SQL revisada y schema validado; E2E con PostgreSQL separado y simulador, si se dispone de un motor local. No se ejecutan migraciones en bases reales del usuario.
