import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import request from 'supertest';
import { randomUUID } from 'crypto';
import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

const storageRoot = mkdtempSync(join(tmpdir(), 'psic-e2e-inventory-'));
// Read by the storage driver when the application starts.
process.env.STORAGE_LOCAL_PATH = storageRoot;

import { AppModule } from './../src/app.module';
import { PrismaService } from './../src/prisma/prisma.service';
import { PlatformTenantsService } from './../src/platform/platform-tenants.service';
import { ClinicalCryptoService } from './../src/clinical-access/clinical-crypto.service';
import { createTestTenant, TEST_PASSWORD } from './helpers/create-test-tenant';

jest.setTimeout(120000);

/** A calendar date `days` from now, as the receipt form sends it. */
const inDays = (days: number) => new Date(Date.now() + days * 86400000).toISOString().slice(0, 10);

describe('Product inventory: receipt, sale, invoice, cancel, transfer, adjustment (E2E)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let tenantId: string;
  let otherTenantId: string;
  let northId: string;
  let southId: string;
  let otherBranchId: string;
  let billingProfileId: string;
  let productId: string;
  let earlyLotId: string;
  let lateLotId: string;
  const tokens: Record<string, string> = {};

  const server = () => app.getHttpServer();
  const as = (who: string) => ({ Authorization: `Bearer ${tokens[who]}` });
  const base = (tenant = tenantId) => `/api/v1/tenants/${tenant}`;

  const login = async (email: string) => {
    const response = await request(server())
      .post('/api/v1/auth/login')
      .send({ email, password: TEST_PASSWORD })
      .expect(200);
    return response.body.accessToken as string;
  };

  const createProduct = async (body: Record<string, unknown>) =>
    (await request(server()).post(`${base()}/products`).set(as('master')).send(body).expect(201))
      .body as { id: string; code: string };

  const createOrder = async (branchId = northId, tenant = tenantId, who = 'master') =>
    (
      await request(server())
        .post(`${base(tenant)}/orders`)
        .set(as(who))
        .send({ branchId })
        .expect(201)
    ).body as { id: string; version: number };

  const addProduct = (
    order: { id: string; version: number },
    product: string,
    quantity: string,
    tenant = tenantId,
    who = 'master',
  ) =>
    request(server())
      .post(`${base(tenant)}/orders/${order.id}/items`)
      .set(as(who))
      .send({ version: order.version, kind: 'PRODUCT', productId: product, quantity });

  const lot = (id: string) => prisma.stockLot.findUniqueOrThrow({ where: { id } });

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication();
    app.setGlobalPrefix('api/v1');
    // The same options as the global pipe in main.ts.
    app.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        forbidNonWhitelisted: true,
        transform: true,
        transformOptions: { enableImplicitConversion: true },
      }),
    );
    await app.init();
    prisma = app.get<PrismaService>(PrismaService);

    await prisma.cleanDatabase();
    const deps = { tenants: app.get(PlatformTenantsService), prisma };
    tenantId = (await createTestTenant(deps, 1)).id;
    otherTenantId = (await createTestTenant(deps, 2)).id;
    await prisma.tenantSubscription.updateMany({
      where: { tenantId: { in: [tenantId, otherTenantId] } },
      data: {
        planId: 'plan_clinic_basic',
        status: 'ACTIVE',
        seatsPsychologistsMax: 5,
        maxActivePatients: 100,
        storageGB: 1,
        // The tests open a second branch.
        maxBranches: 2,
        monthlyElectronicInvoicesLimit: 50,
      },
    });

    tokens.master = await login('admin+1@tenant.test');
    tokens.otherMaster = await login('admin+2@tenant.test');

    northId = (await prisma.branch.findFirstOrThrow({ where: { tenantId, isActive: true } })).id;
    otherBranchId = (
      await prisma.branch.findFirstOrThrow({ where: { tenantId: otherTenantId, isActive: true } })
    ).id;
    southId = (
      await request(server())
        .post(`${base()}/branches`)
        .set(as('master'))
        .send({ name: 'Sede Sur' })
        .expect(201)
    ).body.id;

    // Invoicing configured for the north branch without calling the provider.
    const connection = await prisma.invoicingConnection.create({
      data: {
        tenantId,
        apiKeyEncrypted: 'fixture-not-used',
        externalTenantId: 'fixture-tenant',
        taxpayerId: 'fixture-taxpayer',
        taxpayerName: 'Fixture',
        taxpayerRuc: '1790012345001',
        environment: '1',
        validatedAt: new Date(),
      },
    });
    await prisma.branchEmissionPoint.create({
      data: {
        branchId: northId,
        connectionId: connection.id,
        establishmentId: 'fixture-establishment',
        emissionPointId: 'fixture-point',
        establishmentCode: '001',
        emissionPointCode: '001',
      },
    });

    billingProfileId = (
      await request(server())
        .post(`${base()}/billing-profiles`)
        .set(as('master'))
        .send({
          kind: 'COMPANY',
          idType: '04',
          idNumber: '1710034065001',
          legalName: 'Empresa Inventario S.A.',
          email: 'facturas@empresa.test',
        })
        .expect(201)
    ).body.id;

    await request(server())
      .post(`${base()}/cash-registers/open`)
      .set(as('master'))
      .send({ branchId: northId, openingCash: '0.00' })
      .expect(201);
  });

  afterAll(async () => {
    await app.close();
  });

  it('1. receives two lots with different expiry into the north branch', async () => {
    productId = (
      await createProduct({
        code: 'prot-01',
        name: 'Protector solar SPF 50',
        barcode: '7501234567890',
        price: '10.00',
        taxRatePercent: 15,
        tracksExpiry: true,
        minStock: 2,
      })
    ).id;

    const receipt = await request(server())
      .post(`${base()}/stock-receipts`)
      .set(as('master'))
      .send({
        branchId: northId,
        supplierName: 'Distribuidora Andina',
        documentNumber: '001-001-000000123',
        lines: [
          { productId, quantity: 9, unitCost: '4.00', lotNumber: 'L-LATE', expiresAt: inDays(150) },
          { productId, quantity: 1, unitCost: '3.50', lotNumber: 'L-EARLY', expiresAt: inDays(60) },
        ],
      })
      .expect(201);
    expect(receipt.body.lines).toHaveLength(2);
    earlyLotId = receipt.body.lines.find(
      (l: { lotNumber: string }) => l.lotNumber === 'L-EARLY',
    ).lotId;
    lateLotId = receipt.body.lines.find(
      (l: { lotNumber: string }) => l.lotNumber === 'L-LATE',
    ).lotId;

    const forSale = await request(server())
      .get(`${base()}/products/for-sale?branchId=${northId}&barcode=7501234567890`)
      .set(as('master'))
      .expect(200);
    expect(forSale.body).toEqual([
      expect.objectContaining({ id: productId, code: 'PROT-01', price: '10.00', available: 10 }),
    ]);
    expect(forSale.body[0]).not.toHaveProperty('unitCost');

    const detail = await request(server())
      .get(`${base()}/products/${productId}`)
      .set(as('master'))
      .expect(200);
    expect(detail.body.stock).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ branchId: northId, available: 10 }),
        expect.objectContaining({ branchId: southId, available: 0 }),
      ]),
    );
    // First expired, first out.
    expect(detail.body.lots.map((l: { id: string }) => l.id)).toEqual([earlyLotId, lateLotId]);
  });

  it('2. sells 2 units across both lots, takes the payment and requests the invoice with the product code', async () => {
    const order = await createOrder();
    const added = await addProduct(order, productId, '2').expect(201);
    expect(added.body.total).toBe('23.00');
    const item = added.body.items[0];
    expect(item).toMatchObject({ kind: 'PRODUCT', productId, quantity: expect.any(String) });

    const drawn = await prisma.orderItemLot.findMany({ where: { orderItemId: item.id } });
    expect(drawn.map((d) => [d.lotId, d.quantity]).sort()).toEqual(
      [
        [earlyLotId, 1],
        [lateLotId, 1],
      ].sort(),
    );
    expect((await lot(earlyLotId)).quantityOnHand).toBe(0);
    expect((await lot(lateLotId)).quantityOnHand).toBe(8);

    const withProfile = await request(server())
      .put(`${base()}/orders/${order.id}/billing-profile`)
      .set(as('master'))
      .send({ version: added.body.version, billingProfileId })
      .expect(200);
    expect(withProfile.body.billingProfile.id).toBe(billingProfileId);

    const paid = await request(server())
      .post(`${base()}/orders/${order.id}/payments`)
      .set(as('master'))
      .send({ method: 'CASH', amount: '23.00' })
      .expect(201);
    expect(paid.body.status).toBe('PAID');

    const invoice = await request(server())
      .post(`${base()}/orders/${order.id}/invoice-requests`)
      .set(as('master'))
      .set('Idempotency-Key', randomUUID())
      .expect(202);
    expect(invoice.body.status).toBe('REQUESTED');

    const row = await prisma.invoiceRequest.findUniqueOrThrow({ where: { id: invoice.body.id } });
    const snapshot = JSON.parse(
      app.get(ClinicalCryptoService).decrypt(tenantId, row.snapshotEncrypted),
    ) as { lines: Record<string, string>[] };
    expect(snapshot.lines).toEqual([
      expect.objectContaining({
        localId: productId,
        code: 'PROT-01',
        name: 'Protector solar SPF 50',
        quantity: '2.000000',
        unitPrice: '10.00',
        taxRatePercent: '15.00',
      }),
    ]);
    expect((await prisma.order.findUniqueOrThrow({ where: { id: order.id } })).status).toBe(
      'INVOICED',
    );
  });

  it('3. a cancelled order returns its units to the lot they came from', async () => {
    const order = await createOrder();
    const added = await addProduct(order, productId, '3').expect(201);
    expect((await lot(lateLotId)).quantityOnHand).toBe(5);

    const cancelled = await request(server())
      .post(`${base()}/orders/${order.id}/cancel`)
      .set(as('master'))
      .send({ version: added.body.version, reason: 'La paciente desistió de la compra.' })
      .expect(201);
    expect(cancelled.body.status).toBe('CANCELLED');
    expect((await lot(lateLotId)).quantityOnHand).toBe(8);

    const release = await prisma.stockMovement.findMany({
      where: { orderItemId: added.body.items[0].id, kind: 'SALE_RELEASE' },
    });
    expect(release.map((m) => [m.lotId, m.quantity])).toEqual([[lateLotId, 3]]);
  });

  it('4. transfers 5 units to the south branch and writes off a broken one', async () => {
    const transfer = await request(server())
      .post(`${base()}/stock-transfers`)
      .set(as('master'))
      .send({
        fromBranchId: northId,
        toBranchId: southId,
        lines: [{ lotId: lateLotId, quantity: 5 }],
      })
      .expect(201);
    expect(transfer.body.lines).toHaveLength(1);
    const arrived = transfer.body.lines[0];
    expect(arrived).toMatchObject({ sourceLotId: lateLotId, quantity: 5, unitCost: '4.00' });
    expect((await lot(lateLotId)).quantityOnHand).toBe(3);
    const southLot = await lot(arrived.lotId);
    expect(southLot).toMatchObject({ branchId: southId, quantityOnHand: 5 });
    expect(southLot.expiresAt).toEqual((await lot(lateLotId)).expiresAt);

    const adjusted = await request(server())
      .post(`${base()}/stock-lots/${lateLotId}/adjustments`)
      .set(as('master'))
      .send({ delta: -1, reason: 'DAMAGE', note: 'Envase roto' })
      .expect(201);
    expect(adjusted.body.quantityOnHand).toBe(2);

    const forSouth = await request(server())
      .get(`${base()}/products/for-sale?branchId=${southId}&search=PROT`)
      .set(as('master'))
      .expect(200);
    expect(forSouth.body[0]).toMatchObject({ id: productId, available: 5 });
  });

  it('5. every lot balance equals the sum of its movements', async () => {
    const movements = await request(server())
      .get(`${base()}/stock-movements?productId=${productId}&pageSize=100`)
      .set(as('master'))
      .expect(200);
    expect(new Set(movements.body.items.map((m: { kind: string }) => m.kind))).toEqual(
      new Set(['RECEIPT', 'SALE', 'SALE_RELEASE', 'TRANSFER_OUT', 'TRANSFER_IN', 'ADJUSTMENT']),
    );

    const lots = await prisma.stockLot.findMany({ where: { tenantId } });
    expect(lots.length).toBeGreaterThanOrEqual(3);
    const sums = await prisma.stockMovement.groupBy({
      by: ['lotId'],
      where: { tenantId },
      _sum: { quantity: true },
    });
    const sumByLot = new Map(sums.map((s) => [s.lotId, s._sum.quantity ?? 0]));
    for (const each of lots) {
      expect({ lot: each.id, balance: each.quantityOnHand }).toEqual({
        lot: each.id,
        balance: sumByLot.get(each.id) ?? 0,
      });
      expect(each.quantityOnHand).toBeGreaterThanOrEqual(0);
    }
  });

  it('6. two registers asking for the last unit at once: one gets it, the other 409 INSUFFICIENT_STOCK', async () => {
    const last = (
      await createProduct({
        code: 'GEL-01',
        name: 'Gel limpiador',
        price: '8.00',
        taxRatePercent: 15,
        tracksExpiry: false,
      })
    ).id;
    const receipt = await request(server())
      .post(`${base()}/stock-receipts`)
      .set(as('master'))
      .send({ branchId: northId, lines: [{ productId: last, quantity: 1, unitCost: '3.00' }] })
      .expect(201);
    const lastLotId = receipt.body.lines[0].lotId as string;

    const first = await createOrder();
    const second = await createOrder();
    const results = await Promise.all([
      addProduct(first, last, '1'),
      addProduct(second, last, '1'),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual([201, 409]);
    const loser = results.find((r) => r.status === 409)!;
    expect(loser.body.code).toBe('INSUFFICIENT_STOCK');

    expect((await lot(lastLotId)).quantityOnHand).toBe(0);
    expect(await prisma.orderItem.count({ where: { productId: last } })).toBe(1);
    const sold = await prisma.stockMovement.aggregate({
      where: { lotId: lastLotId },
      _sum: { quantity: true },
    });
    expect(sold._sum.quantity).toBe(0);
  });

  it('7. another tenant neither sees nor sells the products', async () => {
    const foreignGet = await request(server())
      .get(`${base(otherTenantId)}/products/${productId}`)
      .set(as('otherMaster'))
      .expect(404);
    expect(foreignGet.body.code).toBe('PRODUCT_NOT_FOUND');

    const foreignOrder = await createOrder(otherBranchId, otherTenantId, 'otherMaster');
    const foreignSale = await addProduct(
      foreignOrder,
      productId,
      '1',
      otherTenantId,
      'otherMaster',
    ).expect(404);
    expect(foreignSale.body.code).toBe('PRODUCT_NOT_FOUND');

    const foreignList = await request(server())
      .get(`${base(otherTenantId)}/products/for-sale?branchId=${otherBranchId}`)
      .set(as('otherMaster'))
      .expect(200);
    expect(foreignList.body).toEqual([]);

    const foreignAdjustment = await request(server())
      .post(`${base(otherTenantId)}/stock-lots/${lateLotId}/adjustments`)
      .set(as('otherMaster'))
      .send({ delta: -1, reason: 'DAMAGE' })
      .expect(404);
    expect(foreignAdjustment.body.code).toBe('STOCK_LOT_NOT_FOUND');

    // Reaching the product through the own tenant's prefix is refused too.
    await request(server())
      .get(`${base()}/products/${productId}`)
      .set(as('otherMaster'))
      .expect(403);
    expect((await lot(lateLotId)).quantityOnHand).toBe(2);
  });
});
