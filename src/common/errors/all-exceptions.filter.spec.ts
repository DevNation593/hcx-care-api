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
import { flushReports, isReportingEnabled, reportError } from '../monitoring/error-reporter';
import { AllExceptionsFilter } from './all-exceptions.filter';

jest.mock('../monitoring/error-reporter');

const reportErrorMock = jest.mocked(reportError);
const isReportingEnabledMock = jest.mocked(isReportingEnabled);
const flushReportsMock = jest.mocked(flushReports);

beforeEach(() => {
  jest.resetAllMocks();
});

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
  const host = (method = 'POST', request: Record<string, unknown> = {}) =>
    ({
      getType: () => 'http',
      switchToHttp: () => ({
        getRequest: () => ({ method, ...request }),
        getResponse: () => 'response',
      }),
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

  describe('error reporting', () => {
    it('reports a 500 with method, route pattern, userId and tenantId', () => {
      const { filter, host } = setup();
      const error = new Error('secret stack detail');
      filter.catch(
        error,
        host('GET', {
          route: { path: '/api/v1/patients/:id' },
          user: { userId: 'u1', tenantId: 't1', email: 'a@b.c' },
        }),
      );
      expect(reportErrorMock).toHaveBeenCalledTimes(1);
      expect(reportErrorMock).toHaveBeenCalledWith(error, {
        source: 'http',
        method: 'GET',
        route: '/api/v1/patients/:id',
        userId: 'u1',
        tenantId: 't1',
      });
      const context = reportErrorMock.mock.calls[0][1] as Record<string, unknown>;
      expect(context).not.toHaveProperty('email');
      expect(JSON.stringify(context)).not.toContain('a@b.c');
    });

    it('reports a 503 DATABASE_UNAVAILABLE', () => {
      const { filter, reply, host } = setup();
      const error = prismaError('P1001');
      filter.catch(error, host('GET'));
      expect(reply.mock.calls[0][2]).toBe(503);
      expect(reportErrorMock).toHaveBeenCalledWith(
        error,
        expect.objectContaining({ source: 'http', method: 'GET' }),
      );
    });

    it.each([
      ['400', new BadRequestException('x')],
      ['401', new UnauthorizedException()],
      ['403', new ForbiddenException()],
      ['404', new NotFoundException()],
      ['409', new ConflictException()],
    ])('does not report %s', (_status, error) => {
      const { filter, host } = setup();
      filter.catch(error, host('GET'));
      expect(reportErrorMock).not.toHaveBeenCalled();
      expect(flushReportsMock).not.toHaveBeenCalled();
    });

    it('reports a 500 without user or route', () => {
      const { filter, reply, host } = setup();
      const error = new Error('boom');
      expect(() => filter.catch(error, host('GET', {}))).not.toThrow();
      expect(reply.mock.calls[0][2]).toBe(500);
      const context = reportErrorMock.mock.calls[0][1];
      expect(context).toEqual({
        source: 'http',
        method: 'GET',
        route: undefined,
        userId: undefined,
        tenantId: undefined,
      });
    });

    it('waits for flushReports before replying when reporting is enabled', async () => {
      const { filter, reply, host } = setup();
      isReportingEnabledMock.mockReturnValue(true);
      let release!: () => void;
      flushReportsMock.mockReturnValue(new Promise<void>((resolve) => (release = resolve)));

      const result = filter.catch(new Error('boom'), host('GET'));

      expect(reportErrorMock).toHaveBeenCalledTimes(1);
      expect(flushReportsMock).toHaveBeenCalledTimes(1);
      expect(reply).not.toHaveBeenCalled();
      release();
      await result;
      expect(reply).toHaveBeenCalledTimes(1);
      expect(reply.mock.calls[0][2]).toBe(500);
    });

    it('resolves without rejecting when the reply throws after the flush', async () => {
      const { filter, reply, host } = setup();
      isReportingEnabledMock.mockReturnValue(true);
      flushReportsMock.mockResolvedValue(undefined);
      reply.mockImplementation(() => {
        throw new Error('socket closed');
      });

      await expect(filter.catch(new Error('boom'), host('GET'))).resolves.toBeUndefined();
      expect(reply).toHaveBeenCalledTimes(1);
    });

    it('replies synchronously when reporting is disabled', () => {
      const { filter, reply, host } = setup();
      isReportingEnabledMock.mockReturnValue(false);
      const result = filter.catch(new Error('boom'), host('GET'));
      expect(result).toBeUndefined();
      expect(reply).toHaveBeenCalledTimes(1);
      expect(flushReportsMock).not.toHaveBeenCalled();
    });

    it('does not flush when reporting is enabled but the error is a 4xx', () => {
      const { filter, reply, host } = setup();
      isReportingEnabledMock.mockReturnValue(true);
      const result = filter.catch(new NotFoundException(), host('GET'));
      expect(result).toBeUndefined();
      expect(reply).toHaveBeenCalledTimes(1);
      expect(flushReportsMock).not.toHaveBeenCalled();
    });
  });

  it('leaves non-HTTP contexts to Nest', () => {
    const { filter } = setup();
    const error = new Error('job failed');
    expect(() => filter.catch(error, { getType: () => 'rpc' } as unknown as ArgumentsHost)).toThrow(
      error,
    );
  });
});
