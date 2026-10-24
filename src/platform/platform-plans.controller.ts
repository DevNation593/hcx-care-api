import { Body, Controller, Get, HttpCode, Param, Patch, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { AuthUser, CurrentUser } from '../common/decorators/current-user.decorator';
import { PlatformRoute } from '../common/decorators/platform-route.decorator';
import { Roles } from '../common/decorators/roles.decorator';
import { CreatePlanDto, UpdatePlanDto } from '../plans/dto/plan.dto';
import { PlatformPlansService } from './platform-plans.service';

@ApiTags('platform')
@ApiBearerAuth('access-token')
@PlatformRoute()
@Roles('ADMIN')
@Controller('platform/plans')
export class PlatformPlansController {
  constructor(private readonly plans: PlatformPlansService) {}

  @Get()
  @ApiOperation({ summary: 'Every plan, archived ones included, with how many clinics use it' })
  list() {
    return this.plans.list();
  }

  @Get(':planId')
  findOne(@Param('planId') planId: string) {
    return this.plans.findOne(planId);
  }

  @Post()
  @ApiOperation({ summary: 'Create a plan (409 PLAN_CODE_TAKEN)' })
  create(@Body() dto: CreatePlanDto, @CurrentUser() user: AuthUser) {
    return this.plans.create(dto, user);
  }

  @Patch(':planId')
  @ApiOperation({
    summary: 'Edit a plan',
    description:
      'Every clinic on the plan takes the new price, limits and modules at once, except the values overridden for it. 409 PLAN_IN_USE when changing the type of a plan with clinics.',
  })
  update(
    @Param('planId') planId: string,
    @Body() dto: UpdatePlanDto,
    @CurrentUser() user: AuthUser,
  ) {
    return this.plans.update(planId, dto, user);
  }

  @Post(':planId/archive')
  @HttpCode(200)
  @ApiOperation({ summary: 'Stop offering a plan; its clinics keep it' })
  archive(@Param('planId') planId: string, @CurrentUser() user: AuthUser) {
    return this.plans.setArchived(planId, true, user);
  }

  @Post(':planId/restore')
  @HttpCode(200)
  @ApiOperation({ summary: 'Offer an archived plan again' })
  restore(@Param('planId') planId: string, @CurrentUser() user: AuthUser) {
    return this.plans.setArchived(planId, false, user);
  }
}
