import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { AuthUser, CurrentUser } from '../common/decorators/current-user.decorator';
import { RequireSection } from '../common/decorators/require-section.decorator';
import { Roles } from '../common/decorators/roles.decorator';
import { RequirePermission } from '../common/permissions/permission-catalog';
import { PermissionChecker } from '../common/permissions/permission-checker.service';
import { BillingProfilesService } from './billing-profiles.service';
import {
  BillAsPatientDto,
  CreateBillingProfileDto,
  LinkBillingProfileDto,
  ListBillingProfilesQuery,
  UpdateBillingProfileDto,
} from './dto/billing-profile.dto';

@ApiTags('billing-profiles')
@ApiBearerAuth('access-token')
@RequireSection('core.billing.profiles')
@Controller('tenants/:tenantId')
export class BillingProfilesController {
  constructor(
    private readonly service: BillingProfilesService,
    private readonly permissions: PermissionChecker,
  ) {}

  @Get('billing-profiles')
  @Roles('MASTER')
  @RequirePermission('billing.view')
  @ApiOperation({ summary: 'Search billing profiles by name or identification prefix' })
  list(@Param('tenantId') tenantId: string, @Query() query: ListBillingProfilesQuery) {
    return this.service.list(tenantId, query);
  }

  @Post('billing-profiles')
  @Roles('MASTER')
  @RequirePermission('billing.create')
  @ApiOperation({
    summary: 'Create a billing profile',
    description: '422 BILLING_PROFILE_INVALID, 409 BILLING_PROFILE_DUPLICATE.',
  })
  create(
    @Param('tenantId') tenantId: string,
    @CurrentUser() user: AuthUser,
    @Body() dto: CreateBillingProfileDto,
  ) {
    return this.service.create(tenantId, user.userId, dto);
  }

  @Get('billing-profiles/:id')
  @Roles('MASTER')
  @RequirePermission('billing.view')
  @ApiOperation({ summary: 'A billing profile' })
  get(@Param('tenantId') tenantId: string, @Param('id') id: string) {
    return this.service.get(tenantId, id);
  }

  @Patch('billing-profiles/:id')
  @Roles('MASTER')
  @RequirePermission('billing.create')
  @ApiOperation({
    summary: 'Change name, contact or active state',
    description: 'idType and idNumber never change.',
  })
  update(
    @Param('tenantId') tenantId: string,
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
    @Body() dto: UpdateBillingProfileDto,
  ) {
    return this.service.update(tenantId, user.userId, id, dto);
  }

  @Get('patients/:patientId/billing-profiles')
  @Roles('MASTER')
  @RequirePermission('billing.view')
  @ApiOperation({ summary: 'Billing profiles linked to the patient' })
  listForPatient(@Param('tenantId') tenantId: string, @Param('patientId') patientId: string) {
    return this.service.listForPatient(tenantId, patientId);
  }

  @Post('patients/:patientId/billing-profiles')
  @Roles('MASTER')
  @RequirePermission('billing.create')
  @ApiOperation({
    summary: 'Link a billing profile to the patient',
    description: '409 BILLING_PROFILE_INACTIVE. isDefault replaces the previous default.',
  })
  link(
    @Param('tenantId') tenantId: string,
    @CurrentUser() user: AuthUser,
    @Param('patientId') patientId: string,
    @Body() dto: LinkBillingProfileDto,
  ) {
    return this.service.linkToPatient(tenantId, user.userId, patientId, dto);
  }

  @Post('patients/:patientId/billing-profiles/own')
  @Roles('MASTER')
  @RequirePermission('billing.create')
  @ApiOperation({
    summary: "Bill in the patient's own name, from the patient record",
    description:
      'Creates or reuses the profile with the patient data and links it (default when there is none). ' +
      'Fields the record lacks may be sent; writing them also needs patients.update. ' +
      '422 PATIENT_BILLING_DATA_INCOMPLETE (missing), 409 BILLING_PROFILE_INACTIVE or PATIENT_IDENTIFICATION_TAKEN.',
  })
  async billAsPatient(
    @Param('tenantId') tenantId: string,
    @CurrentUser() user: AuthUser,
    @Param('patientId') patientId: string,
    @Body() dto: BillAsPatientDto,
  ) {
    // Completing the record edits the patient: a role without that permission (the cashier)
    // can only bill a patient whose data is already complete.
    if (Object.values(dto).some((value) => value !== undefined)) {
      await this.permissions.assertAllowed(user, 'patients.update');
    }
    return this.service.billAsPatient(tenantId, user.userId, patientId, dto);
  }

  @Delete('patients/:patientId/billing-profiles/:profileId')
  @HttpCode(204)
  @Roles('MASTER')
  @RequirePermission('billing.create')
  @ApiOperation({ summary: 'Unlink the profile from the patient; the profile remains' })
  unlink(
    @Param('tenantId') tenantId: string,
    @CurrentUser() user: AuthUser,
    @Param('patientId') patientId: string,
    @Param('profileId') profileId: string,
  ) {
    return this.service.unlinkFromPatient(tenantId, user.userId, patientId, profileId);
  }
}
