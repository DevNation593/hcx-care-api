import {
  ClinicalModuleDefinition,
  date,
  decimal,
  integer,
  longText,
  multiselect,
  section,
  select,
  table,
  text,
} from '../module-builders';

/**
 * Gynecology. The fields follow the gynecology module specification (sections 5 to 10): they
 * record what the professional assessed and decided, never infer it. Every clinical question
 * offers "unknown", "not assessed" or "not applicable" so a missing answer is never stored as a
 * negative one, nothing is filled in by default, and no rule interprets a result or raises a
 * clinical alert on its own.
 */
const gynecology = (
  definition: Omit<ClinicalModuleDefinition, 'scope' | 'specialtyCode' | 'renderer'>,
): ClinicalModuleDefinition => ({
  ...definition,
  scope: 'SPECIALTY',
  specialtyCode: 'GYNECOLOGY',
  renderer: 'FORM',
});

const YES_NO_UNKNOWN = { SI: 'Sí', NO: 'No', DESCONOCIDO: 'Desconocido' };
const YES_NO_UNKNOWN_NA = { ...YES_NO_UNKNOWN, NO_APLICA: 'No aplica' };

/** How each part of the physical exam went: an exam not performed is never a normal one. */
const EXAM_STATUS = {
  REALIZADO: 'Realizado',
  NO_REALIZADO: 'No realizado',
  DIFERIDO: 'Diferido',
  NO_APLICA: 'No aplica',
};

const exam = (key: string, label: string) => [
  select(`${key}Status`, label, EXAM_STATUS),
  longText(`${key}Findings`, `Hallazgos: ${label.toLowerCase()}`, {
    help: 'Solo lo efectivamente observado.',
  }),
];

/** Laboratory answers are kept literally, as the laboratory reported them. */
const LITERAL_RESULT_HELP =
  'Transcribe el resultado tal como lo reporta el laboratorio; el sistema no lo interpreta.';

