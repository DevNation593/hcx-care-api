import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  Headers,
  HttpCode,
  Param,
  ParseIntPipe,
  Patch,
  Post,
  Put,
  Query,
} from '@nestjs/common';
import { ApiBearerAuth, ApiHeader, ApiOperation, ApiTags } from '@nestjs/swagger';
import { AuthUser, CurrentUser } from '../common/decorators/current-user.decorator';
import { RequireSection } from '../common/decorators/require-section.decorator';
import { Roles } from '../common/decorators/roles.decorator';
import { RequirePermission } from '../common/permissions/permission-catalog';
import {
  AddOrderItemDto,
  BillableSessionsQuery,
  CancelOrderDto,
  CreateOrderDto,
  ListOrdersQuery,
  SetOrderBillingProfileDto,
  UpdateOrderItemDto,
} from './dto/order.dto';
import { RecordPaymentDto, RefundPaymentDto } from './dto/payment.dto';
import { OrdersService } from './orders.service';
import { PaymentsService } from './payments.service';

const IDEMPOTENCY_KEY = /^[A-Za-z0-9._:-]{1,100}$/;

@ApiTags('orders')
@ApiBearerAuth('access-token')
@RequireSection('core.billing.orders')
@Controller('tenants/:tenantId/orders')
export class OrdersController {
  constructor(
    private readonly service: OrdersService,
    private readonly payments: PaymentsService,
  ) {}

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

  @Get(':id/billing-eligibility')
  @Roles('MASTER')
  @RequirePermission('billing.view')
  @ApiOperation({
    summary: 'What still stands between the order and its invoice (RN-10)',
    description: 'Computed from server-side facts only. 404 ORDER_NOT_FOUND.',
  })
  eligibility(
    @Param('tenantId') tenantId: string,
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
  ) {
    return this.service.eligibility(tenantId, id, user.userId);
  }

  @Post(':id/items')
  @Roles('MASTER')
  @RequirePermission('billing.create')
  @ApiOperation({
    summary: 'Add a treatment session, a catalog product or a free item',
    description:
      'FREE items and discounts also need billing.adjust. A PRODUCT takes price and tax from the catalog and draws its stock from the order branch (first expired, first out). 403 SECTION_NOT_ENABLED (PRODUCT without core.billing.inventory), 404 PRODUCT_NOT_FOUND, 409 ORDER_NOT_EDITABLE, 409 ORDER_VERSION_CONFLICT, 409 PRODUCT_INACTIVE, 409 INSUFFICIENT_STOCK, 422 ORDER_LINE_INVALID, 422 TAX_RATE_UNSUPPORTED.',
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
  @ApiOperation({
    summary: 'Remove an item; pass the order version as ?version=',
    description:
      'A PRODUCT line returns its units to the lots it came from. 404 ORDER_ITEM_NOT_FOUND, 409 ORDER_NOT_EDITABLE.',
  })
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

  @Post(':id/payments')
  @Roles('MASTER')
  @RequirePermission('billing.create')
  @ApiOperation({
    summary: 'Record a partial or full payment into the open cash register',
    description:
      'Optional Idempotency-Key header (up to 100 chars, [A-Za-z0-9._:-]). 400 IDEMPOTENCY_KEY_INVALID, 409 ORDER_NOT_EDITABLE, 409 CASH_REGISTER_CLOSED, 409 IDEMPOTENCY_KEY_REUSED, 422 PAYMENT_EXCEEDS_BALANCE.',
  })
  @ApiHeader({ name: 'Idempotency-Key', required: false })
  recordPayment(
    @Param('tenantId') tenantId: string,
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
    @Body() dto: RecordPaymentDto,
    @Headers('idempotency-key') idempotencyKey?: string,
  ) {
    if (idempotencyKey !== undefined && !IDEMPOTENCY_KEY.test(idempotencyKey)) {
      throw new BadRequestException({
        statusCode: 400,
        code: 'IDEMPOTENCY_KEY_INVALID',
        message: 'La clave de idempotencia no es válida.',
      });
    }
    return this.payments.record(tenantId, user.userId, id, dto, idempotencyKey);
  }

  @Post(':id/cancel')
  @Roles('MASTER')
  @RequirePermission('billing.create')
  @ApiOperation({
    summary: 'Cancel an order and release its sessions and product stock',
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

/**
 * Lives here, not with the treatment sessions: its route must be matched before
 * `treatment-sessions/:id`, so OrdersModule is registered before TreatmentSessionsModule.
 */
@ApiTags('orders')
@ApiBearerAuth('access-token')
@RequireSection('core.billing.orders')
@Controller('tenants/:tenantId/treatment-sessions')
export class BillableSessionsController {
  constructor(private readonly service: OrdersService) {}

  @Get('billable')
  @Roles('MASTER')
  @RequirePermission('billing.view')
  @ApiOperation({ summary: 'Sessions that can still be added to an order' })
  billable(
    @Param('tenantId') tenantId: string,
    @CurrentUser() user: AuthUser,
    @Query() query: BillableSessionsQuery,
  ) {
    return this.service.billableSessions(tenantId, query, user.userId);
  }
}

@ApiTags('orders')
@ApiBearerAuth('access-token')
@RequireSection('core.billing.orders')
@Controller('tenants/:tenantId/payments')
export class PaymentsController {
  constructor(private readonly payments: PaymentsService) {}

  @Post(':id/refund')
  @HttpCode(200)
  @Roles('MASTER')
  @RequirePermission('billing.adjust')
  @ApiOperation({
    summary: 'Refund a payment before invoicing',
    description: '404 PAYMENT_NOT_FOUND, 409 PAYMENT_NOT_REFUNDABLE, 409 CASH_REGISTER_CLOSED.',
  })
  refund(
    @Param('tenantId') tenantId: string,
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
    @Body() dto: RefundPaymentDto,
  ) {
    return this.payments.refund(tenantId, user.userId, id, dto);
  }
}
