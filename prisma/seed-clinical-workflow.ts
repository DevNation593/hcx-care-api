import type {
  Appointment,
  Encounter,
  Patient,
  Prisma,
  SpecialtyRecord,
  User,
} from '@prisma/client';
import { randomUUID } from 'crypto';
import {
  FormSchema,
  validateFormData,
  validateFormSchema,
} from '../src/clinical-forms/form-schema';
import {
  CUSTOM_MODULE_PREFIX,
  latestClinicalModule,
  validateModuleData,
} from '../src/clinical-modules/clinical-module-registry';
import { snapshotClinicalNote } from '../src/clinical-notes/clinical-notes.service';
import { snapshotEncounter } from '../src/encounters/encounters.service';
import { snapshotPatientFile } from '../src/patient-files/patient-files.service';
import { documentSections } from '../src/record-documents/document-content';
import { renderRecordPdf } from '../src/record-documents/record-pdf';
import { snapshotSpecialtyRecord } from '../src/specialty-records/specialty-records.service';
import { formatVerificationCode } from '../src/specialty-records/verification-code';
import { demoLabReport, demoRadiograph, demoSignature } from './seed-demo-files';
import {
  createAppointment,
  createPatient,
  createTenant,
  createUser,
  SeedContext,
  SeedTenant,
  syncUsage,
  writeAudit,
} from './seed-helpers';

/** Codes of the documents the seed announces, so that `/verify/<code>` can be tried at once. */
export const DEMO_DOCUMENT_CODES = {
  certificate: 'DEM0CERT00000001',
  prescription: 'DEM0RECETA000001',
  consent: 'DEM0C0NSENT00001',
  corrected: 'DEM0C0RREG1D0001',
  withdrawn: 'DEM0RET1RAD00001',
} as const;

interface CustomForm {
  id: string;
  version: number;
  schema: FormSchema;
}

const SPORTS_INTAKE_V1: FormSchema = {
  sections: [
    {
      key: 'sport',
      title: 'Actividad deportiva',
      fields: [
        { key: 'sport', label: 'Deporte', type: 'text', required: true, maxLength: 80 },
        {
          key: 'level',
          label: 'Nivel',
          type: 'select',
          required: true,
          options: [
            { value: 'RECREATIVO', label: 'Recreativo' },
            { value: 'COMPETITIVO', label: 'Competitivo' },
            { value: 'PROFESIONAL', label: 'Profesional' },
          ],
        },
        { key: 'hoursPerWeek', label: 'Horas por semana', type: 'decimal', min: 0, max: 80 },
        { key: 'previousInjuries', label: 'Lesiones previas', type: 'textarea' },
      ],
    },
  ],
};

// The second version adds the pain scale, the list of goals and the acceptance signed on screen.
const SPORTS_INTAKE_V2: FormSchema = {
  sections: [
    SPORTS_INTAKE_V1.sections[0],
    {
      key: 'today',
      title: 'Estado actual',
      fields: [
        { key: 'painLevel', label: 'Dolor hoy', type: 'scale', min: 0, max: 10 },
        {
          key: 'goals',
          label: 'Objetivos',
          type: 'multiselect',
          options: [
            { value: 'VOLVER_A_COMPETIR', label: 'Volver a competir' },
            { value: 'SIN_DOLOR', label: 'Entrenar sin dolor' },
            { value: 'PREVENCION', label: 'Prevenir recaídas' },
          ],
        },
        { key: 'acceptance', label: 'Firma del deportista', type: 'signature' },
      ],
    },
  ],
  alerts: [
    { when: 'painLevel >= 8', level: 'warning', message: 'Dolor intenso al ingreso (8 o más).' },
  ],
};

const TRIAGE_V1: FormSchema = {
  sections: [
    {
      key: 'triage',
      title: 'Triaje',
      fields: [
        { key: 'arrival', label: 'Hora de llegada', type: 'time', required: true },
        {
          key: 'priority',
          label: 'Prioridad',
          type: 'radio',
          required: true,
          options: [
            { value: 'VERDE', label: 'Verde: puede esperar' },
            { value: 'AMARILLO', label: 'Amarillo: atención pronta' },
            { value: 'ROJO', label: 'Rojo: atención inmediata' },
          ],
        },
        // Alert rules compare numbers, so the urgency is also asked as a scale.
        {
          key: 'urgency',
          label: 'Urgencia (1 a 5)',
          type: 'scale',
          required: true,
          min: 1,
          max: 5,
        },
        { key: 'accompanied', label: 'Llega acompañado', type: 'checkbox' },
        { key: 'reason', label: 'Motivo', type: 'textarea', required: true },
      ],
    },
  ],
  alerts: [
    { when: 'urgency >= 5', level: 'critical', message: 'Triaje de urgencia máxima (5 de 5).' },
  ],
};

/**
 * One clinic that exercises what the multi-specialty work added: branches and their
 * professionals, permissions withdrawn and granted, encounters with their records, documents
 * with templates, signature and verification code, forms designed by the clinic, the medication
 * catalog and real files.
 */
