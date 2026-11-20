import {
  ClinicalModuleDefinition,
  decimal,
  legacySchema,
  longText,
  section,
  select,
  table,
  text,
} from '../module-builders';

const dentistry = (
  definition: Omit<ClinicalModuleDefinition, 'scope' | 'specialtyCode' | 'renderer'> & {
    renderer?: ClinicalModuleDefinition['renderer'];
  },
): ClinicalModuleDefinition => ({
  renderer: 'FORM',
  ...definition,
  scope: 'SPECIALTY',
  specialtyCode: 'DENTISTRY',
});

const quadrant = (prefix: number, count: number) =>
  Array.from({ length: count }, (_, index) => `${prefix}${index + 1}`);

/** FDI two-digit notation: quadrants 1-4 are permanent teeth, 5-8 are primary teeth. */
export const FDI_TEETH = [
  ...[1, 2, 3, 4].flatMap((prefix) => quadrant(prefix, 8)),
  ...[5, 6, 7, 8].flatMap((prefix) => quadrant(prefix, 5)),
];

export const TOOTH_OPTIONS = Object.fromEntries(FDI_TEETH.map((tooth) => [tooth, tooth]));

export const TOOTH_SURFACES = {
  O: 'Oclusal / incisal',
  M: 'Mesial',
  D: 'Distal',
  V: 'Vestibular',
  L: 'Lingual / palatina',
  W: 'Pieza completa',
};

export const TOOTH_STATES = {
  CARIES: 'Caries',
  RESTORATION: 'Restauración',
  MISSING: 'Ausente',
  CROWN: 'Corona',
  ENDODONTICS_INDICATED: 'Endodoncia indicada',
  EXTRACTION_INDICATED: 'Extracción indicada',
  IMPLANT: 'Implante',
};

export const DENTISTRY_MODULES: ClinicalModuleDefinition[] = [
  dentistry({
    moduleKey: 'dentistry.odontogram',
    name: 'Odontograma',
    description: 'Registro anterior a las definiciones de módulo.',
    schemaVersion: 1,
    legacy: true,
    schema: legacySchema({ findings: 'Hallazgos', surfaces: 'Superficies' }),
  }),
  dentistry({
    moduleKey: 'dentistry.odontogram',
    name: 'Odontograma',
    description: 'Estado por pieza (notación FDI) y superficie. Lo no marcado se considera sano.',
    schemaVersion: 2,
    renderer: 'ODONTOGRAM',
    schema: {
      sections: [
        section('odontogram', 'Odontograma', [
          select(
            'dentition',
            'Dentición',
            { PERMANENT: 'Permanente', TEMPORARY: 'Temporal', MIXED: 'Mixta' },
            { required: true },
          ),
          table(
            'findings',
            'Hallazgos',
            [
              select('tooth', 'Pieza', TOOTH_OPTIONS, { required: true }),
              select('surface', 'Superficie', TOOTH_SURFACES, { required: true }),
              select('state', 'Estado', TOOTH_STATES, { required: true }),
            ],
            { maxRows: 320 },
          ),
          longText('observations', 'Observaciones'),
        ]),
      ],
    },
  }),

  dentistry({
    moduleKey: 'dentistry.treatments',
    name: 'Plan de tratamiento',
    description: 'Registro anterior a las definiciones de módulo.',
    schemaVersion: 1,
    legacy: true,
    schema: legacySchema({
      procedure: 'Procedimiento',
      tooth: 'Pieza dental',
      treatmentStatus: 'Estado del tratamiento',
    }),
  }),
  dentistry({
    moduleKey: 'dentistry.treatments',
    name: 'Plan de tratamiento',
    description: 'Procedimientos con pieza, prioridad, estado, costo estimado y observaciones.',
    schemaVersion: 2,
    schema: {
      sections: [
        section('plan', 'Plan de tratamiento', [
          table(
            'items',
            'Procedimientos',
            [
              select('tooth', 'Pieza', TOOTH_OPTIONS),
              text('procedure', 'Procedimiento', { required: true, maxLength: 200 }),
              select(
                'priority',
                'Prioridad',
                { ALTA: 'Alta', MEDIA: 'Media', BAJA: 'Baja' },
                { required: true },
              ),
              select(
                'status',
                'Estado',
                {
                  PENDIENTE: 'Pendiente',
                  EN_CURSO: 'En curso',
                  REALIZADO: 'Realizado',
                  CANCELADO: 'Cancelado',
                },
                { required: true },
              ),
              decimal('estimatedCost', 'Costo estimado', { min: 0, max: 1000000 }),
              text('observations', 'Observaciones', { maxLength: 500 }),
            ],
            { minRows: 1, maxRows: 60 },
          ),
          longText('observations', 'Observaciones generales'),
        ]),
      ],
    },
  }),

  dentistry({
    moduleKey: 'dentistry.evolution',
    name: 'Evolución odontológica',
    description: 'Procedimiento realizado en la atención y su seguimiento.',
    schemaVersion: 1,
    schema: {
      sections: [
        section('evolution', 'Evolución', [
          select('tooth', 'Pieza', TOOTH_OPTIONS),
          longText('procedurePerformed', 'Procedimiento realizado', { required: true }),
          text('anesthesia', 'Anestesia', { maxLength: 200 }),
          longText('observations', 'Observaciones'),
          longText('nextStep', 'Próximo paso'),
        ]),
      ],
    },
  }),
];
