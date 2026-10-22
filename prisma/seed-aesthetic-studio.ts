import { createHash, randomUUID } from 'crypto';
import type {
  Appointment,
  AppointmentStatus,
  Patient,
  Prisma,
  SessionMediaPhase,
  TreatmentSessionStatus,
  User,
} from '@prisma/client';
import {
  FormSchema,
  validateFormData,
  validateFormSchema,
} from '../src/clinical-forms/form-schema';
import { CUSTOM_MODULE_PREFIX } from '../src/clinical-modules/clinical-module-registry';
import { formatLongDateInZone } from '../src/common/utils/timezone';
import { renderConsentPdf } from '../src/consents/consent-pdf';
import { consentChecksum, renderConsentText } from '../src/consents/consent-text';
import { parseTreatmentRequirements } from '../src/treatments/treatment-requirements';
import { demoSignature, demoSkinPhoto } from './seed-demo-files';
import {
  createAppointment,
  createPatient,
  createTenant,
  createUser,
  SeedContext,
  SeedTenant,
  syncUsage,
} from './seed-helpers';

const TIMEZONE = 'America/Guayaquil';

/** The clinic's own intake form: the aesthetic file lives here, not in a coded module. */
const FACIAL_FORM: FormSchema = {
  sections: [
    {
      key: 'skin',
      title: 'Piel',
      fields: [
        {
          key: 'phototype',
          label: 'Fototipo (Fitzpatrick)',
          type: 'select',
          required: true,
          options: ['I', 'II', 'III', 'IV', 'V', 'VI'].map((value) => ({ value, label: value })),
        },
        {
          key: 'skinType',
          label: 'Tipo de piel',
          type: 'select',
          required: true,
          options: [
            { value: 'SECA', label: 'Seca' },
            { value: 'MIXTA', label: 'Mixta' },
            { value: 'GRASA', label: 'Grasa' },
            { value: 'SENSIBLE', label: 'Sensible' },
          ],
        },
        { key: 'area', label: 'Zona a tratar', type: 'text', required: true, maxLength: 120 },
      ],
    },
    {
      key: 'safety',
      title: 'Contraindicaciones',
      fields: [
        { key: 'pregnant', label: 'Embarazo o lactancia', type: 'checkbox' },
        {
          key: 'photosensitizing',
          label: 'Medicación fotosensibilizante',
          type: 'checkbox',
        },
        { key: 'contraindications', label: 'Otras contraindicaciones', type: 'textarea' },
      ],
    },
  ],
};

const CONSENTS = {
  peeling: {
    name: 'Peeling químico',
    title: 'Consentimiento para peeling químico',
    body:
      'Yo, {{paciente}}, autorizo a {{profesional}} a realizarme un {{tratamiento}} el {{fecha}}. ' +
      'Entiendo que puede causar enrojecimiento, descamación y sensibilidad durante varios días, ' +
      'y me comprometo a usar protector solar y a no exponerme al sol durante una semana.',
  },
  laser: {
    name: 'Depilación láser',
    title: 'Consentimiento para depilación láser',
    body:
      'Yo, {{paciente}}, declaro no estar embarazada ni usar medicación fotosensibilizante, y ' +
      'autorizo a {{profesional}} a realizarme una {{tratamiento}} el {{fecha}}. Entiendo que ' +
      'puede causar enrojecimiento temporal y que se requieren varias sesiones.',
  },
};

const sha256 = (data: Buffer) => createHash('sha256').update(data).digest('hex');
const signaturePng = (variant: number) =>
  Buffer.from(demoSignature(variant).replace(/^data:image\/png;base64,/, ''), 'base64');

/**
 * An aesthetic studio on the shared modules: a clinic with the Estética specialty that runs
 * its procedures as treatment sessions — the clinic's form, a consent signed on screen with its
 * PDF, before and after photos — on patients and appointments like any other clinic. Text and
 * bytes the API encrypts are stored encrypted when a key is configured.
 * Without a storage for the bytes the studio is skipped: its sessions cannot exist without them.
 */
