import { ConflictException, NotFoundException, UnprocessableEntityException } from '@nestjs/common';

export const productNotFound = () =>
  new NotFoundException({
    statusCode: 404,
    code: 'PRODUCT_NOT_FOUND',
    message: 'Producto no encontrado.',
  });

export const productInactive = () =>
  new ConflictException({
    statusCode: 409,
    code: 'PRODUCT_INACTIVE',
    message: 'El producto está inactivo.',
  });

export const productCodeTaken = () =>
  new ConflictException({
    statusCode: 409,
    code: 'PRODUCT_CODE_TAKEN',
    message: 'Ya existe un producto o tratamiento con ese código.',
  });

export const productNameTaken = () =>
  new ConflictException({
    statusCode: 409,
    code: 'PRODUCT_NAME_TAKEN',
    message: 'Ya existe un producto con ese nombre.',
  });

export const productBarcodeTaken = () =>
  new ConflictException({
    statusCode: 409,
    code: 'PRODUCT_BARCODE_TAKEN',
    message: 'Ya existe un producto con ese código de barras.',
  });

export const productHasStock = () =>
  new ConflictException({
    statusCode: 409,
    code: 'PRODUCT_HAS_STOCK',
    message: 'El producto tiene lotes: no se puede cambiar si controla vencimiento.',
  });

export const insufficientStock = (available: number) =>
  new ConflictException({
    statusCode: 409,
    code: 'INSUFFICIENT_STOCK',
    message: `No hay existencias suficientes. Disponible: ${available}.`,
    available,
  });

export const lotNotFound = () =>
  new NotFoundException({
    statusCode: 404,
    code: 'STOCK_LOT_NOT_FOUND',
    message: 'Lote no encontrado.',
  });

export const lotExpiryRequired = () =>
  new UnprocessableEntityException({
    statusCode: 422,
    code: 'LOT_EXPIRY_REQUIRED',
    message: 'El producto controla vencimiento: indique la fecha de vencimiento del lote.',
  });

export const lotAlreadyExpired = () =>
  new UnprocessableEntityException({
    statusCode: 422,
    code: 'LOT_ALREADY_EXPIRED',
    message: 'La fecha de vencimiento del lote ya pasó.',
  });

export const stockBelowZero = () =>
  new UnprocessableEntityException({
    statusCode: 422,
    code: 'STOCK_BELOW_ZERO',
    message: 'El ajuste dejaría el lote con existencias negativas.',
  });

export const adjustmentEmpty = () =>
  new UnprocessableEntityException({
    statusCode: 422,
    code: 'ADJUSTMENT_EMPTY',
    message: 'El ajuste no cambia las existencias del lote.',
  });

export const adjustmentNoteRequired = () =>
  new UnprocessableEntityException({
    statusCode: 422,
    code: 'ADJUSTMENT_NOTE_REQUIRED',
    message: 'El motivo «Otro» exige una nota.',
  });

export const transferSameBranch = () =>
  new UnprocessableEntityException({
    statusCode: 422,
    code: 'TRANSFER_SAME_BRANCH',
    message: 'La sede de origen y la de destino deben ser distintas.',
  });

export const lotNotInBranch = () =>
  new UnprocessableEntityException({
    statusCode: 422,
    code: 'LOT_NOT_IN_BRANCH',
    message: 'El lote no pertenece a la sede de origen.',
  });
