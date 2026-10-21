import {
  BadRequestException,
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  Patch,
  Post,
  Put,
  Query,
} from '@nestjs/common';
import { TenantBusinessKind } from '@prisma/client';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { ArrayMaxSize, IsArray, IsString } from 'class-validator';
import { AuthUser, CurrentUser } from '../common/decorators/current-user.decorator';
import { PlatformRoute } from '../common/decorators/platform-route.decorator';
import { Roles } from '../common/decorators/roles.decorator';
import { ChangePlanDto } from './dto/change-plan.dto';
import { CreatePlatformTenantDto } from './dto/create-platform-tenant.dto';
import {
  ListPlatformTenantsQueryDto,
  ResetMasterPasswordDto,
  SetPlatformTenantSectionsDto,
  SuspendPlatformTenantDto,
  UpdatePlatformTenantDto,
} from './dto/platform-tenant.dto';
import { PlatformSubscriptionService } from './platform-subscription.service';
import { PlatformRolePermissionsService } from './platform-role-permissions.service';
import { PlatformTenantsService } from './platform-tenants.service';
import { TenantSpecialtiesService } from '../specialties/tenant-specialties.service';
import { UpdateTenantSpecialtiesDto } from '../specialties/dto/update-specialties.dto';
import { UpdateModuleDto } from '../specialties/dto/update-module.dto';
import { SpecialtyCatalogService } from '../specialties/specialty-catalog.service';

class SetClinicRolePermissionsDto {
  @IsArray()
  @ArrayMaxSize(100)
  @IsString({ each: true })
  allowed: string[];
}

@ApiTags('platform')
@ApiBearerAuth('access-token')
@PlatformRoute()
@Roles('ADMIN')
@Controller('platform')
export class PlatformTenantsController {
  constructor(
    private readonly tenants: PlatformTenantsService,
    private readonly subscriptions: PlatformSubscriptionService,
    private readonly rolePermissions: PlatformRolePermissionsService,
    private readonly clinicModules: TenantSpecialtiesService,
    private readonly specialtyCatalog: SpecialtyCatalogService,
  ) {}

  @Post('tenants')
  create(@Body() dto: CreatePlatformTenantDto, @CurrentUser() user: AuthUser) {
    return this.tenants.create(dto, user.userId);
  }

  @Get('tenants')
  list(@Query() query: ListPlatformTenantsQueryDto) {
    return this.tenants.list(query);
  }

  @Get('tenants/:tenantId')
  findOne(@Param('tenantId') tenantId: string) {
    return this.tenants.findOne(tenantId);
  }

  @Patch('tenants/:tenantId')
  update(
    @Param('tenantId') tenantId: string,
    @Body() dto: UpdatePlatformTenantDto,
    @CurrentUser() user: AuthUser,
  ) {
    return this.tenants.updateAccount(tenantId, dto, user.userId);
  }

  @Patch('tenants/:tenantId/subscription')
  changePlan(
    @Param('tenantId') tenantId: string,
    @Body() dto: ChangePlanDto,
    @CurrentUser() user: AuthUser,
  ) {
    return this.subscriptions.changePlan(tenantId, dto, user.userId);
  }

  @Post('tenants/:tenantId/suspend')
  @HttpCode(200)
  suspend(
    @Param('tenantId') tenantId: string,
    @Body() dto: SuspendPlatformTenantDto,
    @CurrentUser() user: AuthUser,
  ) {
    return this.tenants.suspend(tenantId, dto.reason, user.userId);
  }

  @Post('tenants/:tenantId/reactivate')
  @HttpCode(200)
  reactivate(@Param('tenantId') tenantId: string, @CurrentUser() user: AuthUser) {
    return this.tenants.reactivate(tenantId, user.userId);
  }

  @Put('tenants/:tenantId/sections')
  setSections(
    @Param('tenantId') tenantId: string,
    @Body() dto: SetPlatformTenantSectionsDto,
    @CurrentUser() user: AuthUser,
  ) {
    return this.tenants.setSections(tenantId, dto.sections, user.userId);
  }

  @Post('tenants/:tenantId/master/reset-password')
  @HttpCode(200)
  async resetMasterPassword(
    @Param('tenantId') tenantId: string,
    @Body() dto: ResetMasterPasswordDto,
    @CurrentUser() user: AuthUser,
  ): Promise<void> {
    await this.tenants.resetMasterPassword(tenantId, dto.temporaryPassword, user.userId);
  }

  @Get('section-catalog')
  getSectionCatalog() {
    return this.tenants.getSectionCatalog();
  }

  @Get('specialty-catalog')
  getSpecialtyCatalog() {
    return this.specialtyCatalog.listActive();
  }

  @Get('tenants/:tenantId/roles/:role/permissions')
  getRolePermissions(@Param('tenantId') tenantId: string, @Param('role') role: string) {
    return this.rolePermissions.describe(tenantId, role);
  }

  @Put('tenants/:tenantId/roles/:role/permissions')
  setRolePermissions(
    @Param('tenantId') tenantId: string,
    @Param('role') role: string,
    @Body() dto: SetClinicRolePermissionsDto,
    @CurrentUser() user: AuthUser,
  ) {
    return this.rolePermissions.replace(tenantId, role, user.userId, dto.allowed);
  }

  @Put('tenants/:tenantId/specialties')
  async setSpecialties(
    @Param('tenantId') tenantId: string,
    @Body() dto: UpdateTenantSpecialtiesDto,
    @CurrentUser() user: AuthUser,
  ) {
    const detail = await this.tenants.findOne(tenantId);
    if (detail.tenant.businessKind === TenantBusinessKind.AESTHETIC_STUDIO) {
      throw new BadRequestException('Un estudio estético no utiliza especialidades médicas.');
    }
    return this.clinicModules.replace(tenantId, dto.specialtyCodes, user.userId);
  }

  @Patch('tenants/:tenantId/modules/:moduleKey')
  async setClinicalModule(
    @Param('tenantId') tenantId: string,
    @Param('moduleKey') moduleKey: string,
    @Body() dto: UpdateModuleDto,
    @CurrentUser() user: AuthUser,
  ) {
    const detail = await this.tenants.findOne(tenantId);
    if (detail.tenant.businessKind === TenantBusinessKind.AESTHETIC_STUDIO) {
      throw new BadRequestException('Un estudio estético no utiliza módulos clínicos.');
    }
    return this.clinicModules.updateModule(tenantId, moduleKey, dto.enabled, user.userId);
  }
}
