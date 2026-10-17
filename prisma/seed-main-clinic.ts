import { createECDH, randomBytes } from 'crypto';
import type { Appointment, ClinicalNote, Patient, Prisma, User } from '@prisma/client';
import { snapshotClinicalNote } from '../src/clinical-notes/clinical-notes.service';
import { snapshotEncounter } from '../src/encounters/encounters.service';
import { snapshotSpecialtyRecord } from '../src/specialty-records/specialty-records.service';
import {
  createAppointment,
  createBillingProfile,
  createPatient,
  createTenant,
  createUser,
  SeedContext,
  SeedTenant,
  Slot,
  syncUsage,
  writeAudit,
} from './seed-helpers';
import { seedDemoSpecialties } from './seed-demo-specialties';

type NoteFields = Pick<
  Prisma.ClinicalNoteUncheckedCreateInput,
  'content' | 'diagnosis' | 'treatment' | 'observations'
>;

/** A note plus the CREATE entry the API would have written with it. */
async function writeNote(
  ctx: SeedContext,
  clinic: SeedTenant,
  input: NoteFields & {
    patient: Patient;
    author: User;
    sessionDate: Date;
    appointment?: Appointment;
  },
): Promise<ClinicalNote> {
  const { patient, author, appointment, sessionDate, ...fields } = input;
  const note = await ctx.db.clinicalNote.create({
    data: {
      ...fields,
      tenantId: clinic.tenant.id,
      patientId: patient.id,
      psychologistId: author.id,
      specialtyId: clinic.specialtyOf.get(author.id),
      appointmentId: appointment?.id,
      sessionDate,
      sessionDuration: appointment?.duration,
      createdAt: sessionDate,
    },
  });
  await writeAudit(ctx, clinic, {
    actor: author,
    action: 'CREATE',
    entity: 'CLINICAL_NOTE',
    entityId: note.id,
    patientId: patient.id,
    after: snapshotClinicalNote(note),
    at: sessionDate,
  });
  return note;
}

/** A correction: new version, with the previous and the new state in the audit log. */
async function correctNote(
  ctx: SeedContext,
  clinic: SeedTenant,
  note: ClinicalNote,
  changes: Partial<NoteFields>,
  reason: string,
  at: Date,
): Promise<ClinicalNote> {
  const updated = await ctx.db.clinicalNote.update({
    where: { id: note.id },
    data: { ...changes, version: note.version + 1 },
  });
  await writeAudit(ctx, clinic, {
    actor: { id: note.psychologistId },
    action: 'UPDATE',
    entity: 'CLINICAL_NOTE',
    entityId: note.id,
    patientId: note.patientId,
    before: snapshotClinicalNote(note),
    after: snapshotClinicalNote(updated),
    reason,
    at,
  });
  return updated;
}

async function writeRecord(
  ctx: SeedContext,
  clinic: SeedTenant,
  input: {
    patient: Patient;
    professional: User;
    moduleKey: string;
    /** Omitted for records in the pre-definition format (version 1 of the older modules). */
    schemaVersion?: number;
    data: Prisma.InputJsonObject;
    notes?: string;
    recordDate: Date;
    appointment?: Appointment;
  },
) {
  const record = await ctx.db.specialtyRecord.create({
    data: {
      tenantId: clinic.tenant.id,
      patientId: input.patient.id,
      professionalId: input.professional.id,
      specialtyId: clinic.specialtyOf.get(input.professional.id),
      appointmentId: input.appointment?.id,
      moduleKey: input.moduleKey,
      schemaVersion: input.schemaVersion,
      data: input.data,
      notes: input.notes,
      recordDate: input.recordDate,
      createdAt: input.recordDate,
    },
  });
  await writeAudit(ctx, clinic, {
    actor: input.professional,
    action: 'CREATE',
    entity: 'SPECIALTY_RECORD',
    entityId: record.id,
    patientId: input.patient.id,
    after: snapshotSpecialtyRecord(record),
    at: input.recordDate,
  });
  return record;
}

/** What the retired provider returned for an authorized document. The links are fictitious. */
function issuedDocument(sequential: number, issueDate: Date) {
  const day = issueDate.toISOString().slice(0, 10).split('-').reverse().join('');
  const accessKey = `${day}011790012345001100100${String(sequential).padStart(10, '0')}1234567815`;
  const externalId = `fk_test_${String(sequential).padStart(6, '0')}`;
  return {
    externalId,
    accessKey,
    authorizationNumber: accessKey,
    xmlUrl: `https://faktur.invalid/documents/${externalId}.xml`,
    pdfUrl: `https://faktur.invalid/documents/${externalId}.pdf`,
    providerResponse: { id: externalId, status: 'AUTHORIZED', environment: 'TEST', accessKey },
  };
}

const webPushKeys = () => ({
  p256dh: createECDH('prime256v1').generateKeys().toString('base64url'),
  auth: randomBytes(16).toString('base64url'),
});

/**
 * The clinic with data in every state: team accounts, patients, the six appointment statuses,
 * versioned and removed clinical records, tasks, notifications, invoices and audit trail.
 */
