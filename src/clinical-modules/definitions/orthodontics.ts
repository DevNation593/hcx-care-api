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
import { TOOTH_OPTIONS } from './dentistry';

/**
 * Orthodontics, owned by dentistry so that the same professional keeps the odontogram and the
 * orthodontic records of a patient. The fields record what the professional assessed: every
 * clinical question offers "not assessed", nothing is filled in by default, and no rule
 * interprets a measurement or raises a clinical alert on its own.
 */
const orthodontics = (
  definition: Omit<ClinicalModuleDefinition, 'scope' | 'specialtyCode' | 'renderer'>,
): ClinicalModuleDefinition => ({
  ...definition,
  scope: 'SPECIALTY',
  specialtyCode: 'DENTISTRY',
  renderer: 'FORM',
});

const ANGLE_CLASS = {
  CLASE_I: 'Clase I',
  CLASE_II: 'Clase II',
  CLASE_III: 'Clase III',
  NO_EVALUABLE: 'No evaluable',
};

/** Molar relation of a primary dentition, where Angle's class does not apply yet. */
const TERMINAL_PLANE = {
  RECTO: 'Recto',
  ESCALON_MESIAL: 'Escalón mesial',
  ESCALON_DISTAL: 'Escalón distal',
  NO_EVALUABLE: 'No evaluable',
};

const MIDLINE = {
  CENTRADA: 'Centrada',
  DERECHA: 'Desviada a la derecha',
  IZQUIERDA: 'Desviada a la izquierda',
  NO_EVALUADA: 'No evaluada',
};

const CROWDING = {
  AUSENTE: 'Ausente',
  LEVE: 'Leve',
  MODERADO: 'Moderado',
  SEVERO: 'Severo',
  NO_EVALUADO: 'No evaluado',
};

const RATING = {
  BUENA: 'Buena',
  REGULAR: 'Regular',
  DEFICIENTE: 'Deficiente',
  NO_EVALUADA: 'No evaluada',
};

const mm = (key: string, label: string, min: number, max: number) =>
  decimal(key, label, { min, max, unit: 'mm' });

