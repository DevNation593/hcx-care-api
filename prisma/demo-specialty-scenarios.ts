export type DemoSpecialtyKey = 'psychology' | 'nutrition' | 'physiotherapy' | 'dentistry';

export type DemoSpecialtyCode = 'PSYCHOLOGY' | 'NUTRITION' | 'PHYSIOTHERAPY' | 'DENTISTRY';

export type DemoProfessionalRole = 'PROFESIONAL';

export type DemoPatientGender = 'FEMALE' | 'MALE' | 'OTHER' | 'PREFER_NOT_TO_SAY';

export type DemoAppointmentStatus =
  'SCHEDULED' | 'CONFIRMED' | 'IN_PROGRESS' | 'COMPLETED' | 'CANCELLED' | 'NO_SHOW';

export interface DemoSpecialtyScenario {
  key: DemoSpecialtyKey;
  code: DemoSpecialtyCode;
  professional: {
    email: string;
    firstName: string;
    lastName: string;
    phone: string;
    role: DemoProfessionalRole;
    title: string;
    licenseNumber: string;
    activationDaysAgo: number;
    managedByProvider: boolean;
  };
  patient: {
    firstName: string;
    lastName: string;
    email: string;
    phone: string;
    dateOfBirth: string;
    gender: DemoPatientGender;
    notes: string;
  };
  appointment: {
    title: string;
    description: string;
    startDaysFromNow: number;
    duration: number;
    status: DemoAppointmentStatus;
    location: string;
    isOnline: boolean;
  };
  records: Array<{
    moduleKey: string;
    data: Record<string, string | number | string[]>;
    notes: string;
    recordDaysFromNow?: number;
  }>;
}