export async function seedMainClinic(ctx: SeedContext): Promise<SeedTenant> {
  const { db, clock, catalog } = ctx;

  const clinic = await createTenant(ctx, {
    name: 'Demo Consultorio Integral',
    email: 'contacto@demopsicologia.com',
    phone: '+593999000001',
    address: 'Av. Principal 123, Quito',
    tenantType: 'CLINIC',
    fiscal: {
      legalName: 'Demo Consultorio Integral S.A.',
      taxIdentificationType: 'RUC',
      taxIdentificationNumber: '1790012345001',
    },
    settings: { workingHoursStart: '08:30', workingHoursEnd: '18:30' },
    planType: 'CLINIC_PRO',
    status: 'ACTIVE',
    subscription: {
      startDate: clock.days(-59),
      currentPeriodStart: clock.days(-5),
      currentPeriodEnd: clock.days(25),
      storageUsedBytes: BigInt(850 * 1024 * 1024),
      monthlyNotificationsSent: 97,
      lastNotificationReset: clock.days(-5),
    },
    // Four specialties on a plan that includes three: the fourth is billed as an extra.
    specialties: ['psychology', 'nutrition', 'physiotherapy', 'dentistry'],
    master: {
      email: 'admin.demo@psic.com',
      firstName: 'Daniela',
      lastName: 'Mendoza',
      phone: '+593999000010',
      note: 'Titular sin perfil profesional: administra, no lee contenido clínico',
      data: { activatedAt: clock.days(-59) },
    },
  });
  const tenantId = clinic.tenant.id;
  const { master: admin, agenda } = clinic;

  // ---------------------------------------------------------------- team
  const demos = await seedDemoSpecialties(db, {
    tenantId,
    hashedPassword: ctx.hashedPassword,
    assignedById: admin.id,
    specialtyIds: {
      psychology: catalog.psychology.id,
      nutrition: catalog.nutrition.id,
      physiotherapy: catalog.physiotherapy.id,
      dentistry: catalog.dentistry.id,
    },
    referenceDate: clock.now,
  });
  for (const [key, demo] of Object.entries(demos)) {
    clinic.specialtyOf.set(demo.professional.id, catalog[key as keyof typeof demos].id);
    clinic.usage.seats += 1;
    clinic.usage.patients += 1;
    agenda.reserve(demo.professional.id, demo.appointment.startTime, demo.appointment.duration);
    ctx.logins.push({
      tenant: clinic.tenant.name,
      email: demo.professional.email,
      role: demo.professional.role,
      note: `Profesional activo (${demo.professional.professionalTitle})`,
    });
  }
  const {
    psychology: { professional: ana, patient: valeria, appointment: valeriaLastSession },
    nutrition: { professional: luis, patient: camila },
    physiotherapy: { professional: sofia, patient: andres },
    dentistry: { professional: carlos, patient: lucia },
  } = demos;

  const assistant = await createUser(ctx, clinic, {
    email: 'asistente.demo@psic.com',
    firstName: 'Mariana',
    lastName: 'Rojas',
    phone: '+593999000013',
    role: 'ASISTENTE',
    note: 'Asistente: agenda y pacientes, sin acceso clínico',
    data: { activatedAt: clock.days(-20) },
  });
  const diego = await createUser(ctx, clinic, {
    email: 'psic.diego@psic.com',
    firstName: 'Diego',
    lastName: 'Herrera',
    phone: '+593999000016',
    role: 'PROFESIONAL',
    note: 'Segundo psicólogo: lee el historial compartido, solo edita lo suyo',
    profile: {
      specialty: 'psychology',
      title: 'Psicólogo infantojuvenil',
      licenseNumber: 'PSY-EC-005',
      bio: 'Atención a niños, adolescentes y familias.',
    },
  });
  await createUser(ctx, clinic, {
    email: 'psic.elena@psic.com',
    firstName: 'Elena',
    lastName: 'Cárdenas',
    role: 'PROFESIONAL',
    note: 'Cuenta activa con perfil profesional inactivo: 403 en contenido clínico',
    profile: { specialty: 'psychology', title: 'Psicóloga clínica', isActive: false },
  });
  const raul = await createUser(ctx, clinic, {
    email: 'psic.raul@psic.com',
    firstName: 'Raúl',
    lastName: 'Espinoza',
    role: 'PROFESIONAL',
    note: 'Profesional desactivado con historial clínico: no puede iniciar sesión',
    profile: {
      specialty: 'psychology',
      title: 'Psicólogo clínico',
      licenseNumber: 'PSY-EC-006',
      isActive: false,
    },
    data: { isActive: false, activatedAt: clock.days(-58) },
  });
  const gabriela = await createUser(ctx, clinic, {
    email: 'nutri.gabriela@psic.com',
    firstName: 'Gabriela',
    lastName: 'Ponce',
    role: 'PROFESIONAL',
    note: 'Invitación pendiente de activar por el titular (ya ocupa un cupo)',
    profile: { specialty: 'nutrition', title: 'Nutricionista deportiva' },
    data: {
      isActive: false,
      emailVerified: false,
      activatedAt: null,
      invitedAt: clock.days(-2),
      invitedBy: admin.id,
    },
  });
  await createUser(ctx, clinic, {
    email: 'fisio.tomas@psic.com',
    firstName: 'Tomás',
    lastName: 'Rivas',
    role: 'PROFESIONAL',
    note: 'Acceso heredado pendiente: aparece en /platform/legacy-access/pending',
    profile: { specialty: 'physiotherapy', title: 'Fisioterapeuta', isActive: false },
    data: { isActive: false, emailVerified: false, activatedAt: null, managedByProvider: true },
  });
  await createUser(ctx, clinic, {
    email: 'asistente.patricia@psic.com',
    firstName: 'Patricia',
    lastName: 'Luna',
    role: 'ASISTENTE',
    note: 'Asistente desactivada: no puede iniciar sesión',
    data: { isActive: false },
  });
  await createUser(ctx, clinic, {
    email: 'soporte.legado@psic.com',
    firstName: 'Soporte',
    lastName: 'Heredado',
    role: 'SOPORTE',
    note: 'Rol obsoleto, cuenta cerrada por la migración del panel de plataforma',
    data: { isActive: false },
  });
  await db.user.update({ where: { id: sofia.id }, data: { fcmToken: 'seed-fcm-token-sofia' } });

  // ------------------------------------------------------------ patients
  const jorge = await createPatient(
    ctx,
    clinic,
    {
      firstName: 'Jorge',
      lastName: 'Salazar',
      email: 'jorge.salazar@email.com',
      phone: '+593999100003',
      dateOfBirth: new Date('1988-09-02'),
      gender: 'MALE',
      emergencyContactName: 'Rosa Salazar',
      emergencyContactPhone: '+593999100004',
      currentMedication: 'Escitalopram 10mg',
    },
    { current: [ana] },
  );
  const martina = await createPatient(
    ctx,
    clinic,
    {
      firstName: 'Martina',
      lastName: 'Suárez',
      email: 'martina.suarez@email.com',
      phone: '+593999100008',
      dateOfBirth: new Date('1992-01-27'),
      gender: 'FEMALE',
      address: 'Calle de los Olivos 45, Quito',
      emergencyContactName: 'Pablo Suárez (hermano)',
      emergencyContactPhone: '+593999100009',
      allergies: 'Alergia a la penicilina y a los frutos secos',
      currentMedication: 'Sertralina 50mg',
      notes: 'Atención conjunta de psicología y nutrición. La factura va a nombre de su empresa.',
    },
    { current: [ana, luis] },
  );
  const mateo = await createPatient(
    ctx,
    clinic,
    {
      firstName: 'Mateo',
      lastName: 'Jiménez',
      dateOfBirth: new Date('2015-05-09'),
      gender: 'MALE',
      emergencyContact: 'Verónica Jiménez (madre)',
      emergencyPhone: '+593999100010',
      emergencyContactName: 'Verónica Jiménez',
      emergencyContactPhone: '+593999100010',
      // The API requires a legal guardian for patients under 18.
      guardianName: 'Verónica Jiménez',
      guardianRelationship: 'Madre',
      guardianIdentification: '1712345678',
      guardianPhone: '+593999100010',
      notes: 'Menor de edad. La representante recibe las facturas y las comunicaciones.',
    },
    { current: [diego] },
  );
  const renata = await createPatient(
    ctx,
    clinic,
    {
      firstName: 'Renata',
      lastName: 'Villacís',
      email: 'renata.villacis@email.com',
      phone: '+34600100200',
      dateOfBirth: new Date('1985-12-03'),
      gender: 'OTHER',
      notes: 'Reside en el exterior; todas las sesiones son en línea.',
    },
    { current: [diego] },
  );
  // Only the required fields: this patient has no billing profile.
  const hugo = await createPatient(
    ctx,
    clinic,
    { firstName: 'Hugo', lastName: 'Paredes', gender: 'PREFER_NOT_TO_SAY' },
    { current: [ana] },
  );
  const elias = await createPatient(ctx, clinic, {
    firstName: 'Elías',
    lastName: 'Cordero',
    email: 'elias.cordero@email.com',
    phone: '+593999100011',
    notes: 'Ingreso reciente; aún sin profesional asignado.',
    createdAt: clock.hours(-5),
  });
  const paula = await createPatient(
    ctx,
    clinic,
    {
      firstName: 'Paula',
      lastName: 'Andrade',
      email: 'paula.andrade@email.com',
      dateOfBirth: new Date('1997-07-21'),
      gender: 'FEMALE',
      notes: 'Alta terapéutica. Expediente archivado.',
      isActive: false,
    },
    { former: [raul] },
  );
  const samuel = await createPatient(
    ctx,
    clinic,
    {
      firstName: 'Samuel',
      lastName: 'Ortiz',
      email: 'samuel.ortiz@email.com',
      isActive: false,
      deletedAt: clock.days(-12),
    },
    { current: [ana] },
  );
  // Billing profiles replace the legacy billing fields the patients used to carry.
  await createBillingProfile(ctx, clinic, martina, {
    kind: 'COMPANY',
    idType: '04',
    idNumber: '1791234567001',
    legalName: 'Suárez & Asociados Cía. Ltda.',
    email: 'contabilidad@suarezasociados.ec',
    address: 'Av. República 310, Quito',
  });
  await createBillingProfile(ctx, clinic, mateo, {
    kind: 'PERSON',
    idType: '05',
    idNumber: '1712345675',
    legalName: 'Verónica Jiménez',
    email: 'veronica.jimenez@email.com',
  });
  await createBillingProfile(ctx, clinic, renata, {
    kind: 'PERSON',
    idType: '06',
    idNumber: 'XDA458921',
    legalName: 'Renata Villacís',
    email: 'renata.villacis@email.com',
  });
  await createBillingProfile(ctx, clinic, samuel, {
    kind: 'PERSON',
    idType: '05',
    idNumber: '0912345675',
    legalName: 'Samuel Ortiz',
    email: 'samuel.ortiz@email.com',
  });
  const isabel = await createPatient(
    ctx,
    clinic,
    {
      firstName: 'Isabel',
      lastName: 'Montenegro',
      email: 'isabel.montenegro@email.com',
      phone: '+593999100012',
      dateOfBirth: new Date('1975-03-30'),
      gender: 'FEMALE',
      notes: 'Reasignada a otro profesional tras la salida del anterior.',
    },
    { current: [diego], former: [raul] },
  );

  // -------------------------------------------------------- appointments
  const visit = (
    patient: Patient,
    professional: User,
    slot: Slot,
    status: Appointment['status'],
    title: string,
    data?: Partial<Prisma.AppointmentUncheckedCreateInput>,
  ) => createAppointment(ctx, clinic, { patient, professional, slot, status, title, data });
  const online = (room: string) => ({
    isOnline: true,
    location: 'En línea',
    meetingUrl: `https://meet.example.com/${room}`,
  });

  // Tied to the moment the seed runs, so they are reserved before the calendar is filled.
  await visit(
    mateo,
    diego,
    agenda.reserve(diego.id, clock.minutes(-20), 60),
    'IN_PROGRESS',
    'Terapia de juego',
  );
  await visit(
    hugo,
    ana,
    agenda.reserve(ana.id, clock.hours(2), 45),
    'CONFIRMED',
    'Primera entrevista',
    {
      reminderSent24h: true,
      reminderSent2h: true,
      lastReminderSentAt: clock.now,
    },
  );

  const valeriaIntake = await visit(
    valeria,
    ana,
    agenda.book(ana.id, -24, '09:00'),
    'COMPLETED',
    'Evaluación inicial',
  );
  const valeriaSecond = await visit(
    valeria,
    ana,
    agenda.book(ana.id, -17, '09:00'),
    'COMPLETED',
    'Sesión de seguimiento de ansiedad',
  );
  const valeriaThird = await visit(
    valeria,
    ana,
    agenda.book(ana.id, -10, '09:00'),
    'COMPLETED',
    'Sesión de seguimiento de ansiedad',
  );
  await visit(
    valeria,
    ana,
    agenda.book(ana.id, 4, '09:00'),
    'SCHEDULED',
    'Sesión de seguimiento de ansiedad',
  );
  await visit(
    jorge,
    ana,
    agenda.book(ana.id, 1, '10:00'),
    'CONFIRMED',
    'TCC - gestión de estrés',
    online('demo-psic-001'),
  );
  const hugoCancelled = await visit(
    hugo,
    ana,
    agenda.book(ana.id, -2, '15:00', 45),
    'CANCELLED',
    'Primera entrevista',
    {
      cancelledAt: clock.days(-3),
      cancelledBy: assistant.id,
      cancellationReason: 'El paciente pidió reprogramar por un viaje.',
    },
  );
  const martinaPsychology = await visit(
    martina,
    ana,
    agenda.book(ana.id, -6, '11:00'),
    'COMPLETED',
    'Primera consulta',
  );
  await visit(
    martina,
    ana,
    agenda.book(ana.id, 7, '11:00', 90),
    'SCHEDULED',
    'Sesión extendida de exposición',
  );
  const samuelSession = await visit(
    samuel,
    ana,
    agenda.book(ana.id, -45, '16:00'),
    'COMPLETED',
    'Consulta única',
  );

  const martinaNutrition = await visit(
    martina,
    luis,
    agenda.book(luis.id, -7, '10:00'),
    'COMPLETED',
    'Valoración nutricional',
  );
  await visit(martina, luis, agenda.book(luis.id, 4, '10:00'), 'CANCELLED', 'Control nutricional', {
    cancelledAt: clock.hours(-6),
    cancelledBy: luis.id,
    cancellationReason: 'El profesional no estará disponible ese día.',
  });
  const camilaFirst = await visit(
    camila,
    luis,
    agenda.book(luis.id, -28, '12:00'),
    'COMPLETED',
    'Valoración nutricional',
  );
  const camilaControl = await visit(
    camila,
    luis,
    agenda.book(luis.id, -14, '12:00', 30),
    'COMPLETED',
    'Control mensual',
  );

  const andresFirst = await visit(
    andres,
    sofia,
    agenda.book(sofia.id, -9, '08:30', 45),
    'COMPLETED',
    'Evaluación funcional de rodilla',
    { location: 'Sala de rehabilitación' },
  );
  const andresSecond = await visit(
    andres,
    sofia,
    agenda.book(sofia.id, -5, '08:30', 45),
    'COMPLETED',
    'Rehabilitación de rodilla',
    { location: 'Sala de rehabilitación' },
  );
  await visit(
    andres,
    sofia,
    agenda.book(sofia.id, 8, '08:30', 45),
    'SCHEDULED',
    'Rehabilitación de rodilla',
    { location: 'Sala de rehabilitación' },
  );

  const luciaCleaning = await visit(
    lucia,
    carlos,
    agenda.book(carlos.id, -15, '14:00', 45),
    'COMPLETED',
    'Profilaxis',
    { location: 'Consultorio odontológico' },
  );
  // Past and never closed: nobody marked it as completed or missed.
  await visit(
    lucia,
    carlos,
    agenda.book(carlos.id, -1, '11:00', 30),
    'CONFIRMED',
    'Control de sensibilidad',
    { location: 'Consultorio odontológico' },
  );
  await visit(
    lucia,
    carlos,
    agenda.book(carlos.id, 30, '14:00', 30),
    'SCHEDULED',
    'Control semestral',
    { location: 'Consultorio odontológico' },
  );

  const mateoFirst = await visit(
    mateo,
    diego,
    agenda.book(diego.id, -7, '16:00'),
    'COMPLETED',
    'Entrevista con la familia',
  );
  const renataMissed = await visit(
    renata,
    diego,
    agenda.book(diego.id, -5, '17:00'),
    'NO_SHOW',
    'Sesión en línea',
    online('demo-psic-002'),
  );
  await visit(
    renata,
    diego,
    agenda.book(diego.id, 2, '17:00'),
    'SCHEDULED',
    'Sesión en línea',
    online('demo-psic-002'),
  );
  const isabelCurrent = await visit(
    isabel,
    diego,
    agenda.book(diego.id, -4, '10:00'),
    'COMPLETED',
    'Sesión de continuidad',
  );
  await visit(
    isabel,
    diego,
    agenda.book(diego.id, 6, '10:00'),
    'SCHEDULED',
    'Sesión de continuidad',
  );

  const isabelFormer = await visit(
    isabel,
    raul,
    agenda.book(raul.id, -30, '10:00'),
    'COMPLETED',
    'Sesión de terapia',
  );
  const paulaFirst = await visit(
    paula,
    raul,
    agenda.book(raul.id, -40, '09:00'),
    'COMPLETED',
    'Sesión de terapia',
  );
  const paulaLast = await visit(
    paula,
    raul,
    agenda.book(raul.id, -33, '09:00'),
    'COMPLETED',
    'Sesión de cierre',
  );

  // ------------------------------------------------------ clinical notes
  await writeNote(ctx, clinic, {
    patient: valeria,
    author: ana,
    appointment: valeriaIntake,
    sessionDate: valeriaIntake.startTime,
    content:
      'Primera entrevista. Refiere temor intenso a exponer en reuniones de trabajo desde hace dos años, con evitación progresiva.',
    diagnosis: 'Trastorno de ansiedad social (impresión diagnóstica)',
    treatment: 'Se propone terapia cognitivo conductual, 12 sesiones semanales.',
    observations: 'Se aplica PHQ-9 como línea base.',
  });
  await writeNote(ctx, clinic, {
    patient: valeria,
    author: ana,
    appointment: valeriaSecond,
    sessionDate: valeriaSecond.startTime,
    content:
      'Psicoeducación sobre el ciclo de la ansiedad. Se construye la jerarquía de exposición.',
    treatment: 'Registro de pensamientos automáticos como tarea.',
  });
  const valeriaThirdNote = await writeNote(ctx, clinic, {
    patient: valeria,
    author: ana,
    appointment: valeriaThird,
    sessionDate: valeriaThird.startTime,
    content: 'Primera exposición en sesión: presentación de dos minutos. Ansiedad máxima 6/10.',
    diagnosis: 'Trastorno de ansiedad generalizada',
    treatment: 'Continuar jerarquía de exposición.',
  });
  // Two corrections by the author: the note ends at version 3 with both changes audited.
  const valeriaThirdCorrected = await correctNote(
    ctx,
    clinic,
    valeriaThirdNote,
    { diagnosis: 'Trastorno de ansiedad social' },
    'Diagnóstico registrado por error; corresponde a ansiedad social.',
    clock.days(-9),
  );
  await correctNote(
    ctx,
    clinic,
    valeriaThirdCorrected,
    { observations: 'La paciente autoriza coordinar con su médico de cabecera.' },
    'Se añade la autorización verbal que faltó registrar.',
    clock.days(-8),
  );
  await writeNote(ctx, clinic, {
    patient: valeria,
    author: ana,
    appointment: valeriaLastSession,
    sessionDate: valeriaLastSession.startTime,
    content:
      'Paciente muestra menor evitación social. Se reforzaron técnicas de respiración y registro de pensamientos automáticos.',
    diagnosis: 'Trastorno de ansiedad social',
    treatment: 'Terapia cognitivo conductual con exposición gradual.',
    observations: 'Mantener frecuencia semanal por 4 sesiones adicionales.',
  });

  // The same patient seen by two specialties: one shared history.
  const martinaNote = await writeNote(ctx, clinic, {
    patient: martina,
    author: ana,
    appointment: martinaPsychology,
    sessionDate: martinaPsychology.startTime,
    content:
      'Consulta por ansiedad asociada a la alimentación. Se coordina el abordaje con nutrición.',
    diagnosis: 'Ansiedad con conducta alimentaria restrictiva',
    treatment: 'Trabajo conjunto con nutrición; sesiones quincenales.',
  });
  await writeNote(ctx, clinic, {
    patient: martina,
    author: luis,
    appointment: martinaNutrition,
    sessionDate: martinaNutrition.startTime,
    content: 'Recordatorio de 24 horas: ingesta insuficiente en el desayuno y saltos de comida.',
    treatment: 'Plan de cinco tiempos de comida con horarios fijos.',
    observations: 'Evitar lenguaje de restricción; coordinar mensajes con psicología.',
  });
  // Content only: every optional field stays empty.
  await writeNote(ctx, clinic, {
    patient: camila,
    author: luis,
    appointment: camilaControl,
    sessionDate: camilaControl.startTime,
    content: 'Control mensual. Buena adherencia al plan; refiere más energía por las tardes.',
  });
  await writeNote(ctx, clinic, {
    patient: andres,
    author: sofia,
    appointment: andresSecond,
    sessionDate: andresSecond.startTime,
    content: 'Mejora el rango de flexión. Dolor 5/10 al subir escaleras.',
    diagnosis: 'Rehabilitación posquirúrgica de menisco derecho',
    treatment: 'Fortalecimiento de cuádriceps y propiocepción.',
  });
  await writeNote(ctx, clinic, {
    patient: lucia,
    author: carlos,
    appointment: luciaCleaning,
    sessionDate: luciaCleaning.startTime,
    content: 'Profilaxis sin complicaciones. Se detecta sensibilidad al frío en la pieza 24.',
    diagnosis: 'Hipersensibilidad dentinaria leve',
    treatment: 'Pasta desensibilizante y control en dos semanas.',
  });
  await writeNote(ctx, clinic, {
    patient: mateo,
    author: diego,
    appointment: mateoFirst,
    sessionDate: mateoFirst.startTime,
    content: 'Entrevista con la madre. Dificultades de atención en clase y rabietas frecuentes.',
    observations: 'Solicitar informe escolar.',
  });
  // Not tied to an appointment: a follow-up call.
  await writeNote(ctx, clinic, {
    patient: mateo,
    author: diego,
    sessionDate: clock.days(-3),
    content: 'Llamada con la tutora del colegio. Confirma mejoría en el trabajo en grupo.',
  });
  await writeNote(ctx, clinic, {
    patient: samuel,
    author: ana,
    appointment: samuelSession,
    sessionDate: samuelSession.startTime,
    content: 'Consulta única de orientación. No requiere seguimiento.',
  });

  // History written by a professional who has since left the clinic.
  for (const appointment of [paulaFirst, paulaLast]) {
    await writeNote(ctx, clinic, {
      patient: paula,
      author: raul,
      appointment,
      sessionDate: appointment.startTime,
      content:
        appointment === paulaLast
          ? 'Sesión de cierre. Se revisan logros y plan de prevención de recaídas. Alta terapéutica.'
          : 'Seguimiento del proceso de duelo. Retoma actividades sociales.',
      diagnosis: 'Duelo no complicado',
    });
  }
  await writeNote(ctx, clinic, {
    patient: isabel,
    author: raul,
    appointment: isabelFormer,
    sessionDate: isabelFormer.startTime,
    content: 'Sesión centrada en el conflicto laboral. Se entrena comunicación asertiva.',
    diagnosis: 'Trastorno adaptativo con ánimo ansioso',
  });
  await writeNote(ctx, clinic, {
    patient: isabel,
    author: diego,
    appointment: isabelCurrent,
    sessionDate: isabelCurrent.startTime,
    content: [
      'Primera sesión con el nuevo profesional. Se revisa el historial del proceso anterior y se acuerda continuar con los mismos objetivos.',
      'La paciente describe que el conflicto con su jefatura se redujo tras una reunión mediada por recursos humanos, aunque persiste la anticipación negativa los domingos por la noche.',
      'Se trabaja la identificación de señales tempranas de activación y un plan de acción para la semana: rutina de cierre del día, límites de horario y una actividad placentera no negociable.',
      'Queda pendiente retomar el entrenamiento en asertividad con una situación concreta para la próxima sesión.',
    ].join('\n\n'),
    diagnosis: 'Trastorno adaptativo con ánimo ansioso',
    treatment: 'Continuidad de terapia cognitivo conductual.',
    observations: 'Buena disposición al cambio de profesional.',
  });

  // Written on the wrong patient and removed: the row stays, hidden from every listing.
  const misplacedNote = await writeNote(ctx, clinic, {
    patient: jorge,
    author: ana,
    sessionDate: clock.days(-1),
    content: 'Paciente refiere insomnio de conciliación durante la última semana.',
  });
  const removalReason = 'Registrada en el paciente equivocado.';
  await db.clinicalNote.update({
    where: { id: misplacedNote.id },
    data: { deletedAt: clock.hours(-20), deletedById: ana.id, deletionReason: removalReason },
  });
  await writeAudit(ctx, clinic, {
    actor: ana,
    action: 'DELETE',
    entity: 'CLINICAL_NOTE',
    entityId: misplacedNote.id,
    patientId: jorge.id,
    before: snapshotClinicalNote(misplacedNote),
    reason: removalReason,
    at: clock.hours(-20),
  });
  // Reads leave a trace without content.
  await writeAudit(ctx, clinic, {
    actor: diego,
    action: 'READ',
    entity: 'CLINICAL_NOTE',
    entityId: martinaNote.id,
    patientId: martina.id,
    at: clock.days(-2),
  });

  // --------------------------------------------------- specialty records
  await writeRecord(ctx, clinic, {
    patient: valeria,
    professional: ana,
    appointment: valeriaIntake,
    moduleKey: 'psychology.assessments',
    data: { testName: 'PHQ-9', score: 14, interpretation: 'Síntomas depresivos moderados.' },
    notes: 'Línea base.',
    recordDate: valeriaIntake.startTime,
  });
  await writeRecord(ctx, clinic, {
    patient: valeria,
    professional: ana,
    appointment: valeriaThird,
    moduleKey: 'psychology.assessments',
    data: { testName: 'PHQ-9', score: 11, interpretation: 'Síntomas depresivos moderados.' },
    recordDate: valeriaThird.startTime,
  });
  await writeRecord(ctx, clinic, {
    patient: jorge,
    professional: ana,
    moduleKey: 'psychology.assessments',
    data: { testName: 'GAD-7', score: 9, interpretation: 'Ansiedad leve.' },
    recordDate: clock.days(-8),
  });
  await writeRecord(ctx, clinic, {
    patient: mateo,
    professional: diego,
    appointment: mateoFirst,
    moduleKey: 'psychology.assessments',
    data: {
      testName: 'CBCL 6-18',
      score: 62,
      interpretation: 'Rango limítrofe en problemas de atención.',
    },
    recordDate: mateoFirst.startTime,
  });
  await writeRecord(ctx, clinic, {
    patient: camila,
    professional: luis,
    appointment: camilaFirst,
    moduleKey: 'nutrition.assessments',
    data: { weightKg: 71, heightCm: 165, bmi: 26.1 },
    notes: 'Medición inicial.',
    recordDate: camilaFirst.startTime,
  });
  await writeRecord(ctx, clinic, {
    patient: camila,
    professional: luis,
    appointment: camilaFirst,
    moduleKey: 'nutrition.diet-plans',
    data: {
      dailyCalories: 1800,
      meals: 'Desayuno, almuerzo, merienda y cena',
      dietaryGoals: 'Déficit calórico moderado.',
    },
    recordDate: camilaFirst.startTime,
  });
  await writeRecord(ctx, clinic, {
    patient: camila,
    professional: luis,
    appointment: camilaControl,
    moduleKey: 'nutrition.assessments',
    data: { weightKg: 69.5, heightCm: 165, bmi: 25.5 },
    recordDate: camilaControl.startTime,
  });
  await writeRecord(ctx, clinic, {
    patient: martina,
    professional: luis,
    appointment: martinaNutrition,
    moduleKey: 'nutrition.assessments',
    data: { weightKg: 52, heightCm: 163, bmi: 19.6 },
    recordDate: martinaNutrition.startTime,
  });
  await writeRecord(ctx, clinic, {
    patient: martina,
    professional: luis,
    appointment: martinaNutrition,
    moduleKey: 'nutrition.diet-plans',
    data: {
      dailyCalories: 2100,
      meals: 'Cinco tiempos de comida con horarios fijos',
      dietaryGoals: 'Regularizar la ingesta sin restricciones.',
    },
    recordDate: martinaNutrition.startTime,
  });
  await writeRecord(ctx, clinic, {
    patient: andres,
    professional: sofia,
    appointment: andresFirst,
    moduleKey: 'physiotherapy.evolution',
    data: {
      painLevel: 7,
      mobility: 'Flexión de rodilla limitada a 80 grados',
      progress: 'Evaluación inicial.',
    },
    recordDate: andresFirst.startTime,
  });
  await writeRecord(ctx, clinic, {
    patient: andres,
    professional: sofia,
    appointment: andresFirst,
    moduleKey: 'physiotherapy.exercise-plans',
    data: {
      exercises: 'Isométricos de cuádriceps y deslizamientos de talón',
      frequency: 'A diario',
      repetitions: '3 series de 10 repeticiones',
    },
    recordDate: andresFirst.startTime,
  });
  await writeRecord(ctx, clinic, {
    patient: andres,
    professional: sofia,
    appointment: andresSecond,
    moduleKey: 'physiotherapy.evolution',
    data: {
      painLevel: 5,
      mobility: 'Flexión de rodilla hasta 95 grados',
      progress: 'Mejora sostenida.',
    },
    recordDate: andresSecond.startTime,
  });
  await writeRecord(ctx, clinic, {
    patient: lucia,
    professional: carlos,
    appointment: luciaCleaning,
    moduleKey: 'dentistry.odontogram',
    data: { findings: 'Restauración en pieza 16; sin caries activas.', surfaces: '16-O' },
    recordDate: luciaCleaning.startTime,
  });
  await writeRecord(ctx, clinic, {
    patient: lucia,
    professional: carlos,
    moduleKey: 'dentistry.treatments',
    data: {
      procedure: 'Resina compuesta',
      tooth: 'Pieza 24',
      treatmentStatus: 'Planificado',
    },
    notes: 'Pendiente de aprobación del presupuesto.',
    recordDate: clock.days(-1),
  });

  // Records under the current module definitions, as the API stores them after validation.
  await writeRecord(ctx, clinic, {
    patient: valeria,
    professional: ana,
    appointment: valeriaIntake,
    moduleKey: 'psychology.session-notes',
    data: {
      reason: 'Ánimo bajo y dificultad para dormir desde hace dos meses.',
      intervention: 'Entrevista inicial y psicoeducación sobre higiene del sueño.',
      recommendations: 'Registro diario de sueño hasta la próxima sesión.',
    },
    recordDate: valeriaIntake.startTime,
  });
  await writeRecord(ctx, clinic, {
    patient: valeria,
    professional: ana,
    appointment: valeriaIntake,
    moduleKey: 'psychology.mental-exam',
    data: {
      appearance: 'Cuidada, colaboradora, contacto visual adecuado.',
      consciousness: 'ALERTA',
      orientation: ['TIEMPO', 'ESPACIO', 'PERSONA'],
      mood: 'Ánimo bajo, afecto congruente.',
      insight: 'COMPLETA',
      risk: 'BAJO',
    },
    recordDate: valeriaIntake.startTime,
  });
  await writeRecord(ctx, clinic, {
    patient: valeria,
    professional: ana,
    appointment: valeriaThird,
    moduleKey: 'psychology.phq9',
    data: { q1: 2, q2: 2, q3: 2, q4: 2, q5: 1, q6: 1, q7: 1, q8: 0, q9: 0, total: 11 },
    recordDate: valeriaThird.startTime,
  });
  await writeRecord(ctx, clinic, {
    patient: valeria,
    professional: ana,
    appointment: valeriaThird,
    moduleKey: 'psychology.treatment-plan',
    data: {
      hypothesis: 'Episodio depresivo moderado asociado a sobrecarga laboral.',
      objectives: [
        {
          objective: 'Regularizar el sueño',
          intervention: 'Higiene del sueño y control de estímulos',
          progress: 'EN_PROGRESO',
        },
        {
          objective: 'Retomar actividades placenteras',
          intervention: 'Activación conductual',
          progress: 'NO_INICIADO',
        },
      ],
      nextSteps: 'Revisar el registro de actividades en la próxima sesión.',
    },
    recordDate: valeriaThird.startTime,
  });
  await writeRecord(ctx, clinic, {
    patient: jorge,
    professional: ana,
    moduleKey: 'psychology.gad7',
    data: { q1: 2, q2: 1, q3: 2, q4: 1, q5: 1, q6: 1, q7: 1, total: 9 },
    recordDate: clock.days(-8),
  });
  await writeRecord(ctx, clinic, {
    patient: camila,
    professional: luis,
    appointment: camilaFirst,
    moduleKey: 'nutrition.food-history',
    data: {
      intolerances: 'Lactosa.',
      habits: 'Tres comidas al día, cena tardía y consumo frecuente de bebidas azucaradas.',
      mealsPerDay: 3,
      waterLitersPerDay: 1.2,
      goals: 'Reducir grasa corporal y ordenar horarios.',
    },
    recordDate: camilaFirst.startTime,
  });
  await writeRecord(ctx, clinic, {
    patient: camila,
    professional: luis,
    appointment: camilaControl,
    moduleKey: 'general.vital-signs',
    data: { weightKg: 69.5, heightCm: 165, bmi: 25.5, systolic: 118, diastolic: 76, heartRate: 72 },
    recordDate: camilaControl.startTime,
  });
  await writeRecord(ctx, clinic, {
    patient: andres,
    professional: sofia,
    appointment: andresFirst,
    moduleKey: 'physiotherapy.assessment',
    data: {
      functionalDiagnosis: 'Limitación funcional de rodilla derecha posterior a esguince.',
      painLevel: 7,
      painLocation: 'Cara medial de la rodilla derecha',
      jointRanges: [{ joint: 'Rodilla derecha', movement: 'Flexión', degrees: 80 }],
      muscleStrength: [{ muscleGroup: 'Cuádriceps derecho', grade: 3 }],
    },
    recordDate: andresFirst.startTime,
  });
  await writeRecord(ctx, clinic, {
    patient: lucia,
    professional: carlos,
    appointment: luciaCleaning,
    moduleKey: 'dentistry.evolution',
    data: {
      procedurePerformed: 'Profilaxis y aplicación de flúor.',
      observations: 'Encías sin sangrado.',
      nextStep: 'Resina compuesta en la pieza 24.',
    },
    recordDate: luciaCleaning.startTime,
  });
  await writeRecord(ctx, clinic, {
    patient: lucia,
    professional: carlos,
    moduleKey: 'general.allergies',
    data: {
      category: 'MEDICAMENTO',
      allergen: 'Penicilina',
      reaction: 'Urticaria generalizada',
      severity: 'GRAVE',
    },
    recordDate: luciaCleaning.startTime,
  });
  await writeRecord(ctx, clinic, {
    patient: lucia,
    professional: carlos,
    moduleKey: 'general.prescriptions',
    data: {
      items: [
        {
          medication: 'Ibuprofeno',
          presentation: 'Tabletas de 400 mg',
          dose: '400 mg',
          frequency: 'Cada 8 horas',
          route: 'ORAL',
          duration: '3 días',
          instructions: 'Tomar después de las comidas.',
        },
      ],
    },
    recordDate: clock.days(-1),
  });

  // --------------------------------------------------- encounters
  // A second branch, and an attention opened from an appointment and signed off.
  const northBranch = await db.branch.create({
    data: {
      tenantId: clinic.tenant.id,
      name: 'Sede Norte',
      address: 'Av. de los Shyris N35-71, Quito',
      city: 'Quito',
      rooms: ['Consultorio 1', 'Consultorio odontológico'],
    },
  });
  const luciaEncounter = await db.encounter.create({
    data: {
      tenantId: clinic.tenant.id,
      patientId: lucia.id,
      professionalId: carlos.id,
      specialtyId: clinic.specialtyOf.get(carlos.id),
      appointmentId: luciaCleaning.id,
      branchId: northBranch.id,
      encounterType: 'CONTROL',
      status: 'CLOSED',
      reason: 'Control y profilaxis semestral.',
      summary: 'Profilaxis realizada. Se programa resina en la pieza 24.',
      startedAt: luciaCleaning.startTime,
      closedAt: luciaCleaning.endTime,
      version: 2,
      createdAt: luciaCleaning.startTime,
    },
  });
  await writeAudit(ctx, clinic, {
    actor: carlos,
    action: 'CREATE',
    entity: 'ENCOUNTER',
    entityId: luciaEncounter.id,
    patientId: lucia.id,
    after: snapshotEncounter(luciaEncounter),
    at: luciaCleaning.startTime,
  });

  // Typed with the wrong weight and removed: kept for audit, never listed.
  const mistypedRecord = await writeRecord(ctx, clinic, {
    patient: camila,
    professional: luis,
    appointment: camilaControl,
    moduleKey: 'nutrition.assessments',
    data: { weightKg: 96.5, heightCm: 165, bmi: 35.4 },
    recordDate: camilaControl.startTime,
  });
  await db.specialtyRecord.update({
    where: { id: mistypedRecord.id },
    data: {
      deletedAt: clock.days(-13),
      deletedById: luis.id,
      deletionReason: 'Peso digitado con error.',
    },
  });
  await writeAudit(ctx, clinic, {
    actor: luis,
    action: 'DELETE',
    entity: 'SPECIALTY_RECORD',
    entityId: mistypedRecord.id,
    patientId: camila.id,
    before: snapshotSpecialtyRecord(mistypedRecord),
    reason: 'Peso digitado con error.',
    at: clock.days(-13),
  });
  await writeAudit(ctx, clinic, {
    actor: ana,
    action: 'READ',
    entity: 'SPECIALTY_RECORD',
    entityId: mistypedRecord.id,
    patientId: camila.id,
    at: clock.days(-14),
  });

  // --------------------------------------------------- next session plans
  await db.nextSessionPlan.createMany({
    data: [
      {
        tenantId,
        patientId: valeria.id,
        psychologistId: ana.id,
        specialtyId: catalog.psychology.id,
        objectives: 'Consolidar exposición en contextos laborales.',
        techniques: 'Reestructuración cognitiva y role-play.',
        homework: 'Registro ABC 3 veces por semana.',
        notes: 'Evaluar reducción de evitación en la próxima sesión.',
      },
      {
        tenantId,
        patientId: camila.id,
        psychologistId: luis.id,
        specialtyId: catalog.nutrition.id,
        objectives: 'Revisar adherencia y ajustar porciones.',
        homework: 'Registro fotográfico de comidas durante una semana.',
      },
      {
        tenantId,
        patientId: andres.id,
        psychologistId: sofia.id,
        specialtyId: catalog.physiotherapy.id,
        objectives: 'Alcanzar 110 grados de flexión.',
        techniques: 'Movilización pasiva y ejercicios en cadena cerrada.',
      },
      {
        tenantId,
        patientId: lucia.id,
        psychologistId: carlos.id,
        specialtyId: catalog.dentistry.id,
        objectives: 'Restaurar la pieza 24.',
        notes: 'Confirmar presupuesto antes de la cita.',
      },
      // Only the objective: the rest of the plan is still to be written.
      {
        tenantId,
        patientId: mateo.id,
        psychologistId: diego.id,
        specialtyId: catalog.psychology.id,
        objectives: 'Devolver resultados a la familia.',
      },
    ],
  });

  // ---------------------------------------------------------------- tasks
  const dueSoonTask = await db.task.create({
    data: {
      tenantId,
      patientId: jorge.id,
      createdById: admin.id,
      assignedToId: ana.id,
      title: 'Revisar cuestionario PHQ-9',
      description: 'Analizar variación respecto a la última medición.',
      status: 'PENDING',
      priority: 'HIGH',
      dueDate: clock.hours(20),
    },
  });
  await db.task.createMany({
    data: [
      // Due within a day and nobody assigned: the reminder job notifies whoever created it.
      {
        tenantId,
        patientId: renata.id,
        createdById: diego.id,
        title: 'Enviar enlace de la próxima sesión',
        status: 'PENDING',
        priority: 'MEDIUM',
        dueDate: clock.hours(6),
      },
      {
        tenantId,
        patientId: hugo.id,
        createdById: admin.id,
        assignedToId: assistant.id,
        title: 'Completar la ficha del paciente',
        description: 'Faltan correo, teléfono y datos de facturación.',
        status: 'PENDING',
        priority: 'HIGH',
        dueDate: clock.days(2),
      },
      {
        tenantId,
        patientId: camila.id,
        createdById: admin.id,
        assignedToId: luis.id,
        title: 'Revisar adherencia al plan nutricional',
        status: 'IN_PROGRESS',
        priority: 'MEDIUM',
        dueDate: clock.days(2),
      },
      // Overdue and still open.
      {
        tenantId,
        patientId: valeria.id,
        createdById: admin.id,
        assignedToId: ana.id,
        title: 'Enviar material de psicoeducación',
        status: 'PENDING',
        priority: 'URGENT',
        dueDate: clock.days(-1),
      },
      {
        tenantId,
        patientId: mateo.id,
        createdById: diego.id,
        assignedToId: diego.id,
        title: 'Redactar informe para el colegio',
        status: 'IN_PROGRESS',
        priority: 'URGENT',
        dueDate: clock.days(-3),
      },
      {
        tenantId,
        patientId: andres.id,
        createdById: admin.id,
        assignedToId: sofia.id,
        title: 'Actualizar progresión de ejercicios',
        status: 'COMPLETED',
        priority: 'LOW',
        dueDate: clock.days(-2),
        completedAt: clock.days(-2),
      },
      // Finished after its due date.
      {
        tenantId,
        patientId: martina.id,
        createdById: ana.id,
        assignedToId: luis.id,
        title: 'Coordinar plan conjunto con psicología',
        status: 'COMPLETED',
        priority: 'HIGH',
        dueDate: clock.days(-6),
        completedAt: clock.days(-4),
      },
      {
        tenantId,
        patientId: lucia.id,
        createdById: admin.id,
        assignedToId: carlos.id,
        title: 'Revisar sensibilidad de la pieza 24',
        status: 'PENDING',
        priority: 'MEDIUM',
        dueDate: clock.days(3),
      },
      {
        tenantId,
        patientId: paula.id,
        createdById: admin.id,
        assignedToId: raul.id,
        title: 'Llamada de seguimiento tras el alta',
        status: 'CANCELLED',
        priority: 'LOW',
        dueDate: clock.days(-20),
      },
      // No due date.
      {
        tenantId,
        patientId: elias.id,
        createdById: assistant.id,
        title: 'Asignar profesional tratante',
        status: 'PENDING',
        priority: 'LOW',
      },
    ],
  });

  // -------------------------------------------------------- notifications
  await db.notificationPreference.createMany({
    data: [
      { userId: ana.id, morningDigest: true },
      { userId: luis.id, pushEnabled: false },
      { userId: sofia.id, taskDueReminders: false },
      { userId: carlos.id, appointmentReminders: false },
    ],
  });
  await db.pushSubscription.createMany({
    data: [
      {
        tenantId,
        userId: ana.id,
        endpoint: 'https://push.invalid/seed/ana-desktop',
        userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/140.0',
        ...webPushKeys(),
      },
      {
        tenantId,
        userId: ana.id,
        endpoint: 'https://push.invalid/seed/ana-mobile',
        userAgent: 'Mozilla/5.0 (Linux; Android 15) Chrome/140.0 Mobile',
        ...webPushKeys(),
      },
      {
        tenantId,
        userId: admin.id,
        endpoint: 'https://push.invalid/seed/admin-desktop',
        userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_6) Safari/605.1.15',
        ...webPushKeys(),
      },
    ],
  });
  await db.notificationLog.createMany({
    data: [
      {
        tenantId,
        userId: admin.id,
        type: 'SYSTEM_ANNOUNCEMENT',
        status: 'SENT',
        title: 'Bienvenido al entorno demo',
        body: 'La base de datos fue sembrada correctamente.',
        sentAt: clock.days(-1),
      },
      // No recipient: an announcement for the whole clinic.
      {
        tenantId,
        type: 'SYSTEM_ANNOUNCEMENT',
        status: 'SENT',
        title: 'Mantenimiento programado',
        body: 'El sistema no estará disponible el domingo de 02:00 a 03:00.',
        sentAt: clock.days(-2),
        createdAt: clock.days(-2),
      },
      {
        tenantId,
        userId: ana.id,
        type: 'SYSTEM_ANNOUNCEMENT',
        status: 'READ',
        title: '☀️ Tu día de hoy',
        body: '2 citas y 1 actividad por vencer',
        data: { type: 'MORNING_DIGEST', url: '/dashboard' },
        dedupeKey: `digest:${ana.id}:${clock.days(-1).toISOString().slice(0, 10)}`,
        sentAt: clock.days(-1),
        readAt: clock.days(-1),
        createdAt: clock.days(-1),
      },
      {
        tenantId,
        userId: ana.id,
        type: 'APPOINTMENT_REMINDER',
        status: 'SENT',
        title: '🔔 Recordatorio de cita',
        body: 'Cita con Valeria Ortega en 24 horas',
        data: {
          type: 'APPOINTMENT_REMINDER',
          reminderRule: '24h',
          appointmentId: valeriaLastSession.id,
          patientId: valeria.id,
          startTime: valeriaLastSession.startTime.toISOString(),
          url: '/calendar',
        },
        relatedEntityType: 'appointment',
        relatedEntityId: valeriaLastSession.id,
        sentAt: clock.days(-4),
        createdAt: clock.days(-4),
      },
      {
        tenantId,
        userId: diego.id,
        type: 'APPOINTMENT_CONFIRMED',
        status: 'READ',
        title: 'Cita confirmada',
        body: 'Mateo Jiménez confirmó su cita.',
        relatedEntityType: 'appointment',
        relatedEntityId: mateoFirst.id,
        sentAt: clock.days(-8),
        readAt: clock.days(-8),
        createdAt: clock.days(-8),
      },
      {
        tenantId,
        userId: ana.id,
        type: 'APPOINTMENT_CANCELLED',
        status: 'SENT',
        title: 'Cita cancelada',
        body: 'Se canceló la cita con Hugo Paredes.',
        relatedEntityType: 'appointment',
        relatedEntityId: hugoCancelled.id,
        sentAt: clock.days(-3),
        createdAt: clock.days(-3),
      },
      {
        tenantId,
        userId: diego.id,
        type: 'APPOINTMENT_REMINDER',
        status: 'SENT',
        title: '🔔 Recordatorio de cita',
        body: 'Cita con Renata Villacís en 2 horas',
        data: {
          type: 'APPOINTMENT_REMINDER',
          reminderRule: '2h',
          appointmentId: renataMissed.id,
          patientId: renata.id,
          startTime: renataMissed.startTime.toISOString(),
          url: '/calendar',
        },
        relatedEntityType: 'appointment',
        relatedEntityId: renataMissed.id,
        sentAt: new Date(renataMissed.startTime.getTime() - 2 * 60 * 60 * 1000),
        createdAt: new Date(renataMissed.startTime.getTime() - 2 * 60 * 60 * 1000),
      },
      {
        tenantId,
        userId: ana.id,
        type: 'TASK_ASSIGNED',
        status: 'READ',
        title: 'Nueva actividad asignada',
        body: 'Revisar cuestionario PHQ-9',
        relatedEntityType: 'task',
        relatedEntityId: dueSoonTask.id,
        sentAt: clock.days(-2),
        readAt: clock.days(-2),
        createdAt: clock.days(-2),
      },
      // Already announced with the key the reminder job uses, so it is not sent again.
      {
        tenantId,
        userId: ana.id,
        type: 'TASK_DUE_SOON',
        status: 'SENT',
        title: '⏰ Actividad próxima a vencer',
        body: '"Revisar cuestionario PHQ-9" de Jorge Salazar vence pronto',
        data: {
          type: 'TASK_DUE_SOON',
          taskId: dueSoonTask.id,
          patientId: jorge.id,
          dueDate: dueSoonTask.dueDate.toISOString(),
          url: `/patients/${jorge.id}`,
        },
        relatedEntityType: 'task',
        relatedEntityId: dueSoonTask.id,
        dedupeKey: `task-due:${dueSoonTask.id}:${ana.id}:${dueSoonTask.dueDate.toISOString()}`,
        sentAt: clock.hours(-1),
        createdAt: clock.hours(-1),
      },
      {
        tenantId,
        userId: sofia.id,
        type: 'TASK_ASSIGNED',
        status: 'FAILED',
        title: 'Nueva actividad asignada',
        body: 'Actualizar progresión de ejercicios',
        fcmToken: 'seed-fcm-token-sofia',
        failedAt: clock.days(-5),
        errorMessage: 'messaging/registration-token-not-registered',
        createdAt: clock.days(-5),
      },
      {
        tenantId,
        userId: luis.id,
        type: 'APPOINTMENT_REMINDER',
        status: 'PENDING',
        title: '🔔 Recordatorio de cita',
        body: 'Cita con Camila Naranjo en 24 horas',
      },
    ],
  });

  // ------------------------------------------------------------- invoices
  const invoice = async (
    key: string,
    patient: Patient | null,
    issuer: User,
    customer: Pick<
      Prisma.InvoiceUncheckedCreateInput,
      'customerName' | 'customerEmail' | 'customerTaxIdType' | 'customerTaxId' | 'customerAddress'
    >,
    data: Pick<Prisma.InvoiceUncheckedCreateInput, 'status' | 'issueDate' | 'description'> &
      Partial<Prisma.InvoiceUncheckedCreateInput>,
    sequential?: number,
  ) => {
    const issueDate = data.issueDate as Date;
    if (data.status === 'ISSUED' && issueDate >= clock.monthStart()) {
      clinic.usage.invoicesThisMonth += 1;
    }
    return db.invoice.create({
      data: {
        tenantId,
        patientId: patient?.id,
        issuerId: issuer.id,
        subtotal: 40,
        tax: 0,
        total: 40,
        // Namespaced per tenant, as the billing service stores them.
        idempotencyKey: `${tenantId}:seed-invoice-${key}`,
        createdAt: issueDate,
        ...customer,
        ...(sequential ? issuedDocument(sequential, issueDate) : {}),
        ...data,
      },
    });
  };
  const valeriaCustomer = {
    customerName: 'Valeria Ortega',
    customerEmail: 'valeria.ortega@email.com',
    customerTaxIdType: 'CEDULA',
    customerTaxId: '1723456789',
  };
  const luciaCustomer = {
    customerName: 'Lucía Torres',
    customerEmail: 'lucia.torres@email.com',
    customerTaxIdType: 'CEDULA',
    customerTaxId: '1734567890',
  };

  await invoice(
    'company',
    martina,
    admin,
    {
      customerName: 'Suárez & Asociados Cía. Ltda.',
      customerEmail: 'contabilidad@suarezasociados.ec',
      customerTaxIdType: 'RUC',
      customerTaxId: '1791234567001',
      customerAddress: 'Av. República 310, Quito',
    },
    {
      status: 'ISSUED',
      issueDate: clock.days(-20),
      description: 'Consulta psicológica y valoración nutricional',
      subtotal: 85,
      total: 85,
    },
    1,
  );
  await invoice(
    'own-id',
    valeria,
    ana,
    valeriaCustomer,
    { status: 'ISSUED', issueDate: clock.hours(-3), description: 'Sesión de psicoterapia' },
    2,
  );
  await invoice(
    'passport',
    renata,
    diego,
    {
      customerName: 'Renata Villacís',
      customerEmail: 'renata.villacis@email.com',
      customerTaxIdType: 'PASSPORT',
      customerTaxId: 'XDA458921',
    },
    {
      status: 'ISSUED',
      issueDate: clock.hours(-1),
      description: 'Sesión de psicoterapia en línea',
      // Taxed item: the only document with a tax amount.
      subtotal: 40,
      tax: 6,
      total: 46,
    },
    3,
  );
  // Paid by the guardian and still waiting for the provider's answer.
  await invoice(
    'guardian',
    mateo,
    admin,
    {
      customerName: 'Verónica Jiménez',
      customerEmail: 'veronica.jimenez@email.com',
      customerTaxIdType: 'CEDULA',
      customerTaxId: '1712345678',
    },
    { status: 'PENDING', issueDate: clock.minutes(-4), description: 'Terapia de juego' },
  );
  await invoice(
    'rejected',
    jorge,
    ana,
    {
      customerName: 'Jorge Salazar',
      customerEmail: 'jorge.salazar@email.com',
      customerTaxIdType: 'CEDULA',
      customerTaxId: '1745678901',
    },
    {
      status: 'FAILED',
      issueDate: clock.days(-2),
      description: 'Sesión de psicoterapia',
      errorMessage: 'Faktur respondió 422: la identificación del receptor no es válida.',
    },
  );
  await invoice(
    'voided',
    lucia,
    carlos,
    luciaCustomer,
    {
      status: 'VOIDED',
      issueDate: clock.days(-15),
      description: 'Profilaxis y aplicación de flúor',
      subtotal: 55,
      total: 55,
    },
    4,
  );
  await invoice(
    'credit-note',
    lucia,
    carlos,
    luciaCustomer,
    {
      documentType: 'CREDIT_NOTE',
      status: 'ISSUED',
      issueDate: clock.days(-14),
      description: 'Nota de crédito por la factura anulada de profilaxis',
      subtotal: 55,
      total: 55,
    },
    5,
  );
  await invoice(
    'removed-patient',
    samuel,
    ana,
    {
      customerName: 'Samuel Ortiz',
      customerEmail: 'samuel.ortiz@email.com',
      customerTaxIdType: 'CEDULA',
      customerTaxId: '0912345678',
    },
    { status: 'ISSUED', issueDate: clock.days(-45), description: 'Consulta de orientación' },
    6,
  );
  // The patient row no longer exists and the key predates the tenant namespace:
  // the document keeps its own copy of the customer.
  await invoice(
    'legacy',
    null,
    admin,
    {
      customerName: 'Fernando Aguirre',
      customerEmail: 'fernando.aguirre@email.com',
      customerTaxIdType: 'CEDULA',
      customerTaxId: '1756789012',
    },
    {
      status: 'ISSUED',
      issueDate: clock.days(-50),
      description: 'Sesión de psicoterapia',
      idempotencyKey: 'seed-legacy-invoice-0001',
    },
    7,
  );

  // --------------------------------------------- subscription and platform
  const upgradeReference = ctx.nextPaymentReference();
  await db.subscriptionPayment.createMany({
    data: [
      {
        tenantId,
        kind: 'PLAN_UPGRADE',
        status: 'CONFIRMED',
        amount: 76.67,
        targetPlan: 'CLINIC_PRO',
        providerReference: upgradeReference,
        requestedById: admin.id,
        resolvedById: ctx.platformAdminId,
        resolvedAt: clock.days(-20),
        resolutionNote: 'Transferencia verificada en la cuenta de la plataforma.',
        expiresAt: clock.days(-14),
        createdAt: clock.days(-21),
      },
      {
        tenantId,
        kind: 'RENEWAL',
        status: 'CONFIRMED',
        amount: Number(clinic.subscription.basePrice),
        targetPlan: 'CLINIC_PRO',
        periodStart: clock.days(-5),
        periodEnd: clock.days(25),
        providerReference: ctx.nextPaymentReference(),
        resolvedById: ctx.platformAdminId,
        resolvedAt: clock.days(-6),
        createdAt: clock.days(-12),
      },
    ],
  });
  await db.subscriptionEvent.createMany({
    data: [
      {
        tenantId,
        eventType: 'TRIAL_STARTED',
        newPlan: 'TRIAL',
        newStatus: 'TRIALING',
        createdAt: clock.days(-59),
      },
      {
        tenantId,
        eventType: 'SUBSCRIPTION_ACTIVATED',
        previousPlan: 'TRIAL',
        previousStatus: 'TRIALING',
        newPlan: 'CLINIC_BASIC',
        newStatus: 'ACTIVE',
        reason: 'Fin de la prueba y activación inicial',
        triggeredByUserId: ctx.platformAdminId,
        createdAt: clock.days(-45),
      },
      {
        tenantId,
        eventType: 'SEATS_INCREASED',
        previousPlan: 'CLINIC_BASIC',
        newPlan: 'CLINIC_BASIC',
        reason: 'El consultorio incorporó a un cuarto profesional.',
        metadata: { source: 'PLATFORM_PANEL', seatsPsychologistsMax: 4 },
        triggeredByUserId: ctx.platformAdminId,
        createdAt: clock.days(-30),
      },
      {
        tenantId,
        eventType: 'PLAN_UPGRADED',
        previousPlan: 'CLINIC_BASIC',
        newPlan: 'CLINIC_PRO',
        previousStatus: 'ACTIVE',
        newStatus: 'ACTIVE',
        metadata: { amount: 76.67, reference: upgradeReference },
        triggeredByUserId: ctx.platformAdminId,
        createdAt: clock.days(-20),
      },
      {
        tenantId,
        eventType: 'PAYMENT_SUCCEEDED',
        previousStatus: 'ACTIVE',
        newStatus: 'ACTIVE',
        metadata: { kind: 'RENEWAL', amount: Number(clinic.subscription.basePrice) },
        triggeredByUserId: ctx.platformAdminId,
        createdAt: clock.days(-6),
      },
    ],
  });
  await db.usageMetrics.createMany({
    data: [
      {
        tenantId,
        periodStart: clock.days(-65),
        periodEnd: clock.days(-35),
        seatsPsychologistsUsed: 3,
        activePatientsCount: 6,
        storageUsedGB: 0.31,
        notificationsSent: 44,
        appointmentsCreated: 11,
        clinicalNotesCreated: 5,
        tasksCreated: 4,
        estimatedCost: 99,
        recordedAt: clock.days(-35),
      },
      {
        tenantId,
        periodStart: clock.days(-35),
        periodEnd: clock.days(-5),
        seatsPsychologistsUsed: 5,
        activePatientsCount: 10,
        storageUsedGB: 0.63,
        notificationsSent: 61,
        appointmentsCreated: 18,
        clinicalNotesCreated: 9,
        tasksCreated: 9,
        estimatedCost: 214,
        recordedAt: clock.days(-5),
      },
      {
        tenantId,
        periodStart: clock.days(-5),
        periodEnd: clock.days(25),
        seatsPsychologistsUsed: clinic.usage.seats,
        activePatientsCount: clinic.usage.patients,
        storageUsedGB: 0.83,
        notificationsSent: 97,
        appointmentsCreated: 9,
        clinicalNotesCreated: 6,
        tasksCreated: 7,
        estimatedCost: 214,
        recordedAt: clock.now,
      },
    ],
  });

  // Sessions: one in use, a family revoked after a reused token, and an expired one.
  await db.refreshToken.createMany({
    data: [
      {
        userId: admin.id,
        token: 'seed-refresh-admin-active',
        familyId: 'seed-family-admin',
        expiresAt: clock.days(6),
      },
      {
        userId: ana.id,
        token: 'seed-refresh-ana-rotated',
        familyId: 'seed-family-ana',
        isRevoked: true,
        expiresAt: clock.days(3),
      },
      {
        userId: ana.id,
        token: 'seed-refresh-ana-reused',
        familyId: 'seed-family-ana',
        isRevoked: true,
        expiresAt: clock.days(4),
      },
      {
        userId: luis.id,
        token: 'seed-refresh-luis-expired',
        familyId: 'seed-family-luis',
        expiresAt: clock.days(-2),
      },
    ],
  });

  // ------------------------------------------- audit of non-clinical data
  await writeAudit(ctx, clinic, {
    actor: admin,
    action: 'UPDATE',
    entity: 'PATIENT',
    entityId: jorge.id,
    before: { currentMedication: null },
    after: { currentMedication: 'Escitalopram 10mg' },
    at: clock.days(-11),
  });
  await writeAudit(ctx, clinic, {
    actor: assistant,
    action: 'CREATE',
    entity: 'PATIENT',
    entityId: elias.id,
    after: { firstName: 'Elías', lastName: 'Cordero' },
    at: clock.hours(-5),
  });
  await writeAudit(ctx, clinic, {
    actor: admin,
    action: 'DELETE',
    entity: 'PATIENT',
    entityId: samuel.id,
    before: { isActive: true },
    after: { isActive: false },
    at: clock.days(-12),
  });
  await writeAudit(ctx, clinic, {
    actor: assistant,
    action: 'UPDATE',
    entity: 'APPOINTMENT',
    entityId: hugoCancelled.id,
    before: { status: 'SCHEDULED' },
    after: { status: 'CANCELLED' },
    at: clock.days(-3),
  });
  await writeAudit(ctx, clinic, {
    actor: admin,
    action: 'CREATE',
    entity: 'USER',
    entityId: gabriela.id,
    after: { email: gabriela.email, role: 'PROFESIONAL', invited: true },
    at: clock.days(-2),
  });
  await writeAudit(ctx, clinic, {
    actor: admin,
    action: 'UPDATE',
    entity: 'USER',
    entityId: raul.id,
    before: { isActive: true },
    after: { isActive: false },
    at: clock.days(-28),
  });
  await writeAudit(ctx, clinic, {
    actor: admin,
    action: 'READ',
    entity: 'TENANT',
    entityId: tenantId,
    at: clock.days(-1),
  });
  // Written by the platform ADMIN on the clinic it changed.
  await writeAudit(ctx, clinic, {
    actor: { id: ctx.platformAdminId },
    action: 'UPDATE',
    entity: 'TENANT',
    entityId: tenantId,
    before: { seatsPsychologistsMax: 3 },
    after: { seatsPsychologistsMax: 4 },
    reason: 'El consultorio incorporó a un cuarto profesional.',
    at: clock.days(-30),
  });

  await syncUsage(ctx, clinic);
  return clinic;
}
