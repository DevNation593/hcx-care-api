import {
  ArgumentsHost,
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
  PayloadTooLargeException,
  UnauthorizedException,
} from '@nestjs/common';
import { HttpAdapterHost } from '@nestjs/core';
import { Prisma } from '@prisma/client';
import { AllExceptionsFilter } from './all-exceptions.filter';

const prismaError = (code: string, meta?: Record<string, unknown>) =>
  new Prisma.PrismaClientKnownRequestError('prisma failure with private details', {
    code,
    clientVersion: 'test',
    meta,
  });

function setup() {
  const reply = jest.fn();
  const filter = new AllExceptionsFilter({ httpAdapter: { reply } } as unknown as HttpAdapterHost);
  jest
    .spyOn((filter as unknown as { logger: { error: () => void } }).logger, 'error')
    .mockImplementation();
  jest
    .spyOn((filter as unknown as { logger: { warn: () => void } }).logger, 'warn')
    .mockImplementation();
  const host = (method = 'POST') =>
    ({
      getType: () => 'http',
      switchToHttp: () => ({ getRequest: () => ({ method }), getResponse: () => 'response' }),
    }) as unknown as ArgumentsHost;
  return { filter, reply, host };
}

describe('AllExceptionsFilter', () => {
  it('keeps the body of an HttpException that already explains itself', () => {
    const { filter } = setup();
    const body = filter.toBody(
      new ConflictException({
        code: 'SLOT_TAKEN',
        message: 'El horario ya está ocupado',
        extra: 1,
      }),
    );
    expect(body).toEqual({
      statusCode: 409,
      code: 'SLOT_TAKEN',
      message: 'El horario ya está ocupado',
      extra: 1,
    });
  });

  it.each([
    [new ForbiddenException(), 403, 'No tienes permiso para realizar esta acción.'],
    [new UnauthorizedException(), 401, 'Tu sesión expiró o no es válida. Inicia sesión de nuevo.'],
    [new NotFoundException('Cannot GET /api/v1/nada'), 404, 'El recurso solicitado no existe.'],
    [
      new PayloadTooLargeException('File too large'),
      413,
      'El archivo supera el tamaño máximo permitido.',
    ],
    [
      new BadRequestException('Validation failed (uuid is expected)'),
      400,
      'El identificador enviado no es válido.',
    ],
  ])('translates the default English message of %p', (exception, statusCode, message) => {
    const { filter } = setup();
    expect(filter.toBody(exception)).toMatchObject({ statusCode, message });
  });

  it('joins the messages of a pipe that answers a list', () => {
    const { filter } = setup();
    const body = filter.toBody(new BadRequestException(['uno', 'dos']));
    expect(body).toMatchObject({ statusCode: 400, code: 'VALIDATION_ERROR', message: 'uno. dos' });
  });

  it('turns a duplicate into a 409 that names the field, without the tenant', () => {
    const { filter } = setup();
    expect(filter.toBody(prismaError('P2002', { target: ['tenantId', 'email'] }))).toEqual({
      statusCode: 409,
      code: 'DUPLICATE_RECORD',
      message: 'Ya existe un registro con el mismo valor en «Correo electrónico».',
      fields: ['email'],
    });
  });

  it('turns a missing record into a 404', () => {
    const { filter } = setup();
    expect(filter.toBody(prismaError('P2025'))).toMatchObject({
      statusCode: 404,
      code: 'RECORD_NOT_FOUND',
    });
  });

  it('tells a delete of a record in use from a link to a missing record', () => {
    const { filter } = setup();
    expect(filter.toBody(prismaError('P2003'), 'DELETE')).toMatchObject({
      statusCode: 409,
      code: 'RECORD_IN_USE',
    });
    expect(filter.toBody(prismaError('P2003'), 'POST')).toMatchObject({
      statusCode: 409,
      code: 'RELATED_RECORD_MISSING',
    });
  });

  it('answers an unreachable database with a 503', () => {
    const { filter } = setup();
    expect(filter.toBody(prismaError('P1001'))).toMatchObject({
      statusCode: 503,
      code: 'DATABASE_UNAVAILABLE',
    });
  });

  it('answers a malformed JSON body with a 400', () => {
    const { filter } = setup();
    const error = Object.assign(new SyntaxError('Unexpected token'), {
      type: 'entity.parse.failed',
      status: 400,
    });
    expect(filter.toBody(error)).toMatchObject({ statusCode: 400, code: 'INVALID_JSON' });
  });

  it('hides the cause of an unexpected error and logs it', () => {
    const { filter, reply, host } = setup();
    filter.catch(new Error('secret stack detail'), host());
    const [, body, status] = reply.mock.calls[0];
    expect(status).toBe(500);
    expect(body).toEqual({
      statusCode: 500,
      code: 'INTERNAL_ERROR',
      message: expect.stringContaining('Ocurrió un error inesperado en el servidor'),
    });
    expect(JSON.stringify(body)).not.toContain('secret');
    expect((filter as unknown as { logger: { error: jest.Mock } }).logger.error).toHaveBeenCalled();
  });

  it('does not leak the text of an unhandled Prisma error', () => {
    const { filter } = setup();
    const body = filter.toBody(prismaError('P2010'));
    expect(body).toMatchObject({ statusCode: 500, code: 'INTERNAL_ERROR' });
    expect(JSON.stringify(body)).not.toContain('private');
  });

  it('leaves non-HTTP contexts to Nest', () => {
    const { filter } = setup();
    const error = new Error('job failed');
    expect(() => filter.catch(error, { getType: () => 'rpc' } as unknown as ArgumentsHost)).toThrow(
      error,
    );
  });
});
