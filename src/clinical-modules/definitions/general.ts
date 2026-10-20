import {
  calculated,
  checkbox,
  ClinicalModuleDefinition,
  date,
  decimal,
  integer,
  longText,
  section,
  select,
  signature,
  table,
  text,
} from '../module-builders';

/**
 * Specialties whose professionals may issue prescriptions. DENTISTRY and GENERAL_MEDICINE are
 * in the catalog; other medical codes work as soon as they are added to it.
 */
export const PRESCRIBER_SPECIALTY_CODES = [
  'DENTISTRY',
  'ORTHODONTICS',
  'GENERAL_MEDICINE',
  'INTERNAL_MEDICINE',
  'PEDIATRICS',
  'PSYCHIATRY',
  'GYNECOLOGY',
  'OBSTETRICS',
  'CARDIOLOGY',
  'DERMATOLOGY',
  'OPHTHALMOLOGY',
  'NEUROLOGY',
  'ENDOCRINOLOGY',
  'TRAUMATOLOGY',
  'SPORTS_MEDICINE',
] as const;

const general = (
  definition: Omit<ClinicalModuleDefinition, 'scope' | 'specialtyCode' | 'renderer'>,
): ClinicalModuleDefinition => ({
  ...definition,
  scope: 'GENERAL',
  specialtyCode: null,
  renderer: 'FORM',
});

const PRIORITY = { RUTINA: 'Rutina', PREFERENTE: 'Preferente', URGENTE: 'Urgente' };

