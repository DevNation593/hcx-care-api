import {
  AppointmentStatus,
  AuditAction,
  AuditEntity,
  EncounterStatus,
  InvoiceDocumentType,
  InvoiceStatus,
  NotificationStatus,
  NotificationType,
  PlanType,
  PrismaClient,
  SubscriptionEventType,
  SubscriptionPaymentKind,
  SubscriptionPaymentStatus,
  SubscriptionStatus,
  TaskPriority,
  TaskStatus,
  TenantType,
} from '@prisma/client';
import { validateFormData, validateFormSchema } from '../src/clinical-forms/form-schema';
import {
  grantablePermissions,
  rolePermissions,
} from '../src/common/permissions/permission-catalog';
import { SECTION_KEYS } from '../src/common/sections/section-catalog';
import { unknownTemplateVariables } from '../src/document-templates/document-templates.service';
import { TEMPLATE_MODULE_KEYS } from '../src/document-templates/template-catalog';
import { ageInYears } from '../src/patients/patient-identity';
import { normalizeVerificationCode } from '../src/specialty-records/verification-code';
import { DEMO_DOCUMENT_CODES } from '../prisma/seed-clinical-workflow';
import { BILLING_RULES } from '../src/subscription/subscription-billing.rules';
import { seedDatabase } from '../prisma/seed';
import { SPECIALTY_MODULE_KEYS } from '../prisma/seed-helpers';
import {
  CLINICAL_MODULES,
  CUSTOM_MODULE_PREFIX,
  findClinicalModule,
  validateModuleData,
} from '../src/clinical-modules/clinical-module-registry';

type Row = Record<string, any>;

// Relations the seed writes nested under their parent, and the column that points back.
const NESTED: Record<string, { model: string; foreignKey: string }> = {
  professionalProfile: { model: 'professionalProfile', foreignKey: 'userId' },
  professionalSpecialties: { model: 'professionalSpecialty', foreignKey: 'userId' },
};

// Column defaults of the schema that the assertions below read.
const DEFAULTS: Record<string, Row> = {
  tenant: { isActive: true, isPlatform: false },
  tenantSettings: { allowDoubleBooking: false },
  tenantModule: { enabled: true },
  user: { isActive: true },
  patient: { isActive: true },
  professionalProfile: { isActive: true },
  clinicalNote: { version: 1 },
  specialtyRecord: { version: 1 },
  task: { status: 'PENDING', priority: 'MEDIUM' },
  invoice: { status: 'PENDING', documentType: 'INVOICE' },
  subscriptionPayment: { status: 'PENDING', provider: 'MANUAL' },
  notificationLog: { status: 'PENDING' },
};

/** The slice of the Prisma client the seed uses, kept in memory. */
function createMemoryDatabase() {
  const tables = new Map<string, Row[]>();
  const rows = (model: string) => {
    if (!tables.has(model)) tables.set(model, []);
    return tables.get(model);
  };

  const insert = (model: string, data: Row): Row => {
    const row: Row = { id: `${model}-${rows(model).length + 1}`, ...DEFAULTS[model] };
    for (const [key, value] of Object.entries(data)) {
      if (NESTED[key]) {
        insert(NESTED[key].model, { ...value.create, [NESTED[key].foreignKey]: row.id });
      } else {
        row[key] = value;
      }
    }
    rows(model).push(row);
    return row;
  };

  const matches = (row: Row, where: Row = {}) =>
    Object.entries(where).every(([key, expected]) =>
      expected !== null && typeof expected === 'object' && 'equals' in expected
        ? String(row[key]).toLowerCase() === String(expected.equals).toLowerCase()
        : row[key] === expected,
    );

  const find = (model: string, where: Row) => rows(model).find((row) => matches(row, where));

  const delegate = (model: string) => ({
    create: async ({ data }: { data: Row }) => insert(model, data),
    createMany: async ({ data }: { data: Row[] }) => {
      data.forEach((item) => insert(model, item));
      return { count: data.length };
    },
    upsert: async ({ where, create, update }: { where: Row; create: Row; update: Row }) => {
      const existing = find(model, where);
      return existing ? Object.assign(existing, update) : insert(model, create);
    },
    update: async ({ where, data }: { where: Row; data: Row }) => {
      const row = find(model, where);
      if (!row) throw new Error(`No ${model} matches ${JSON.stringify(where)}`);
      return Object.assign(row, data);
    },
    findFirst: async ({ where }: { where?: Row } = {}) => find(model, where) ?? null,
    findMany: async ({ where }: { where?: Row } = {}) =>
      rows(model).filter((row) => matches(row, where)),
    deleteMany: async () => {
      const count = rows(model).length;
      tables.set(model, []);
      return { count };
    },
  });

  const db = new Proxy({}, { get: (_target, model: string) => delegate(model) });
  return { db: db as unknown as PrismaClient, rows };
}

