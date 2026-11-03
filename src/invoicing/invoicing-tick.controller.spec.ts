import { HttpException, Logger, NotFoundException, UnauthorizedException } from '@nestjs/common';
import { SriError } from './sri/sri-types';
import * as nodeCrypto from 'crypto';
import { InvoicingController } from './invoicing.controller';
import { InvoicingTickController } from './invoicing-tick.controller';

jest.mock('crypto', () => {
  const actual = jest.requireActual('crypto');
  return { ...actual, timingSafeEqual: jest.fn(actual.timingSafeEqual) };
});

const secret = 'tick-secret-value';

describe('InvoicingTickController', () => {
  const original = process.env.INVOICING_TICK_SECRET;
  let worker: { tick: jest.Mock };
  let controller: InvoicingTickController;

  beforeEach(() => {
    process.env.INVOICING_TICK_SECRET = secret;
    worker = { tick: jest.fn().mockResolvedValue({ processed: 2 }) };
    controller = new InvoicingTickController(worker as any);
  });
  afterEach(() => {
    if (original === undefined) delete process.env.INVOICING_TICK_SECRET;
    else process.env.INVOICING_TICK_SECRET = original;
  });

  it('answers 404 when no tick secret is configured', () => {
    delete process.env.INVOICING_TICK_SECRET;
    expect(() => controller.tick(`Bearer ${secret}`)).toThrow(NotFoundException);
    expect(worker.tick).not.toHaveBeenCalled();
  });

  it.each([undefined, '', 'Bearer', 'Bearer x', 'Basic ' + secret, 'Bearer ' + secret + 'x'])(
    'answers 401 for %p without throwing from timingSafeEqual',
    (header) => {
      const compare = nodeCrypto.timingSafeEqual as jest.Mock;
      compare.mockClear();
      expect(() => controller.tick(header)).toThrow(UnauthorizedException);
      expect(compare).not.toHaveBeenCalled();
      expect(worker.tick).not.toHaveBeenCalled();
    },
  );

  it('answers 401 for a wrong secret of the right length', () => {
    expect(() => controller.tick('Bearer ' + 'x'.repeat(secret.length))).toThrow(
      UnauthorizedException,
    );
    expect(worker.tick).not.toHaveBeenCalled();
  });

  it('is not throttled', () => {
    expect(
      Reflect.getMetadata(`THROTTLER:SKIPdefault`, InvoicingTickController.prototype.tick),
    ).toBe(true);
  });

  it('runs one tick with the right secret', async () => {
    await expect(controller.tick(`Bearer ${secret}`)).resolves.toEqual({ processed: 2 });
    expect(worker.tick).toHaveBeenCalledWith(45000);
  });
});

describe('InvoicingController.create', () => {
  const user = { userId: 'user', role: 'MASTER' } as any;
  let requests: { create: jest.Mock; view: jest.Mock };
  let worker: { processOne: jest.Mock };
  let permissions: { assertAllowed: jest.Mock };
  let controller: InvoicingController;

  beforeEach(() => {
    requests = {
      create: jest.fn().mockResolvedValue({ id: 'request', status: 'REQUESTED' }),
      view: jest.fn().mockResolvedValue({ id: 'request', status: 'AUTHORIZED' }),
    };
    worker = { processOne: jest.fn().mockResolvedValue(undefined) };
    permissions = { assertAllowed: jest.fn().mockResolvedValue(undefined) };
    controller = new InvoicingController(
      {} as any,
      requests as any,
      {} as any,
      worker as any,
      permissions as any,
    );
  });

  it('returns the state reached inline', async () => {
    await expect(controller.create('clinic', 'order', user, 'key')).resolves.toEqual({
      id: 'request',
      status: 'AUTHORIZED',
    });
    expect(requests.create).toHaveBeenCalledWith('clinic', 'user', 'order', 'key');
    expect(worker.processOne).toHaveBeenCalledWith('request', 15000);
    expect(permissions.assertAllowed).toHaveBeenCalledWith(
      { userId: 'user', tenantId: 'clinic', role: 'MASTER' },
      'billing.view',
    );
    expect(requests.view).toHaveBeenCalledWith('clinic', 'request', { includeError: true });
  });

  it('hides SRI messages from a caller without billing.view', async () => {
    permissions.assertAllowed.mockRejectedValue(new Error('PERMISSION_DENIED'));
    await controller.create('clinic', 'order', user, 'key');
    expect(requests.view).toHaveBeenCalledWith('clinic', 'request', { includeError: false });
  });

  it.each([
    [new SriError('transient', 'SRI_TIMEOUT'), 'SRI_TIMEOUT'],
    [new HttpException({ code: 'INVOICE_X', message: 'secret text' }, 409), 'INVOICE_X'],
    [new TypeError('secret text'), 'TypeError'],
  ])('answers with the view and warns with id and code only (%#)', async (error, code) => {
    const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation();
    worker.processOne.mockRejectedValue(error);
    await expect(controller.create('clinic', 'order', user, 'key')).resolves.toMatchObject({
      id: 'request',
    });
    expect(warn).toHaveBeenCalledTimes(1);
    const message = String(warn.mock.calls[0][0]);
    expect(message).toContain('request');
    expect(message).toContain(code);
    expect(message).not.toContain('secret text');
    warn.mockRestore();
  });
});
