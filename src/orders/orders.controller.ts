import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseIntPipe,
  Patch,
  Post,
  Put,
  Query,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { AuthUser, CurrentUser } from '../common/decorators/current-user.decorator';
import { RequireSection } from '../common/decorators/require-section.decorator';
import { Roles } from '../common/decorators/roles.decorator';
import { RequirePermission } from '../common/permissions/permission-catalog';
import {
  AddOrderItemDto,
  CancelOrderDto,
  CreateOrderDto,
  ListOrdersQuery,
  SetOrderBillingProfileDto,
  UpdateOrderItemDto,
} from './dto/order.dto';
import { OrdersService } from './orders.service';

@ApiTags('orders')
@ApiBearerAuth('access-token')
@RequireSection('core.billing')
@Controller('tenants/:tenantId/orders')
export class OrdersController {
  constructor(private readonly service: OrdersService) {}

  @Get()
  @Roles('MASTER')
  @RequirePermission('billing.view')
  @ApiOperation({ summary: 'Orders by number, billing profile or patient' })
  list(@Param('tenantId') tenantId: string, @Query() query: ListOrdersQuery) {
    return this.service.list(tenantId, query);
  }

  @Post()
  @Roles('MASTER')
  @RequirePermission('billing.create')
  @ApiOperation({
    summary: 'Create an order, optionally from treatment sessions',
    description:
      '404 TREATMENT_SESSION_NOT_FOUND, 409 TREATMENT_SESSION_NOT_BILLABLE, 409 SESSION_ALREADY_IN_ORDER, 422 ORDER_BRANCH_MISMATCH.',
  })
  create(
    @Param('tenantId') tenantId: string,
    @CurrentUser() user: AuthUser,
    @Body() dto: CreateOrderDto,
  ) {
    return this.service.create(tenantId, user, dto);
  }

  @Get(':id')
  @Roles('MASTER')
  @RequirePermission('billing.view')
  @ApiOperation({ summary: 'An order with its items, payments and totals' })
  get(@Param('tenantId') tenantId: string, @Param('id') id: string) {
    return this.service.get(tenantId, id);
  }

  @Post(':id/items')
  @Roles('MASTER')
  @RequirePermission('billing.create')
  @ApiOperation({
    summary: 'Add a treatment session or a free item',
    description:
      'FREE items and discounts also need billing.adjust. 409 ORDER_NOT_EDITABLE, 409 ORDER_VERSION_CONFLICT, 422 TAX_RATE_UNSUPPORTED.',
  })
  addItem(
    @Param('tenantId') tenantId: string,
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
    @Body() dto: AddOrderItemDto,
  ) {
    return this.service.addItem(tenantId, user, id, dto);
  }

  @Delete(':id/items/:itemId')
  @Roles('MASTER')
  @RequirePermission('billing.create')
  @ApiOperation({ summary: 'Remove an item; pass the order version as ?version=' })
  removeItem(
    @Param('tenantId') tenantId: string,
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
    @Param('itemId') itemId: string,
    @Query('version', ParseIntPipe) version: number,
  ) {
    return this.service.removeItem(tenantId, user.userId, id, itemId, version);
  }

  @Patch(':id/items/:itemId')
  @Roles('MASTER')
  @RequirePermission('billing.adjust')
  @ApiOperation({ summary: 'Change the discount of an item' })
  updateItem(
    @Param('tenantId') tenantId: string,
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
    @Param('itemId') itemId: string,
    @Body() dto: UpdateOrderItemDto,
  ) {
    return this.service.updateItemDiscount(tenantId, user.userId, id, itemId, dto);
  }

  @Put(':id/billing-profile')
  @Roles('MASTER')
  @RequirePermission('billing.create')
  @ApiOperation({
    summary: 'Set who receives the invoice',
    description: '409 BILLING_PROFILE_INACTIVE.',
  })
  setBillingProfile(
    @Param('tenantId') tenantId: string,
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
    @Body() dto: SetOrderBillingProfileDto,
  ) {
    return this.service.setBillingProfile(tenantId, user.userId, id, dto);
  }

  @Post(':id/cancel')
  @Roles('MASTER')
  @RequirePermission('billing.create')
  @ApiOperation({
    summary: 'Cancel an order and release its sessions',
    description: '409 ORDER_HAS_PAYMENTS.',
  })
  cancel(
    @Param('tenantId') tenantId: string,
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
    @Body() dto: CancelOrderDto,
  ) {
    return this.service.cancel(tenantId, user.userId, id, dto);
  }
}