export function buildDemoSpecialtyScenarios(): DemoSpecialtyScenario[] {
  return [
    {
      key: 'psychology',
      code: 'PSYCHOLOGY',
      professional: {
        email: 'psic.ana@psic.com',
        firstName: 'Ana',
        lastName: 'Vega',
        phone: '+593999000011',
        role: 'PROFESIONAL',
        title: 'Psicóloga clínica',
        licenseNumber: 'PSY-EC-001',
        activationDaysAgo: 40,
        managedByProvider: true,
      },
      patient: {
        firstName: 'Valeria',
        lastName: 'Ortega',
        email: 'valeria.ortega@email.com',
        phone: '+593999100001',
        dateOfBirth: '1994-04-12',
        gender: 'FEMALE',
        notes: 'Seguimiento semanal por ansiedad social.',
      },
      appointment: {
        title: 'Sesión de seguimiento de ansiedad',
        description: 'Revisión de avances y ajuste de técnicas.',
        startDaysFromNow: -3,
        duration: 60,
        status: 'COMPLETED',
        location: 'Consultorio 2',
        isOnline: false,
      },
      records: [
        {
          moduleKey: 'psychology.assessments',
          data: {
            testName: 'PHQ-9',
            score: 8,
            interpretation: 'Síntomas depresivos leves; continuar seguimiento.',
          },
          notes: 'Repetir evaluación en cuatro semanas.',
          recordDaysFromNow: -3,
        },
      ],
    },
    {
      key: 'nutrition',
      code: 'NUTRITION',
      professional: {
        email: 'nutri.luis@psic.com',
        firstName: 'Luis',
        lastName: 'Paredes',
        phone: '+593999000012',
        role: 'PROFESIONAL',
        title: 'Nutricionista clínico',
        licenseNumber: 'NUT-EC-002',
        activationDaysAgo: 30,
        managedByProvider: false,
      },
      patient: {
        firstName: 'Camila',
        lastName: 'Naranjo',
        email: 'camila.naranjo@email.com',
        phone: '+593999100005',
        dateOfBirth: '2001-11-20',
        gender: 'FEMALE',
        notes: 'Busca mejorar su composición corporal y hábitos alimenticios.',
      },
      appointment: {
        title: 'Evaluación nutricional inicial',
        description: 'Valoración antropométrica y definición de objetivos.',
        startDaysFromNow: 2,
        duration: 60,
        status: 'SCHEDULED',
        location: 'Consultorio 1',
        isOnline: false,
      },
      records: [
        {
          moduleKey: 'nutrition.assessments',
          data: { weightKg: 68, heightCm: 165, bmi: 25 },
          notes: 'Control nutricional mensual.',
        },
        {
          moduleKey: 'nutrition.diet-plans',
          data: {
            dailyCalories: 1900,
            meals: 'Desayuno, refrigerio, almuerzo, merienda y cena',
            dietaryGoals: 'Aumentar fibra y mantener una hidratación adecuada.',
          },
          notes: 'Revisar adherencia al plan en cuatro semanas.',
        },
      ],
    },
    {
      key: 'physiotherapy',
      code: 'PHYSIOTHERAPY',
      professional: {
        email: 'fisio.sofia@psic.com',
        firstName: 'Sofía',
        lastName: 'Almeida',
        phone: '+593999000014',
        role: 'PROFESIONAL',
        title: 'Fisioterapeuta',
        licenseNumber: 'FIS-EC-003',
        activationDaysAgo: 25,
        managedByProvider: false,
      },
      patient: {
        firstName: 'Andrés',
        lastName: 'Mora',
        email: 'andres.mora@email.com',
        phone: '+593999100006',
        dateOfBirth: '1979-06-18',
        gender: 'MALE',
        notes: 'Rehabilitación posterior a lesión de rodilla derecha.',
      },
      appointment: {
        title: 'Rehabilitación de rodilla',
        description: 'Evaluación funcional y progresión de ejercicios.',
        startDaysFromNow: 1,
        duration: 45,
        status: 'CONFIRMED',
        location: 'Sala de rehabilitación',
        isOnline: false,
      },
      records: [
        {
          moduleKey: 'physiotherapy.evolution',
          data: {
            painLevel: 4,
            mobility: 'Flexión de rodilla limitada a 105 grados',
            progress: 'Mejora funcional moderada.',
          },
          notes: 'Continuar trabajo de movilidad y control del dolor.',
          recordDaysFromNow: -2,
        },
        {
          moduleKey: 'physiotherapy.exercise-plans',
          data: {
            exercises: 'Puente de glúteos, extensión de rodilla y bicicleta estática',
            frequency: '4 veces por semana',
            repetitions: '3 series de 12 repeticiones',
          },
          notes: 'Aumentar resistencia si no aparece dolor mayor a 5/10.',
        },
      ],
    },
    {
      key: 'dentistry',
      code: 'DENTISTRY',
      professional: {
        email: 'odonto.carlos@psic.com',
        firstName: 'Carlos',
        lastName: 'Benítez',
        phone: '+593999000015',
        role: 'PROFESIONAL',
        title: 'Odontólogo general',
        licenseNumber: 'ODO-EC-004',
        activationDaysAgo: 20,
        managedByProvider: false,
      },
      patient: {
        firstName: 'Lucía',
        lastName: 'Torres',
        email: 'lucia.torres@email.com',
        phone: '+593999100007',
        dateOfBirth: '1990-02-14',
        gender: 'FEMALE',
        notes: 'Control preventivo y evaluación de sensibilidad dental.',
      },
      appointment: {
        title: 'Evaluación odontológica',
        description: 'Examen general, profilaxis y actualización de odontograma.',
        startDaysFromNow: 3,
        duration: 45,
        status: 'SCHEDULED',
        location: 'Consultorio odontológico',
        isOnline: false,
      },
      records: [
        {
          moduleKey: 'dentistry.treatments',
          data: {
            procedure: 'Profilaxis y aplicación de flúor',
            tooth: 'Arcada completa',
            treatmentStatus: 'Completado',
          },
          notes: 'Programar control preventivo en seis meses.',
          recordDaysFromNow: -1,
        },
        {
          moduleKey: 'dentistry.odontogram',
          data: {
            findings: 'Restauración estable en pieza 16; sensibilidad leve en pieza 24.',
            surfaces: '16-O y 24-V',
          },
          notes: 'Vigilar sensibilidad y reevaluar en el próximo control.',
        },
      ],
    },
  ];
}
