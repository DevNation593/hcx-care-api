import { BadRequestException, ValidationPipe } from '@nestjs/common';
import { AddOrderItemDto } from './order.dto';

// Same configuration as the global ValidationPipe in main.ts.
const pipe = new ValidationPipe({
  whitelist: true,
  forbidNonWhitelisted: true,
  transform: true,
  transformOptions: { enableImplicitConversion: true },
});

const validateBody = (body: Record<string, unknown>) =>
  pipe.transform(body, { type: 'body', metatype: AddOrderItemDto });

const rejectionMessages = (body: Record<string, unknown>) =>
  validateBody(body).then(
    () => [],
    (error: BadRequestException) => (error.getResponse() as { message: string[] }).message,
  );

describe('AddOrderItemDto quantity', () => {
  const product = { version: 3, kind: 'PRODUCT', productId: 'product-1' };
  const free = {
    version: 3,
    kind: 'FREE',
    description: 'Gel',
    unitPrice: '10.00',
    taxRatePercent: 15,
  };

  // The service answers 422 ORDER_LINE_INVALID for a product quantity that is not a whole number.
  it.each(['-1', '2.5', '0', 'abc'])(
    'lets a product quantity %j through to the service',
    async (quantity) => {
      await expect(validateBody({ ...product, quantity })).resolves.toMatchObject({ quantity });
    },
  );

  it('still requires a product quantity to be a string', async () => {
    expect(await rejectionMessages({ ...product, quantity: ['1'] })).toEqual([
      'quantity must be a string',
    ]);
  });

  it.each(['-1', 'abc', '1.1234567'])('rejects a free quantity %j as before', async (quantity) => {
    expect(await rejectionMessages({ ...free, quantity })).toEqual([
      'La cantidad debe ser un decimal con hasta 6 decimales.',
    ]);
  });

  it('accepts a free decimal quantity', async () => {
    await expect(validateBody({ ...free, quantity: '2.5' })).resolves.toMatchObject({
      quantity: '2.5',
    });
  });
});
