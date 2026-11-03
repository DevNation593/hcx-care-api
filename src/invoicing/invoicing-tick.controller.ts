import {
  Controller,
  Headers,
  HttpCode,
  NotFoundException,
  Post,
  UnauthorizedException,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { timingSafeEqual } from 'crypto';
import { Public } from '../common/decorators/public.decorator';
import { InvoiceWorkerService } from './invoice-worker.service';

@Controller('internal/invoicing')
export class InvoicingTickController {
  constructor(private readonly worker: InvoiceWorkerService) {}

  // @Public(): called by an external scheduler with no user session, so it is authenticated by
  // INVOICING_TICK_SECRET (Bearer) instead of JWT. Without the secret configured the route does not exist.
  @Public()
  @Post('tick')
  @HttpCode(200)
  @Throttle({ default: { limit: 6, ttl: 60000 } })
  tick(@Headers('authorization') authorization?: string) {
    const secret = process.env.INVOICING_TICK_SECRET;
    if (!secret) throw new NotFoundException();
    const given = Buffer.from(authorization?.startsWith('Bearer ') ? authorization.slice(7) : '');
    const expected = Buffer.from(secret);
    // timingSafeEqual throws on different lengths, so those are rejected first.
    if (given.length !== expected.length || !timingSafeEqual(given, expected)) {
      throw new UnauthorizedException();
    }
    return this.worker.tick(45000);
  }
}
