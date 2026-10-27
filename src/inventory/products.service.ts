import { Injectable } from '@nestjs/common';
import { Prisma, Product } from '@prisma/client';
import { recordBillingAudit } from '../common/audit/billing-audit';
import { PrismaService } from '../prisma/prisma.service';
import { isCodeUsedByTreatment, normalizeCatalogCode } from './catalog-codes';
import { clinicToday } from './clinic-today';
import {
  CreateProductDto,
  ListProductsQuery,
  ProductsForSaleQuery,
  SetProductActiveDto,
  UpdateProductDto,
} from './dto/product.dto';
import { taxRateUnsupported } from '../orders/orders.service';
import { SUPPORTED_FREE_TAX_RATES } from '../orders/order-totals';
import { isLotExpired } from './fefo';
import {
  productBarcodeTaken,
  productCodeTaken,
  productHasStock,
  productNameTaken,
  productNotFound,
} from './inventory-errors';

const DEFAULT_PAGE_SIZE = 20;
const FOR_SALE_LIMIT = 20;

type ProductDb = PrismaService | Prisma.TransactionClient;

export interface ProductBranchStock {
  branchId: string;
  branchName: string;
  available: number;
  belowMin: boolean;
}

export interface ProductSummary {
  id: string;
  code: string;
  name: string;
  category: string | null;
  barcode: string | null;
  price: string;
  taxRatePercent: number;
  tracksExpiry: boolean;
  minStock: number;
  isActive: boolean;
  createdAt: Date;
  updatedAt: Date;
  stock: ProductBranchStock[];
}

export interface ProductLotView {
  id: string;
  branchId: string;
  lotNumber: string | null;
  expiresAt: Date | null;
  unitCost: string;
  quantityReceived: number;
  quantityOnHand: number;
  receivedAt: Date;
  expired: boolean;
}

export interface ProductDetail extends ProductSummary {
  lots: ProductLotView[];
}

/** What the cash register sees: never the cost. */
export interface ProductForSale {
  id: string;
  code: string;
  name: string;
  barcode: string | null;
  price: string;
  taxRatePercent: number;
  available: number;
}

/**
 * Which unique of a product was hit, from the error target only: the message carries the
 * failed query's source, which names fields that have nothing to do with the violation. The
 * target is a list of fields or, for the raw barcode index, an index or constraint name.
 * "barcode" contains "code", so it is tested first.
 */
function takenError(error: unknown): Error | null {
  const meta = (error as { meta?: { target?: unknown; constraint?: unknown } }).meta;
  const parts = [meta?.target, meta?.constraint].flatMap((value) =>
    Array.isArray(value) ? value : value == null ? [] : [value],
  );
  const text = parts.map(String).join(' ');
  if (/barcode/i.test(text)) return productBarcodeTaken();
  if (/code/i.test(text)) return productCodeTaken();
  if (/name/i.test(text)) return productNameTaken();
  return null;
}

const isUniqueViolation = (error: unknown) =>
  (error as Prisma.PrismaClientKnownRequestError)?.code === 'P2002';

@Injectable()
export class ProductsService {
  constructor(private readonly prisma: PrismaService) {}

  async listForSale(tenantId: string, query: ProductsForSaleQuery): Promise<ProductForSale[]> {
    const barcode = query.barcode?.trim();
    const search = query.search?.trim();
    const where: Prisma.ProductWhereInput = { tenantId, isActive: true };
    if (barcode) {
      where.barcode = barcode;
    } else if (search) {
      const text = { contains: search, mode: 'insensitive' as const };
      where.OR = [{ name: text }, { code: text }];
    }

    const products = await this.prisma.product.findMany({
      where,
      orderBy: { name: 'asc' },
      take: FOR_SALE_LIMIT,
    });
    if (products.length === 0) return [];

    const today = await clinicToday(this.prisma, tenantId);
    const lots = await this.prisma.stockLot.findMany({
      where: {
        tenantId,
        branchId: query.branchId,
        productId: { in: products.map((product) => product.id) },
        quantityOnHand: { gt: 0 },
      },
      select: { productId: true, quantityOnHand: true, expiresAt: true },
    });

    return products.map((product) => ({
      id: product.id,
      code: product.code,
      name: product.name,
      barcode: product.barcode,
      price: product.price.toFixed(2),
      taxRatePercent: Number(product.taxRatePercent),
      available: lots
        .filter((lot) => lot.productId === product.id && !isLotExpired(lot.expiresAt, today))
        .reduce((sum, lot) => sum + lot.quantityOnHand, 0),
    }));
  }

