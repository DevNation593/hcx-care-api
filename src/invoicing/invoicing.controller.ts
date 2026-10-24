import {
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  Param,
  Post,
  Put,
  Query,
  RawBodyRequest,
  Req,
  Res,
} from '@nestjs/common';
import { Request, Response } from 'express';
import { Throttle } from '@nestjs/throttler';
import { CurrentUser, AuthUser } from '../common/decorators/current-user.decorator';
import { Roles } from '../common/decorators/roles.decorator';
import { RequireSection } from '../common/decorators/require-section.decorator';
import { Public } from '../common/decorators/public.decorator';
import { RequirePermission } from '../common/permissions/permission-catalog';
import { ConnectionService } from './connection.service';
import { InvoiceRequestsService } from './invoice-requests.service';
import { InvoiceArtifactsService } from './invoice-artifacts.service';
import { InvoiceWebhookService } from './invoice-webhook.service';
import {
  EmissionPointDto,
  ListInvoiceRequestsQuery,
  SaveConnectionDto,
  TestConnectionDto,
} from './dto/invoicing.dto';
@Controller('tenants/:tenantId')
@RequireSection('core.billing.invoicing')
export class InvoicingController {
  constructor(
    private readonly connections: ConnectionService,
    private readonly requests: InvoiceRequestsService,
    private readonly artifacts: InvoiceArtifactsService,
  ) {}
  @Get('invoicing/connection') @Roles('MASTER') getConnection(@Param('tenantId') t: string) {
    return this.connections.get(t);
  }
  @Put('invoicing/connection') @Roles('MASTER') save(
    @Param('tenantId') t: string,
    @CurrentUser() u: AuthUser,
    @Body() d: SaveConnectionDto,
  ) {
    return this.connections.save(t, u.userId, d);
  }
  @Post('invoicing/test') @HttpCode(200) @Roles('MASTER') test(
    @Param('tenantId') t: string,
    @Body() d: TestConnectionDto,
  ) {
    return this.connections.test(t, d);
  }
  @Get('invoicing/options') @Roles('MASTER') options(@Param('tenantId') t: string) {
    return this.connections.options(t);
  }
  @Put('branches/:branchId/emission-point') @Roles('MASTER') point(
    @Param('tenantId') t: string,
    @Param('branchId') b: string,
    @CurrentUser() u: AuthUser,
    @Body() d: EmissionPointDto,
  ) {
    return this.connections.setPoint(t, u.userId, b, d);
  }
  @Post('orders/:id/invoice-requests')
  @HttpCode(202)
  @Roles('MASTER')
  @RequirePermission('billing.create')
  create(
    @Param('tenantId') t: string,
    @Param('id') id: string,
    @CurrentUser() u: AuthUser,
    @Headers('idempotency-key') key: string,
  ) {
    return this.requests.create(t, u.userId, id, key);
  }
  @Get('invoice-requests')
  @Throttle({ default: { limit: 120, ttl: 60000 } })
  @Roles('MASTER')
  @RequirePermission('billing.view')
  list(@Param('tenantId') t: string, @Query() q: ListInvoiceRequestsQuery) {
    return this.requests.list(t, q);
  }
  @Get('invoice-requests/:id')
  @Throttle({ default: { limit: 120, ttl: 60000 } })
  @Roles('MASTER')
  @RequirePermission('billing.view')
  get(@Param('tenantId') t: string, @Param('id') id: string) {
    return this.requests.get(t, id);
  }
  @Get('invoice-requests/:id/xml') @Roles('MASTER') @RequirePermission('billing.view') async xml(
    @Param('tenantId') t: string,
    @Param('id') id: string,
    @CurrentUser() u: AuthUser,
    @Res() res: Response,
  ) {
    return this.download(t, u.userId, id, 'xml', res);
  }
  @Get('invoice-requests/:id/ride') @Roles('MASTER') @RequirePermission('billing.view') async ride(
    @Param('tenantId') t: string,
    @Param('id') id: string,
    @CurrentUser() u: AuthUser,
    @Res() res: Response,
  ) {
    return this.download(t, u.userId, id, 'ride', res);
  }
  private async download(t: string, u: string, id: string, kind: 'xml' | 'ride', res: Response) {
    const f = await this.artifacts.read(t, u, id, kind);
    res
      .set({
        'Content-Type': f.contentType,
        'Content-Disposition': `attachment; filename="${f.filename}"`,
        ETag: `"${f.sha256}"`,
        'Cache-Control': 'private, no-store',
      })
      .send(f.bytes);
  }
}
@Controller('integrations/emite-facil')
export class InvoicingWebhookController {
  constructor(private readonly service: InvoiceWebhookService) {}
  @Public()
  @Post('webhook/:connectionId')
  @HttpCode(204)
  @Throttle({ default: { limit: 300, ttl: 60000 } })
  receive(@Param('connectionId') id: string, @Req() req: RawBodyRequest<Request>) {
    return this.service.receive(id, req.rawBody!, req.headers);
  }
}
