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
  Res,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { Response } from 'express';
import { Throttle } from '@nestjs/throttler';
import { CurrentUser, AuthUser } from '../common/decorators/current-user.decorator';
import { Roles } from '../common/decorators/roles.decorator';
import { RequireSection } from '../common/decorators/require-section.decorator';
import { RequirePermission } from '../common/permissions/permission-catalog';
import { ConnectionService } from './connection.service';
import { InvoiceRequestsService } from './invoice-requests.service';
import { InvoiceArtifactsService } from './invoice-artifacts.service';
import { IssuerService } from './issuer.service';
import { InvoiceWorkerService } from './invoice-worker.service';
import {
  ListInvoiceRequestsQuery,
  SaveConnectionDto,
  TestConnectionDto,
} from './dto/invoicing.dto';
import { IssuerCertificateDto, IssuerEmissionPointDto, SaveIssuerDto } from './dto/issuer.dto';
@Controller('tenants/:tenantId')
@RequireSection('core.billing.invoicing')
export class InvoicingController {
  constructor(
    private readonly connections: ConnectionService,
    private readonly issuer: IssuerService,
    private readonly requests: InvoiceRequestsService,
    private readonly artifacts: InvoiceArtifactsService,
    private readonly worker: InvoiceWorkerService,
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
  @Get('invoicing/issuer') @Roles('MASTER') getIssuer(@Param('tenantId') t: string) {
    return this.issuer.get(t);
  }
  @Put('invoicing/issuer') @Roles('MASTER') saveIssuer(
    @Param('tenantId') t: string,
    @CurrentUser() u: AuthUser,
    @Body() d: SaveIssuerDto,
  ) {
    return this.issuer.save(t, u.userId, d);
  }
  @Put('invoicing/issuer/certificate')
  @Roles('MASTER')
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: 50 * 1024 } }))
  saveCertificate(
    @Param('tenantId') t: string,
    @CurrentUser() u: AuthUser,
    @UploadedFile() file: { buffer: Buffer } | undefined,
    @Body() d: IssuerCertificateDto,
  ) {
    return this.issuer.saveCertificate(t, u.userId, file?.buffer ?? Buffer.alloc(0), d.password);
  }
  // Moves to invoicing/test when the Emite Fácil connection is removed.
  @Post('invoicing/issuer/test') @HttpCode(200) @Roles('MASTER') testIssuer(
    @Param('tenantId') t: string,
  ) {
    return this.issuer.test(t);
  }
  @Put('branches/:branchId/emission-point') @Roles('MASTER') point(
    @Param('tenantId') t: string,
    @Param('branchId') b: string,
    @CurrentUser() u: AuthUser,
    @Body() d: IssuerEmissionPointDto,
  ) {
    return this.issuer.setPoint(t, u.userId, b, d);
  }
  @Post('orders/:id/invoice-requests')
  @HttpCode(202)
  @Roles('MASTER')
  @RequirePermission('billing.create')
  async create(
    @Param('tenantId') t: string,
    @Param('id') id: string,
    @CurrentUser() u: AuthUser,
    @Headers('idempotency-key') key: string,
  ) {
    const r = await this.requests.create(t, u.userId, id, key);
    try {
      await this.worker.processOne(r.id, 15000);
    } catch {
      // The request exists already: the tick resumes it, so the inline attempt never fails the call.
    }
    return this.requests.view(t, r.id);
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
