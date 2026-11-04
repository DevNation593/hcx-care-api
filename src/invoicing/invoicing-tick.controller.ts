import {
  Controller,
  Headers,
  HttpCode,
  Logger,
  NotFoundException,
  Post,
  UnauthorizedException,
} from '@nestjs/common';
import { Public } from '../common/decorators/public.decorator';
import { InvoiceWorkerService } from './invoice-worker.service';
import {
  MIN_TICK_SECRET_LENGTH,
  TickRoute,
  configuredTickSecret,
  hasValidTickSecret,
} from './invoicing-tick.throttle';

@Controller('internal/invoicing')
export class InvoicingTickController {
  constructor(private readonly worker: InvoiceWorkerService) {
    // Never log the value, only that it is unusable.
    if (process.env.INVOICING_TICK_SECRET && !configuredTickSecret()) {
      new Logger(InvoicingTickController.name).warn(
        `INVOICING_TICK_SECRET is shorter than ${MIN_TICK_SECRET_LENGTH} characters: the tick route is disabled (404)`,
      );
    }
  }

  // @Public(): called by an external scheduler with no user session, so it is authenticated by
  // INVOICING_TICK_SECRET (Bearer) instead of JWT. Without a usable secret (unset or under 32 characters) the route does not exist.
  // Throttled per client by the named throttlers of invoicing-tick.throttle.ts (SEC-API-05): wrong or
  // missing secrets are limited to 10 per minute, then every request from that client, the right secret
  // included, gets 429 until the window ends (so a right guess cannot be told from a wrong one); other
  // clients are unaffected and valid calls have a ceiling of their own. Concurrent ticks are safe
  // (SKIP LOCKED leases).
  @Public()
  @TickRoute()
  @Post('tick')
  @HttpCode(200)
  tick(@Headers('authorization') authorization?: string) {
    if (!configuredTickSecret()) throw new NotFoundException();
    if (!hasValidTickSecret(authorization)) throw new UnauthorizedException();
    return this.worker.tick(45000);
  }
}
