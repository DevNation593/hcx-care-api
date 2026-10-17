# Entrega B2: emite-facil

Estado: implementación y revisión final completadas; ramas listas para integración.

La configuración está en **Administración → Facturación** (`/admin/billing`), para el
titular MASTER. Permite probar la API key, elegir el emisor y asignar establecimiento
y punto de emisión por sede. Los secretos guardados se muestran solo como presentes.

**Caja → Facturas** y el detalle de cada orden muestran las solicitudes, su resultado
del SRI y los archivos disponibles. La ficha del paciente incorpora las nuevas
facturas y conserva el historial anterior de Faktur.

## Activación

Los cambios están en `feat/emite-facil-b2` de API (`d2d9d8f`) y web (`26be62b`),
en sus respectivos `.worktrees/emite-facil-b2`. Integrar esas ramas o ejecutar
ambos worktrees permite usar la nueva pantalla. Los checkouts `dev` se conservan.

El usuario configurará manualmente `EMITE_FACIL_API_URL` con el servidor real y la
ruta `/api/v1/`. El ejemplo permanece vacío. El backend necesita las claves de cifrado
y el almacenamiento persistente ya documentados en [DEPLOYMENT](../../DEPLOYMENT.md).
La migración nueva es `20261017000000_emite_facil_b2`; se aplica con
`npx prisma migrate deploy` durante la integración/despliegue.

Después, el MASTER prueba y guarda la API key/emisor en la pantalla y asigna los
puntos por sede. El webhook es opcional: `BACKEND_PUBLIC_URL` permite mostrar la URL
que se registra manualmente en emite-facil y cuyo secreto se pega en HCX. El worker
y la conciliación también funcionan sin webhook.

Se validó con PostgreSQL desechable y un simulador HTTP local. La conectividad y la
emisión contra el servidor real quedan pendientes de su configuración manual.

## Evidencia

| Área | Resultado |
| --- | --- |
| API, suite completa | 123 suites, 2239 aprobadas y 1 omitida |
| API, corrección de permisos | 106 focalizadas aprobadas; 18 E2E B2 aprobadas |
| API, concurrencia clínica/fiscal | 6 regresiones PostgreSQL en ambos órdenes; 24 E2E B2 y 11 E2E B1 aprobadas; 370 unitarias relacionadas aprobadas |
| Caja B1 | 11 E2E aprobadas |
| Web, suite completa | 115 suites, 1012 aprobadas y 1 omitida |
| Web, corrección de reintentos | 93 focalizadas aprobadas |
| Esquema/migración | Prisma validate y comparación contra PostgreSQL sin diferencias |
| Compilación | API y Next aprobados; Next generó 47 páginas con URLs públicas reservadas de prueba |
| Análisis estático | TypeScript y lint aprobados; API conserva una advertencia preexistente |

La suite completa precedió las correcciones focalizadas; sus pruebas de regresión y
comprobaciones de tipos/lint se ejecutaron después. Los reportes
[backend](2026-10-17-emite-facil-b2-backend.md) y
[web](2026-10-17-emite-facil-b2-frontend.md) contienen comandos y evidencia RED/GREEN.
La [revisión del conjunto](2026-10-17-emite-facil-b2-integration-review.md)
detectó una carrera entre autorización y cierre clínico. La
[corrección y sus pruebas](2026-10-17-emite-facil-b2-concurrency-fix.md) quedaron
[aprobadas en la revisión acotada](2026-10-17-emite-facil-b2-integration-fix-review.md).
No quedan hallazgos críticos o importantes. La prueba de desbordamiento del cuerpo
HTTP quedó como cobertura menor pendiente; los límites de producción existen.

## Decisiones de implementación

| Decisión | Motivo e implicación |
| --- | --- |
| API key estática y webhook manual opcional | Corresponde al contrato actual del proveedor. Una futura autenticación distinta requiere adaptar el puerto. |
| `CUSTOMER_SYNC_REQUIRED` ante datos fiscales diferentes | El proveedor carece de actualización de clientes. Se corrige el receptor en emite-facil antes de emitir. |
| Worktrees y ramas locales preservados | Mantienen los checkouts actuales; la integración y publicación quedan a cargo del usuario. |
| Mensajes SRI desde `documents/:id/sri-attempts` | El detalle del documento no contiene todos los motivos. Un cambio de ese endpoint requiere adaptar las explicaciones. |
| Empresa/emisor estables después de la primera solicitud | Conserva la propiedad de documentos y referencias. Rotar la key para la misma identidad sigue permitido; cambiar empresa requiere una migración explícita. |
| Cambio de ambiente del mismo emisor cuando está conciliado | Exige ausencia de solicitudes activas/inciertas y archivos autorizados pendientes. Los snapshots conservan el ambiente y se bloquean reemplazos entre ambientes. |
| `SIGNATURE_FAILED` permanece en proceso | El proveedor puede reintentar ese mismo documento. Se corrige la firma allí mientras HCX sigue conciliando y mantiene los bloqueos de reemisión/devolución. |
| POST confirma la solicitud sin descifrar errores | `billing.create` y `billing.view` son independientes. Las explicaciones se obtienen mediante consultas con `billing.view`. |
| Incertidumbre local por cada intento de emisión | El rechazo anterior no resuelve una reemisión sin respuesta. Se conserva el UUID y se consulta cada cinco segundos, con permiso de lectura, hasta recuperar la solicitud. |
| Recuperación mediante recibo de la misma clave | Una lista tardía o una solicitud de otro usuario no demuestra a qué clave pertenece el resultado. Un fallo seguro observado mantiene el UUID incierto hasta recuperar su recibo mediante el mismo POST; una autorización impide permanentemente la nueva emisión. |
| Bloqueo común entre cierre clínico y finalización fiscal | Serializa ambos cambios sobre la solicitud de factura; si cambia mientras se completa una atención, la transacción clínica relee el resultado y evita dejarla pendiente tras la autorización o rechazo. |