export const GENERAL_MODULES: ClinicalModuleDefinition[] = [
  general({
    moduleKey: 'general.soap-note',
    name: 'Nota SOAP',
    description: 'Nota de atención en formato subjetivo, objetivo, análisis y plan.',
    schemaVersion: 1,
    schema: {
      sections: [
        section('soap', 'Nota SOAP', [
          longText('subjective', 'Subjetivo', {
            required: true,
            help: 'Lo que refiere el paciente.',
          }),
          longText('objective', 'Objetivo', { help: 'Hallazgos de la exploración y mediciones.' }),
          longText('assessment', 'Análisis', { required: true }),
          longText('plan', 'Plan', { required: true }),
        ]),
      ],
    },
  }),

  general({
    moduleKey: 'general.vital-signs',
    name: 'Signos vitales',
    description: 'Mediciones de la atención: antropometría, presión, frecuencias y saturación.',
    schemaVersion: 1,
    schema: {
      sections: [
        section('anthropometry', 'Antropometría', [
          decimal('weightKg', 'Peso', { unit: 'kg', min: 0.3, max: 500 }),
          decimal('heightCm', 'Altura', { unit: 'cm', min: 20, max: 250 }),
          calculated('bmi', 'IMC', 'round(weightKg / ((heightCm / 100) ^ 2), 1)', {
            unit: 'kg/m²',
          }),
          decimal('waistCm', 'Perímetro abdominal', { unit: 'cm', min: 10, max: 300 }),
        ]),
        section('vitals', 'Signos vitales', [
          decimal('temperatureC', 'Temperatura', { unit: '°C', min: 30, max: 45 }),
          integer('systolic', 'Presión sistólica', { unit: 'mmHg', min: 40, max: 300 }),
          integer('diastolic', 'Presión diastólica', { unit: 'mmHg', min: 20, max: 200 }),
          integer('heartRate', 'Frecuencia cardíaca', { unit: 'lpm', min: 20, max: 300 }),
          integer('respiratoryRate', 'Frecuencia respiratoria', { unit: 'rpm', min: 4, max: 100 }),
          integer('oxygenSaturation', 'Saturación de oxígeno', { unit: '%', min: 40, max: 100 }),
          decimal('glucoseMgDl', 'Glucemia', { unit: 'mg/dL', min: 10, max: 1500 }),
        ]),
        section('notes', 'Observaciones', [longText('observations', 'Observaciones')]),
      ],
      alerts: [
        {
          when: 'oxygenSaturation < 90',
          level: 'critical',
          message: 'Saturación de oxígeno menor al 90 %.',
        },
        {
          when: 'systolic >= 180 or diastolic >= 120',
          level: 'critical',
          message: 'Presión arterial en rango de crisis hipertensiva (≥ 180/120 mmHg).',
        },
        {
          when: 'temperatureC >= 39.5',
          level: 'warning',
          message: 'Temperatura igual o mayor a 39,5 °C.',
        },
      ],
    },
  }),

  general({
    moduleKey: 'general.diagnoses',
    name: 'Diagnósticos',
    description: 'Diagnósticos codificados de la atención (CIE-10 o CIE-11).',
    schemaVersion: 1,
    schema: {
      sections: [
        section('diagnoses', 'Diagnósticos', [
          table(
            'diagnoses',
            'Diagnósticos',
            [
              select(
                'system',
                'Clasificación',
                { CIE10: 'CIE-10', CIE11: 'CIE-11' },
                {
                  required: true,
                },
              ),
              text('code', 'Código', { required: true, maxLength: 12, lookup: 'diagnosis' }),
              text('description', 'Descripción', { required: true, maxLength: 300 }),
              select(
                'kind',
                'Tipo',
                { PRINCIPAL: 'Principal', SECUNDARIO: 'Secundario' },
                {
                  required: true,
                },
              ),
              select(
                'certainty',
                'Condición',
                {
                  PRESUNTIVO: 'Presuntivo',
                  DEFINITIVO: 'Definitivo',
                  CONFIRMADO: 'Confirmado',
                  DESCARTADO: 'Descartado',
                },
                { required: true },
              ),
            ],
            { minRows: 1, maxRows: 20 },
          ),
          longText('observations', 'Observaciones'),
        ]),
      ],
    },
  }),

  general({
    moduleKey: 'general.allergies',
    name: 'Alergias',
    description: 'Una alergia del paciente con su reacción y severidad.',
    schemaVersion: 1,
    schema: {
      sections: [
        section('allergy', 'Alergia', [
          select(
            'category',
            'Tipo',
            {
              MEDICAMENTO: 'Medicamento',
              ALIMENTO: 'Alimento',
              SUSTANCIA: 'Sustancia',
              OTRO: 'Otro',
            },
            { required: true },
          ),
          text('allergen', 'Alérgeno', { required: true, maxLength: 200 }),
          text('reaction', 'Tipo de reacción', { required: true, maxLength: 300 }),
          select(
            'severity',
            'Severidad',
            { LEVE: 'Leve', MODERADA: 'Moderada', GRAVE: 'Grave' },
            { required: true },
          ),
          longText('observations', 'Observaciones'),
        ]),
      ],
      alerts: [
        { when: "severity == 'GRAVE'", level: 'critical', message: 'Alergia grave registrada.' },
      ],
    },
  }),

  general({
    moduleKey: 'general.prescriptions',
    name: 'Receta',
    description: 'Prescripción de medicamentos con dosis, frecuencia, vía y duración.',
    allowedSpecialtyCodes: PRESCRIBER_SPECIALTY_CODES,
    schemaVersion: 1,
    schema: {
      sections: [
        section('prescription', 'Prescripción', [
          table(
            'items',
            'Medicamentos',
            [
              text('medication', 'Medicamento', {
                required: true,
                maxLength: 200,
                lookup: 'medication',
              }),
              text('activeIngredient', 'Principio activo', { maxLength: 200 }),
              text('presentation', 'Presentación', { maxLength: 200 }),
              text('dose', 'Dosis', { required: true, maxLength: 100 }),
              text('frequency', 'Frecuencia', { required: true, maxLength: 100 }),
              select(
                'route',
                'Vía',
                {
                  ORAL: 'Oral',
                  SUBLINGUAL: 'Sublingual',
                  TOPICA: 'Tópica',
                  INTRAVENOSA: 'Intravenosa',
                  INTRAMUSCULAR: 'Intramuscular',
                  SUBCUTANEA: 'Subcutánea',
                  INHALATORIA: 'Inhalatoria',
                  OFTALMICA: 'Oftálmica',
                  OTICA: 'Ótica',
                  RECTAL: 'Rectal',
                  OTRA: 'Otra',
                },
                { required: true },
              ),
              text('duration', 'Duración', { required: true, maxLength: 100 }),
              text('instructions', 'Indicaciones', { maxLength: 500 }),
            ],
            { minRows: 1, maxRows: 30 },
          ),
          longText('generalInstructions', 'Indicaciones generales'),
        ]),
      ],
    },
  }),

  general({
    moduleKey: 'general.orders',
    name: 'Orden',
    description: 'Orden de laboratorio, imagen, procedimiento, terapia o interconsulta.',
    schemaVersion: 1,
    schema: {
      sections: [
        section('order', 'Orden', [
          select(
            'orderType',
            'Tipo',
            {
              LABORATORIO: 'Laboratorio',
              IMAGEN: 'Imagen',
              PROCEDIMIENTO: 'Procedimiento',
              TERAPIA: 'Terapia',
              INTERCONSULTA: 'Interconsulta',
            },
            { required: true },
          ),
          longText('description', 'Detalle de lo solicitado', { required: true }),
          select('priority', 'Prioridad', PRIORITY, { required: true }),
          select(
            'status',
            'Estado',
            {
              CREADA: 'Creada',
              PENDIENTE: 'Pendiente',
              REALIZADA: 'Realizada',
              CANCELADA: 'Cancelada',
            },
            { required: true },
          ),
        ]),
        section('result', 'Resultado', [longText('result', 'Resultado registrado')]),
      ],
    },
  }),

  general({
    moduleKey: 'general.referrals',
    name: 'Referencia',
    description: 'Derivación del paciente a otra especialidad o profesional.',
    schemaVersion: 1,
    schema: {
      sections: [
        section('referral', 'Referencia', [
          text('destinationSpecialty', 'Especialidad de destino', {
            required: true,
            maxLength: 200,
          }),
          text('destinationProfessional', 'Profesional o institución de destino', {
            maxLength: 200,
          }),
          longText('reason', 'Motivo', { required: true }),
          text('diagnosis', 'Diagnóstico', { maxLength: 300 }),
          select('priority', 'Prioridad', PRIORITY, { required: true }),
          select(
            'status',
            'Estado',
            { PENDIENTE: 'Pendiente', ATENDIDA: 'Atendida', CANCELADA: 'Cancelada' },
            { required: true },
          ),
          longText('observations', 'Observaciones'),
        ]),
      ],
    },
  }),

  general({
    moduleKey: 'general.certificates',
    name: 'Certificado',
    description: 'Certificado médico, psicológico, de reposo, aptitud, asistencia o tratamiento.',
    schemaVersion: 1,
    schema: {
      sections: [
        section('certificate', 'Certificado', [
          select(
            'certificateType',
            'Tipo de certificado',
            {
              MEDICO: 'Certificado médico',
              PSICOLOGICO: 'Certificado psicológico',
              REPOSO: 'Certificado de reposo',
              APTITUD: 'Certificado de aptitud',
              ASISTENCIA: 'Certificado de asistencia',
              TRATAMIENTO: 'Certificado de tratamiento',
              EVOLUCION: 'Informe de evolución',
              DERIVACION: 'Certificado de derivación',
            },
            { required: true },
          ),
          text('addressedTo', 'Dirigido a', { maxLength: 200 }),
          longText('body', 'Texto del certificado', { required: true }),
          text('diagnosis', 'Diagnóstico', { maxLength: 300 }),
          integer('restDays', 'Días de reposo', { min: 0, max: 365 }),
          date('validFrom', 'Desde'),
          date('validTo', 'Hasta'),
        ]),
      ],
    },
  }),

  general({
    moduleKey: 'general.consents',
    name: 'Consentimiento informado',
    description: 'Texto del consentimiento y quién lo acepta, para imprimir y firmar.',
    schemaVersion: 1,
    schema: {
      sections: [
        section('consent', 'Consentimiento', [
          text('title', 'Título', { required: true, maxLength: 200 }),
          longText('body', 'Texto del consentimiento', { required: true }),
          select(
            'acceptedBy',
            'Quién lo acepta',
            { PACIENTE: 'El paciente', REPRESENTANTE: 'El representante legal' },
            { required: true },
          ),
          text('signerName', 'Nombre de quien firma', { required: true, maxLength: 200 }),
          text('signerIdentification', 'Identificación de quien firma', { maxLength: 40 }),
          checkbox('accepted', 'Aceptó el consentimiento'),
          signature('signerSignature', 'Firma de quien acepta', {
            help: 'Quien acepta firma en la pantalla. Si firma en papel, déjalo vacío y adjunta el documento escaneado.',
          }),
        ]),
      ],
    },
  }),
];