export async function seedAestheticStudio(ctx: SeedContext): Promise<SeedTenant | null> {
  if (!ctx.storage) {
    ctx.highlights.push(
      'Estudio Estético Aurora: sin almacenamiento configurado no se sembró el estudio.',
    );
    return null;
  }
  const { db, clock } = ctx;
  const storage = ctx.storage;

  const studio = await createTenant(ctx, {
    name: 'Estudio Estético Aurora',
    email: 'contacto@esteticaaurora.ec',
    phone: '+593 2 245 7788',
    address: 'Av. República de El Salvador N35-12, Quito',
    tenantType: 'CLINIC',
    planType: 'CLINIC_BASIC',
    status: 'ACTIVE',
    specialties: ['aesthetics'],
    fiscal: {
      legalName: 'Estética Aurora Cía. Ltda.',
      taxIdentificationType: 'RUC',
      taxIdentificationNumber: '1793187654001',
    },
    master: {
      email: 'titular.aurora@psic.com',
      firstName: 'Andrea',
      lastName: 'Molina',
      phone: '+593 99 410 2233',
      note: 'Titular del estudio, sin perfil profesional: administra, no atiende',
    },
  });
  const tenantId = studio.tenant.id;
  const protect = (value: string) => (ctx.cipher ? ctx.cipher.encrypt(tenantId, value) : value);
  const protectBytes = (bytes: Buffer) =>
    ctx.cipher ? ctx.cipher.encryptBuffer(tenantId, bytes) : bytes;

  const lucia = await createUser(ctx, studio, {
    email: 'cosmiatra.aurora@psic.com',
    firstName: 'Lucía',
    lastName: 'Paredes',
    role: 'PROFESIONAL',
    note: 'Cosmiatra: abre sesiones de tratamiento, toma el consentimiento y las fotos',
    profile: { specialty: 'aesthetics', title: 'Cosmiatra', licenseNumber: 'COS-EC-118' },
  });
  const sofia = await createUser(ctx, studio, {
    email: 'esteticista.aurora@psic.com',
    firstName: 'Sofía',
    lastName: 'Cárdenas',
    role: 'PROFESIONAL',
    note: 'Esteticista con agenda propia; no ve los módulos médicos',
    profile: { specialty: 'aesthetics', title: 'Esteticista' },
  });
  await createUser(ctx, studio, {
    email: 'recepcion.aurora@psic.com',
    firstName: 'Daniel',
    lastName: 'Ortiz',
    role: 'ASISTENTE',
    note: 'Recepción: agenda y pacientes, sin contenido clínico',
  });

  // ------------------------------------------------------------------ the clinic's catalog
  const form = await db.formDefinition.create({
    data: {
      tenantId,
      name: 'Ficha estética facial',
      description: 'Lo que se revisa antes de un procedimiento facial.',
      category: 'Estética',
      specialtyId: ctx.catalog.aesthetics.id,
      createdById: studio.master.id,
      createdAt: clock.days(-40),
    },
  });
  await db.formDefinitionVersion.create({
    data: {
      formDefinitionId: form.id,
      version: 1,
      schema: validateFormSchema(FACIAL_FORM) as unknown as Prisma.InputJsonValue,
      createdById: studio.master.id,
      createdAt: clock.days(-40),
    },
  });

  const templateVersion = async (consent: (typeof CONSENTS)[keyof typeof CONSENTS]) => {
    const template = await db.consentTemplate.create({
      data: { tenantId, name: consent.name, createdAt: clock.days(-40) },
    });
    return db.consentTemplateVersion.create({
      data: {
        tenantId,
        templateId: template.id,
        version: 1,
        title: consent.title,
        body: consent.body,
        checksum: consentChecksum(consent.title, consent.body),
        status: 'PUBLISHED',
        publishedAt: clock.days(-39),
        createdById: studio.master.id,
        createdAt: clock.days(-40),
      },
    });
  };
  const peelingConsent = await templateVersion(CONSENTS.peeling);
  const laserConsent = await templateVersion(CONSENTS.laser);

  const treatment = async (input: {
    name: string;
    category: string;
    price: number;
    durationMinutes: number;
    isActive?: boolean;
    formRequired?: boolean;
    consentVersionId?: string;
    photos?: { minimumBefore: number; minimumAfter: number };
    notesRequired?: boolean;
  }) => {
    const created = await db.treatment.create({
      data: {
        tenantId,
        name: input.name,
        category: input.category,
        specialtyId: ctx.catalog.aesthetics.id,
        isActive: input.isActive ?? true,
        createdAt: clock.days(-40),
      },
    });
    const requirements = parseTreatmentRequirements({
      medicalForm: { required: input.formRequired ?? false },
      informedConsent: { required: !!input.consentVersionId, validityDays: null },
      photos: input.photos ?? { minimumBefore: 0, minimumAfter: 0 },
      clinicalNotes: { requiredForCompletion: input.notesRequired ?? false },
    });
    const version = await db.treatmentVersion.create({
      data: {
        tenantId,
        treatmentId: created.id,
        version: 1,
        price: input.price,
        taxRatePercent: 15,
        durationMinutes: input.durationMinutes,
        formDefinitionId: input.formRequired ? form.id : null,
        formVersion: input.formRequired ? 1 : null,
        consentTemplateVersionId: input.consentVersionId ?? null,
        requirements: requirements as unknown as Prisma.InputJsonValue,
        createdById: studio.master.id,
        createdAt: clock.days(-40),
      },
    });
    return { ...created, version };
  };
  const facial = await treatment({
    name: 'Limpieza facial profunda',
    category: 'Facial',
    price: 35,
    durationMinutes: 60,
  });
  const peeling = await treatment({
    name: 'Peeling químico',
    category: 'Facial',
    price: 60,
    durationMinutes: 45,
    formRequired: true,
    consentVersionId: peelingConsent.id,
    photos: { minimumBefore: 1, minimumAfter: 1 },
    notesRequired: true,
  });
  const laser = await treatment({
    name: 'Depilación láser',
    category: 'Corporal',
    price: 45,
    durationMinutes: 30,
    consentVersionId: laserConsent.id,
  });
  const microderm = await treatment({
    name: 'Microdermoabrasión',
    category: 'Facial',
    price: 50,
    durationMinutes: 45,
  });
  // Out of the menu: it keeps its history and opens no new sessions.
  await treatment({
    name: 'Radiofrecuencia corporal',
    category: 'Corporal',
    price: 70,
    durationMinutes: 60,
    isActive: false,
  });

  // ------------------------------------------------------------------ patients
  const team = { current: [lucia, sofia] };
  const patient = (data: Omit<Prisma.PatientUncheckedCreateInput, 'tenantId'>) =>
    createPatient(ctx, studio, { createdAt: clock.days(-60), ...data }, team);
  const valentina = await patient({
    firstName: 'Valentina',
    lastName: 'Ríos',
    email: 'valentina.rios@pacientes.test',
    phone: '+593981123344',
    gender: 'Femenino',
    identificationType: 'CEDULA',
    identificationNumber: '1719283746',
  });
  const camila = await patient({
    firstName: 'Camila',
    lastName: 'Torres',
    email: 'camila.torres@pacientes.test',
    phone: '+593982234455',
    gender: 'Femenino',
  });
  const gabriela = await patient({
    firstName: 'Gabriela',
    lastName: 'Suárez',
    phone: '+593983345566',
    gender: 'Femenino',
    identificationType: 'CEDULA',
    identificationNumber: '1720394857',
  });
  const isabel = await patient({
    firstName: 'Isabel',
    lastName: 'Moreno',
    email: 'isabel.moreno@pacientes.test',
    gender: 'Femenino',
  });
  const mariana = await patient({
    firstName: 'Mariana',
    lastName: 'Vega',
    email: 'mariana.vega@pacientes.test',
    phone: '+593984456677',
    gender: 'Femenino',
  });
  // No longer comes: archived, with her team kept for the history.
  await patient({ firstName: 'Paula', lastName: 'Herrera', gender: 'Femenino', isActive: false });

  // ------------------------------------------------------------------ sessions
  let codes = 0;
  let photoBytes = 0;
  const fullName = (person: { firstName: string; lastName: string }) =>
    `${person.firstName} ${person.lastName}`;

  const book = (
    who: Patient,
    professional: User,
    what: { name: string; version: { durationMinutes: number } },
    status: AppointmentStatus,
    when: { dayOffset: number; time: string } | { start: Date },
  ) =>
    createAppointment(ctx, studio, {
      patient: who,
      professional,
      status,
      title: what.name,
      slot:
        'start' in when
          ? studio.agenda.reserve(professional.id, when.start, what.version.durationMinutes)
          : studio.agenda.book(
              professional.id,
              when.dayOffset,
              when.time,
              what.version.durationMinutes,
            ),
    });

  const session = async (input: {
    patient: Patient;
    professional: User;
    treatment: Awaited<ReturnType<typeof treatment>>;
    appointment: Appointment;
    status: TreatmentSessionStatus;
    form?: Record<string, unknown>;
    consent?: { signer: string; identification?: string };
    photos?: SessionMediaPhase[];
    notes?: string;
    cancellation?: string;
  }) => {
    const openedAt = input.appointment.startTime;
    const endedAt = input.appointment.endTime;
    const closed = input.status !== 'READY_FOR_CONSENT';
    const encounter = await db.encounter.create({
      data: {
        tenantId,
        patientId: input.patient.id,
        professionalId: input.professional.id,
        specialtyId: ctx.catalog.aesthetics.id,
        appointmentId: input.appointment.id,
        branchId: input.appointment.branchId,
        encounterType: 'PROCEDURE',
        status: closed ? 'CLOSED' : 'OPEN',
        reason: input.treatment.name,
        summary: closed ? (input.notes ?? input.cancellation ?? null) : null,
        startedAt: openedAt,
        closedAt: closed ? endedAt : null,
        createdAt: openedAt,
      },
    });
    const formRecord = input.form
      ? await db.specialtyRecord.create({
          data: {
            tenantId,
            patientId: input.patient.id,
            professionalId: input.professional.id,
            specialtyId: ctx.catalog.aesthetics.id,
            appointmentId: input.appointment.id,
            encounterId: encounter.id,
            moduleKey: `${CUSTOM_MODULE_PREFIX}${form.id}`,
            schemaVersion: 1,
            formDefinitionId: form.id,
            verificationCode: `AURO${String(++codes).padStart(12, '0')}`,
            data: validateFormData(FACIAL_FORM, input.form) as Prisma.InputJsonObject,
            recordDate: openedAt,
            createdAt: openedAt,
          },
        })
      : null;
    const created = await db.treatmentSession.create({
      data: {
        tenantId,
        patientId: input.patient.id,
        professionalId: input.professional.id,
        branchId: input.appointment.branchId,
        appointmentId: input.appointment.id,
        treatmentVersionId: input.treatment.version.id,
        encounterId: encounter.id,
        formRecordId: formRecord?.id,
        status: input.status,
        startedAt: input.status === 'CLINICAL_COMPLETE' ? openedAt : null,
        completedAt: input.status === 'CLINICAL_COMPLETE' ? endedAt : null,
        cancelledAt: input.status === 'CANCELLED' ? openedAt : null,
        procedureNotes: input.notes ? protect(input.notes) : null,
        cancellationReason: input.cancellation ? protect(input.cancellation) : null,
        createdAt: openedAt,
      },
    });

    if (input.consent) {
      const template =
        input.treatment.version.consentTemplateVersionId === peelingConsent.id
          ? peelingConsent
          : laserConsent;
      const signedAt = new Date(openedAt.getTime() + 5 * 60 * 1000);
      const values = {
        paciente: fullName(input.patient),
        identificacion: input.patient.identificationNumber ?? '',
        tratamiento: input.treatment.name,
        profesional: fullName(input.professional),
        fecha: formatLongDateInZone(openedAt, TIMEZONE),
      };
      const title = renderConsentText(template.title, values);
      const body = renderConsentText(template.body, values);
      const document = await db.consentDocument.create({
        data: {
          tenantId,
          patientId: input.patient.id,
          treatmentSessionId: created.id,
          templateVersionId: template.id,
          title: protect(title),
          body: protect(body),
          checksum: consentChecksum(title, body),
          presentedAt: openedAt,
          createdAt: openedAt,
        },
      });
      const signer = {
        signerName: input.consent.signer,
        signerRole: 'PATIENT' as const,
        signerIdentification: input.consent.identification ?? null,
        relationship: null,
        understood: true,
        questionsAnswered: true,
        marketingPhotos: false,
      };
      const png = signaturePng(codes + 2);
      const pdf = await renderConsentPdf({
        clinic: { name: studio.tenant.name, address: studio.tenant.address },
        patient: {
          name: fullName(input.patient),
          identification: input.patient.identificationNumber,
        },
        treatment: { name: input.treatment.name, version: 1 },
        templateVersion: { version: template.version, checksum: template.checksum },
        title,
        body,
        checksum: document.checksum,
        signature: { png, ...signer },
        operatorName: fullName(input.professional),
        signedAt,
        timezone: TIMEZONE,
      });
      const attempt = randomUUID();
      const signatureKey = `${tenantId}/consents/${document.id}/signature/${attempt}`;
      const pdfKey = `${tenantId}/consents/${document.id}/pdf/${attempt}`;
      await storage.put(signatureKey, protectBytes(png));
      await storage.put(pdfKey, protectBytes(pdf));
      await db.consentDocument.update({
        where: { id: document.id },
        data: { status: 'SIGNED', signedAt, pdfStorageKey: pdfKey, pdfChecksum: sha256(pdf) },
      });
      await db.consentSignature.create({
        data: {
          tenantId,
          documentId: document.id,
          signerRole: signer.signerRole,
          signerName: protect(signer.signerName),
          signerIdentification: protect(signer.signerIdentification ?? ''),
          understood: true,
          questionsAnswered: true,
          marketingPhotos: false,
          signatureStorageKey: signatureKey,
          operatorId: input.professional.id,
          ipAddress: '190.15.128.10',
          userAgent: 'Mozilla/5.0 (demo seed)',
          signedAt,
          createdAt: signedAt,
        },
      });
      await db.consentEvent.createMany({
        data: [
          { tenantId, documentId: document.id, type: 'PRESENTED', actorId: input.professional.id },
          { tenantId, documentId: document.id, type: 'SIGNED', actorId: input.professional.id },
        ],
      });
      await db.treatmentSession.update({
        where: { id: created.id },
        data: { consentDocumentId: document.id },
      });
    }

    for (const phase of input.photos ?? []) {
      const bytes = demoSkinPhoto(phase === 'AFTER' ? 'AFTER' : 'BEFORE');
      const storageKey = `${tenantId}/${input.patient.id}/${randomUUID()}`;
      await storage.put(storageKey, protectBytes(bytes));
      photoBytes += bytes.length;
      await db.patientFile.create({
        data: {
          tenantId,
          patientId: input.patient.id,
          uploadedById: input.professional.id,
          encounterId: encounter.id,
          treatmentSessionId: created.id,
          phase,
          category: 'IMAGEN',
          fileName: `${phase === 'BEFORE' ? 'antes' : 'despues'}-${input.treatment.name
            .toLowerCase()
            .normalize('NFD')
            .replace(/[̀-ͯ]/g, '')
            .replace(/\s+/g, '-')}.png`,
          description: phase === 'BEFORE' ? 'Foto antes del procedimiento.' : 'Foto después.',
          mimeType: 'image/png',
          sizeBytes: bytes.length,
          storageKey,
          createdAt: phase === 'BEFORE' ? openedAt : endedAt,
        },
      });
    }
    return created;
  };

  // Peeling with everything: form, consent signed on screen, before and after photos, notes.
  await session({
    patient: valentina,
    professional: lucia,
    treatment: peeling,
    appointment: await book(valentina, lucia, peeling, 'COMPLETED', {
      dayOffset: -14,
      time: '10:00',
    }),
    status: 'CLINICAL_COMPLETE',
    form: { phototype: 'III', skinType: 'MIXTA', area: 'Rostro completo', pregnant: false },
    consent: { signer: 'Valentina Ríos', identification: '1719283746' },
    photos: ['BEFORE', 'AFTER'],
    notes:
      'Ácido glicólico al 30 % durante 3 minutos. Eritema leve al retirar. Control en 15 días.',
  });

  // Laser: consent only.
  await session({
    patient: gabriela,
    professional: sofia,
    treatment: laser,
    appointment: await book(gabriela, sofia, laser, 'COMPLETED', { dayOffset: -3, time: '11:00' }),
    status: 'CLINICAL_COMPLETE',
    consent: { signer: 'Gabriela Suárez', identification: '1720394857' },
    notes: 'Sesión 1 de 6. Sin reacciones adversas.',
  });

  // In the chair now: the form is done, the consent is still to be signed, so it cannot start.
  await session({
    patient: mariana,
    professional: lucia,
    treatment: peeling,
    appointment: await book(mariana, lucia, peeling, 'IN_PROGRESS', { start: clock.minutes(-10) }),
    status: 'READY_FOR_CONSENT',
    form: { phototype: 'II', skinType: 'SENSIBLE', area: 'Mejillas y frente' },
  });

  // Cancelled when she arrived: she had sunburn.
  await session({
    patient: isabel,
    professional: sofia,
    treatment: microderm,
    appointment: await book(isabel, sofia, microderm, 'CANCELLED', {
      dayOffset: -2,
      time: '16:00',
    }),
    status: 'CANCELLED',
    cancellation: 'Quemadura solar reciente: se reprograma.',
  });

  // ------------------------------------------------------------------ upcoming
  await book(camila, sofia, facial, 'SCHEDULED', { dayOffset: 1, time: '09:00' });
  await book(valentina, lucia, peeling, 'SCHEDULED', { dayOffset: 15, time: '10:00' });
  await book(camila, lucia, laser, 'SCHEDULED', { dayOffset: 5, time: '17:00' });

  await syncUsage(ctx, studio);
  await db.tenantSubscription.update({
    where: { tenantId },
    data: { storageUsedBytes: BigInt(photoBytes) },
  });

  ctx.highlights.push(
    `${studio.tenant.name}: consultorio de Estética sobre tratamientos — un peeling cerrado con ficha, consentimiento firmado y fotos; otro en curso que no puede iniciarse sin el consentimiento.`,
  );
  return studio;
}