const NOW = new Date('2026-10-02T15:30:00.000Z');
const DAY_MS = 24 * 60 * 60 * 1000;

describe('demo seed', () => {
  let rows: (model: string) => Row[];
  let byId: (model: string) => Map<string, Row>;

  // The bytes of the seeded clinical files, by storage key.
  const stored = new Map<string, Buffer>();

  beforeAll(async () => {
    const memory = createMemoryDatabase();
    await seedDatabase(memory.db, {
      now: NOW,
      storage: {
        put: async (key, data) => void stored.set(key, data),
        remove: async (key) => void stored.delete(key),
      },
    });
    rows = memory.rows;
    byId = (model) => new Map(rows(model).map((row) => [row.id, row]));
  });

  const values = (model: string, field: string) =>
    [...new Set(rows(model).map((row) => row[field]))].sort();
  const all = (enumeration: Record<string, string>) => Object.values(enumeration).sort();

  it('has at least one row for every value of every state enum', () => {
    expect(values('tenant', 'tenantType')).toEqual(all(TenantType));
    expect(values('tenantSubscription', 'planType')).toEqual(all(PlanType));
    expect(values('tenantSubscription', 'status')).toEqual(all(SubscriptionStatus));
    expect(values('subscriptionPayment', 'kind')).toEqual(all(SubscriptionPaymentKind));
    expect(values('subscriptionPayment', 'status')).toEqual(all(SubscriptionPaymentStatus));
    expect(values('subscriptionEvent', 'eventType')).toEqual(all(SubscriptionEventType));
    expect(values('appointment', 'status')).toEqual(all(AppointmentStatus));
    expect(values('task', 'status')).toEqual(all(TaskStatus));
    expect(values('task', 'priority')).toEqual(all(TaskPriority));
    expect(values('notificationLog', 'type')).toEqual(all(NotificationType));
    expect(values('notificationLog', 'status')).toEqual(all(NotificationStatus));
    expect(values('auditLog', 'action')).toEqual(all(AuditAction));
    // TODO(treatment-sessions, cash-and-billing): the demo seed has no treatment sessions,
    // consent documents, orders, payments, cash registers, billing profiles or invoice requests
    // yet; drop this exemption when it gains them.
    const unseededEntities = [
      'TREATMENT_SESSION',
      'CONSENT_DOCUMENT',
      'BILLING_PROFILE',
      'CASH_REGISTER',
      'INVOICE_REQUEST',
      'ORDER',
      'PAYMENT',
    ];
    expect(values('auditLog', 'entity')).toEqual(
      all(AuditEntity).filter((entity) => !unseededEntities.includes(entity)),
    );
    expect(values('encounter', 'status')).toEqual(all(EncounterStatus));
    expect(values('invoice', 'status')).toEqual(all(InvoiceStatus));
    expect(values('invoice', 'documentType')).toEqual(all(InvoiceDocumentType));
  });

  it('covers every role in use and leaves the retired ones out or closed', () => {
    // CLIENTE and PSICOLOGO were migrated away and PACIENTE has no login: none is seeded.
    expect(values('user', 'role')).toEqual([
      'ADMIN',
      'ASISTENTE',
      'MASTER',
      'PROFESIONAL',
      'SOPORTE',
    ]);
    expect(rows('user').filter((user) => user.role === 'SOPORTE' && user.isActive)).toEqual([]);
  });

  it('gives every clinic one MASTER and the eight sections, and keeps ADMIN on the platform', () => {
    const platform = rows('tenant').filter((tenant) => tenant.isPlatform);
    expect(platform).toHaveLength(1);

    for (const admin of rows('user').filter((user) => user.role === 'ADMIN')) {
      expect(admin.tenantId).toBe(platform[0].id);
    }
    for (const tenant of rows('tenant').filter((candidate) => !candidate.isPlatform)) {
      const masters = rows('user').filter(
        (user) => user.tenantId === tenant.id && user.role === 'MASTER',
      );
      const sections = rows('tenantModule')
        .filter((module) => module.tenantId === tenant.id)
        .map((module) => module.moduleKey)
        .filter((key) => (SECTION_KEYS as readonly string[]).includes(key));

      expect({ tenant: tenant.name, masters: masters.length }).toEqual({
        tenant: tenant.name,
        masters: 1,
      });
      expect(sections.sort()).toEqual([...SECTION_KEYS].sort());
    }
  });

  it('uses each login email once across all tenants', () => {
    const emails = rows('user').map((user) => user.email.toLowerCase());
    expect(new Set(emails).size).toBe(emails.length);
  });

  it('keeps every reference inside the tenant that owns the row', () => {
    const references: Array<[model: string, field: string, target: string]> = [
      ['patient', 'assignedPsychologistId', 'user'],
      ['patientProfessional', 'patientId', 'patient'],
      ['patientProfessional', 'professionalId', 'user'],
      ['appointment', 'patientId', 'patient'],
      ['appointment', 'professionalId', 'user'],
      ['appointment', 'psychologistId', 'user'],
      ['clinicalNote', 'patientId', 'patient'],
      ['clinicalNote', 'psychologistId', 'user'],
      ['clinicalNote', 'appointmentId', 'appointment'],
      ['specialtyRecord', 'patientId', 'patient'],
      ['specialtyRecord', 'professionalId', 'user'],
      ['specialtyRecord', 'appointmentId', 'appointment'],
      ['task', 'patientId', 'patient'],
      ['task', 'createdById', 'user'],
      ['task', 'assignedToId', 'user'],
      ['nextSessionPlan', 'patientId', 'patient'],
      ['nextSessionPlan', 'psychologistId', 'user'],
      ['invoice', 'patientId', 'patient'],
      ['invoice', 'issuerId', 'user'],
      ['notificationLog', 'userId', 'user'],
      ['pushSubscription', 'userId', 'user'],
    ];

    const broken: string[] = [];
    for (const [model, field, target] of references) {
      const targets = byId(target);
      for (const row of rows(model)) {
        if (row[field] === undefined || row[field] === null) continue;
        if (targets.get(row[field])?.tenantId !== row.tenantId) {
          broken.push(`${model}.${field} of ${row.id}`);
        }
      }
    }
    expect(broken).toEqual([]);
  });

  it('books appointments only with professionals of the patient team, in their specialty', () => {
    const profiles = new Map(rows('professionalProfile').map((row) => [row.userId, row]));
    const team = new Set(
      rows('patientProfessional').map((row) => `${row.patientId}:${row.professionalId}`),
    );

    const invalid = rows('appointment').filter(
      (appointment) =>
        appointment.professionalId !== appointment.psychologistId ||
        profiles.get(appointment.professionalId)?.specialtyId !== appointment.specialtyId ||
        !team.has(`${appointment.patientId}:${appointment.professionalId}`),
    );
    expect(invalid.map((appointment) => appointment.id)).toEqual([]);
  });

  it('never double-books a professional unless the clinic allows it', () => {
    const allowsDoubleBooking = new Set(
      rows('tenantSettings')
        .filter((settings) => settings.allowDoubleBooking)
        .map((settings) => settings.tenantId),
    );
    const active = rows('appointment').filter(
      (appointment) =>
        appointment.status !== 'CANCELLED' && !allowsDoubleBooking.has(appointment.tenantId),
    );

    const overlaps = active.flatMap((first, index) =>
      active
        .slice(index + 1)
        .filter(
          (second) =>
            second.professionalId === first.professionalId &&
            first.startTime < second.endTime &&
            second.startTime < first.endTime,
        )
        .map((second) => `${first.id} / ${second.id}`),
    );
    expect(overlaps).toEqual([]);
    // The clinic that allows it has a pair to show.
    expect(allowsDoubleBooking.size).toBe(1);
  });

  it('stores the usage counters the API would have computed, within the plan limits', () => {
    const users = byId('user');
    for (const subscription of rows('tenantSubscription')) {
      const seats = rows('professionalProfile').filter(
        (profile) =>
          profile.isActive && users.get(profile.userId).tenantId === subscription.tenantId,
      ).length;
      const patients = rows('patient').filter(
        (patient) =>
          patient.tenantId === subscription.tenantId && patient.isActive && !patient.deletedAt,
      ).length;

      expect({
        tenantId: subscription.tenantId,
        seats: subscription.seatsPsychologistsUsed,
        patients: subscription.activePatientsCount,
      }).toEqual({ tenantId: subscription.tenantId, seats, patients });
      expect(seats).toBeLessThanOrEqual(subscription.seatsPsychologistsMax);
      expect(patients).toBeLessThanOrEqual(subscription.maxActivePatients);
      expect(subscription.monthlyElectronicInvoicesUsed).toBeLessThanOrEqual(
        subscription.monthlyElectronicInvoicesLimit,
      );
    }
  });

  it('has a clinic at each limit: seats, patients and monthly invoices', () => {
    const subscriptions = rows('tenantSubscription');
    expect(subscriptions.some((s) => s.seatsPsychologistsUsed === s.seatsPsychologistsMax)).toBe(
      true,
    );
    expect(subscriptions.some((s) => s.activePatientsCount === s.maxActivePatients)).toBe(true);
    expect(
      subscriptions.some(
        (s) => s.monthlyElectronicInvoicesUsed === s.monthlyElectronicInvoicesLimit,
      ),
    ).toBe(true);
  });

  it('leaves every subscription in a state the hourly lifecycle job will not change at once', () => {
    const now = NOW.getTime();
    for (const subscription of rows('tenantSubscription')) {
      const { status, planType, trialEndsAt, currentPeriodEnd } = subscription;
      const label = `${planType} ${status}`;
      const paid = planType !== 'TRIAL' && Number(subscription.basePrice) > 0;

      if (status === 'TRIALING') {
        expect([label, trialEndsAt > NOW]).toEqual([label, true]);
      }
      if (status === 'ACTIVE' && paid) {
        expect([label, currentPeriodEnd > NOW]).toEqual([label, true]);
      }
      if (status === 'PAST_DUE') {
        const ended = (planType === 'TRIAL' ? trialEndsAt : currentPeriodEnd).getTime();
        expect([label, ended <= now && ended > now - BILLING_RULES.graceDays * DAY_MS]).toEqual([
          label,
          true,
        ]);
      }
      if (status === 'UNPAID') {
        expect([
          label,
          currentPeriodEnd.getTime() <= now - BILLING_RULES.graceDays * DAY_MS,
        ]).toEqual([label, true]);
      }
    }
  });

  it('respects the unique indexes the database enforces', () => {
    const duplicates = (keys: string[]) => keys.filter((key, index) => keys.indexOf(key) < index);

    expect(
      duplicates(
        rows('subscriptionPayment')
          .filter((payment) => payment.providerReference)
          .map((payment) => `${payment.provider}:${payment.providerReference}`),
      ),
    ).toEqual([]);
    expect(
      duplicates(
        rows('subscriptionPayment')
          .filter((payment) => payment.periodStart)
          .map((p) => `${p.tenantId}:${p.kind}:${p.periodStart.toISOString()}`),
      ),
    ).toEqual([]);
    expect(
      duplicates(
        rows('notificationLog')
          .filter((log) => log.dedupeKey)
          .map((log) => `${log.tenantId}:${log.dedupeKey}`),
      ),
    ).toEqual([]);
    expect(duplicates(rows('invoice').map((invoice) => invoice.idempotencyKey))).toEqual([]);
    expect(duplicates(rows('nextSessionPlan').map((plan) => plan.patientId))).toEqual([]);
    expect(duplicates(rows('pushSubscription').map((push) => push.endpoint))).toEqual([]);
    expect(duplicates(rows('refreshToken').map((token) => token.token))).toEqual([]);
    expect(
      duplicates(rows('patientProfessional').map((r) => `${r.patientId}:${r.professionalId}`)),
    ).toEqual([]);
  });

  it('has a record for every specialty module and for general modules', () => {
    const specialtyKeys = Object.values(SPECIALTY_MODULE_KEYS).flat().sort();
    const seeded = values('specialtyRecord', 'moduleKey');

    const isOwnForm = (moduleKey: string) => moduleKey.startsWith(CUSTOM_MODULE_PREFIX);
    expect(
      seeded.filter((moduleKey) => !moduleKey.startsWith('general.') && !isOwnForm(moduleKey)),
    ).toEqual(specialtyKeys);
    // Every general module has a record, and so have the forms designed by a clinic.
    expect(seeded.filter((moduleKey) => moduleKey.startsWith('general.'))).toEqual(
      [
        ...new Set(
          CLINICAL_MODULES.map(({ moduleKey }) => moduleKey).filter((moduleKey) =>
            moduleKey.startsWith('general.'),
          ),
        ),
      ].sort(),
    );
    expect(seeded.some(isOwnForm)).toBe(true);
  });

  it('stores every record exactly as its module definition would validate it', () => {
    for (const record of rows('specialtyRecord')) {
      if (record.formDefinitionId) {
        // A form of the clinic: validated against the version the record was written under.
        const version = rows('formDefinitionVersion').find(
          (candidate) =>
            candidate.formDefinitionId === record.formDefinitionId &&
            candidate.version === record.schemaVersion,
        );
        expect(record.moduleKey).toBe(`${CUSTOM_MODULE_PREFIX}${record.formDefinitionId}`);
        expect(validateFormData(validateFormSchema(version.schema), record.data)).toEqual(
          record.data,
        );
        continue;
      }
      const definition = findClinicalModule(record.moduleKey, record.schemaVersion ?? 1);

      expect({ moduleKey: record.moduleKey, defined: Boolean(definition) }).toEqual({
        moduleKey: record.moduleKey,
        defined: true,
      });
      expect(validateModuleData(definition, record.data)).toEqual(record.data);
    }
  });

  it('keeps corrected and removed clinical records with their audit trail', () => {
    const notes = rows('clinicalNote');
    const corrected = notes.find((note) => note.version === 3);
    const removed = notes.find((note) => note.deletedAt);
    const audit = (entityId: string) =>
      rows('auditLog')
        .filter((log) => log.entityId === entityId)
        .map((log) => log.action);

    expect(audit(corrected.id)).toEqual(['CREATE', 'UPDATE', 'UPDATE']);
    expect(audit(removed.id)).toEqual(['CREATE', 'DELETE']);
    expect(removed.deletionReason).toBeTruthy();
    // A mistyped assessment and a certificate withdrawn after it was issued.
    const removedRecords = rows('specialtyRecord').filter((record) => record.deletedAt);
    expect(removedRecords).toHaveLength(2);
    for (const record of removedRecords) {
      expect(record.deletionReason).toBeTruthy();
      expect(audit(record.id)).toContain('DELETE');
    }

    const clinical = rows('auditLog').filter(
      (log) => log.entity === 'CLINICAL_NOTE' || log.entity === 'SPECIALTY_RECORD',
    );
    expect(clinical.every((log) => log.patientId)).toBe(true);
    expect(
      clinical
        .filter((log) => log.action === 'UPDATE' || log.action === 'DELETE')
        .every((log) => log.reason),
    ).toBe(true);
  });

  describe('clinical workflow clinic', () => {
    const clinicId = () =>
      rows('tenant').find((tenant) => tenant.name === 'Centro Médico Los Arrayanes').id;
    const ofClinic = (model: string) => rows(model).filter((row) => row.tenantId === clinicId());

    it('has branches with and without their own professionals, and a closed one', () => {
      const branches = ofClinic('branch');
      const tied = new Set(ofClinic('professionalBranch').map((row) => row.branchId));

      expect(branches.filter((branch) => branch.isMain)).toHaveLength(1);
      expect(branches.some((branch) => branch.isActive === false)).toBe(true);
      expect(tied.size).toBe(2);
      // Someone attends in one branch, someone in two and someone has none marked.
      const perUser = new Map<string, number>();
      for (const row of ofClinic('professionalBranch')) {
        perUser.set(row.userId, (perUser.get(row.userId) ?? 0) + 1);
      }
      expect([...new Set(perUser.values())].sort()).toEqual([1, 2]);
      const professionals = rows('professionalProfile').filter(
        (profile) => byId('user').get(profile.userId).tenantId === clinicId(),
      );
      expect(professionals.some((profile) => !perUser.has(profile.userId))).toBe(true);
    });

    it('books each professional only in the branches they attend in, as the API requires', () => {
      const branchesOf = new Map<string, Set<string>>();
      for (const row of rows('professionalBranch')) {
        branchesOf.set(row.userId, (branchesOf.get(row.userId) ?? new Set()).add(row.branchId));
      }
      const inactive = new Set(
        rows('branch')
          .filter((branch) => branch.isActive === false)
          .map((branch) => branch.id),
      );

      const invalid = rows('appointment').filter(
        (appointment) =>
          appointment.branchId &&
          (inactive.has(appointment.branchId) ||
            (branchesOf.has(appointment.professionalId) &&
              !branchesOf.get(appointment.professionalId).has(appointment.branchId))),
      );
      expect(invalid.map((appointment) => appointment.id)).toEqual([]);
    });

    it('only withdraws permissions the role has and only grants the ones it can receive', () => {
      const users = byId('user');
      const permissions = ofClinic('userPermission');

      expect(permissions.some((row) => row.granted)).toBe(true);
      expect(permissions.some((row) => !row.granted)).toBe(true);
      for (const row of permissions) {
        const role = users.get(row.userId).role;
        const allowed = row.granted ? grantablePermissions(role) : rolePermissions(role);
        expect({
          permission: row.permission,
          role,
          valid: allowed.includes(row.permission),
        }).toEqual({ permission: row.permission, role, valid: true });
      }
    });

    it('keeps each encounter and what was written in it with one patient and one professional', () => {
      const encounters = byId('encounter');
      const appointments = byId('appointment');
      const open = ofClinic('encounter').filter((encounter) => encounter.status === 'OPEN');

      // The one in course is the appointment being attended right now.
      expect(open).toHaveLength(1);
      expect(appointments.get(open[0].appointmentId).status).toBe('IN_PROGRESS');
      for (const encounter of ofClinic('encounter').filter((row) => row.status === 'CLOSED')) {
        expect(encounter.closedAt.getTime()).toBeGreaterThan(encounter.startedAt.getTime());
        expect(encounter.summary).toBeTruthy();
        if (encounter.appointmentId) {
          expect(appointments.get(encounter.appointmentId).status).toBe('COMPLETED');
        }
      }
      // An appointment is attended in one encounter at most.
      const attended = rows('encounter').flatMap((encounter) => encounter.appointmentId ?? []);
      expect(new Set(attended).size).toBe(attended.length);

      for (const model of ['specialtyRecord', 'clinicalNote', 'patientFile']) {
        for (const row of rows(model).filter((candidate) => candidate.encounterId)) {
          const encounter = encounters.get(row.encounterId);
          const author = row.professionalId ?? row.psychologistId ?? row.uploadedById;
          expect({ model, id: row.id, patientId: row.patientId, author }).toEqual({
            model,
            id: row.id,
            patientId: encounter.patientId,
            author: encounter.professionalId,
          });
        }
      }
      expect(new Set(ofClinic('encounter').map((row) => row.encounterType)).size).toBeGreaterThan(
        4,
      );
    });

    it('gives every document a verification code nobody else has', () => {
      const codes = ofClinic('specialtyRecord').map((record) => record.verificationCode);

      expect(new Set(codes).size).toBe(codes.length);
      for (const code of codes) expect(normalizeVerificationCode(code)).toBe(code);
      expect(codes).toEqual(expect.arrayContaining(Object.values(DEMO_DOCUMENT_CODES)));

      const byCode = (code: string) =>
        rows('specialtyRecord').find((record) => record.verificationCode === code);
      // The states the public verification page tells apart.
      expect(byCode(DEMO_DOCUMENT_CODES.certificate)).toMatchObject({ version: 1 });
      expect(byCode(DEMO_DOCUMENT_CODES.corrected)).toMatchObject({
        version: 2,
        data: { restDays: 10 },
      });
      expect(byCode(DEMO_DOCUMENT_CODES.withdrawn).deletedAt).toBeInstanceOf(Date);
      expect(byCode(DEMO_DOCUMENT_CODES.consent).data.signerSignature).toMatch(
        /^data:image\/png;base64,/,
      );
    });

    it('answers a form of the clinic under each of its versions', () => {
      const form = ofClinic('formDefinition').find((row) => row.currentVersion === 2);
      const versions = rows('formDefinitionVersion')
        .filter((version) => version.formDefinitionId === form.id)
        .map((version) => version.version);
      const answered = rows('specialtyRecord')
        .filter((record) => record.formDefinitionId === form.id)
        .map((record) => record.schemaVersion);

      expect(versions.sort()).toEqual([1, 2]);
      expect(answered.sort()).toEqual([1, 2]);
    });

    it('writes templates that use only the variables a client can fill in', () => {
      const templates = ofClinic('documentTemplate');

      expect(new Set(templates.map((template) => template.moduleKey))).toEqual(
        new Set(TEMPLATE_MODULE_KEYS),
      );
      expect(templates.some((template) => template.isActive === false)).toBe(true);
      for (const template of templates) {
        expect(unknownTemplateVariables(`${template.title ?? ''}\n${template.body}`)).toEqual([]);
      }
    });

    it('stores the bytes of every file, real PDF and PNG, and counts them all', () => {
      const files = ofClinic('patientFile');
      const magic: Record<string, string> = {
        'application/pdf': '%PDF-',
        'image/png': '\x89PNG',
      };

      expect(files.length).toBeGreaterThan(3);
      expect(new Set(files.map((file) => file.mimeType))).toEqual(new Set(Object.keys(magic)));
      for (const file of files) {
        const bytes = stored.get(file.storageKey);
        expect(bytes?.length).toBe(file.sizeBytes);
        expect(bytes.subarray(0, magic[file.mimeType].length).toString('latin1')).toBe(
          magic[file.mimeType],
        );
      }
      // A removed file keeps its bytes and keeps counting against the plan.
      expect(files.filter((file) => file.deletedAt)).toHaveLength(1);
      const subscription = rows('tenantSubscription').find((row) => row.tenantId === clinicId());
      expect(subscription.storageUsedBytes).toBe(
        BigInt(files.reduce((total, file) => total + file.sizeBytes, 0)),
      );
    });

    it('identifies its patients as the API would accept them', () => {
      const patients = ofClinic('patient');

      expect(new Set(patients.map((patient) => patient.identificationType ?? null))).toEqual(
        new Set(['CEDULA', 'PASSPORT', null]),
      );
      const numbers = patients.flatMap((patient) => patient.identificationNumber ?? []);
      expect(new Set(numbers).size).toBe(numbers.length);
      // A minor has a legal guardian on file.
      const minors = patients.filter(
        (patient) => patient.dateOfBirth && ageInYears(patient.dateOfBirth, NOW) < 18,
      );
      expect(minors).toHaveLength(1);
      expect(minors[0].guardianName).toBeTruthy();
    });
  });

  it('covers the account and patient states the access rules depend on', () => {
    const users = rows('user');
    const profiles = new Map(rows('professionalProfile').map((row) => [row.userId, row]));
    const hasProfile = (user: Row, isActive: boolean) =>
      profiles.get(user.id)?.isActive === isActive;

    expect({
      masterWithProfile: users.some((u) => u.role === 'MASTER' && hasProfile(u, true)),
      masterWithoutProfile: users.some((u) => u.role === 'MASTER' && !profiles.has(u.id)),
      activeWithInactiveProfile: users.some((u) => u.isActive && hasProfile(u, false)),
      deactivated: users.some((u) => u.role === 'PROFESIONAL' && !u.isActive && u.activatedAt),
      pendingInvitation: users.some((u) => !u.isActive && u.invitedAt && !u.activatedAt),
      pendingLegacyAccess: users.some((u) => !u.isActive && u.managedByProvider),
      mustChangePassword: users.some((u) => u.mustChangePassword),
      suspendedTenant: rows('tenant').some((tenant) => !tenant.isActive),
    }).toEqual({
      masterWithProfile: true,
      masterWithoutProfile: true,
      activeWithInactiveProfile: true,
      deactivated: true,
      pendingInvitation: true,
      pendingLegacyAccess: true,
      mustChangePassword: true,
      suspendedTenant: true,
    });

    const patients = rows('patient');
    const team = rows('patientProfessional');
    const teamSize = (patient: Row) =>
      team.filter((member) => member.patientId === patient.id && member.isActive).length;

    expect({
      archived: patients.some((p) => !p.isActive && !p.deletedAt),
      removed: patients.some((p) => p.deletedAt),
      unassigned: patients.some((p) => p.isActive && teamSize(p) === 0),
      sharedByTwoProfessionals: patients.some((p) => teamSize(p) > 1),
      formerProfessional: team.some((member) => !member.isActive),
      billingProfileIdTypes: [
        ...new Set(rows('billingProfile').map((profile) => profile.idType)),
      ].sort(),
      defaultProfileLinks: rows('patientBillingProfile').every((link) => link.isDefault),
      withoutBillingProfile: patients.some(
        (p) => !rows('patientBillingProfile').some((link) => link.patientId === p.id),
      ),
    }).toEqual({
      archived: true,
      removed: true,
      unassigned: true,
      sharedByTwoProfessionals: true,
      formerProfessional: true,
      billingProfileIdTypes: ['04', '05', '06'],
      defaultProfileLinks: true,
      withoutBillingProfile: true,
    });
  });
});