export const ORTHODONTICS_MODULES: ClinicalModuleDefinition[] = [
  orthodontics({
    moduleKey: 'dentistry.ortho-assessment',
    name: 'Diagnóstico ortodóntico',
    description: 'Valoración inicial: análisis facial y funcional, oclusión y diagnóstico.',
    schemaVersion: 1,
    schema: {
      sections: [
        section('reason', 'Motivo', [
          longText('chiefComplaint', 'Motivo de consulta', { required: true }),
          select('dentition', 'Dentición', {
            PERMANENTE: 'Permanente',
            MIXTA: 'Mixta',
            TEMPORAL: 'Temporal',
          }),
        ]),
        section('facial', 'Análisis facial', [
          select('facialProfile', 'Perfil', {
            RECTO: 'Recto',
            CONVEXO: 'Convexo',
            CONCAVO: 'Cóncavo',
            NO_EVALUADO: 'No evaluado',
          }),
          select('facialSymmetry', 'Simetría facial', {
            SIMETRICO: 'Simétrico',
            ASIMETRICO: 'Asimétrico',
            NO_EVALUADO: 'No evaluado',
          }),
          select('lipCompetence', 'Competencia labial', {
            COMPETENTE: 'Competente',
            INCOMPETENTE: 'Incompetente',
            NO_EVALUADO: 'No evaluado',
          }),
          longText('smileNotes', 'Sonrisa'),
        ]),
        section('functional', 'Análisis funcional', [
          select('breathing', 'Respiración', {
            NASAL: 'Nasal',
            ORAL: 'Oral',
            MIXTA: 'Mixta',
            NO_EVALUADA: 'No evaluada',
          }),
          select('swallowing', 'Deglución', {
            NORMAL: 'Normal',
            ATIPICA: 'Atípica',
            NO_EVALUADA: 'No evaluada',
          }),
          multiselect('habits', 'Hábitos referidos u observados', {
            SUCCION_DIGITAL: 'Succión digital',
            INTERPOSICION_LINGUAL: 'Interposición lingual',
            RESPIRACION_ORAL: 'Respiración oral',
            ONICOFAGIA: 'Onicofagia',
            BRUXISMO: 'Bruxismo',
            OTRO: 'Otro',
          }),
          text('habitsNotes', 'Detalle de hábitos', { maxLength: 300 }),
          longText('tmjNotes', 'Articulación temporomandibular (ATM)'),
        ]),
        section('occlusion', 'Oclusión', [
          select('molarClassRight', 'Clase molar derecha', ANGLE_CLASS),
          select('molarClassLeft', 'Clase molar izquierda', ANGLE_CLASS),
          select('canineClassRight', 'Clase canina derecha', ANGLE_CLASS),
          select('canineClassLeft', 'Clase canina izquierda', ANGLE_CLASS),
          select('classIIDivision', 'División (Clase II)', {
            DIVISION_1: 'División 1',
            DIVISION_2: 'División 2',
            NO_APLICA: 'No aplica',
            NO_EVALUADA: 'No evaluada',
          }),
          select(
            'terminalPlaneRight',
            'Plano terminal derecho (dentición temporal)',
            TERMINAL_PLANE,
          ),
          select(
            'terminalPlaneLeft',
            'Plano terminal izquierdo (dentición temporal)',
            TERMINAL_PLANE,
          ),
          mm('overjetMm', 'Overjet (resalte)', -10, 20),
          mm('overbiteMm', 'Overbite (sobremordida)', -10, 15),
          select('crossbite', 'Mordida cruzada', {
            PRESENTE: 'Presente',
            AUSENTE: 'Ausente',
            NO_EVALUADA: 'No evaluada',
          }),
          multiselect('crossbiteLocation', 'Ubicación de la mordida cruzada', {
            ANTERIOR: 'Anterior',
            POSTERIOR_DERECHA: 'Posterior derecha',
            POSTERIOR_IZQUIERDA: 'Posterior izquierda',
          }),
          select('openBite', 'Mordida abierta', {
            ANTERIOR: 'Anterior',
            POSTERIOR: 'Posterior',
            AUSENTE: 'Ausente',
            NO_EVALUADA: 'No evaluada',
          }),
          select('upperMidlineDirection', 'Línea media superior', MIDLINE),
          mm('upperMidlineDeviationMm', 'Desviación de la línea media superior', 0, 10),
          select('lowerMidlineDirection', 'Línea media inferior', MIDLINE),
          mm('lowerMidlineDeviationMm', 'Desviación de la línea media inferior', 0, 10),
          select('upperCrowding', 'Apiñamiento superior', CROWDING),
          select('lowerCrowding', 'Apiñamiento inferior', CROWDING),
        ]),
        section('records', 'Registros de diagnóstico', [
          multiselect(
            'recordsTaken',
            'Registros tomados',
            {
              FOTOS_EXTRAORALES: 'Fotos extraorales',
              FOTOS_INTRAORALES: 'Fotos intraorales',
              PANORAMICA: 'Radiografía panorámica',
              CEFALICA_LATERAL: 'Radiografía cefálica lateral',
              MODELOS_ESCANEO: 'Modelos o escaneo intraoral',
            },
            { help: 'Los archivos se suben en Archivos del paciente.' },
          ),
        ]),
        section('diagnosis', 'Diagnóstico', [
          longText('orthodonticDiagnosis', 'Diagnóstico ortodóntico', { required: true }),
          longText('observations', 'Observaciones'),
        ]),
      ],
    },
  }),

  orthodontics({
    moduleKey: 'dentistry.ortho-cephalometry',
    name: 'Análisis cefalométrico',
    description: 'Medidas de la radiografía cefálica transcritas y la interpretación profesional.',
    schemaVersion: 1,
    schema: {
      sections: [
        section('cephalometry', 'Análisis cefalométrico', [
          date('radiographDate', 'Fecha de la radiografía'),
          select('analysisMethod', 'Análisis usado', {
            STEINER: 'Steiner',
            RICKETTS: 'Ricketts',
            MCNAMARA: 'McNamara',
            OTRO: 'Otro',
          }),
          table(
            'measurements',
            'Medidas',
            [
              text('measure', 'Medida', { required: true, maxLength: 80 }),
              decimal('value', 'Valor', { required: true, min: -360, max: 360 }),
              text('unit', 'Unidad', { required: true, maxLength: 20 }),
            ],
            {
              maxRows: 60,
              help: 'Transcribe cada medida tal como se obtuvo; el sistema no la interpreta.',
            },
          ),
          longText('professionalInterpretation', 'Interpretación del profesional', {
            required: true,
          }),
          longText('observations', 'Observaciones'),
        ]),
      ],
    },
  }),

  orthodontics({
    moduleKey: 'dentistry.ortho-treatment-plan',
    name: 'Plan ortodóntico',
    description: 'Objetivos, aparatología, extracciones, fases, duración, retención y costo.',
    schemaVersion: 1,
    schema: {
      sections: [
        section('goals', 'Objetivos', [
          longText('treatmentGoals', 'Objetivos del tratamiento', { required: true }),
        ]),
        section('appliances', 'Aparatología', [
          select(
            'appliance',
            'Aparatología',
            {
              FIJA_METALICA: 'Fija metálica',
              FIJA_ESTETICA: 'Fija estética',
              AUTOLIGADO: 'Autoligado',
              LINGUAL: 'Lingual',
              ALINEADORES: 'Alineadores',
              REMOVIBLE: 'Removible',
              ORTOPEDICA_FUNCIONAL: 'Ortopédica / funcional',
              OTRO: 'Otra',
            },
            { required: true },
          ),
          select('bracketPrescription', 'Prescripción', {
            ROTH: 'Roth',
            MBT: 'MBT',
            OTRA: 'Otra',
            NO_APLICA: 'No aplica',
          }),
          select('slot', 'Slot', { SLOT_018: '.018', SLOT_022: '.022', NO_APLICA: 'No aplica' }),
          select('arches', 'Arcadas', {
            SUPERIOR: 'Superior',
            INFERIOR: 'Inferior',
            AMBAS: 'Ambas',
          }),
          select('extractionsIndicated', 'Extracciones indicadas', {
            SI: 'Sí',
            NO: 'No',
            POR_DEFINIR: 'Por definir',
          }),
          multiselect('extractionTeeth', 'Piezas a extraer', TOOTH_OPTIONS),
          multiselect('auxiliaries', 'Auxiliares', {
            EXPANSOR: 'Expansor',
            MINITORNILLOS: 'Minitornillos',
            ELASTICOS_INTERMAXILARES: 'Elásticos intermaxilares',
            ARCO_TRANSPALATINO: 'Arco transpalatino',
            BARRA_LINGUAL: 'Barra lingual',
            OTRO: 'Otro',
          }),
        ]),
        section('phases', 'Fases y duración', [
          table(
            'phases',
            'Fases',
            [
              text('phase', 'Fase', { required: true, maxLength: 100 }),
              text('goal', 'Objetivo', { maxLength: 300 }),
              integer('estimatedMonths', 'Duración estimada (meses)', { min: 1, max: 60 }),
              select(
                'status',
                'Estado',
                { PENDIENTE: 'Pendiente', EN_CURSO: 'En curso', COMPLETADA: 'Completada' },
                { required: true },
              ),
            ],
            { maxRows: 10 },
          ),
          integer('estimatedDurationMonths', 'Duración total estimada', {
            min: 1,
            max: 72,
            unit: 'meses',
          }),
          select('plannedRetention', 'Retención planificada', {
            FIJA: 'Fija',
            REMOVIBLE: 'Removible',
            AMBAS: 'Fija y removible',
            POR_DEFINIR: 'Por definir',
          }),
          decimal('estimatedCost', 'Costo estimado', { min: 0, max: 1000000 }),
          longText('observations', 'Observaciones'),
        ]),
      ],
    },
  }),

  orthodontics({
    moduleKey: 'dentistry.ortho-control',
    name: 'Control ortodóntico',
    description:
      'Cada cita: arcos, ligaduras, elásticos o alineadores, incidencias e indicaciones.',
    schemaVersion: 1,
    schema: {
      sections: [
        section('visit', 'Cita', [
          select(
            'visitType',
            'Tipo de cita',
            {
              INSTALACION: 'Instalación',
              AJUSTE: 'Ajuste',
              CONTROL: 'Control de rutina o entrega de alineadores',
              OBSERVACION: 'Observación o control de crecimiento',
              RECEMENTADO: 'Recementado',
              EMERGENCIA: 'Emergencia',
              RETIRO: 'Retiro de aparatología',
              CONTROL_RETENCION: 'Control de retención',
            },
            { required: true },
          ),
        ]),
        section('appliances', 'Aparatología', [
          text('upperArchwire', 'Arco superior', { maxLength: 60, help: 'Por ejemplo NiTi .014' }),
          text('lowerArchwire', 'Arco inferior', { maxLength: 60 }),
          text('ligatures', 'Ligaduras', { maxLength: 100 }),
          text('elastics', 'Elásticos indicados', { maxLength: 200 }),
          integer('currentAligner', 'Alineador actual', { min: 1, max: 200 }),
          integer('totalAligners', 'Total de alineadores', { min: 1, max: 200 }),
          multiselect('debondedBrackets', 'Brackets despegados', TOOTH_OPTIONS),
        ]),
        section('assessment', 'Evaluación', [
          select('hygiene', 'Higiene', RATING),
          select('cooperation', 'Cooperación', RATING),
          longText('procedurePerformed', 'Procedimiento realizado', { required: true }),
          longText('patientInstructions', 'Indicaciones al paciente'),
          date('nextControlDate', 'Próximo control'),
          longText('observations', 'Observaciones'),
        ]),
      ],
    },
  }),
];
