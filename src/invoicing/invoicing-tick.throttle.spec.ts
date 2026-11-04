import { Controller, INestApplication, Post } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { ThrottlerModule } from '@nestjs/throttler';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { InvoicingTickController } from './invoicing-tick.controller';
import { InvoiceWorkerService } from './invoice-worker.service';
import { TickAwareThrottlerGuard, buildThrottlers } from './invoicing-tick.throttle';

const secret = 'tick-secret-value-0123456789abcdef-xyz';
const valid = `Bearer ${secret}`;
const WINDOW_MS = 2500;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

@Controller('other')
class OtherController {
  @Post()
  hit() {
    return { ok: true };
  }
}

describe('invoicing tick throttling (SEC-API-05)', () => {
  const original = process.env.INVOICING_TICK_SECRET;
  let app: INestApplication;
  let worker: { tick: jest.Mock };

  beforeEach(async () => {
    process.env.INVOICING_TICK_SECRET = secret;
    worker = { tick: jest.fn().mockResolvedValue({ processed: 1 }) };
    const module = await Test.createTestingModule({
      // The same builder as AppModule; the default limit is 1, so a second valid tick call (or a
      // second hit anywhere else) would 429 if the default throttler counted the tick.
      imports: [ThrottlerModule.forRoot(buildThrottlers({ ttl: 60_000, limit: 1 }, WINDOW_MS))],
      controllers: [InvoicingTickController, OtherController],
      providers: [
        { provide: InvoiceWorkerService, useValue: worker },
        { provide: APP_GUARD, useClass: TickAwareThrottlerGuard },
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

  const post = (forwarded: string, authorization?: string, path = '/internal/invoicing/tick') => {
    const call = request(app.getHttpServer()).post(path).set('X-Forwarded-For', forwarded);
    return authorization === undefined ? call : call.set('Authorization', authorization);
  };

  async function exhaust(forwarded: string) {
    for (let i = 0; i < 10; i++) await post(forwarded, 'Bearer wrong').expect(401);
  }

  it('answers 429 to the 11th invalid attempt, and also to the valid secret afterwards', async () => {
    await exhaust('203.0.113.1');
    await post('203.0.113.1', 'Bearer wrong').expect(429);
    await post('203.0.113.1').expect(429);
    await post('203.0.113.1', 'Basic ' + secret).expect(429);
    await post('203.0.113.1', valid).expect(429);
    expect(worker.tick).not.toHaveBeenCalled();
  });

  it('answers 429 to the valid secret right after the tenth invalid attempt', async () => {
    await exhaust('203.0.113.7');
    await post('203.0.113.7', valid).expect(429);
  });

  it('leaves other clients unaffected', async () => {
    await exhaust('203.0.113.2');
    await post('203.0.113.2', valid).expect(429);
    await post('203.0.113.8', valid).expect(200);
    await post('203.0.113.8', 'Bearer wrong').expect(401);
  });

  it('lets both kinds through again once the window ends', async () => {
    await exhaust('203.0.113.9');
    await post('203.0.113.9', valid).expect(429);
    await new Promise((resolve) => setTimeout(resolve, WINDOW_MS + 150));
    await post('203.0.113.9', valid).expect(200);
    await post('203.0.113.9', 'Bearer wrong').expect(401);
  });

  it('answers a right and a wrong guess identically once the budget is spent', async () => {
    await exhaust('203.0.113.13');
    const wrong = await post('203.0.113.13', 'Bearer wrong').expect(429);
    const right = await post('203.0.113.13', valid).expect(429);
    const comparable = (headers: Record<string, any>) =>
      Object.fromEntries(
        Object.entries(headers).filter(
          ([name]) => !['date', 'etag', 'content-length'].includes(name),
        ),
      );
    expect(right.body).toEqual(wrong.body);
    expect(Object.keys(right.headers).sort()).toEqual(Object.keys(wrong.headers).sort());
    expect(comparable(right.headers)).toEqual(comparable(wrong.headers));
    expect(Object.keys(right.headers).filter((name) => /rate|retry/i.test(name))).toEqual([]);
  });

  it('keeps the lockout while blocked even after the counted hits decayed below the limit', async () => {
    const client = '203.0.113.14';
    for (let i = 0; i < 2; i++) await post(client, 'Bearer wrong').expect(401);
    await sleep(WINDOW_MS * 0.7);
    // Nine more bring the count to 11: blocked until one window after this moment.
    for (let i = 0; i < 8; i++) await post(client, 'Bearer wrong').expect(401);
    await post(client, 'Bearer wrong').expect(429);
    // The first two hits expire; the count falls to 9 but the block lasts.
    await sleep(WINDOW_MS * 0.45);
    await post(client, valid).expect(429);
    await sleep(WINDOW_MS * 0.7);
    await post(client, valid).expect(200);
  });

  it('keeps a ceiling of 30 per minute on the valid secret, not the default limit', async () => {
    for (let i = 0; i < 30; i++) await post('203.0.113.3', valid).expect(200);
    await post('203.0.113.3', valid).expect(429);
  });

  it('tracks clients by the first X-Forwarded-For address, independently', async () => {
    await exhaust('203.0.113.4, 10.0.0.1');
    await post('203.0.113.4, 10.9.9.9', 'Bearer wrong').expect(429);
    await post('203.0.113.5, 10.0.0.1', 'Bearer wrong').expect(401);
  });

  it('counts nothing and answers 404 when no usable secret is configured', async () => {
    for (const unusable of [undefined, 'x'.repeat(31)]) {
      if (unusable) process.env.INVOICING_TICK_SECRET = unusable;
      else delete process.env.INVOICING_TICK_SECRET;
      for (let i = 0; i < 12; i++) await post('203.0.113.6', 'Bearer wrong').expect(404);
    }
    process.env.INVOICING_TICK_SECRET = secret;
    await post('203.0.113.6', 'Bearer wrong').expect(401);
  });

  it('never applies the tick throttlers to other routes', async () => {
    // A roomy default limit, so only the tick throttlers could answer 429 below.
    await app.close();
    const module = await Test.createTestingModule({
      imports: [ThrottlerModule.forRoot(buildThrottlers({ ttl: 60_000, limit: 1000 }, WINDOW_MS))],
      controllers: [InvoicingTickController, OtherController],
      providers: [
        { provide: InvoiceWorkerService, useValue: worker },
        { provide: APP_GUARD, useClass: TickAwareThrottlerGuard },
      ],
    }).compile();
    app = module.createNestApplication();
    await app.init();

    for (let i = 0; i < 15; i++) await post('203.0.113.10', 'Bearer wrong', '/other').expect(201);
    for (let i = 0; i < 15; i++) await post('203.0.113.10', undefined, '/other').expect(201);
    await post('203.0.113.10', valid, '/other').expect(201);
  });
});
