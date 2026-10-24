import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Post,
  StreamableFile,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { ApiBearerAuth, ApiConsumes, ApiOperation, ApiTags } from '@nestjs/swagger';
import { ClinicalActor, CurrentClinicalActor } from '../clinical-access/clinical-actor';
import { ClinicalProfileGuard } from '../clinical-access/clinical-profile.guard';
import { AuthUser, CurrentUser } from '../common/decorators/current-user.decorator';
import { RequireFeature } from '../common/decorators/require-feature.decorator';
import { RequireSection } from '../common/decorators/require-section.decorator';
import { Roles } from '../common/decorators/roles.decorator';
import { RequirePermission } from '../common/permissions/permission-catalog';
import { DeletePatientFileDto, UploadPatientFileDto } from './dto/patient-file.dto';
import {
  MAX_PATIENT_FILE_BYTES,
  PatientFilesService,
  UploadedFilePart,
} from './patient-files.service';

@ApiTags('patient-files')
@ApiBearerAuth('access-token')
@RequireSection('core.patients.files')
@UseGuards(ClinicalProfileGuard)
@Controller('tenants/:tenantId/patients/:patientId/files')
export class PatientFilesController {
  constructor(private readonly filesService: PatientFilesService) {}

  @Get()
  @Roles('MASTER', 'PROFESIONAL')
  @RequirePermission('clinical_records.view')
  @ApiOperation({
    summary: 'Clinical files of the patient',
    description: 'Requires an active professional profile. Every file listed is audited.',
  })
  list(
    @Param('tenantId') tenantId: string,
    @Param('patientId') patientId: string,
    @CurrentClinicalActor() actor: ClinicalActor,
  ) {
    return this.filesService.list(tenantId, patientId, actor);
  }

  @Post()
  @Roles('MASTER', 'PROFESIONAL')
  @RequireFeature('attachments')
  @RequirePermission('clinical_records.create')
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: MAX_PATIENT_FILE_BYTES } }))
  @ApiConsumes('multipart/form-data')
  @ApiOperation({
    summary: 'Upload a clinical file (PDF, JPG or PNG, up to 10 MB)',
    description:
      'The file is stored encrypted and counted against the storage of the plan (413 STORAGE_LIMIT_REACHED).',
  })
  upload(
    @Param('tenantId') tenantId: string,
    @Param('patientId') patientId: string,
    @CurrentClinicalActor() actor: ClinicalActor,
    @UploadedFile() file: UploadedFilePart | undefined,
    @Body() dto: UploadPatientFileDto,
  ) {
    return this.filesService.upload(tenantId, patientId, actor, file, dto);
  }

  @Get(':fileId/download')
  @Roles('MASTER', 'PROFESIONAL')
  @RequirePermission('clinical_records.view')
  @ApiOperation({ summary: 'Download a clinical file', description: 'The download is audited.' })
  async download(
    @Param('tenantId') tenantId: string,
    @Param('patientId') patientId: string,
    @Param('fileId') fileId: string,
    @CurrentClinicalActor() actor: ClinicalActor,
  ) {
    const file = await this.filesService.download(tenantId, patientId, fileId, actor);
    return new StreamableFile(file.data, {
      type: file.mimeType,
      // RFC 5987: the name may carry accents; quotes and control characters never reach the header.
      disposition: `attachment; filename*=UTF-8''${encodeURIComponent(file.fileName)}`,
      length: file.data.length,
    });
  }

  @Delete(':fileId')
  @Roles('MASTER', 'PROFESIONAL')
  @RequirePermission('clinical_records.update')
  @ApiOperation({
    summary: 'Remove a clinical file - Uploader only',
    description: 'Soft delete: requires a reason and keeps the file for audit.',
  })
  remove(
    @Param('tenantId') tenantId: string,
    @Param('patientId') patientId: string,
    @Param('fileId') fileId: string,
    @CurrentClinicalActor() actor: ClinicalActor,
    @Body() dto: DeletePatientFileDto,
  ) {
    return this.filesService.delete(tenantId, patientId, fileId, actor, dto);
  }
}

@ApiTags('storage')
@ApiBearerAuth('access-token')
@RequireSection('core.patients.files')
@Controller('tenants/:tenantId/storage')
export class StorageController {
  constructor(private readonly filesService: PatientFilesService) {}

  @Get('breakdown')
  @Roles('MASTER')
  @ApiOperation({ summary: 'Storage used by the clinic, in bytes' })
  breakdown(@Param('tenantId') tenantId: string) {
    return this.filesService.usage(tenantId);
  }

  @Get('files')
  @Roles('MASTER')
  @ApiOperation({
    summary: 'Files stored by the clinic',
    description:
      'Size, type, patient and uploader. File names are masked for an account without an active professional profile.',
  })
  files(@Param('tenantId') tenantId: string, @CurrentUser() user: AuthUser) {
    return this.filesService.listForAccount(tenantId, user.userId);
  }
}
