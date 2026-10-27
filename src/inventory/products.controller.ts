import { Body, Controller, Get, Param, Patch, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { AuthUser, CurrentUser } from '../common/decorators/current-user.decorator';
import { RequireSection } from '../common/decorators/require-section.decorator';
import { Roles } from '../common/decorators/roles.decorator';
import { RequirePermission } from '../common/permissions/permission-catalog';
import {
  CreateProductDto,
  ListProductsQuery,
  ProductLotsQuery,
  ProductsForSaleQuery,
  SetProductActiveDto,
  UpdateProductDto,
} from './dto/product.dto';
import { ProductsService } from './products.service';

@ApiTags('inventory')
@ApiBearerAuth('access-token')
@RequireSection('core.billing.inventory')
@Controller('tenants/:tenantId/products')
export class ProductsController {
  constructor(private readonly service: ProductsService) {}

  // Declared before `:id` so `for-sale` is not read as an id.
  @Get('for-sale')
  @Roles('MASTER')
  @RequirePermission('billing.create')
  @ApiOperation({
    summary: 'Active products the cash register can add, with the stock of one branch',
    description: 'At most 20. Never includes cost.',
  })
  forSale(@Param('tenantId') tenantId: string, @Query() query: ProductsForSaleQuery) {
    return this.service.listForSale(tenantId, query);
  }

  @Get()
  @Roles('MASTER')
  @RequirePermission('inventory.manage')
  @ApiOperation({ summary: 'Product catalog with the available stock per branch' })
  list(@Param('tenantId') tenantId: string, @Query() query: ListProductsQuery) {
    return this.service.list(tenantId, query);
  }

  @Post()
  @Roles('MASTER')
  @RequirePermission('inventory.manage')
  @ApiOperation({
    summary: 'Create a product',
    description: '409 PRODUCT_CODE_TAKEN, PRODUCT_NAME_TAKEN, PRODUCT_BARCODE_TAKEN.',
  })
  create(
    @Param('tenantId') tenantId: string,
    @CurrentUser() user: AuthUser,
    @Body() dto: CreateProductDto,
  ) {
    return this.service.create(tenantId, user.userId, dto);
  }

  @Get(':id')
  @Roles('MASTER')
  @RequirePermission('inventory.manage')
  @ApiOperation({ summary: 'A product with its lots and costs' })
  get(@Param('tenantId') tenantId: string, @Param('id') id: string) {
    return this.service.get(tenantId, id);
  }

  @Get(':id/lots')
  @Roles('MASTER')
  @RequirePermission('inventory.manage')
  @ApiOperation({ summary: 'Lots of a product with stock, optionally of one branch' })
  lots(
    @Param('tenantId') tenantId: string,
    @Param('id') id: string,
    @Query() query: ProductLotsQuery,
  ) {
    return this.service.lots(tenantId, id, query.branchId);
  }

  @Patch(':id')
  @Roles('MASTER')
  @RequirePermission('inventory.manage')
  @ApiOperation({
    summary: 'Edit a product',
    description:
      '409 PRODUCT_CODE_TAKEN, PRODUCT_NAME_TAKEN, PRODUCT_BARCODE_TAKEN, PRODUCT_HAS_STOCK (tracksExpiry with lots).',
  })
  update(
    @Param('tenantId') tenantId: string,
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
    @Body() dto: UpdateProductDto,
  ) {
    return this.service.update(tenantId, user.userId, id, dto);
  }

  @Patch(':id/active')
  @Roles('MASTER')
  @RequirePermission('inventory.manage')
  @ApiOperation({ summary: 'Activate or deactivate a product' })
  setActive(
    @Param('tenantId') tenantId: string,
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
    @Body() dto: SetProductActiveDto,
  ) {
    return this.service.setActive(tenantId, user.userId, id, dto);
  }
}
