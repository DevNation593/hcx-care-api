import {
  Controller,
  Headers,
  HttpCode,
  NotFoundException,
  Post,
  UnauthorizedException,
} from '@nestjs/common';
import { Public } from '../common/decorators/public.decorator';
import { InvoiceWorkerService } from './invoice-worker.service';
import { TickRoute, hasValidTickSecret } from './invoicing-tick.throttle';

@Controller('internal/invoicing')
export class InvoicingTickController {
  constructor(private readonly worker: InvoiceWorkerService) {}

  // @Public(): called by an external scheduler with no user session, so it is authenticated by
  // INVOICING_TICK_SECRET (Bearer) instead of JWT. Without the secret configured the route does not exist.
  // Throttled per client by the named throttlers of invoicing-tick.throttle.ts (SEC-API-05): wrong or
  // missing secrets are limited to 10 per minute, then 429, while a request with the right secret is
  // never blocked by that budget (it only has a generous ceiling of its own). Concurrent ticks are
  // safe (SKIP LOCKED leases).
  @Public()
  @TickRoute()
  @Post('tick')
  @HttpCode(200)
  tick(@Headers('authorization') authorization?: string) {
    if (!process.env.INVOICING_TICK_SECRET) throw new NotFoundException();
    if (!hasValidTickSecret(authorization)) throw new UnauthorizedException();
    return this.worker.tick(45000);
  }
}
