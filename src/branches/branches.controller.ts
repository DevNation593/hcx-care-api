import { Body, Controller, Get, Param, Patch, Post, Put } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Roles } from '../common/decorators/roles.decorator';
import { RequireSection } from '../common/decorators/require-section.decorator';
import { BranchesService } from './branches.service';
import { CreateBranchDto, SetBranchProfessionalsDto, UpdateBranchDto } from './dto/branch.dto';

@ApiTags('branches')
@ApiBearerAuth('access-token')
@Controller('tenants/:tenantId/branches')
export class BranchesController {
  constructor(private readonly branchesService: BranchesService) {}

  @Get()
  @Roles('MASTER', 'ASISTENTE', 'PROFESIONAL', 'CAJERO')
  @ApiOperation({ summary: 'List the branches of the clinic, the main one first' })
  list(@Param('tenantId') tenantId: string) {
    return this.branchesService.list(tenantId);
  }

  @Post()
  @RequireSection('core.admin.branches')
  @Roles('MASTER')
  @ApiOperation({
    summary: 'Create a branch',
    description: 'A PERSONAL tenant has a single branch (409 BRANCH_LIMIT_REACHED).',
  })
  create(@Param('tenantId') tenantId: string, @Body() dto: CreateBranchDto) {
    return this.branchesService.create(tenantId, dto);
  }

  @Patch(':branchId')
  @RequireSection('core.admin.branches')
  @Roles('MASTER')
  @ApiOperation({
    summary: 'Update, activate or deactivate a branch, or make it the main one',
    description: 'Branches are never deleted: their appointments and encounters refer to them.',
  })
  update(
    @Param('tenantId') tenantId: string,
    @Param('branchId') branchId: string,
    @Body() dto: UpdateBranchDto,
  ) {
    return this.branchesService.update(tenantId, branchId, dto);
  }

  @Put(':branchId/professionals')
  @RequireSection('core.admin.branches')
  @Roles('MASTER')
  @ApiOperation({
    summary: 'Set the professionals who attend in a branch',
    description:
      'A professional tied to no branch attends in all of them. Tied to some, their appointments are booked only there (409 PROFESSIONAL_NOT_IN_BRANCH).',
  })
  setProfessionals(
    @Param('tenantId') tenantId: string,
    @Param('branchId') branchId: string,
    @Body() dto: SetBranchProfessionalsDto,
  ) {
    return this.branchesService.setProfessionals(tenantId, branchId, dto.userIds);
  }
}
