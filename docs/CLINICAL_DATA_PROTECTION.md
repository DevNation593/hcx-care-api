# Protección de datos clínicos almacenados

**Fecha:** 2026-10-01 · **Requisito:** SRS `RNF-05` (cifrado de información clínica) · **Tarea:** T-03

## Decisión

1. **El cifrado no es un módulo de pago.** Todo consultorio, en cualquier plan, tiene sus datos clínicos cifrados. `clinicalNotesEncryption` queda incluido en todos los planes con precio 0; el indicador `featureClinicalNotesEncryption` se conserva en la base solo por compatibilidad y ya no cambia el comportamiento.
2. **Dos capas.** El cifrado del almacenamiento y de los respaldos lo da el proveedor de PostgreSQL; encima, la API cifra los campos clínicos antes de escribirlos. La segunda capa protege frente a lo que la primera no cubre: un volcado de la base, una réplica, un respaldo copiado o una consulta SQL directa muestran solo texto cifrado.
3. **La clave vive fuera de la base de datos**, en la variable `CLINICAL_ENCRYPTION_KEYS` del entorno de la API. En producción la API no arranca sin ella.

## Qué se cifra

| Tabla | Columnas |
| --- | --- |
| `ClinicalNote` | `content`, `diagnosis`, `treatment`, `observations`, `deletionReason` |
| `SpecialtyRecord` | `data` (JSON), `notes`, `amendmentReason` |
| `AuditLog` de notas y registros | `changes` (instantáneas anterior/posterior), `reason` |

No se cifra lo que la base necesita para filtrar, ordenar o relacionar: identificadores, `tenantId`, `patientId`, autor, especialidad, `moduleKey`, fechas, duración y versión.

**Fuera de este alcance, todavía en texto plano:** planes de próxima sesión (`NextSessionPlan`), tareas, y los campos médicos básicos de `Patient` (`allergies`, `currentMedication`, `notes`). La búsqueda de pacientes filtra por nombre y correo, por eso la ficha demográfica no se cifra en esta entrega.

## Firma y adendas

La historia no se reescribe una vez firmada.

- **Cerrar una atención es firmarla.** Se guardan `signedAt`, `signedById` y `contentHash`: el SHA-256 (`v1:<hex>`) del contenido de la atención junto con la huella de cada registro y nota que contiene. Cada registro de la atención guarda también su propia huella y hora de firma.
- **Un registro fuera de toda atención** (un certificado o una receta sueltos) **se firma al guardarse.**
- **Lo firmado no se edita ni se elimina** (`409 CLINICAL_RECORD_SIGNED`). Se corrige con una **adenda**: un registro nuevo del mismo formulario, con `amendsRecordId` y un motivo obligatorio, que queda en la misma atención, cita y fecha del original. El original no cambia y se muestra como corregido; un registro admite una sola adenda (para volver a corregir, se corrige la adenda). La página pública de verificación avisa que el documento fue corregido.
- **Atenciones cerradas antes de este cambio:** quedan igual de definitivas, sin huella. No se calcula una huella retroactiva.
- La huella se calcula sobre el **texto descifrado**, con las claves de los objetos ordenadas y las fechas en ISO, así que rotar la clave de cifrado no la altera. Código: `src/clinical-access/clinical-signature.ts`.
- **Concurrencia:** escribir en una atención toma un bloqueo compartido sobre su fila y cerrarla toma uno exclusivo, así que nada entra en una atención después de firmada. Una corrección mientras la atención está abierta solo reemplaza la versión que leyó; si alguien guardó antes, responde `409 CLINICAL_RECORD_VERSION_CONFLICT` con `currentVersion`. El cliente puede enviar `version` para detectarlo desde el formulario.
- **Notas clínicas:** una nota dentro de una atención firmada tampoco se edita ni se elimina. Las notas sueltas (sin atención) mantienen la corrección auditada de siempre.
- **Archivos adjuntos:** al subir un archivo se guarda el SHA-256 de sus bytes descifrados (`PatientFile.contentHash`). La firma de la atención cubre cada archivo que contiene: categoría, nombre, descripción, tipo, tamaño y esa huella. Un archivo subido antes de que existiera la huella se lee del almacenamiento y se le calcula al firmar su atención. Un archivo de una atención firmada no se elimina (`409 PATIENT_FILE_SIGNED`); los archivos sueltos siguen eliminándose con motivo.
- **Identidad de quien firma:** toda firma explícita pide la contraseña del profesional aunque la sesión sea válida: cerrar una atención, guardar una adenda y guardar un registro fuera de toda atención. Una contraseña ausente o incorrecta responde `403 SIGNATURE_PASSWORD_INVALID` (nunca 401, para no cerrar la sesión). La contraseña solo se compara con bcrypt: no se guarda ni se registra. Las atenciones que una sesión de tratamiento cierra por sí misma no la piden.