  async list(tenantId: string, query: ListProductsQuery) {
    const page = query.page ?? 1;
    const pageSize = query.pageSize ?? DEFAULT_PAGE_SIZE;
    const where: Prisma.ProductWhereInput = {
      tenantId,
      ...(query.active !== undefined ? { isActive: query.active } : {}),
    };
    if (query.search) {
      const text = { contains: query.search, mode: 'insensitive' as const };
      where.OR = [{ name: text }, { code: text }, { barcode: text }];
    }

    const [products, total] = await Promise.all([
      this.prisma.product.findMany({
        where,
        orderBy: { name: 'asc' },
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
      this.prisma.product.count({ where }),
    ]);
    const stock = await this.stockByProduct(this.prisma, tenantId, products);
    return {
      items: products.map((product) => toSummary(product, stock.get(product.id) ?? [])),
      total,
      page,
      pageSize,
    };
  }

  async get(tenantId: string, id: string): Promise<ProductDetail> {
    return this.detail(this.prisma, tenantId, id);
  }

  /** The lots of a product, optionally of one branch. */
  async lots(tenantId: string, id: string, branchId?: string): Promise<ProductLotView[]> {
    const { lots } = await this.detail(this.prisma, tenantId, id, branchId);
    return lots;
  }

  async create(tenantId: string, userId: string, dto: CreateProductDto): Promise<ProductDetail> {
    try {
      return await this.transaction(async (tx) => {
        assertTaxRate(dto.taxRatePercent);
        const code = normalizeCatalogCode(dto.code);
        if (await isCodeUsedByTreatment(tx, tenantId, code)) throw productCodeTaken();

        const created = await tx.product.create({
          data: {
            tenantId,
            code,
            name: dto.name.trim(),
            category: dto.category?.trim() || null,
            barcode: dto.barcode?.trim() || null,
            price: new Prisma.Decimal(dto.price).toFixed(2),
            taxRatePercent: dto.taxRatePercent,
            tracksExpiry: dto.tracksExpiry,
            minStock: dto.minStock ?? 0,
            createdById: userId,
          },
        });
        await recordBillingAudit(tx, {
          tenantId,
          actorId: userId,
          action: 'CREATE',
          entity: 'PRODUCT',
          entityId: created.id,
          changes: { code: created.code, name: created.name },
        });
        return this.detail(tx, tenantId, created.id);
      });
    } catch (error) {
      throw mapUnique(error);
    }
  }

  async update(
    tenantId: string,
    userId: string,
    id: string,
    dto: UpdateProductDto,
  ): Promise<ProductDetail> {
    try {
      return await this.transaction(async (tx) => {
        const product = await this.findOwn(tx, tenantId, id);
        if (dto.taxRatePercent !== undefined) assertTaxRate(dto.taxRatePercent);

        if (dto.tracksExpiry !== undefined && dto.tracksExpiry !== product.tracksExpiry) {
          if ((await tx.stockLot.count({ where: { tenantId, productId: id } })) > 0) {
            throw productHasStock();
          }
        }

        const data: Prisma.ProductUncheckedUpdateInput = {};
        if (dto.code !== undefined) {
          const code = normalizeCatalogCode(dto.code);
          if (await isCodeUsedByTreatment(tx, tenantId, code)) throw productCodeTaken();
          data.code = code;
        }
        if (dto.name !== undefined) data.name = dto.name.trim();
        if (dto.category !== undefined) data.category = dto.category?.trim() || null;
        if (dto.barcode !== undefined) data.barcode = dto.barcode?.trim() || null;
        if (dto.price !== undefined) data.price = new Prisma.Decimal(dto.price).toFixed(2);
        if (dto.taxRatePercent !== undefined) data.taxRatePercent = dto.taxRatePercent;
        if (dto.tracksExpiry !== undefined) data.tracksExpiry = dto.tracksExpiry;
        if (dto.minStock !== undefined) data.minStock = dto.minStock;

        await tx.product.update({ where: { id }, data });
        await recordBillingAudit(tx, {
          tenantId,
          actorId: userId,
          action: 'UPDATE',
          entity: 'PRODUCT',
          entityId: id,
          changes: data,
        });
        return this.detail(tx, tenantId, id);
      });
    } catch (error) {
      throw mapUnique(error);
    }
  }

  async setActive(
    tenantId: string,
    userId: string,
    id: string,
    dto: SetProductActiveDto,
  ): Promise<ProductDetail> {
    return this.transaction(async (tx) => {
      await this.findOwn(tx, tenantId, id);
      await tx.product.update({ where: { id }, data: { isActive: dto.isActive } });
      await recordBillingAudit(tx, {
        tenantId,
        actorId: userId,
        action: 'UPDATE',
        entity: 'PRODUCT',
        entityId: id,
        changes: { isActive: dto.isActive },
      });
      return this.detail(tx, tenantId, id);
    });
  }

  private async findOwn(db: ProductDb, tenantId: string, id: string): Promise<Product> {
    const product = await db.product.findFirst({ where: { id, tenantId } });
    if (!product) throw productNotFound();
    return product;
  }

  private async detail(
    db: ProductDb,
    tenantId: string,
    id: string,
    branchId?: string,
  ): Promise<ProductDetail> {
    const product = await this.findOwn(db, tenantId, id);
    const stock = await this.stockByProduct(db, tenantId, [product]);
    const today = await clinicToday(db, tenantId);
    // Lots with stock left, expired ones included so the owner can write them off.
    const lots = await db.stockLot.findMany({
      where: {
        tenantId,
        productId: id,
        quantityOnHand: { gt: 0 },
        ...(branchId ? { branchId } : {}),
      },
      orderBy: [{ expiresAt: { sort: 'asc', nulls: 'last' } }, { receivedAt: 'asc' }],
    });
    return {
      ...toSummary(product, stock.get(id) ?? []),
      lots: lots.map((lot) => ({
        id: lot.id,
        branchId: lot.branchId,
        lotNumber: lot.lotNumber,
        expiresAt: lot.expiresAt,
        unitCost: lot.unitCost.toFixed(2),
        quantityReceived: lot.quantityReceived,
        quantityOnHand: lot.quantityOnHand,
        receivedAt: lot.receivedAt,
        expired: isLotExpired(lot.expiresAt, today),
      })),
    };
  }

  /** Available (unexpired) units per branch for each product; every active branch is listed. */
  private async stockByProduct(
    db: ProductDb,
    tenantId: string,
    products: Product[],
  ): Promise<Map<string, ProductBranchStock[]>> {
    const result = new Map<string, ProductBranchStock[]>();
    if (products.length === 0) return result;

    const today = await clinicToday(db, tenantId);
    const [branches, lots] = await Promise.all([
      db.branch.findMany({
        where: { tenantId, isActive: true },
        select: { id: true, name: true },
        orderBy: { name: 'asc' },
      }),
      db.stockLot.findMany({
        where: {
          tenantId,
          productId: { in: products.map((product) => product.id) },
          quantityOnHand: { gt: 0 },
        },
        select: { productId: true, branchId: true, quantityOnHand: true, expiresAt: true },
      }),
    ]);

    for (const product of products) {
      result.set(
        product.id,
        branches.map((branch) => {
          const available = lots
            .filter(
              (lot) =>
                lot.productId === product.id &&
                lot.branchId === branch.id &&
                !isLotExpired(lot.expiresAt, today),
            )
            .reduce((sum, lot) => sum + lot.quantityOnHand, 0);
          return {
            branchId: branch.id,
            branchName: branch.name,
            available,
            belowMin: product.minStock > 0 && available < product.minStock,
          };
        }),
      );
    }
    return result;
  }

  private transaction<T>(callback: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T> {
    return this.prisma.$transaction(async (tx) => {
      await this.prisma.applyRlsContext(tx);
      return callback(tx);
    });
  }
}

function assertTaxRate(rate: number): void {
  if (!SUPPORTED_FREE_TAX_RATES.includes(rate)) throw taxRateUnsupported();
}

function mapUnique(error: unknown): unknown {
  return (isUniqueViolation(error) && takenError(error)) || error;
}

function toSummary(product: Product, stock: ProductBranchStock[]): ProductSummary {
  return {
    id: product.id,
    code: product.code,
    name: product.name,
    category: product.category,
    barcode: product.barcode,
    price: product.price.toFixed(2),
    taxRatePercent: Number(product.taxRatePercent),
    tracksExpiry: product.tracksExpiry,
    minStock: product.minStock,
    isActive: product.isActive,
    createdAt: product.createdAt,
    updatedAt: product.updatedAt,
    stock,
  };
}