export async function seedClinicalWorkflow(ctx: SeedContext): Promise<SeedTenant> {
  const { db, clock } = ctx;

  const clinic = await createTenant(ctx, {
    name: 'Centro Médico Los Arrayanes',
    email: 'contacto@arrayanes.test',
    phone: '+593999500001',
    address: 'Av. República E7-123 y Diego de Almagro, Quito',
    tenantType: 'CLINIC',
    planType: 'CLINIC_PRO',
    status: 'ACTIVE',
    specialties: ['psychology', 'nutrition', 'physiotherapy', 'dentistry'],
    fiscal: {
      legalName: 'Centro Médico Los Arrayanes S.A.',
      taxIdentificationType: 'RUC',
      taxIdentificationNumber: '1791234567001',
    },
    master: {
      email: 'titular.arrayanes@psic.com',
      firstName: 'Lorena',
      lastName: 'Jaramillo',
      phone: '+593999500002',
      note: 'Titular sin perfil profesional: sedes, permisos, plantillas, formularios y reportes; ve los archivos con el nombre oculto',
    },
  });
  const tenantId = clinic.tenant.id;

  // ------------------------------------------------------------------ team
  const valeria = await createUser(ctx, clinic, {
    email: 'psic.arrayanes@psic.com',
    firstName: 'Valeria',
    lastName: 'Montalvo',
    role: 'PROFESIONAL',
    note: 'Psicóloga; atiende solo en la sede principal',
    profile: { specialty: 'psychology', title: 'Psicóloga clínica', licenseNumber: 'PSI-EC-310' },
  });
  const esteban = await createUser(ctx, clinic, {
    email: 'odonto.arrayanes@psic.com',
    firstName: 'Esteban',
    lastName: 'Cordero',
    role: 'PROFESIONAL',
    note: 'Odontólogo; atiende solo en la Sede Norte. Tiene una atención abierta y puede recetar',
    profile: { specialty: 'dentistry', title: 'Odontólogo', licenseNumber: 'ODO-EC-311' },
  });
  const daniela = await createUser(ctx, clinic, {
    email: 'nutri.arrayanes@psic.com',
    firstName: 'Daniela',
    lastName: 'Paz',
    role: 'PROFESIONAL',
    note: 'Nutricionista sin sedes marcadas: atiende en todas',
    profile: { specialty: 'nutrition', title: 'Nutricionista', licenseNumber: 'NUT-EC-312' },
  });
  const hugo = await createUser(ctx, clinic, {
    email: 'fisio.arrayanes@psic.com',
    firstName: 'Hugo',
    lastName: 'Salas',
    role: 'PROFESIONAL',
    note: 'Fisioterapeuta en ambas sedes; su rol puede ver facturas, sin emitirlas',
    profile: { specialty: 'physiotherapy', title: 'Fisioterapeuta', licenseNumber: 'FIS-EC-313' },
  });
  await createUser(ctx, clinic, {
    email: 'recepcion.arrayanes@psic.com',
    firstName: 'Marta',
    lastName: 'Luna',
    role: 'ASISTENTE',
    note: 'Asistente; su rol puede ver y emitir facturas',
  });
  await createUser(ctx, clinic, {
    email: 'asistente.arrayanes@psic.com',
    firstName: 'Pablo',
    lastName: 'Rey',
    role: 'ASISTENTE',
    note: 'Asistente con los mismos permisos de su rol',
  });

  await db.tenantRolePermission.createMany({
    data: [
      { role: 'ASISTENTE' as const, permission: 'billing.view', granted: true },
      { role: 'ASISTENTE' as const, permission: 'billing.create', granted: true },
      // Professionals can view invoices, but only the master and assistants can issue them.
      { role: 'PROFESIONAL' as const, permission: 'billing.view', granted: true },
    ].map((row) => ({ tenantId, createdById: clinic.master.id, ...row })),
  });

  // ------------------------------------------------------------------ branches
  const mainBranch = await db.branch.findFirst({ where: { tenantId, isMain: true } });
  await db.branch.update({
    where: { id: mainBranch.id },
    data: {
      city: 'Quito',
      openingHours: 'Lunes a viernes de 08:00 a 18:00',
      rooms: ['Consultorio 1', 'Consultorio 2', 'Sala de rehabilitación'],
    },
  });
  const northBranch = await db.branch.create({
    data: {
      tenantId,
      name: 'Sede Norte',
      address: 'Av. de la Prensa N58-45, Quito',
      city: 'Quito',
      phone: '+593999500003',
      openingHours: 'Lunes a sábado de 09:00 a 17:00',
      rooms: ['Consultorio odontológico', 'Gimnasio terapéutico'],
    },
  });
  // Closed: it keeps its history and takes no new appointments.
  await db.branch.create({
    data: {
      tenantId,
      name: 'Sede Valle',
      address: 'Av. Ilaló y Río Zamora, Sangolquí',
      city: 'Sangolquí',
      isActive: false,
    },
  });
  await db.professionalBranch.createMany({
    data: [
      { userId: valeria.id, branchId: mainBranch.id },
      { userId: esteban.id, branchId: northBranch.id },
      { userId: hugo.id, branchId: mainBranch.id },
      { userId: hugo.id, branchId: northBranch.id },
    ].map((row) => ({ tenantId, ...row })),
  });

  // ------------------------------------------------------------------ catalogs
  await db.medication.createMany({
    data: [
      {
        commercialName: 'Amoxicilina Genfar',
        activeIngredient: 'Amoxicilina',
        concentration: '500 mg',
        presentation: 'Caja de 21 cápsulas',
        pharmaceuticalForm: 'Cápsula',
      },
      {
        commercialName: 'Ibuprofeno MK',
        activeIngredient: 'Ibuprofeno',
        concentration: '400 mg',
        presentation: 'Caja de 20 tabletas',
        pharmaceuticalForm: 'Tableta',
      },
      {
        commercialName: 'Paracetamol Infantil',
        activeIngredient: 'Paracetamol',
        concentration: '160 mg / 5 mL',
        presentation: 'Frasco de 120 mL',
        pharmaceuticalForm: 'Jarabe',
      },
      {
        commercialName: 'Clorhexidina Bucal',
        activeIngredient: 'Clorhexidina',
        concentration: '0,12 %',
        presentation: 'Frasco de 250 mL',
        pharmaceuticalForm: 'Enjuague',
      },
      // Out of use: it is no longer suggested when prescribing.
      {
        commercialName: 'Ketorolaco Sublingual',
        activeIngredient: 'Ketorolaco',
        concentration: '30 mg',
        pharmaceuticalForm: 'Tableta sublingual',
        isActive: false,
      },
    ].map((row) => ({ tenantId, ...row })),
  });

  await db.documentTemplate.createMany({
    data: [
      {
        moduleKey: 'general.certificates',
        name: 'Asistencia a consulta',
        body: 'Certifico que {{paciente}}, con identificación {{identificacion}}, asistió a consulta en {{consultorio}} el {{fecha}}.',
      },
      {
        moduleKey: 'general.certificates',
        name: 'Reposo',
        body: 'Certifico que {{paciente}}, de {{edad}}, fue atendido el {{fecha}} y requiere reposo por el tiempo indicado en este documento.',
      },
      {
        moduleKey: 'general.consents',
        name: 'Tratamiento odontológico',
        title: 'Consentimiento para tratamiento odontológico',
        body: 'Yo, {{paciente}}, con identificación {{identificacion}}, declaro que {{profesional}} me explicó el procedimiento, sus riesgos y alternativas, y autorizo su realización en {{consultorio}}.',
      },
      {
        moduleKey: 'general.consents',
        name: 'Atención psicológica',
        title: 'Consentimiento para atención psicológica',
        body: 'Acepto recibir atención psicológica con {{profesional}}. Entiendo los límites de la confidencialidad y que puedo terminar el proceso cuando lo decida.',
      },
      {
        moduleKey: 'general.certificates',
        name: 'Aptitud deportiva (formato anterior)',
        body: 'Certifico que {{paciente}} es apto para la práctica deportiva.',
        isActive: false,
      },
    ].map((row) => ({ tenantId, createdById: clinic.master.id, ...row })),
  });

  // ------------------------------------------------------------------ forms of the clinic
  const sportsForm = await db.formDefinition.create({
    data: {
      tenantId,
      name: 'Ficha de ingreso deportivo',
      description: 'Antecedentes deportivos del paciente de fisioterapia.',
      category: 'Fisioterapia',
      specialtyId: ctx.catalog.physiotherapy.id,
      currentVersion: 2,
      createdById: clinic.master.id,
      createdAt: clock.days(-25),
    },
  });
  const triageForm = await db.formDefinition.create({
    data: {
      tenantId,
      name: 'Triaje de teleconsulta',
      description: 'Lo que se pregunta antes de una teleconsulta, sea cual sea la especialidad.',
      category: 'Admisión',
      createdById: clinic.master.id,
      createdAt: clock.days(-25),
    },
  });
  await db.formDefinitionVersion.createMany({
    data: [
      { formDefinitionId: sportsForm.id, version: 1, schema: SPORTS_INTAKE_V1, at: -25 },
      { formDefinitionId: sportsForm.id, version: 2, schema: SPORTS_INTAKE_V2, at: -4 },
      { formDefinitionId: triageForm.id, version: 1, schema: TRIAGE_V1, at: -25 },
    ].map(({ at, schema, ...row }) => ({
      ...row,
      // Stored as the API stores a definition: checked and without anything it does not know.
      schema: validateFormSchema(schema) as unknown as Prisma.InputJsonValue,
      createdById: clinic.master.id,
      createdAt: clock.days(at),
    })),
  });
  const sportsV1: CustomForm = { id: sportsForm.id, version: 1, schema: SPORTS_INTAKE_V1 };
  const sportsV2: CustomForm = { id: sportsForm.id, version: 2, schema: SPORTS_INTAKE_V2 };
  const triage: CustomForm = { id: triageForm.id, version: 1, schema: TRIAGE_V1 };

  // ------------------------------------------------------------------ patients
  const renata = await createPatient(
    ctx,
    clinic,
    {
      firstName: 'Renata',
      lastName: 'Aguirre',
      email: 'renata.aguirre@pacientes.test',
      phone: '+593998100001',
      dateOfBirth: new Date('1988-03-14T00:00:00.000Z'),
      gender: 'Femenino',
      address: 'Los Cipreses N64-12, Quito',
      identificationType: 'CEDULA',
      identificationNumber: '1718402213',
      maritalStatus: 'Casada',
      occupation: 'Arquitecta',
      nationality: 'Ecuatoriana',
      bloodType: 'O+',
      insuranceProvider: 'Seguros Andinos',
      insurancePolicyNumber: 'SA-2026-004512',
      emergencyContactName: 'Julián Aguirre',
      emergencyContactPhone: '+593998100002',
      createdAt: clock.days(-20),
    },
    { current: [valeria, esteban] },
  );
  // A minor: the API requires the legal guardian.
  const mateo = await createPatient(
    ctx,
    clinic,
    {
      firstName: 'Mateo',
      lastName: 'Aguirre',
      dateOfBirth: new Date('2017-08-02T00:00:00.000Z'),
      gender: 'Masculino',
      identificationType: 'CEDULA',
      identificationNumber: '1722641185',
      nationality: 'Ecuatoriana',
      guardianName: 'Renata Aguirre',
      guardianRelationship: 'Madre',
      guardianIdentification: '1718402213',
      guardianPhone: '+593998100001',
      createdAt: clock.days(-18),
    },
    { current: [esteban, daniela] },
  );
  const thomas = await createPatient(
    ctx,
    clinic,
    {
      firstName: 'Thomas',
      lastName: 'Becker',
      email: 'thomas.becker@pacientes.test',
      phone: '+593998100003',
      dateOfBirth: new Date('1994-11-23T00:00:00.000Z'),
      gender: 'Masculino',
      identificationType: 'PASSPORT',
      identificationNumber: 'C4F7H82KP',
      nationality: 'Alemana',
      occupation: 'Entrenador de triatlón',
      createdAt: clock.days(-15),
    },
    { current: [hugo] },
  );
  const carmen = await createPatient(
    ctx,
    clinic,
    {
      firstName: 'Carmen',
      lastName: 'Yépez',
      phone: '+593998100004',
      dateOfBirth: new Date('1951-06-30T00:00:00.000Z'),
      gender: 'Femenino',
      identificationType: 'CEDULA',
      identificationNumber: '1709523374',
      maritalStatus: 'Viuda',
      nationality: 'Ecuatoriana',
      bloodType: 'A-',
      disability: 'Movilidad reducida; usa andador',
      insuranceProvider: 'IESS',
      emergencyContactName: 'Rocío Yépez',
      emergencyContactPhone: '+593998100005',
      createdAt: clock.days(-12),
    },
    { current: [daniela, valeria] },
  );
  // Registered at the front desk without a document yet.
  const jorge = await createPatient(
    ctx,
    clinic,
    {
      firstName: 'Jorge',
      lastName: 'Pinto',
      phone: '+593998100006',
      dateOfBirth: new Date('1979-01-09T00:00:00.000Z'),
      gender: 'Masculino',
      createdAt: clock.days(-6),
    },
    { current: [hugo, esteban] },
  );

  // ------------------------------------------------------------------ helpers
  let sequential = 0;
  const nextCode = () => `SEED${String(++sequential).padStart(12, '0')}`;

  const writeRecord = async (input: {
    patient: Patient;
    professional: User;
    moduleKey?: string;
    form?: CustomForm;
    data: Record<string, unknown>;
    notes?: string;
    at: Date;
    appointment?: Appointment;
    encounter?: Encounter;
    code?: string;
  }): Promise<SpecialtyRecord> => {
    const definition = input.form ? undefined : latestClinicalModule(input.moduleKey);
    // Stored exactly as the API would store it: validated, with its calculated fields.
    const data = input.form
      ? validateFormData(input.form.schema, input.data)
      : validateModuleData(definition, input.data);

    const record = await db.specialtyRecord.create({
      data: {
        tenantId,
        patientId: input.patient.id,
        professionalId: input.professional.id,
        specialtyId: clinic.specialtyOf.get(input.professional.id),
        appointmentId: input.appointment?.id,
        encounterId: input.encounter?.id,
        moduleKey: input.form ? `${CUSTOM_MODULE_PREFIX}${input.form.id}` : input.moduleKey,
        schemaVersion: input.form?.version ?? definition.schemaVersion,
        formDefinitionId: input.form?.id,
        verificationCode: input.code ?? nextCode(),
        data: data as Prisma.InputJsonObject,
        notes: input.notes,
        recordDate: input.at,
        createdAt: input.at,
      },
    });
    await writeAudit(ctx, clinic, {
      actor: input.professional,
      action: 'CREATE',
      entity: 'SPECIALTY_RECORD',
      entityId: record.id,
      patientId: input.patient.id,
      after: snapshotSpecialtyRecord(record),
      at: input.at,
    });
    return record;
  };

  const openEncounter = async (input: {
    patient: Patient;
    professional: User;
    encounterType: Encounter['encounterType'];
    reason: string;
    startedAt: Date;
    appointment?: Appointment;
    branchId?: string;
  }): Promise<Encounter> => {
    const encounter = await db.encounter.create({
      data: {
        tenantId,
        patientId: input.patient.id,
        professionalId: input.professional.id,
        specialtyId: clinic.specialtyOf.get(input.professional.id),
        appointmentId: input.appointment?.id,
        branchId: input.branchId ?? input.appointment?.branchId,
        encounterType: input.encounterType,
        status: 'OPEN',
        reason: input.reason,
        startedAt: input.startedAt,
        createdAt: input.startedAt,
      },
    });
    await writeAudit(ctx, clinic, {
      actor: input.professional,
      action: 'CREATE',
      entity: 'ENCOUNTER',
      entityId: encounter.id,
      patientId: input.patient.id,
      after: snapshotEncounter(encounter),
      at: input.startedAt,
    });
    return encounter;
  };

  const closeEncounter = async (encounter: Encounter, summary: string, closedAt: Date) => {
    const closed = await db.encounter.update({
      where: { id: encounter.id },
      data: { status: 'CLOSED', summary, closedAt, version: 2 },
    });
    await writeAudit(ctx, clinic, {
      actor: { id: encounter.professionalId },
      action: 'UPDATE',
      entity: 'ENCOUNTER',
      entityId: encounter.id,
      patientId: encounter.patientId,
      before: snapshotEncounter(encounter),
      after: snapshotEncounter(closed),
      reason: 'Cierre de la atención',
      at: closedAt,
    });
    return closed;
  };

  let storedBytes = 0;
  /** A clinical file with its bytes in the storage. Skipped when the seed has no storage. */
  const writeFile = async (input: {
    patient: Patient;
    uploader: User;
    category: string;
    fileName: string;
    description: string;
    mimeType: string;
    bytes: Buffer;
    at: Date;
    encounter?: Encounter;
  }) => {
    if (!ctx.storage) return null;
    const storageKey = `${tenantId}/${input.patient.id}/${randomUUID()}`;
    await ctx.storage.put(
      storageKey,
      ctx.cipher ? ctx.cipher.encryptBuffer(tenantId, input.bytes) : input.bytes,
    );
    storedBytes += input.bytes.length;

    const file = await db.patientFile.create({
      data: {
        tenantId,
        patientId: input.patient.id,
        uploadedById: input.uploader.id,
        encounterId: input.encounter?.id,
        category: input.category,
        fileName: input.fileName,
        description: input.description,
        mimeType: input.mimeType,
        sizeBytes: input.bytes.length,
        storageKey,
        createdAt: input.at,
      },
    });
    await writeAudit(ctx, clinic, {
      actor: input.uploader,
      action: 'CREATE',
      entity: 'PATIENT_FILE',
      entityId: file.id,
      patientId: input.patient.id,
      after: snapshotPatientFile(file),
      at: input.at,
    });
    return file;
  };

  const longDate = new Intl.DateTimeFormat('es', {
    dateStyle: 'long',
    timeZone: 'America/Guayaquil',
  });
  const frontendUrl = (process.env.FRONTEND_URL || 'http://localhost:4200').replace(/\/+$/, '');
  /** The PDF the API generates for a record, to keep among the files of the patient. */
  const renderDocument = (record: SpecialtyRecord, patient: Patient, professional: User) => {
    const definition = latestClinicalModule(record.moduleKey);
    const code = formatVerificationCode(record.verificationCode);
    return renderRecordPdf({
      clinic: {
        name: clinic.tenant.name,
        address: clinic.tenant.address,
        phone: clinic.tenant.phone,
      },
      title: definition.name,
      issuedOn: longDate.format(record.recordDate),
      patient: {
        name: `${patient.firstName} ${patient.lastName}`,
        identification: patient.identificationNumber,
      },
      professional: {
        name: `${professional.firstName} ${professional.lastName}`,
        title: professional.professionalTitle,
        licenseNumber: professional.licenseNumber,
      },
      sections: documentSections(definition.schema, record.data as Record<string, unknown>),
      notes: record.notes,
      verification: { code, url: `${frontendUrl}/verify/${code}` },
    });
  };

  const book = (professional: User, dayOffset: number, time: string) =>
    clinic.agenda.book(professional.id, dayOffset, time);

  // ------------------------------------------------------------------ Renata: psychology
  // First visit at the main branch: SOAP note, diagnosis, a narrative note and a certificate.
  const renataFirst = await createAppointment(ctx, clinic, {
    patient: renata,
    professional: valeria,
    slot: book(valeria, -7, '09:00'),
    status: 'COMPLETED',
    title: 'Primera consulta de psicología',
    data: { branchId: mainBranch.id, location: 'Consultorio 1' },
  });
  let renataEncounter = await openEncounter({
    patient: renata,
    professional: valeria,
    encounterType: 'FIRST_VISIT',
    reason: 'Ansiedad y dificultad para dormir desde hace dos meses.',
    startedAt: renataFirst.startTime,
    appointment: renataFirst,
  });
  await writeRecord({
    patient: renata,
    professional: valeria,
    moduleKey: 'general.soap-note',
    encounter: renataEncounter,
    appointment: renataFirst,
    at: renataFirst.startTime,
    data: {
      subjective: 'Refiere preocupación constante por el trabajo y despertares a las 3 a. m.',
      objective: 'Orientada, discurso coherente, afecto ansioso. Sin ideación suicida.',
      assessment: 'Cuadro compatible con ansiedad generalizada de intensidad moderada.',
      plan: 'Psicoeducación, higiene del sueño y sesiones semanales. Control en 7 días.',
    },
  });
  await writeRecord({
    patient: renata,
    professional: valeria,
    moduleKey: 'general.diagnoses',
    encounter: renataEncounter,
    appointment: renataFirst,
    at: renataFirst.startTime,
    data: {
      diagnoses: [
        {
          system: 'CIE10',
          code: 'F41.1',
          description: 'Trastorno de ansiedad generalizada',
          kind: 'PRINCIPAL',
          certainty: 'PRESUNTIVO',
        },
      ],
      observations: 'A confirmar en la segunda sesión con escala GAD-7.',
    },
  });
  await writeRecord({
    patient: renata,
    professional: valeria,
    moduleKey: 'general.certificates',
    encounter: renataEncounter,
    appointment: renataFirst,
    at: renataFirst.endTime,
    code: DEMO_DOCUMENT_CODES.certificate,
    data: {
      certificateType: 'ASISTENCIA',
      addressedTo: 'A quien corresponda',
      body: `Certifico que Renata Aguirre, con identificación 1718402213, asistió a consulta en Centro Médico Los Arrayanes el ${longDate.format(renataFirst.startTime)}.`,
    },
  });
  const renataNote = await db.clinicalNote.create({
    data: {
      tenantId,
      patientId: renata.id,
      psychologistId: valeria.id,
      specialtyId: clinic.specialtyOf.get(valeria.id),
      appointmentId: renataFirst.id,
      encounterId: renataEncounter.id,
      sessionDate: renataFirst.startTime,
      sessionDuration: renataFirst.duration,
      content:
        'Primera sesión. Se explora el inicio de los síntomas tras un cambio de cargo. Buena alianza.',
      diagnosis: 'F41.1 presuntivo',
      treatment: 'Terapia cognitivo-conductual, frecuencia semanal.',
      createdAt: renataFirst.startTime,
    },
  });
  await writeAudit(ctx, clinic, {
    actor: valeria,
    action: 'CREATE',
    entity: 'CLINICAL_NOTE',
    entityId: renataNote.id,
    patientId: renata.id,
    after: snapshotClinicalNote(renataNote),
    at: renataFirst.startTime,
  });
  renataEncounter = await closeEncounter(
    renataEncounter,
    'Se acuerda proceso semanal. Tarea: registro de sueño.',
    renataFirst.endTime,
  );

  // ------------------------------------------------------------------ Renata: dentistry
  // Control at Sede Norte: vital signs, consent signed on screen, prescription, an imaging
  // order with its result, and two files (the X-ray and the PDF of the consent).
  const renataDental = await createAppointment(ctx, clinic, {
    patient: renata,
    professional: esteban,
    slot: book(esteban, -3, '10:00'),
    status: 'COMPLETED',
    title: 'Tratamiento de conducto, pieza 36',
    data: { branchId: northBranch.id, location: 'Consultorio odontológico' },
  });
  let dentalEncounter = await openEncounter({
    patient: renata,
    professional: esteban,
    encounterType: 'PROCEDURE',
    reason: 'Dolor al masticar en la pieza 36.',
    startedAt: renataDental.startTime,
    appointment: renataDental,
  });
  await writeRecord({
    patient: renata,
    professional: esteban,
    moduleKey: 'general.vital-signs',
    encounter: dentalEncounter,
    appointment: renataDental,
    at: renataDental.startTime,
    data: {
      weightKg: 62,
      heightCm: 160,
      temperatureC: 36.6,
      systolic: 116,
      diastolic: 74,
      heartRate: 70,
      oxygenSaturation: 98,
    },
  });
  const consent = await writeRecord({
    patient: renata,
    professional: esteban,
    moduleKey: 'general.consents',
    encounter: dentalEncounter,
    appointment: renataDental,
    at: renataDental.startTime,
    code: DEMO_DOCUMENT_CODES.consent,
    data: {
      title: 'Consentimiento para tratamiento odontológico',
      body: 'Yo, Renata Aguirre, con identificación 1718402213, declaro que Esteban Cordero me explicó el procedimiento, sus riesgos y alternativas, y autorizo su realización en Centro Médico Los Arrayanes.',
      acceptedBy: 'PACIENTE',
      signerName: 'Renata Aguirre',
      signerIdentification: '1718402213',
      accepted: true,
      signerSignature: demoSignature(1),
    },
  });
  await writeRecord({
    patient: renata,
    professional: esteban,
    moduleKey: 'general.orders',
    encounter: dentalEncounter,
    appointment: renataDental,
    at: renataDental.startTime,
    data: {
      orderType: 'IMAGEN',
      description: 'Radiografía periapical de la pieza 36.',
      priority: 'PREFERENTE',
      status: 'REALIZADA',
      result: 'Lesión periapical de 3 mm. Conductos permeables. Imagen adjunta en Archivos.',
    },
  });
  const prescription = await writeRecord({
    patient: renata,
    professional: esteban,
    moduleKey: 'general.prescriptions',
    encounter: dentalEncounter,
    appointment: renataDental,
    at: renataDental.endTime,
    code: DEMO_DOCUMENT_CODES.prescription,
    data: {
      items: [
        {
          medication: 'Amoxicilina Genfar',
          activeIngredient: 'Amoxicilina',
          presentation: 'Caja de 21 cápsulas',
          dose: '500 mg',
          frequency: 'Cada 8 horas',
          route: 'ORAL',
          duration: '7 días',
          instructions: 'Completar el tratamiento aunque ceda el dolor.',
        },
        {
          medication: 'Ibuprofeno MK',
          activeIngredient: 'Ibuprofeno',
          presentation: 'Caja de 20 tabletas',
          dose: '400 mg',
          frequency: 'Cada 8 horas si hay dolor',
          route: 'ORAL',
          duration: '3 días',
        },
      ],
      generalInstructions: 'Dieta blanda por 48 horas. No masticar del lado tratado.',
    },
  });
  await writeFile({
    patient: renata,
    uploader: esteban,
    encounter: dentalEncounter,
    category: 'IMAGEN',
    fileName: 'radiografia-periapical-36.png',
    description: 'Radiografía periapical previa al tratamiento.',
    mimeType: 'image/png',
    bytes: demoRadiograph(),
    at: renataDental.startTime,
  });
  if (ctx.storage) {
    const consentFile = await writeFile({
      patient: renata,
      uploader: esteban,
      encounter: dentalEncounter,
      category: 'CONSENTIMIENTO',
      fileName: 'consentimiento-informado.pdf',
      description: `Documento generado. Código de verificación ${formatVerificationCode(consent.verificationCode)}.`,
      mimeType: 'application/pdf',
      bytes: await renderDocument(consent, renata, esteban),
      at: renataDental.startTime,
    });
    // The psychologist of the patient opened it afterwards: every download is audited.
    await writeAudit(ctx, clinic, {
      actor: valeria,
      action: 'READ',
      entity: 'PATIENT_FILE',
      entityId: consentFile.id,
      patientId: renata.id,
      at: clock.days(-2),
    });
    await writeFile({
      patient: renata,
      uploader: esteban,
      category: 'RECETA',
      fileName: 'receta.pdf',
      description: `Documento generado. Código de verificación ${formatVerificationCode(prescription.verificationCode)}.`,
      mimeType: 'application/pdf',
      bytes: await renderDocument(prescription, renata, esteban),
      at: renataDental.endTime,
    });
  }
  dentalEncounter = await closeEncounter(
    dentalEncounter,
    'Apertura y conductometría de la pieza 36. Obturación en la próxima cita.',
    renataDental.endTime,
  );
  await createAppointment(ctx, clinic, {
    patient: renata,
    professional: esteban,
    slot: book(esteban, 4, '10:00'),
    status: 'CONFIRMED',
    title: 'Obturación de conductos, pieza 36',
    data: { branchId: northBranch.id, location: 'Consultorio odontológico' },
  });

  // ------------------------------------------------------------------ Mateo: in progress
  // The child is in the chair right now: an open encounter of the dentist, an allergy that
  // raises a standing alert and a temperature that raises a warning.
  const mateoNow = await createAppointment(ctx, clinic, {
    patient: mateo,
    professional: esteban,
    slot: clinic.agenda.reserve(esteban.id, clock.minutes(-20), 60),
    status: 'IN_PROGRESS',
    title: 'Urgencia: dolor dental',
    data: { branchId: northBranch.id, location: 'Consultorio odontológico' },
  });
  const mateoEncounter = await openEncounter({
    patient: mateo,
    professional: esteban,
    encounterType: 'EMERGENCY',
    reason: 'Dolor intenso en molar inferior derecho desde anoche; no durmió.',
    startedAt: mateoNow.startTime,
    appointment: mateoNow,
  });
  await writeRecord({
    patient: mateo,
    professional: esteban,
    moduleKey: 'general.allergies',
    at: clock.days(-18),
    data: {
      category: 'MEDICAMENTO',
      allergen: 'Penicilina',
      reaction: 'Erupción generalizada y dificultad respiratoria',
      severity: 'GRAVE',
      observations: 'Referida por la madre; atendido en emergencia en 2023.',
    },
  });
  await writeRecord({
    patient: mateo,
    professional: esteban,
    moduleKey: 'general.vital-signs',
    encounter: mateoEncounter,
    appointment: mateoNow,
    at: mateoNow.startTime,
    data: { weightKg: 29.5, heightCm: 132, temperatureC: 39.6, heartRate: 108 },
  });
  await createAppointment(ctx, clinic, {
    patient: mateo,
    professional: daniela,
    slot: book(daniela, 6, '15:00'),
    status: 'SCHEDULED',
    title: 'Control nutricional',
    data: { branchId: mainBranch.id, location: 'Consultorio 2' },
  });

  // ------------------------------------------------------------------ Thomas: physiotherapy
  // The same form of the clinic answered under its two versions, a referral and a
  // certificate that was corrected after it was handed over.
  const thomasFirst = await createAppointment(ctx, clinic, {
    patient: thomas,
    professional: hugo,
    slot: book(hugo, -9, '11:00'),
    status: 'COMPLETED',
    title: 'Evaluación de rodilla',
    data: { branchId: northBranch.id, location: 'Gimnasio terapéutico' },
  });
  let thomasEncounter = await openEncounter({
    patient: thomas,
    professional: hugo,
    encounterType: 'ASSESSMENT',
    reason: 'Dolor en la rodilla izquierda al correr más de 5 km.',
    startedAt: thomasFirst.startTime,
    appointment: thomasFirst,
  });
  await writeRecord({
    patient: thomas,
    professional: hugo,
    form: sportsV1,
    encounter: thomasEncounter,
    appointment: thomasFirst,
    at: thomasFirst.startTime,
    data: {
      sport: 'Triatlón',
      level: 'COMPETITIVO',
      hoursPerWeek: 14.5,
      previousInjuries: 'Fascitis plantar derecha en 2024.',
    },
  });
  await writeRecord({
    patient: thomas,
    professional: hugo,
    moduleKey: 'general.referrals',
    encounter: thomasEncounter,
    appointment: thomasFirst,
    at: thomasFirst.endTime,
    data: {
      destinationSpecialty: 'Traumatología',
      reason: 'Descartar lesión meniscal antes de aumentar la carga de entrenamiento.',
      diagnosis: 'Síndrome femoropatelar izquierdo',
      priority: 'PREFERENTE',
      status: 'PENDIENTE',
    },
  });
  thomasEncounter = await closeEncounter(
    thomasEncounter,
    'Plan de fortalecimiento de cuádriceps y control en una semana.',
    thomasFirst.endTime,
  );

  const thomasControl = await createAppointment(ctx, clinic, {
    patient: thomas,
    professional: hugo,
    slot: book(hugo, -2, '11:00'),
    status: 'COMPLETED',
    title: 'Control de rodilla',
    data: { branchId: mainBranch.id, location: 'Sala de rehabilitación' },
  });
  let thomasSecond = await openEncounter({
    patient: thomas,
    professional: hugo,
    encounterType: 'FOLLOW_UP',
    reason: 'Control a la semana de iniciar el plan.',
    startedAt: thomasControl.startTime,
    appointment: thomasControl,
  });
  await writeRecord({
    patient: thomas,
    professional: hugo,
    form: sportsV2,
    encounter: thomasSecond,
    appointment: thomasControl,
    at: thomasControl.startTime,
    data: {
      sport: 'Triatlón',
      level: 'COMPETITIVO',
      hoursPerWeek: 9,
      painLevel: 8,
      goals: ['VOLVER_A_COMPETIR', 'PREVENCION'],
      acceptance: demoSignature(2),
    },
  });
  const restCertificate = await writeRecord({
    patient: thomas,
    professional: hugo,
    moduleKey: 'general.certificates',
    encounter: thomasSecond,
    appointment: thomasControl,
    at: thomasControl.endTime,
    code: DEMO_DOCUMENT_CODES.corrected,
    data: {
      certificateType: 'REPOSO',
      body: 'Certifico que Thomas Becker fue atendido y requiere reposo deportivo por el tiempo indicado en este documento.',
      diagnosis: 'Síndrome femoropatelar izquierdo',
      restDays: 5,
    },
  });
  // Corrected the next day: ten days of rest, not five. The verification page warns about it.
  const correctedData = validateModuleData(latestClinicalModule('general.certificates'), {
    ...(restCertificate.data as Record<string, unknown>),
    restDays: 10,
  });
  const correctedCertificate = await db.specialtyRecord.update({
    where: { id: restCertificate.id },
    data: {
      data: correctedData as Prisma.InputJsonObject,
      version: 2,
      updatedAt: clock.days(-1),
    },
  });
  await writeAudit(ctx, clinic, {
    actor: hugo,
    action: 'UPDATE',
    entity: 'SPECIALTY_RECORD',
    entityId: restCertificate.id,
    patientId: thomas.id,
    before: snapshotSpecialtyRecord(restCertificate),
    after: snapshotSpecialtyRecord(correctedCertificate),
    reason: 'Días de reposo mal digitados.',
    at: clock.days(-1),
  });
  thomasSecond = await closeEncounter(
    thomasSecond,
    'Dolor 8/10 tras la carrera del domingo. Se suspende la carrera por 10 días.',
    thomasControl.endTime,
  );

  // ------------------------------------------------------------------ Carmen: teleconsultation
  // No appointment and no branch: the nutritionist called her. Blood pressure in crisis range
  // raises a critical alert; the laboratory order is still pending.
  const carmenCall = clock.at(-1, '16:30');
  let carmenEncounter = await openEncounter({
    patient: carmen,
    professional: daniela,
    encounterType: 'TELECONSULTATION',
    reason: 'Mareo y dolor de cabeza desde la mañana; mide su presión en casa.',
    startedAt: carmenCall,
  });
  await writeRecord({
    patient: carmen,
    professional: daniela,
    form: triage,
    encounter: carmenEncounter,
    at: carmenCall,
    data: {
      arrival: '16:30',
      priority: 'ROJO',
      urgency: 5,
      accompanied: true,
      reason: 'Presión de 185/122 medida en casa, con cefalea.',
    },
  });
  await writeRecord({
    patient: carmen,
    professional: daniela,
    moduleKey: 'general.vital-signs',
    encounter: carmenEncounter,
    at: carmenCall,
    data: {
      weightKg: 71,
      heightCm: 152,
      systolic: 185,
      diastolic: 122,
      heartRate: 96,
      glucoseMgDl: 112,
      observations: 'Valores referidos por la paciente con tensiómetro digital.',
    },
  });
  await writeRecord({
    patient: carmen,
    professional: daniela,
    moduleKey: 'general.diagnoses',
    encounter: carmenEncounter,
    at: carmenCall,
    data: {
      diagnoses: [
        {
          system: 'CIE10',
          code: 'I10',
          description: 'Hipertensión esencial (primaria)',
          kind: 'PRINCIPAL',
          certainty: 'CONFIRMADO',
        },
        {
          system: 'CIE10',
          code: 'E66.9',
          description: 'Obesidad, no especificada',
          kind: 'SECUNDARIO',
          certainty: 'DEFINITIVO',
        },
      ],
    },
  });
  await writeRecord({
    patient: carmen,
    professional: daniela,
    moduleKey: 'general.orders',
    encounter: carmenEncounter,
    at: carmenCall,
    data: {
      orderType: 'LABORATORIO',
      description: 'Perfil lipídico, glucosa en ayunas y creatinina.',
      priority: 'URGENTE',
      status: 'PENDIENTE',
    },
  });
  carmenEncounter = await closeEncounter(
    carmenEncounter,
    'Se indica acudir a emergencia hoy. Se envía orden de laboratorio.',
    new Date(carmenCall.getTime() + 25 * 60 * 1000),
  );

  if (ctx.storage) {
    await writeFile({
      patient: carmen,
      uploader: daniela,
      category: 'EXAMEN',
      fileName: 'perfil-lipidico.pdf',
      description: 'Resultado anterior, traído por la paciente.',
      mimeType: 'application/pdf',
      bytes: await demoLabReport('Carmen Yépez', longDate.format(clock.days(-40))),
      at: clock.days(-10),
    });
    // Uploaded to the wrong patient and removed: kept for audit, never listed.
    const wrongFile = await writeFile({
      patient: carmen,
      uploader: daniela,
      category: 'OTRO',
      fileName: 'resultado-de-otro-paciente.pdf',
      description: 'Subido por error.',
      mimeType: 'application/pdf',
      bytes: await demoLabReport('Otro paciente', longDate.format(clock.days(-11))),
      at: clock.days(-10),
    });
    await db.patientFile.update({
      where: { id: wrongFile.id },
      data: {
        deletedAt: clock.days(-9),
        deletedById: daniela.id,
        deletionReason: 'Archivo subido al paciente equivocado.',
      },
    });
    await writeAudit(ctx, clinic, {
      actor: daniela,
      action: 'DELETE',
      entity: 'PATIENT_FILE',
      entityId: wrongFile.id,
      patientId: carmen.id,
      before: snapshotPatientFile(wrongFile),
      reason: 'Archivo subido al paciente equivocado.',
      at: clock.days(-9),
    });
  }

  // A certificate issued and then withdrawn: `/verify` reports it as no longer valid.
  const withdrawn = await writeRecord({
    patient: carmen,
    professional: valeria,
    moduleKey: 'general.certificates',
    at: clock.days(-8),
    code: DEMO_DOCUMENT_CODES.withdrawn,
    data: {
      certificateType: 'PSICOLOGICO',
      body: 'Certifico que Carmen Yépez asiste a proceso psicológico en este consultorio.',
    },
  });
  await db.specialtyRecord.update({
    where: { id: withdrawn.id },
    data: {
      deletedAt: clock.days(-7),
      deletedById: valeria.id,
      deletionReason: 'Emitido por error: la paciente aún no inicia el proceso.',
    },
  });
  await writeAudit(ctx, clinic, {
    actor: valeria,
    action: 'DELETE',
    entity: 'SPECIALTY_RECORD',
    entityId: withdrawn.id,
    patientId: carmen.id,
    before: snapshotSpecialtyRecord(withdrawn),
    reason: 'Emitido por error: la paciente aún no inicia el proceso.',
    at: clock.days(-7),
  });
  await createAppointment(ctx, clinic, {
    patient: carmen,
    professional: valeria,
    slot: book(valeria, 3, '09:00'),
    status: 'SCHEDULED',
    title: 'Primera consulta de psicología',
    data: { branchId: mainBranch.id, location: 'Consultorio 1' },
  });

  // ------------------------------------------------------------------ Jorge: the report
  // Appointments that did not end in an attention, so that the activity report by branch has
  // cancelled and missed ones to count.
  await createAppointment(ctx, clinic, {
    patient: jorge,
    professional: hugo,
    slot: book(hugo, -4, '15:00'),
    status: 'CANCELLED',
    title: 'Evaluación de hombro',
    data: {
      branchId: northBranch.id,
      location: 'Gimnasio terapéutico',
      cancelledAt: clock.days(-5),
      cancellationReason: 'El paciente avisó que no podía asistir.',
    },
  });
  await createAppointment(ctx, clinic, {
    patient: jorge,
    professional: esteban,
    slot: book(esteban, -1, '09:00'),
    status: 'NO_SHOW',
    title: 'Revisión odontológica',
    data: { branchId: northBranch.id, location: 'Consultorio odontológico' },
  });
  await createAppointment(ctx, clinic, {
    patient: jorge,
    professional: hugo,
    slot: book(hugo, 2, '15:00'),
    status: 'SCHEDULED',
    title: 'Evaluación de hombro',
    data: { branchId: mainBranch.id, location: 'Sala de rehabilitación' },
  });

  // ------------------------------------------------------------------ usage
  await syncUsage(ctx, clinic);
  if (storedBytes > 0) {
    // Removed files keep their bytes for the audit and keep counting.
    await db.tenantSubscription.update({
      where: { tenantId },
      data: { storageUsedBytes: BigInt(storedBytes) },
    });
  }

  ctx.highlights.push(
    `${clinic.tenant.name}: documentos para probar en /verify/<código> sin iniciar sesión —`,
    `  certificado vigente ${formatVerificationCode(DEMO_DOCUMENT_CODES.certificate)}, receta ${formatVerificationCode(DEMO_DOCUMENT_CODES.prescription)}, consentimiento firmado ${formatVerificationCode(DEMO_DOCUMENT_CODES.consent)},`,
    `  certificado corregido ${formatVerificationCode(DEMO_DOCUMENT_CODES.corrected)} y certificado anulado ${formatVerificationCode(DEMO_DOCUMENT_CODES.withdrawn)}.`,
  );
  if (!ctx.storage) {
    ctx.highlights.push(
      `${clinic.tenant.name}: sin almacenamiento configurado no se sembraron archivos de pacientes.`,
    );
  }
  return clinic;
}
