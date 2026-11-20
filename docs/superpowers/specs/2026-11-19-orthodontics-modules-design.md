# Ortodoncia dentro de Odontología — diseño

Fecha: 2026-11-19 · Estado: propuesto

## Intención

Que un ortodoncista registre su trabajo de forma estructurada (oclusión, cefalometría, plan con
aparatología y controles de ajuste) en lugar de escribirlo como texto libre en las observaciones
de Odontología. Los ortodoncistas también hacen odontología general, así que necesitan el
odontograma, el plan de tratamiento y la evolución odontológica en el mismo paciente.

## Objetivos

- Cuatro módulos clínicos nuevos de ortodoncia, propiedad de la especialidad `DENTISTRY`.
- Cualquier profesional con perfil de Odontología puede escribirlos; el consultorio los activa o
  desactiva uno por uno, como cualquier módulo de especialidad.
- Un paciente de demostración con un tratamiento de ortodoncia en curso.

## No objetivos

- Ortodoncia como especialidad propia (`ORTHODONTICS`) en catálogo, equipo o agenda.
- Cambios en la lógica de acceso clínico, guards o permisos.
- Tablas nuevas, renderizadores nuevos (cefalograma, trazados) o cálculos cefalométricos.
- Almacenar fotos, radiografías o modelos dentro de los módulos: se suben como archivos del
  paciente, como hoy.

## Anti-objetivos

- Que el sistema interprete un valor (clase, overjet, medida cefalométrica) o marque algo como
  normal por defecto. Lo no evaluado debe quedar como no evaluado.

## Enfoques considerados

- **A. Módulos dentro de Odontología (elegido).** Claves `dentistry.ortho-*` con
  `specialtyCode: 'DENTISTRY'`. Mismo patrón que Ginecología; no toca acceso clínico. Contra:
  "Ortodoncia" no aparece como especialidad propia.
- **B. Especialidad `ORTHODONTICS` que hereda los módulos de Odontología.** Nombre propio en
  catálogo y agenda, pero exige cambiar la regla de escritura por especialidad
  (`clinical-modules.service.ts`, guard de especialidad), zona sensible. Puede construirse
  encima de A más adelante sin rehacer los módulos.
- Especialidad aislada sin herencia: descartada, dejaría al ortodoncista sin odontograma.

Se eligió A por dar todo lo clínico con el menor riesgo.

## Restricciones

- Todo vive en el motor de módulos existente (`module-builders`, renderer `FORM`), en
  `src/clinical-modules/definitions/orthodontics.ts`, registrado en `CLINICAL_MODULES`.
- Versión de esquema 1 para los cuatro; las versiones nunca se editan después de publicadas.
- Convenciones de Ginecología: cada pregunta clínica ofrece "No evaluado" / "No evaluable" /
  "No aplica" según corresponda, nada viene relleno, ninguna regla genera alertas.
- Piezas en notación FDI reutilizando las opciones de `dentistry.ts` (exportarlas si hace falta).

## Módulos

### `dentistry.ortho-assessment` — Diagnóstico ortodóntico

- Motivo de consulta (obligatorio) y dentición (permanente, mixta, temporal).
- Análisis facial: perfil (recto, convexo, cóncavo, no evaluado), simetría facial, competencia
  labial, sonrisa (texto).
- Análisis funcional: respiración (nasal, oral, mixta, no evaluada), deglución (normal, atípica,
  no evaluada), hábitos (selección múltiple: succión digital, interposición lingual, respiración
  oral, onicofagia, bruxismo, otro), ATM (texto).
- Oclusión: clase molar derecha/izquierda y clase canina derecha/izquierda (I, II, III, no
  evaluable); división de la Clase II (1, 2, no aplica, no evaluada); plano terminal derecho e
  izquierdo para dentición temporal (recto, escalón mesial, escalón distal, no evaluable); overjet y
  overbite en mm (decimales, admiten negativos); mordida cruzada
  (anterior, posterior derecha, posterior izquierda, ausente, no evaluada); mordida abierta
  (anterior, posterior, ausente, no evaluada); desviación de línea media superior e inferior
  (mm y dirección); apiñamiento superior e inferior (ausente, leve, moderado, severo, no
  evaluado).
