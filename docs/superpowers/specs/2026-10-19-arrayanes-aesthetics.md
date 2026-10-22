# Demo única y estudios estéticos

> **Reemplazado** en su parte estética por `2026-10-22-aesthetics-shared-modules-design.md`: Estética es una especialidad sobre los módulos compartidos; ya no hay tablas `Aesthetic*` ni `businessKind`.

## Alcance acordado

- La seed de demostración crea una sola cuenta cliente: Centro Médico Los Arrayanes. La cuenta de administración de plataforma y los catálogos globales siguen presentes.
- Los Arrayanes incorpora Medicina General al catálogo, al conjunto de especialidades del centro y a un usuario profesional con perfil activo.
- El dueño de la plataforma puede crear estudios estéticos y asignar sus módulos y permisos por rol. El titular del estudio administra su propia operación, sin acceso a asignar módulos de plataforma.
- La primera versión estética incluye clientes, agenda, servicios, sesiones, consentimientos y fotos. No utiliza pacientes, citas, expedientes, tratamientos ni archivos clínicos médicos.

## Diseño

`Tenant.businessKind` diferencia `MEDICAL` y `AESTHETIC_STUDIO`, independientemente de `TenantType` (tamaño del equipo). Las cuentas existentes reciben `MEDICAL` por defecto. La sección `core.aesthetics` es exclusiva del estudio; las secciones médicas no se pueden habilitar para él, y el guard del servidor verifica el tipo incluso si se modifica una fila de `TenantModule` por fuera del panel. La API del estudio mantiene clientes, reservas, servicios, sesiones, aceptaciones de consentimiento y fotos en tablas propias, todas limitadas por `tenantId`. Las fotos se cifran y guardan mediante el proveedor de archivos configurado para la API.

La aplicación presenta una ruta `Estética` con vistas para las seis funciones y oculta la navegación médica en cuentas estéticas. Los permisos `aesthetics.*` se asignan por rol desde el panel de plataforma. Un profesional de estudio no requiere una especialidad médica, pero sí ocupa una plaza del plan.

## Límites

- `prisma:seed` corre sobre la base de `DATABASE_URL`, producción incluida, para mostrar las demos (decisión del 2026-10-21): borra todas las cuentas y registros antes de recrearlas. Además de Los Arrayanes crea el estudio estético Aurora.
- La migración de esquema será aditiva y dejará todos los tenants actuales como `MEDICAL`.
- La foto y su metadata no serán públicas ni contendrán claves de Storage en las respuestas.
- El registro de aceptación indica quién la registró y cuándo. No pretende sustituir una firma electrónica avanzada.
