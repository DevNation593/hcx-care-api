import { Body, Controller, Get, Param, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { AuthUser, CurrentUser } from '../common/decorators/current-user.decorator';
import { RequireSection } from '../common/decorators/require-section.decorator';
import { Roles } from '../common/decorators/roles.decorator';
import { RequirePermission } from '../common/permissions/permission-catalog';
import { CashRegistersService } from './cash-registers.service';
import {
  CloseCashRegisterDto,
  ListCashRegistersQuery,
  OpenCashRegisterDto,
} from './dto/cash-register.dto';

@ApiTags('cash-registers')
@ApiBearerAuth('access-token')
@RequireSection('core.billing.cash')
@Controller('tenants/:tenantId/cash-registers')
export class CashRegistersController {
  constructor(private readonly service: CashRegistersService) {}

  @Get()
  @Roles('MASTER')
  @RequirePermission('billing.view')
  @ApiOperation({ summary: 'Cash registers, most recent first' })
  list(@Param('tenantId') tenantId: string, @Query() query: ListCashRegistersQuery) {
    return this.service.list(tenantId, query);
  }

  @Post('open')
  @Roles('MASTER')
  @RequirePermission('cash.manage')
  @ApiOperation({
    summary: 'Open the cash register of a branch',
    description: '404 BRANCH_NOT_FOUND, 409 CASH_REGISTER_ALREADY_OPEN.',
  })
  open(
    @Param('tenantId') tenantId: string,
    @CurrentUser() user: AuthUser,
    @Body() dto: OpenCashRegisterDto,
  ) {
    return this.service.open(tenantId, user.userId, dto);
  }

  @Get(':id')
  @Roles('MASTER')
  @RequirePermission('billing.view')
  @ApiOperation({ summary: 'A cash register with its summary by payment method' })
  get(@Param('tenantId') tenantId: string, @Param('id') id: string) {
    return this.service.get(tenantId, id);
  }

  @Post(':id/close')
  @Roles('MASTER')
  @RequirePermission('cash.manage')
  @ApiOperation({
    summary: 'Close the cash register with a cash count',
    description: '409 CASH_REGISTER_CLOSED, 422 CASH_CLOSING_NOTE_REQUIRED.',
  })
  close(
    @Param('tenantId') tenantId: string,
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
    @Body() dto: CloseCashRegisterDto,
  ) {
    return this.service.close(tenantId, user.userId, id, dto);
  }
}
