import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseEnumPipe,
  Patch,
  Post,
  Query,
  StreamableFile,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { ApiBearerAuth, ApiConsumes, ApiTags } from '@nestjs/swagger';
import { AestheticPhotoPhase } from '@prisma/client';
import { AuthUser, CurrentUser } from '../common/decorators/current-user.decorator';
import { RequireSection } from '../common/decorators/require-section.decorator';
import { Roles } from '../common/decorators/roles.decorator';
import { RequirePermission } from '../common/permissions/permission-catalog';
import { UploadedFilePart } from '../patient-files/patient-files.service';
import { AestheticPhotosService } from './aesthetic-photos.service';
import { AestheticsService } from './aesthetics.service';
import {
  CompleteAestheticSessionDto,
  CreateAestheticBookingDto,
  CreateAestheticClientDto,
  CreateAestheticServiceDto,
  CreateAestheticSessionDto,
  ListAestheticBookingsDto,
  RecordAestheticConsentDto,
  UpdateAestheticBookingDto,
  UpdateAestheticClientDto,
  UpdateAestheticServiceDto,
} from './dto/aesthetics.dto';

@ApiTags('aesthetics')
@ApiBearerAuth('access-token')
@RequireSection('core.aesthetics')
@Roles('MASTER', 'PROFESIONAL', 'ASISTENTE')
@Controller('tenants/:tenantId/aesthetics')
export class AestheticsController {
  constructor(
    private readonly aesthetics: AestheticsService,
    private readonly photos: AestheticPhotosService,
  ) {}

  @Get('clients')
  @RequirePermission('aesthetics.view')
  clients(@Param('tenantId') tenantId: string) {
    return this.aesthetics.listClients(tenantId);
  }

  @Post('clients')
  @RequirePermission('aesthetics.clients.manage')
  createClient(@Param('tenantId') tenantId: string, @Body() input: CreateAestheticClientDto) {
    return this.aesthetics.createClient(tenantId, input);
  }

  @Patch('clients/:id')
  @RequirePermission('aesthetics.clients.manage')
  updateClient(
    @Param('tenantId') tenantId: string,
    @Param('id') id: string,
    @Body() input: UpdateAestheticClientDto,
  ) {
    return this.aesthetics.updateClient(tenantId, id, input);
  }

  @Get('services')
  @RequirePermission('aesthetics.view')
  services(@Param('tenantId') tenantId: string) {
    return this.aesthetics.listServices(tenantId);
  }

  @Post('services')
  @RequirePermission('aesthetics.services.manage')
  createService(@Param('tenantId') tenantId: string, @Body() input: CreateAestheticServiceDto) {
    return this.aesthetics.createService(tenantId, input);
  }

  @Patch('services/:id')
  @RequirePermission('aesthetics.services.manage')
  updateService(
    @Param('tenantId') tenantId: string,
    @Param('id') id: string,
    @Body() input: UpdateAestheticServiceDto,
  ) {
    return this.aesthetics.updateService(tenantId, id, input);
  }

  @Get('bookings')
  @RequirePermission('aesthetics.view')
  bookings(@Param('tenantId') tenantId: string, @Query() query: ListAestheticBookingsDto) {
    return this.aesthetics.listBookings(tenantId, query.from, query.to);
  }

  @Post('bookings')
  @RequirePermission('aesthetics.bookings.manage')
  createBooking(
    @Param('tenantId') tenantId: string,
    @Body() input: CreateAestheticBookingDto,
    @CurrentUser() actor: AuthUser,
  ) {
    return this.aesthetics.createBooking(tenantId, input, actor.userId);
  }

  @Patch('bookings/:id')
  @RequirePermission('aesthetics.bookings.manage')
  updateBooking(
    @Param('tenantId') tenantId: string,
    @Param('id') id: string,
    @Body() input: UpdateAestheticBookingDto,
    @CurrentUser() actor: AuthUser,
  ) {
    return this.aesthetics.updateBooking(tenantId, id, input, actor.userId);
  }

  @Get('sessions')
  @RequirePermission('aesthetics.view')
  sessions(@Param('tenantId') tenantId: string, @Query('clientId') clientId?: string) {
    return this.aesthetics.listSessions(tenantId, clientId);
  }

  @Post('sessions')
  @RequirePermission('aesthetics.sessions.manage')
  createSession(
    @Param('tenantId') tenantId: string,
    @Body() input: CreateAestheticSessionDto,
    @CurrentUser() actor: AuthUser,
  ) {
    return this.aesthetics.createSession(tenantId, input, actor.userId);
  }

  @Post('sessions/:id/complete')
  @RequirePermission('aesthetics.sessions.manage')
  completeSession(
    @Param('tenantId') tenantId: string,
    @Param('id') id: string,
    @Body() input: CompleteAestheticSessionDto,
    @CurrentUser() actor: AuthUser,
  ) {
    return this.aesthetics.completeSession(tenantId, id, input, actor.userId);
  }

  @Get('consents')
  @RequirePermission('aesthetics.view')
  consents(@Param('tenantId') tenantId: string) {
    return this.aesthetics.listConsents(tenantId);
  }

  @Post('sessions/:id/consent')
  @RequirePermission('aesthetics.consents.manage')
  recordConsent(
    @Param('tenantId') tenantId: string,
    @Param('id') id: string,
    @Body() input: RecordAestheticConsentDto,
    @CurrentUser() actor: AuthUser,
  ) {
    return this.aesthetics.recordConsent(tenantId, id, input, actor.userId);
  }

  @Get('sessions/:id/photos')
  @RequirePermission('aesthetics.photos.view')
  listPhotos(@Param('tenantId') tenantId: string, @Param('id') id: string) {
    return this.photos.list(tenantId, id);
  }

  @Post('sessions/:id/photos')
  @RequirePermission('aesthetics.photos.manage')
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: 10 * 1024 * 1024 } }))
  @ApiConsumes('multipart/form-data')
  uploadPhoto(
    @Param('tenantId') tenantId: string,
    @Param('id') id: string,
    @Body('phase', new ParseEnumPipe(AestheticPhotoPhase)) phase: AestheticPhotoPhase,
    @UploadedFile() part: UploadedFilePart,
    @CurrentUser() actor: AuthUser,
  ) {
    return this.photos.upload(tenantId, id, phase, part, actor);
  }

  @Get('sessions/:id/photos/:photoId/download')
  @RequirePermission('aesthetics.photos.view')
  async downloadPhoto(
    @Param('tenantId') tenantId: string,
    @Param('id') id: string,
    @Param('photoId') photoId: string,
  ) {
    const photo = await this.photos.download(tenantId, id, photoId);
    return new StreamableFile(photo.data, {
      type: photo.mimeType,
      disposition: `attachment; filename="foto-${photoId}.${photo.mimeType === 'image/png' ? 'png' : 'jpg'}"`,
      length: photo.data.length,
    });
  }

  @Delete('sessions/:id/photos/:photoId')
  @RequirePermission('aesthetics.photos.manage')
  removePhoto(
    @Param('tenantId') tenantId: string,
    @Param('id') id: string,
    @Param('photoId') photoId: string,
  ) {
    return this.photos.remove(tenantId, id, photoId);
  }
}