## Cómo funciona

- Algoritmo: AES-256-GCM, IV aleatorio de 12 bytes por valor.
- El `tenantId` va como dato autenticado: un valor copiado a la fila de otro consultorio no se descifra.
- Formato de un texto: `enc:v1:<id de clave>:<iv>:<etiqueta>:<datos>` en base64url. Una columna JSON guarda `{ "$enc": "<el mismo formato>" }`.
- Un valor sin el prefijo `enc:v1:` se devuelve tal cual. Así las filas anteriores al cifrado se siguen leyendo hasta ejecutar la migración de datos.
- Código: `src/clinical-access/clinical-cipher.ts` (cifrado) y `clinical-crypto.service.ts` (configuración). Los servicios de notas, registros, línea clínica y auditoría cifran al escribir y descifran al devolver; el resto del sistema solo ve texto claro.

## Claves

`CLINICAL_ENCRYPTION_KEYS` es una lista separada por comas de entradas `id:clave`, donde la clave son 32 bytes en base64. **La primera entrada cifra; las demás solo descifran.**

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
```

```
CLINICAL_ENCRYPTION_KEYS=2026a:<base64>
```

- Guardarla en el gestor de secretos del despliegue, nunca en el repositorio ni en la base.
- Respaldarla por separado de los respaldos de la base. **Sin la clave, los datos cifrados no se pueden recuperar.**
- Fuera de producción, sin la variable, la API escribe en texto plano y lo avisa en el log.

### Rotación

1. Generar una clave nueva y ponerla **primera**, conservando la anterior: `CLINICAL_ENCRYPTION_KEYS=2027a:<nueva>,2026a:<anterior>`.
2. Desplegar. Lo nuevo se escribe con `2027a`; lo anterior se sigue leyendo con `2026a`.
3. Reescribir lo existente con la clave nueva:

   ```bash
   npm run prisma:encrypt-clinical-data -- --dry-run
   npm run prisma:encrypt-clinical-data
   ```

4. Repetir el paso con `--dry-run` hasta que `updated` sea 0 en las tres tablas.
5. Solo entonces retirar la clave anterior de la variable y volver a desplegar.

Si una clave se expone, se sigue el mismo procedimiento de inmediato.

## Migración de datos existentes

El mismo script cifra las filas que hoy están en texto plano. Se puede ejecutar varias veces: deja intactas las filas ya protegidas con la clave activa.

1. Respaldar la base.
2. Configurar `CLINICAL_ENCRYPTION_KEYS` y desplegar la API (ya lee tanto texto plano como cifrado).
3. `npm run prisma:encrypt-clinical-data -- --dry-run` para ver cuántas filas se tocarán.
4. `npm run prisma:encrypt-clinical-data`.
5. Comprobar con una consulta directa que `ClinicalNote.content` empieza por `enc:v1:` y abrir una nota desde la aplicación.

## Pendiente de verificar fuera del código

Estas comprobaciones dependen del entorno desplegado y no se han hecho:

- [ ] Confirmar en el proveedor de PostgreSQL que el almacenamiento y los respaldos están cifrados en reposo, y dejar la evidencia aquí.
- [ ] Confirmar que la conexión de la API a la base exige TLS.
- [ ] Guardar la clave en el gestor de secretos y definir quién tiene acceso.
- [ ] Ejecutar la migración de datos sobre una copia de producción antes de hacerlo en producción.
- [ ] Probar la restauración de un respaldo junto con la clave.

## Pruebas

- `src/clinical-access/clinical-cipher.spec.ts`: ida y vuelta, IV distinto por valor, rechazo de otro consultorio o de datos alterados, lectura de texto plano anterior, rotación y configuración.
- `src/clinical-access/clinical-encryption.spec.ts`: lo que llega a la base desde cada servicio es texto cifrado y lo que se devuelve es legible.
- `test/encrypt-clinical-data.spec.ts`: migración, rotación, segunda ejecución sin cambios y modo `--dry-run`.
- `test/clinical-records.e2e-spec.ts`: comprueba contra PostgreSQL que la fila y la auditoría no contienen el texto clínico.