export const GYNECOLOGY_MODULES: ClinicalModuleDefinition[] = [
  gynecology({
    moduleKey: 'gynecology.consultation',
    name: 'Consulta ginecológica',
    description:
      'Motivo, anamnesis, examen físico efectivamente realizado, evaluación, plan y seguimiento.',
    schemaVersion: 1,
    schema: {
      sections: [
        section('anamnesis', 'Motivo y anamnesis', [
          longText('chiefComplaint', 'Motivo de consulta', { required: true, maxLength: 2000 }),
          longText('historyPresentIllness', 'Enfermedad actual', {
            help: 'Anamnesis y evolución.',
          }),
          longText('reviewOfSystems', 'Revisión por sistemas'),
          select('allergiesReviewed', 'Alergias revisadas', {
            SI: 'Sí',
            NO: 'No',
          }),
          select('medicationsReviewed', 'Medicación revisada', {
            SI: 'Sí',
            NO: 'No',
          }),
        ]),
        section('exam', 'Examen físico', [
          ...exam('general', 'Examen general'),
          ...exam('abdominal', 'Examen abdominal'),
          ...exam('breast', 'Examen mamario'),
          ...exam('externalGenitalia', 'Genitales externos'),
          ...exam('speculum', 'Especuloscopia'),
          ...exam('bimanual', 'Tacto bimanual'),
          longText('examNotPerformedReason', 'Motivo si alguna parte no se realizó'),
          select('examConsent', 'Consentimiento para el examen', {
            VERBAL: 'Verbal, registrado',
            ESCRITO: 'Escrito',
            RECHAZADO: 'Rechazado',
            NO_APLICA: 'No aplica',
          }),
          select('chaperonePresent', 'Acompañante o asistente presente', YES_NO_UNKNOWN_NA),
        ]),
        section('assessment', 'Evaluación y plan', [
          longText('clinicalAssessment', 'Evaluación clínica', {
            required: true,
            help: 'Los diagnósticos codificados (CIE-10) se registran en el módulo de diagnósticos.',
          }),
          longText('managementPlan', 'Plan de manejo', {
            required: true,
            help: 'Conducta, estudios, tratamiento y derivaciones.',
          }),
          longText('patientInstructions', 'Indicaciones entregadas y signos de alarma'),
          date('followUpDate', 'Próxima revisión'),
          text('followUpReason', 'Motivo de la próxima revisión', { maxLength: 300 }),
        ]),
      ],
    },
  }),

  gynecology({
    moduleKey: 'gynecology.menstrual-history',
    name: 'Historia menstrual',
    description:
      'Menarquia, FUM con su certeza y fuente, ciclo, sangrado, dismenorrea y estado menopáusico.',
    schemaVersion: 1,
    schema: {
      sections: [
        section('menstrual', 'Ciclo menstrual', [
          integer('menarcheAgeYears', 'Edad de la menarquia', { unit: 'años', min: 5, max: 30 }),
          date('lastMenstrualPeriodDate', 'Fecha de última menstruación (FUM)', {
            help: 'Una FUM no implica embarazo. Deja vacío si no se conoce.',
          }),
          select('lmpCertainty', 'Certeza de la FUM', {
            SEGURA: 'Segura',
            APROXIMADA: 'Aproximada',
            DESCONOCIDA: 'Desconocida',
            NO_APLICA: 'No aplica',
          }),
          select('lmpSource', 'Fuente de la FUM', {
            REFERIDA: 'Referida por la paciente',
            REGISTRO: 'Registro clínico previo',
            OTRA: 'Otra',
          }),
          select('cycleRegular', 'Ciclo regular', YES_NO_UNKNOWN_NA),
          integer('typicalCycleDays', 'Duración habitual del ciclo', {
            unit: 'días',
            min: 10,
            max: 180,
          }),
          integer('bleedingDurationDays', 'Duración del sangrado', {
            unit: 'días',
            min: 1,
            max: 60,
          }),
          text('bleedingPattern', 'Patrón de sangrado', {
            maxLength: 500,
            help: 'Cantidad, irregularidad u otras características.',
          }),
          select('dysmenorrhea', 'Dismenorrea', {
            NO: 'No',
            LEVE: 'Leve',
            MODERADA: 'Moderada',
            SEVERA: 'Severa',
            DESCONOCIDO: 'Desconocido',
            NO_APLICA: 'No aplica',
          }),
          select('intermenstrualBleeding', 'Sangrado intermenstrual', YES_NO_UNKNOWN_NA),
          select('postcoitalBleeding', 'Sangrado poscoital', YES_NO_UNKNOWN_NA),
          longText('amenorrheaNotes', 'Amenorrea: observaciones', {
            help: 'Contexto descrito por el profesional; el sistema no infiere la causa.',
          }),
        ]),
        section('menopause', 'Menopausia y terapia hormonal', [
          select('menopauseStatus', 'Estado menopáusico', {
            PREMENOPAUSIA: 'Premenopausia',
            TRANSICION: 'Transición menopáusica',
            POSMENOPAUSIA: 'Posmenopausia',
            OTRO: 'Otro',
            NO_EVALUADO: 'No evaluado',
          }),
          integer('menopauseAgeYears', 'Edad de la menopausia', { unit: 'años', min: 15, max: 75 }),
          longText('hormonalTherapy', 'Terapia hormonal en curso'),
        ]),
      ],
    },
  }),

  gynecology({
    moduleKey: 'gynecology.gynecologic-history',
    name: 'Antecedentes ginecológicos',
    description:
      'Patologías y cirugías ginecológicas, síntomas, tamizajes previos, vacunación contra VPH y antecedentes familiares.',
    schemaVersion: 1,
    schema: {
      sections: [
        section('conditions', 'Patologías y síntomas', [
          multiselect('conditions', 'Patologías previas', {
            ENDOMETRIOSIS: 'Endometriosis',
            MIOMATOSIS: 'Miomatosis',
            SOP: 'Síndrome de ovario poliquístico',
            QUISTES_OVARICOS: 'Quistes ováricos',
            LESION_CERVICAL: 'Lesión cervical',
            ITS: 'Infección de transmisión sexual',
            OTRA: 'Otra',
          }),
          longText('conditionsDetail', 'Detalle de las patologías'),
          longText('symptoms', 'Síntomas actuales', {
            help: 'Dolor pélvico, dispareunia, síntomas urinarios o vulvovaginales, cuando proceda.',
          }),
        ]),
        section('surgeries', 'Cirugías ginecológicas', [
          table(
            'surgeries',
            'Cirugías',
            [
              text('procedure', 'Procedimiento', { required: true, maxLength: 200 }),
              text('approximateDate', 'Fecha aproximada', { maxLength: 50 }),
              text('organOrSide', 'Órgano o lado', { maxLength: 100 }),
              text('complications', 'Complicaciones', { maxLength: 300 }),
            ],
            { maxRows: 30 },
          ),
        ]),
        section('screening', 'Tamizajes y estudios previos', [
          table(
            'priorStudies',
            'Estudios previos',
            [
              select(
                'study',
                'Estudio',
                {
                  CITOLOGIA: 'Citología',
                  VPH: 'Prueba VPH',
                  COLPOSCOPIA: 'Colposcopia',
                  BIOPSIA: 'Biopsia',
                  TRATAMIENTO_CERVICAL: 'Tratamiento cervical',
                  MAMOGRAFIA: 'Mamografía',
                  ECOGRAFIA_MAMARIA: 'Ecografía mamaria',
                  OTRO: 'Otro',
                },
                { required: true },
              ),
              text('approximateDate', 'Fecha aproximada', { maxLength: 50 }),
              text('reportedResult', 'Resultado referido o reportado', { maxLength: 500 }),
              text('source', 'Fuente', { maxLength: 200 }),
            ],
            { maxRows: 40 },
          ),
          select('hpvVaccination', 'Vacunación contra VPH', {
            COMPLETA: 'Completa',
            INCOMPLETA: 'Incompleta',
            NO_VACUNADA: 'No vacunada',
            DESCONOCIDO: 'Desconocido',
          }),
          select('hpvVaccinationVerified', 'Vacunación verificada con documento', {
            SI: 'Sí',
            NO: 'No',
          }),
        ]),
        section('family', 'Antecedentes familiares', [
          longText('familyHistory', 'Neoplasias ginecológicas o mamarias en la familia', {
            help: 'Solo cuando sea clínicamente pertinente.',
          }),
        ]),
      ],
    },
  }),

  gynecology({
    moduleKey: 'gynecology.obstetric-history',
    name: 'Antecedentes obstétricos',
    description:
      'Un registro por embarazo previo con su resultado. No calcula fórmulas G/P: guarda los hechos.',
    schemaVersion: 1,
    schema: {
      sections: [
        section('history', 'Embarazos previos', [
          select('historyStatus', 'Antecedentes', {
            REGISTRADOS: 'Registrados abajo',
            SIN_EMBARAZOS: 'Sin embarazos previos',
            NO_INFORMADO: 'No informado',
            DESCONOCIDO: 'Desconocido',
          }),
          table(
            'pregnancies',
            'Embarazos',
            [
              integer('year', 'Año', { min: 1940, max: 2100 }),
              select(
                'outcome',
                'Resultado',
                {
                  PARTO_VAGINAL: 'Parto vaginal',
                  CESAREA: 'Cesárea',
                  PERDIDA_GESTACIONAL: 'Pérdida gestacional',
                  ECTOPICO: 'Embarazo ectópico',
                  OTRO: 'Otro',
                  DESCONOCIDO: 'Desconocido',
                },
                { required: true },
              ),
              integer('fetuses', 'Número de fetos', { min: 1, max: 8 }),
              integer('liveBirths', 'Nacidos vivos', { min: 0, max: 8 }),
              text('complications', 'Complicaciones relevantes', { maxLength: 300 }),
            ],
            { maxRows: 20 },
          ),
          longText('notes', 'Observaciones'),
        ]),
      ],
    },
  }),

  gynecology({
    moduleKey: 'gynecology.contraception',
    name: 'Anticoncepción',
    description:
      'Método actual, vigencia, cambios, efectos referidos, dispositivo, consejería y decisión de la paciente.',
    schemaVersion: 1,
    schema: {
      sections: [
        section('method', 'Método', [
          select('method', 'Método anticonceptivo', {
            NINGUNO: 'Ninguno',
            PRESERVATIVO: 'Preservativo',
            ORAL_COMBINADO: 'Oral combinado',
            ORAL_PROGESTAGENO: 'Oral solo progestágeno',
            INYECTABLE: 'Inyectable',
            IMPLANTE: 'Implante subdérmico',
            DIU_COBRE: 'DIU de cobre',
            DIU_HORMONAL: 'DIU hormonal',
            ANILLO: 'Anillo vaginal',
            PARCHE: 'Parche',
            ESTERILIZACION: 'Esterilización quirúrgica',
            NATURAL: 'Método natural',
            OTRO: 'Otro',
            NO_INFORMADO: 'No informado',
          }),
          select('status', 'Estado', {
            EN_USO: 'En uso',
            SUSPENDIDO: 'Suspendido',
            CAMBIADO: 'Cambiado',
          }),
          date('startedOn', 'Inicio'),
          date('endedOn', 'Fin'),
          text('reasonForChange', 'Motivo del cambio o suspensión', { maxLength: 500 }),
          longText('reportedSideEffects', 'Efectos referidos'),
        ]),
        section('device', 'Dispositivo', [
          text('deviceIdentification', 'Identificación del dispositivo', { maxLength: 200 }),
          text('lot', 'Lote', { maxLength: 100 }),
          date('expiry', 'Caducidad'),
        ]),
        section('counseling', 'Consejería', [
          select('reproductiveIntention', 'Intención reproductiva', {
            DESEA_EMBARAZO: 'Desea embarazo',
            NO_DESEA: 'No desea embarazo por ahora',
            INDECISA: 'Indecisa',
            NO_INFORMADO: 'No informado',
          }),
          longText('counselingNotes', 'Consejería realizada'),
          longText('patientDecision', 'Decisión de la paciente'),
          date('followUpDate', 'Control'),
        ]),
      ],
    },
  }),

  gynecology({
    moduleKey: 'gynecology.iud-procedure',
    name: 'Procedimiento con DIU',
    description:
      'Inserción, retiro o recambio de DIU con dispositivo, lote, incidencias y control.',
    schemaVersion: 1,
    schema: {
      sections: [
        section('procedure', 'Procedimiento', [
          select(
            'procedure',
            'Procedimiento',
            { INSERCION: 'Inserción', RETIRO: 'Retiro', RECAMBIO: 'Recambio' },
            { required: true },
          ),
          select('deviceType', 'Tipo de DIU', {
            COBRE: 'Cobre',
            HORMONAL: 'Hormonal',
            OTRO: 'Otro',
          }),
          text('deviceIdentification', 'Identificación del dispositivo', { maxLength: 200 }),
          text('lot', 'Lote', { maxLength: 100 }),
          date('expiry', 'Caducidad'),
          select('consentRecorded', 'Consentimiento informado', {
            REGISTRADO: 'Registrado en el módulo de consentimiento',
            ADJUNTO: 'Documento adjunto',
            NO_REGISTRADO: 'No registrado',
          }),
          longText('description', 'Descripción del procedimiento', { required: true }),
          longText('incidents', 'Incidencias'),
          longText('instructions', 'Indicaciones entregadas'),
          date('followUpDate', 'Control'),
        ]),
      ],
    },
  }),

  gynecology({
    moduleKey: 'gynecology.cytology-hpv',
    name: 'Citología y prueba VPH',
    description:
      'Toma de muestra, laboratorio, reporte literal, revisión médica y comunicación a la paciente.',
    schemaVersion: 1,
    schema: {
      sections: [
        section('sample', 'Muestra', [
          select(
            'study',
            'Estudio',
            {
              CITOLOGIA_CONVENCIONAL: 'Citología convencional',
              CITOLOGIA_LIQUIDA: 'Citología en base líquida',
              VPH: 'Prueba VPH',
              COTEST: 'Citología y prueba VPH',
            },
            { required: true },
          ),
          longText('indication', 'Indicación'),
          date('sampleDate', 'Fecha de toma'),
          text('sampleType', 'Tipo de muestra', { maxLength: 200 }),
          text('laboratory', 'Laboratorio', { maxLength: 200 }),
          text('laboratoryReference', 'Folio o referencia del laboratorio', { maxLength: 100 }),
        ]),
        section('report', 'Reporte del laboratorio', [
          date('reportReceivedDate', 'Fecha de recepción del reporte'),
          text('classificationSystem', 'Sistema de clasificación y versión', {
            maxLength: 100,
            help: 'El que usa el laboratorio, por ejemplo Bethesda 2014.',
          }),
          longText('cytologyResult', 'Resultado de citología', { help: LITERAL_RESULT_HELP }),
          text('hpvAssay', 'Ensayo VPH', { maxLength: 200 }),
          longText('hpvResult', 'Resultado VPH', { help: LITERAL_RESULT_HELP }),
          select('sampleAdequacy', 'Calidad de la muestra según el laboratorio', {
            ADECUADA: 'Adecuada',
            INADECUADA: 'Inadecuada',
            NO_REPORTADA: 'No reportada',
          }),
        ]),
        section('review', 'Revisión y seguimiento', [
          date('reviewedOn', 'Fecha de revisión médica'),
          longText('reviewNotes', 'Revisión y conducta'),
          date('patientInformedOn', 'Fecha en que se informó a la paciente'),
          date('followUpDate', 'Próximo control indicado'),
        ]),
      ],
    },
  }),

  gynecology({
    moduleKey: 'gynecology.colposcopy',
    name: 'Colposcopia',
    description: 'Indicación, hallazgos descritos por el médico, biopsia y plan.',
    schemaVersion: 1,
    schema: {
      sections: [
        section('colposcopy', 'Colposcopia', [
          longText('indication', 'Indicación', { required: true }),
          longText('findings', 'Hallazgos', {
            required: true,
            help: 'Descritos por el médico. Las imágenes se adjuntan como archivos de la atención.',
          }),
          select('biopsyTaken', 'Se tomó biopsia', { SI: 'Sí', NO: 'No' }),
          text('biopsySites', 'Sitios de biopsia', { maxLength: 300 }),
          text('specimenId', 'Identificador de la muestra', { maxLength: 100 }),
          longText('impression', 'Impresión'),
          longText('plan', 'Plan', { required: true }),
        ]),
      ],
    },
  }),

  gynecology({
    moduleKey: 'gynecology.ultrasound',
    name: 'Ecografía ginecológica',
    description: 'Vía, mediciones con unidades, hallazgos, impresión e informante.',
    schemaVersion: 1,
    schema: {
      sections: [
        section('study', 'Estudio', [
          select(
            'route',
            'Vía',
            { TRANSVAGINAL: 'Transvaginal', TRANSABDOMINAL: 'Transabdominal', OTRA: 'Otra' },
            { required: true },
          ),
          table(
            'measurements',
            'Mediciones',
            [
              text('structure', 'Estructura', { required: true, maxLength: 100 }),
              text('dimension', 'Medida', { maxLength: 100 }),
              decimal('value', 'Valor', { required: true, min: 0, max: 100000 }),
              select(
                'unit',
                'Unidad',
                { MM: 'mm', CM: 'cm', ML: 'mL', CM3: 'cm³' },
                { required: true },
              ),
            ],
            { maxRows: 40 },
          ),
          longText('findings', 'Hallazgos', { required: true }),
          longText('impression', 'Impresión', { required: true }),
          text('reportedBy', 'Informante', { maxLength: 200 }),
        ]),
      ],
    },
  }),

  gynecology({
    moduleKey: 'gynecology.biopsy',
    name: 'Biopsia',
    description: 'Sitio, muestra, reporte histopatológico literal, revisión y comunicación.',
    schemaVersion: 1,
    schema: {
      sections: [
        section('sample', 'Muestra', [
          text('site', 'Sitio de extracción', { required: true, maxLength: 300 }),
          text('technique', 'Técnica', { maxLength: 200 }),
          text('specimenId', 'Identificador de la muestra', { maxLength: 100 }),
          text('laboratory', 'Laboratorio de patología', { maxLength: 200 }),
          date('sampleDate', 'Fecha de toma'),
        ]),
        section('report', 'Reporte histopatológico', [
          date('reportReceivedDate', 'Fecha de recepción del reporte'),
          longText('histopathologyReport', 'Reporte', { help: LITERAL_RESULT_HELP }),
        ]),
        section('review', 'Revisión y seguimiento', [
          date('reviewedOn', 'Fecha de revisión médica'),
          longText('reviewNotes', 'Revisión y conducta'),
          date('patientInformedOn', 'Fecha en que se informó a la paciente'),
        ]),
      ],
    },
  }),

  gynecology({
    moduleKey: 'gynecology.menopause',
    name: 'Climaterio y menopausia',
    description: 'Síntomas, antecedentes y factores de riesgo, tratamiento en curso y plan.',
    schemaVersion: 1,
    schema: {
      sections: [
        section('climacteric', 'Climaterio', [
          multiselect('symptoms', 'Síntomas referidos', {
            SOFOCOS: 'Sofocos',
            SUDORACION_NOCTURNA: 'Sudoración nocturna',
            ALTERACION_SUENO: 'Alteración del sueño',
            SEQUEDAD_VAGINAL: 'Sequedad vaginal',
            CAMBIOS_ANIMO: 'Cambios del estado de ánimo',
            DOLOR_ARTICULAR: 'Dolor articular',
            OTROS: 'Otros',
          }),
          longText('symptomsDetail', 'Detalle de los síntomas'),
          longText('riskFactors', 'Antecedentes y factores de riesgo'),
          longText('currentTreatment', 'Tratamiento en curso'),
          longText('plan', 'Plan individualizado', { required: true }),
        ]),
      ],
    },
  }),

  gynecology({
    moduleKey: 'gynecology.fertility',
    name: 'Consulta de fertilidad',
    description: 'Tiempo referido, estudios, evolución y derivación, sin inferencias automáticas.',
    schemaVersion: 1,
    schema: {
      sections: [
        section('fertility', 'Fertilidad', [
          integer('monthsTrying', 'Tiempo buscando embarazo', { unit: 'meses', min: 0, max: 600 }),
          longText('priorStudies', 'Estudios previos'),
          longText('orderedStudies', 'Estudios solicitados'),
          longText('evolution', 'Evolución'),
          text('referral', 'Derivación', { maxLength: 300 }),
          longText('plan', 'Plan', { required: true }),
        ]),
      ],
    },
  }),
];
