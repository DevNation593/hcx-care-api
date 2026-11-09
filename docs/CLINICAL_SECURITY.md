# Consentimientos de procedimientos, antivirus y verificación en dos pasos

Fase 4 del módulo de ginecología, aplicable a todas las especialidades de salud. Cubre §12 (consentimiento), SEG-01 (MFA), SEG-09 y CA-015 (archivos) de la especificación del módulo. La huella SHA-256 de los archivos llegó en la fase 2.

## Consentimientos de procedimientos

Un procedimiento clínico (inserción de DIU, colposcopia, biopsia) se consiente dentro de una atención abierta, con el mismo circuito que las sesiones de tratamiento:

- **Plantilla versionada:** se presenta la última versión publicada de una plantilla del consultorio, con `{{paciente}}`, `{{identificacion}}`, `{{procedimiento}}` (también `{{tratamiento}}`), `{{profesional}}` y `{{fecha}}`. El documento guarda el texto que vio el paciente, cifrado, y su huella.
- **Decisión:** firma (paciente o representante, con relación; menor de edad exige representante), con declaraciones, firma dibujada, testigo opcional y PDF cifrado con su SHA-256; o rechazo con motivo. Revocación posterior con motivo, por el profesional de la atención o el titular. Cada paso queda como evento con su autor.
- **No bloquea la atención:** un rechazo se registra y nada más; decidir si seguir es del profesional (§12.2).
- **Quién:** presenta, firma y registra el rechazo solo el profesional de la atención; leer y descargar, cualquier profesional con perfil activo. Las rutas de las sesiones de tratamiento no actúan sobre estos documentos ni al revés.
- **Plantillas:** se administran en Clínica › Consentimientos, que exige la sección «Consentimientos» del consultorio.

Rutas: `GET /procedure-consents/templates`, `GET /patients/{id}/procedure-consents`, `POST /patients/{id}/encounters/{encounterId}/procedure-consents`, `POST /procedure-consents/{id}/sign|refuse|revoke`, `GET /procedure-consents/{id}/pdf`.

## Antivirus de archivos

Con `FILE_SCAN_DRIVER=clamav` cada archivo del paciente (también las fotos de sesiones) pasa por ClamAV antes de guardarse, sin tocar disco del lado de la API (comando `INSTREAM` de clamd):

| Resultado | Qué pasa |
| --- | --- |
| Limpio | Se guarda con `scanStatus CLEAN`, la fecha y el motor (`ClamAV 1.4.1/27450`). |
| Infectado | `422 PATIENT_FILE_INFECTED`; no se guarda nada. El log registra la firma y el consultorio, nunca el nombre del archivo ni el paciente. |
| clamd no responde | `503 FILE_SCAN_UNAVAILABLE`; no se guarda nada. |

Los archivos guardados antes (`NOT_SCANNED`) se analizan en su siguiente descarga; si resultan infectados quedan `INFECTED` y no se vuelven a entregar. Sin la variable, los archivos se guardan como `NOT_SCANNED`. La variable se configura en `docs/DEPLOYMENT.md`; clamd debe correr fuera de Vercel.

## Verificación en dos pasos (MFA)

- **TOTP** (RFC 6238, 6 dígitos, 30 s, ±1 paso) con cualquier aplicación de autenticación. Se activa desde el perfil: contraseña, código QR, un código para confirmar y 10 códigos de recuperación que se muestran una vez.
- **Almacenamiento:** el secreto, cifrado con las claves clínicas (el script `prisma:encrypt-clinical-data` lo recifra al rotar). Los códigos de recuperación se guardan como SHA-256 y cada uno sirve una vez. Un código TOTP no se acepta dos veces: se guarda el último paso usado.
- **Inicio de sesión:** con MFA, la contraseña correcta devuelve `{ mfaRequired, mfaToken }` (válido 5 minutos, firmado con un secreto propio) y la sesión se abre con `POST /auth/mfa/verify` y un código o un código de recuperación.
- **Obligatoria por consultorio:** `TenantSettings.requireMfa` (Configuración › Seguridad de las cuentas) la exige al titular y a los profesionales; para los administradores de plataforma, `PLATFORM_ADMIN_MFA_REQUIRED=true`. Quien no la tenga recibe `403 MFA_ENROLLMENT_REQUIRED` en todo salvo sus rutas de sesión hasta configurarla, y mientras sea obligatoria no puede desactivarla. Asistentes y cajeros pueden activarla pero no se les exige todavía.
- **Teléfono perdido:** el titular la restablece desde Equipo (`POST /users/{id}/mfa/reset`), lo que cierra las sesiones de esa persona. Si el titular pierde el suyo, lo restablece el soporte de la plataforma en la base de datos.
- **Auditoría:** activar, desactivar, regenerar códigos y restablecer quedan en el log de auditoría del consultorio (`USER`).

## Lo que queda fuera

- Acceso de emergencia (`break-glass`), lista de dispositivos y aviso de accesos anómalos (SEG-16, T-28).
- Versiones de archivos (un archivo corregido se sube como otro).
- Revisión jurídica de los mecanismos de firma (§12.2) y de los textos de consentimiento.
