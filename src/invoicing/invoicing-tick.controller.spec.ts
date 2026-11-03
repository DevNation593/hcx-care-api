import { NotFoundException, UnauthorizedException } from '@nestjs/common';
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

  it('runs one tick with the right secret', async () => {
    await expect(controller.tick(`Bearer ${secret}`)).resolves.toEqual({ processed: 2 });
    expect(worker.tick).toHaveBeenCalledWith(45000);
  });
});

describe('InvoicingController.create', () => {
  const user = { userId: 'user' } as any;
  let requests: { create: jest.Mock; view: jest.Mock };
  let worker: { processOne: jest.Mock };
  let controller: InvoicingController;

  beforeEach(() => {
    requests = {
      create: jest.fn().mockResolvedValue({ id: 'request', status: 'REQUESTED' }),
      view: jest.fn().mockResolvedValue({ id: 'request', status: 'AUTHORIZED' }),
    };
    worker = { processOne: jest.fn().mockResolvedValue(undefined) };
    controller = new InvoicingController(
      {} as any,
      {} as any,
      requests as any,
      {} as any,
      worker as any,
    );
  });

  it('returns the state reached inline', async () => {
    await expect(controller.create('clinic', 'order', user, 'key')).resolves.toEqual({
      id: 'request',
      status: 'AUTHORIZED',
    });
    expect(requests.create).toHaveBeenCalledWith('clinic', 'user', 'order', 'key');
    expect(worker.processOne).toHaveBeenCalledWith('request', 15000);
    expect(requests.view).toHaveBeenCalledWith('clinic', 'request');
  });

  it('still answers with the current view when the inline attempt throws', async () => {
    worker.processOne.mockRejectedValue(new Error('boom'));
    await expect(controller.create('clinic', 'order', user, 'key')).resolves.toMatchObject({
      id: 'request',
    });
  });
});
