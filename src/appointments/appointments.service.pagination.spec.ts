import { PatientTeamService } from '../patient-team/patient-team.service';
import { TeamActor } from '../patient-team/patient-team.types';
import { ProfessionalEligibilityService } from '../patient-team/professional-eligibility.service';
import { PrismaService } from '../prisma/prisma.service';
import { AppointmentsService } from './appointments.service';

describe('AppointmentsService.findAll paging', () => {
  const tenantId = 'tenant-1';
  const admin: TeamActor = { tenantId, userId: 'admin-1', role: 'MASTER' };
  const assistant: TeamActor = { tenantId, userId: 'assistant-1', role: 'ASISTENTE' };
  const clinician: TeamActor = { tenantId, userId: 'professional-1', role: 'PROFESIONAL' };
  const own = {
    OR: [
      { professionalId: 'professional-1' },
      { professionalId: null, psychologistId: 'professional-1' },
    ],
  };
  const person = { id: 'u-1', firstName: 'Ana', lastName: 'López', email: 'ana@example.test' };
  const row = (id: string) => ({
    id,
    tenantId,
    patientId: 'patient-1',
    professionalId: 'professional-1',
    psychologistId: 'professional-1',
    startTime: new Date('2026-09-29T13:00:00.000Z'),
    endTime: new Date('2026-09-29T14:00:00.000Z'),
    duration: 60,
    status: 'SCHEDULED',
    patient: { id: 'patient-1', firstName: 'Pat', lastName: 'Smith' },
    professional: person,
    psychologist: person,
    specialty: null,
    branch: null,
  });
  // The unpaged list reads through the client; a page reads inside one transaction, on `tx`.
  const tx = { appointment: { findMany: jest.fn(), count: jest.fn() } };
  const prisma = {
    appointment: { findMany: jest.fn(), count: jest.fn() },
    tenantSettings: { findUnique: jest.fn() },
    $transaction: jest.fn(),
    applyRlsContext: jest.fn(),
  };
  const service = new (AppointmentsService as any)(
    prisma as unknown as PrismaService,
    {} as unknown as ProfessionalEligibilityService,
    {} as unknown as PatientTeamService,
  ) as AppointmentsService;
  const list = (filters: Record<string, unknown>, actor: TeamActor = admin) =>
    (service as any).findAll(tenantId, filters, actor);

  beforeEach(() => {
    jest.resetAllMocks();
    prisma.$transaction.mockImplementation((callback: (client: typeof tx) => unknown) =>
      callback(tx),
    );
    prisma.appointment.findMany.mockResolvedValue([row('a-1'), row('a-2')]);
    tx.appointment.findMany.mockResolvedValue([row('a-1'), row('a-2')]);
    tx.appointment.count.mockResolvedValue(53);
    prisma.tenantSettings.findUnique.mockResolvedValue({ timezone: 'America/Guayaquil' });
  });

  describe('without page or limit (the contract the calendar and the mobile app rely on)', () => {
    it('returns the bare, normalized array ordered by start time with no window', async () => {
      const result = await list({ from: '2026-09-28T00:00:00.000Z' });

      expect(Array.isArray(result)).toBe(true);
      expect(result.map((item: { id: string }) => item.id)).toEqual(['a-1', 'a-2']);
      expect(result[0].psychologistId).toBe('professional-1');
      expect(tx.appointment.count).not.toHaveBeenCalled();
      expect(prisma.$transaction).not.toHaveBeenCalled();
      const args = prisma.appointment.findMany.mock.calls[0][0];
      expect(args.orderBy).toEqual({ startTime: 'asc' });
      expect(args).not.toHaveProperty('skip');
      expect(args).not.toHaveProperty('take');
      expect(args.where).toEqual({
        tenantId,
        AND: [],
        startTime: { gte: new Date('2026-09-28T00:00:00.000Z') },
      });
    });
  });

  describe('with page or limit', () => {
    it('returns { data, meta } with normalized rows and a deterministic order', async () => {
      const result = await list({ page: 2, limit: 25 });

      expect(result.meta).toEqual({ page: 2, limit: 25, total: 53, totalPages: 3 });
      expect(result.data.map((item: { id: string }) => item.id)).toEqual(['a-1', 'a-2']);
      expect(result.data[0].psychologistId).toBe('professional-1');
      expect(tx.appointment.findMany.mock.calls[0][0]).toMatchObject({
        skip: 25,
        take: 25,
        orderBy: [{ startTime: 'asc' }, { id: 'asc' }],
      });
    });

    it("counts and lists a professional's page with their own-calendar limit and the filters", async () => {
      await list({ status: 'SCHEDULED', from: '2026-09-28', page: 1, limit: 10 }, clinician);

      const listed = tx.appointment.findMany.mock.calls[0][0].where;
      expect(tx.appointment.count.mock.calls[0][0].where).toBe(listed);
      expect(listed).toMatchObject({ tenantId, status: 'SCHEDULED', AND: [own] });
      // A bound written as a date is that whole day in the clinic's time zone (UTC-5).
      expect(listed.startTime).toEqual({ gte: new Date('2026-09-28T05:00:00.000Z') });
    });

    it('keeps the assigned-patient visibility of a professional inside a patient record', async () => {
      await list({ patientId: 'patient-1', page: 1 }, clinician);

      const listed = tx.appointment.findMany.mock.calls[0][0].where;
      expect(tx.appointment.count.mock.calls[0][0].where).toBe(listed);
      expect(listed.patientId).toBe('patient-1');
      expect(listed.AND[0].OR).toEqual([
        ...own.OR,
        {
          patient: {
            is: {
              tenantId,
              deletedAt: null,
              professionalAssignments: {
                some: { tenantId, professionalId: 'professional-1', isActive: true },
              },
            },
          },
        },
      ]);
    });

    it('still asks an assistant to choose a professional, without touching the database', async () => {
      await expect(list({ page: 1 }, assistant)).rejects.toMatchObject({
        status: 400,
        response: { code: 'APPOINTMENT_PROFESSIONAL_REQUIRED' },
      });
      expect(prisma.$transaction).not.toHaveBeenCalled();
      expect(tx.appointment.count).not.toHaveBeenCalled();
      expect(tx.appointment.findMany).not.toHaveBeenCalled();
    });

    it('reads the total and the page in one transaction, through tx, after the RLS context', async () => {
      const order: string[] = [];
      prisma.applyRlsContext.mockImplementation(async () => void order.push('rls'));
      tx.appointment.count.mockImplementation(async () => (order.push('count'), 53));
      tx.appointment.findMany.mockImplementation(async () => (order.push('rows'), []));

      await list({ page: 1 });

      expect(prisma.$transaction).toHaveBeenCalledTimes(1);
      expect(prisma.applyRlsContext).toHaveBeenCalledWith(tx);
      expect(order).toEqual(['rls', 'count', 'rows']);
      expect(prisma.appointment.findMany).not.toHaveBeenCalled();
      expect(prisma.appointment.count).not.toHaveBeenCalled();
    });

    it('does not run the count and the page at the same time (RLS wrapper shares its context)', async () => {
      let running = 0;
      let overlapped = false;
      const track =
        <T>(value: T) =>
        async () => {
          running += 1;
          overlapped = overlapped || running > 1;
          await new Promise((resolve) => setImmediate(resolve));
          running -= 1;
          return value;
        };
      tx.appointment.count.mockImplementation(track(53));
      tx.appointment.findMany.mockImplementation(track([row('a-1')]));

      await list({ page: 1 });

      expect(overlapped).toBe(false);
    });
  });
});