- Registros tomados (selección múltiple): fotos extraorales, fotos intraorales, panorámica,
  cefálica lateral, modelos o escaneo.
- Diagnóstico ortodóntico (obligatorio) y observaciones.

### `dentistry.ortho-cephalometry` — Análisis cefalométrico

- Fecha de la radiografía y análisis usado (Steiner, Ricketts, McNamara, otro).
- Tabla de medidas: medida (texto), valor (decimal), unidad (texto). Se transcribe tal cual.
- Interpretación del profesional (obligatoria) y observaciones.

### `dentistry.ortho-treatment-plan` — Plan ortodóntico

- Objetivos del tratamiento (obligatorio).
- Aparatología (fija metálica, fija estética, autoligado, lingual, alineadores, removible,
  ortopédica/funcional, otro), prescripción (Roth, MBT, otra), slot (.018, .022, no aplica),
  arcadas (superior, inferior, ambas).
- Extracciones indicadas (sí, no, por definir) y piezas a extraer (FDI, selección múltiple).
- Auxiliares (selección múltiple: expansor, minitornillos, elásticos intermaxilares, arco
  transpalatino, barra lingual, otro).
- Tabla de fases: fase, objetivo, duración estimada en meses, estado (pendiente, en curso,
  completada).
- Duración total estimada (meses), retención planificada (fija, removible, ambas, por definir),
  costo estimado y observaciones.

### `dentistry.ortho-control` — Control ortodóntico

- Tipo de cita (obligatorio): instalación, ajuste, control de rutina o entrega de alineadores,
  observación o control de crecimiento, recementado, emergencia, retiro de aparatología, control
  de retención.
- Arco superior e inferior (texto, p. ej. "NiTi .014"), ligaduras (texto), elásticos indicados
  (texto), alineador actual y total (enteros).
- Brackets despegados (piezas FDI, selección múltiple).
- Higiene y cooperación (buena, regular, deficiente, no evaluada).
- Procedimiento realizado (obligatorio), indicaciones al paciente, próximo control (fecha) y
  observaciones.

## Alta en la base de datos

Migración nueva que inserta los cuatro `SpecialtyModule` de `DENTISTRY` (idempotente, mismo
patrón que `20261108000000_gynecology_specialty`) y los activa (`TenantModule`) para todo consultorio
que ya tenga Odontología, como hizo la migración de `dentistry.evolution`. Aún no hay consultorios,
pero así la migración es correcta en cualquier base; los que activen Odontología después reciben
los módulos como cualquier módulo de la especialidad. Si el catálogo aún no tiene `DENTISTRY`, la
migración la crea (sin tocar una fila existente, inactiva incluida), para que los módulos nunca
queden sin especialidad.

Verificación:

- `npm run prisma:verify-orthodontic-modules` (CI): en esquemas desechables aplica la migración
  sobre consultorios existentes (con Odontología, con otra especialidad, sin especialidades y con
  una fila de módulo previa que debe conservarse) y sobre un catálogo sin `DENTISTRY`, y comprueba
  las filas exactas de `SpecialtyModule` y `TenantModule`.
- `npm run prisma:audit-orthodontic-modules`: solo lectura contra `DATABASE_URL`; lista las
  asociaciones que falten y termina con código 1 si hay alguna. Para correr tras desplegar.

## Demo y pruebas

- El seed de demostración agrega un paciente sintético con diagnóstico, plan y al menos un
  control de ortodoncia, en el consultorio de demo que ya tiene Odontología.
- Pruebas unitarias del estilo de `gynecology.spec.ts`: claves y versiones, que ningún campo
  tenga valor por defecto, que las preguntas clínicas ofrezcan la opción "no evaluado", y que un
  registro válido y uno inválido pasen y fallen la validación.
- La prueba e2e del seed clínico cubre los registros de ortodoncia de la demo.

## Web (PR aparte contra `dev`)

Nombres y descripciones de las cuatro claves en
`web/src/features/admin/specialties/module-labels.ts`. Los formularios se dibujan solos a partir
del esquema.

## Decisiones del implementador

- Textos exactos de etiquetas y ayudas, límites numéricos (rangos de mm, `maxRows`), y si una
  sección agrupa uno u otro campo.
- Datos concretos del paciente de demo.
