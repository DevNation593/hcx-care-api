import { INestApplication } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { InvoicingTickController } from './invoicing-tick.controller';
import { InvoiceWorkerService } from './invoice-worker.service';
import { isTickRoute, tickThrottlers } from './invoicing-tick.throttle';

const secret = 'tick-secret-value';
const valid = `Bearer ${secret}`;

describe('invoicing tick throttling (SEC-API-05)', () => {
  const original = process.env.INVOICING_TICK_SECRET;
  let app: INestApplication;
  let worker: { tick: jest.Mock };

  beforeEach(async () => {
    process.env.INVOICING_TICK_SECRET = secret;
    worker = { tick: jest.fn().mockResolvedValue({ processed: 1 }) };
    const module = await Test.createTestingModule({
      imports: [
        ThrottlerModule.forRoot([
          { ttl: 60_000, limit: 1000, skipIf: isTickRoute },
          ...tickThrottlers,
        ]),
      ],
      controllers: [InvoicingTickController],
      providers: [
        { provide: InvoiceWorkerService, useValue: worker },
        { provide: APP_GUARD, useClass: ThrottlerGuard },
      ],
    }).compile();
    app = module.createNestApplication();
    await app.init();
  });
  afterEach(async () => {
    await app.close();
    if (original === undefined) delete process.env.INVOICING_TICK_SECRET;
    else process.env.INVOICING_TICK_SECRET = original;
  });

  const post = (forwarded: string, authorization?: string) => {
    const call = request(app.getHttpServer()).post('/internal/invoicing/tick');
    call.set('X-Forwarded-For', forwarded);
    return authorization === undefined ? call : call.set('Authorization', authorization);
  };

  async function exhaust(forwarded: string) {
    for (let i = 0; i < 10; i++) await post(forwarded, 'Bearer wrong').expect(401);
  }

  it('answers 429 to the 11th invalid attempt of a client within a minute', async () => {
    await exhaust('203.0.113.1');
    await post('203.0.113.1', 'Bearer wrong').expect(429);
    await post('203.0.113.1').expect(429);
    await post('203.0.113.1', 'Basic ' + secret).expect(429);
    expect(worker.tick).not.toHaveBeenCalled();
  });

  it('never blocks the valid secret because of a client that exhausted the invalid budget', async () => {
    await exhaust('203.0.113.2');
    await post('203.0.113.2', 'Bearer wrong').expect(429);
    await post('203.0.113.2', valid).expect(200);
    expect(worker.tick).toHaveBeenCalledTimes(1);
  });

  it('still puts a ceiling of 30 per minute on the valid secret', async () => {
    for (let i = 0; i < 30; i++) await post('203.0.113.3', valid).expect(200);
    await post('203.0.113.3', valid).expect(429);
  });

  it('tracks clients by the first X-Forwarded-For address, independently', async () => {
    await exhaust('203.0.113.4, 10.0.0.1');
    await post('203.0.113.4, 10.9.9.9', 'Bearer wrong').expect(429);
    await post('203.0.113.5, 10.0.0.1', 'Bearer wrong').expect(401);
  });

  it('counts nothing and answers 404 when no secret is configured', async () => {
    delete process.env.INVOICING_TICK_SECRET;
    for (let i = 0; i < 12; i++) await post('203.0.113.6', 'Bearer wrong').expect(404);
    process.env.INVOICING_TICK_SECRET = secret;
    await post('203.0.113.6', 'Bearer wrong').expect(401);
  });
});
