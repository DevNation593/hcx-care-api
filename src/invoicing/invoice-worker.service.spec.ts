import { InvoiceWorkerService } from './invoice-worker.service';

describe('InvoiceWorkerService dispatch entry points', () => {
  const env = { ...process.env };
  let tx: any;
  let prisma: any;
  let emitter: { advance: jest.Mock };
  let worker: InvoiceWorkerService;
  const row = (id: string) => ({ id, tenantId: 't', issuerId: 'i', leaseToken: 'l' });

  beforeEach(() => {
    tx = {
      $queryRaw: jest.fn().mockResolvedValue([]),
      invoiceRequest: { update: jest.fn(async ({ where }: any) => row(where.id)) },
    };
    prisma = { $transaction: jest.fn(async (fn: any) => fn(tx)) };
    emitter = { advance: jest.fn().mockResolvedValue(undefined) };
    worker = new InvoiceWorkerService(prisma, {} as any, emitter as any);
  });
  afterEach(() => {
    process.env = { ...env };
    jest.restoreAllMocks();
  });

  describe('processOne', () => {
    it('claims that row with a parameterized id filter and advances it with the budget', async () => {
      tx.$queryRaw.mockResolvedValue([row('r1')]);
      const before = Date.now();
      await worker.processOne('r1', 15000);
      const query = tx.$queryRaw.mock.calls[0][0];
      expect(query.sql).toContain('"id" = ?');
      expect(query.sql).not.toContain('r1');
      expect(query.values).toContain('r1');
      const [advanced, deadline] = emitter.advance.mock.calls[0];
      expect(advanced.id).toBe('r1');
      expect(deadline).toBeGreaterThanOrEqual(before + 15000);
      expect(deadline).toBeLessThanOrEqual(Date.now() + 15000);
    });

    it('does nothing when another worker holds the lease', async () => {
      tx.$queryRaw.mockResolvedValue([]);
      await expect(worker.processOne('r1', 15000)).resolves.toBeUndefined();
      expect(emitter.advance).not.toHaveBeenCalled();
    });
  });

  describe('tick', () => {
    it('drains normal claims, then reconcile claims, until nothing is due', async () => {
      tx.$queryRaw
        .mockResolvedValueOnce([row('a'), row('b')])
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([row('c')])
        .mockResolvedValue([]);
      await expect(worker.tick(45000)).resolves.toEqual({ processed: 3 });
      expect(emitter.advance.mock.calls.map(([r]) => r.id)).toEqual(['a', 'b', 'c']);
      const deadlines = emitter.advance.mock.calls.map(([, d]) => d);
      expect(new Set(deadlines).size).toBe(1);
    });

    it('does not start a row with less than 4 s left', async () => {
      tx.$queryRaw.mockResolvedValue([row('a')]);
      await expect(worker.tick(3999)).resolves.toEqual({ processed: 0 });
      expect(tx.$queryRaw).not.toHaveBeenCalled();
      expect(emitter.advance).not.toHaveBeenCalled();
    });

    it('stops mid-batch when the budget runs below 4 s', async () => {
      tx.$queryRaw.mockResolvedValue([row('a'), row('b')]);
      const now = jest.spyOn(Date, 'now');
      now.mockReturnValue(1_000_000);
      emitter.advance.mockImplementation(async () => now.mockReturnValue(1_000_000 + 44_000));
      await expect(worker.tick(45000)).resolves.toEqual({ processed: 1 });
    });
  });

  describe('internal scheduler', () => {
    it.each([undefined, 'false', '1'])(
      'stays idle unless the flag is "true" (%p)',
      async (flag) => {
        process.env.NODE_ENV = 'production';
        if (flag === undefined) delete process.env.INVOICING_INTERNAL_SCHEDULER;
        else process.env.INVOICING_INTERNAL_SCHEDULER = flag;
        await worker.scheduledDispatch();
        await worker.scheduledReconcile();
        expect(prisma.$transaction).not.toHaveBeenCalled();
      },
    );

    it('runs when the flag is "true" outside tests', async () => {
      process.env.NODE_ENV = 'production';
      process.env.INVOICING_INTERNAL_SCHEDULER = 'true';
      await worker.scheduledDispatch();
      await worker.scheduledReconcile();
      expect(prisma.$transaction).toHaveBeenCalledTimes(2);
    });

    it('stays idle under NODE_ENV=test even with the flag', async () => {
      process.env.NODE_ENV = 'test';
      process.env.INVOICING_INTERNAL_SCHEDULER = 'true';
      await worker.scheduledDispatch();
      expect(prisma.$transaction).not.toHaveBeenCalled();
    });
  });
});
