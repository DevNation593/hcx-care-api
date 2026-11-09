import {
  ArgumentsHost,
  BadRequestException,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import { HttpAdapterHost } from '@nestjs/core';
import { Prisma } from '@prisma/client';
import { fieldLabel } from './field-labels';

const INVALID_JSON_MESSAGE = 'El cuerpo de la solicitud no es un JSON válido.';

type ErrorBody = Record<string, unknown> & { statusCode: number; message: string };

/** Spanish text for a status whose error carries no message of its own. */
const STATUS_MESSAGES: Record<number, string> = {
  400: 'La solicitud tiene datos inválidos.',
  401: 'Tu sesión expiró o no es válida. Inicia sesión de nuevo.',
  403: 'No tienes permiso para realizar esta acción.',
  404: 'El recurso solicitado no existe.',
  405: 'La operación no está permitida.',
  408: 'El servidor tardó demasiado en responder. Intenta de nuevo.',
  409: 'La operación entra en conflicto con datos existentes.',
  413: 'El archivo o la solicitud supera el tamaño máximo permitido.',
  415: 'El tipo de archivo o de contenido no es compatible.',
  422: 'Los datos enviados no se pueden procesar.',
  429: 'Demasiadas solicitudes seguidas. Espera un momento e intenta de nuevo.',
  500: 'Ocurrió un error inesperado en el servidor. Intenta de nuevo; si el problema continúa, contacta a soporte.',
  502: 'Un servicio externo no respondió correctamente. Intenta de nuevo en unos minutos.',
  503: 'El servicio no está disponible en este momento. Intenta de nuevo en unos minutos.',
  504: 'Un servicio externo tardó demasiado en responder. Intenta de nuevo en unos minutos.',
};

/** Texts NestJS, Multer and the throttler answer with by default (in English). */
const DEFAULT_ENGLISH_MESSAGES: Record<string, string> = {
  'File too large': 'El archivo supera el tamaño máximo permitido.',
  'Too many files': 'Se enviaron demasiados archivos.',
  'Unexpected field': 'El archivo se envió en un campo no esperado.',
  'Multipart: Boundary not found': 'El archivo no se envió correctamente. Intenta de nuevo.',
  'Validation failed (uuid is expected)': 'El identificador enviado no es válido.',
  'Validation failed (numeric string is expected)': 'Se esperaba un número.',
  'Validation failed (boolean string is expected)': 'Se esperaba verdadero o falso.',
  'Validation failed (enum string is expected)': 'El valor enviado no es una opción permitida.',
};

function statusMessage(status: number): string {
  return STATUS_MESSAGES[status] ?? STATUS_MESSAGES[status >= 500 ? 500 : 400];
}

/** True for a message that only repeats the name of its status ("Forbidden resource", "Not Found"…). */
function isGenericMessage(message: string, status: number): boolean {
  const statusName = HttpStatus[status]?.replace(/_/g, ' ').toLowerCase();
  const text = message.trim().toLowerCase();
  return (
    !text ||
    text === statusName ||
    text === 'forbidden resource' ||
    text === 'internal server error' ||
    text.startsWith('throttlerexception') ||
    /^cannot (get|post|put|patch|delete|head|options) \//.test(text)
  );
}

function translate(message: string, status: number): string {
  if (Object.hasOwn(DEFAULT_ENGLISH_MESSAGES, message)) return DEFAULT_ENGLISH_MESSAGES[message];
  return isGenericMessage(message, status) ? statusMessage(status) : message;
}

/** The fields a unique constraint names: a list of columns, or the constraint name. */
function uniqueFields(meta: Record<string, unknown> | undefined): string[] {
  const target = meta?.target;
  if (Array.isArray(target))
    return target.filter((f): f is string => typeof f === 'string' && f !== 'tenantId');
  return [];
}

/**
 * Every error of an HTTP request answers with a message in Spanish that says why it failed:
 * - HttpExceptions keep their body (`code`, `missing`, `details`…); a default English message
 *   ("Forbidden resource", "File too large", "Cannot GET /x") is replaced by its Spanish reason.
 * - Prisma errors no service caught become the 4xx they mean (duplicate, not found, linked data).
 * - Anything else is a 500 with a generic Spanish message: the cause is logged, never sent.
 */
@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  private readonly logger = new Logger('ExceptionsHandler');

  constructor(private readonly adapterHost: HttpAdapterHost) {}

  catch(exception: unknown, host: ArgumentsHost): void {
    if (host.getType() !== 'http') throw exception;
    const ctx = host.switchToHttp();
    const request = ctx.getRequest<{ method?: string }>();
    const body = this.toBody(exception, request?.method);
    if (body.statusCode >= 500) {
      this.logger.error(
        exception instanceof Error ? exception.message : String(exception),
        exception instanceof Error ? exception.stack : undefined,
      );
    }
    this.adapterHost.httpAdapter.reply(ctx.getResponse(), body, body.statusCode);
  }

  toBody(exception: unknown, method?: string): ErrorBody {
    if (exception instanceof HttpException) return this.fromHttpException(exception);
    if (exception instanceof Prisma.PrismaClientKnownRequestError) {
      return this.fromPrismaError(exception, method);
    }
    if (
      exception instanceof Prisma.PrismaClientInitializationError ||
      exception instanceof Prisma.PrismaClientRustPanicError
    ) {
      return { statusCode: 503, code: 'DATABASE_UNAVAILABLE', message: statusMessage(503) };
    }
    const parserError = this.fromBodyParserError(exception);
    if (parserError) return parserError;
    return { statusCode: 500, code: 'INTERNAL_ERROR', message: statusMessage(500) };
  }

  /**
   * Nest turns the body parser's SyntaxError (malformed JSON) and Express' URIError (a badly
   * encoded path) into `new BadRequestException(err.message)` before any filter runs
   * (RoutesResolver.mapExternalException): they arrive here with the default body and the
   * parser's English text, which is recognized and replaced.
   */
  private fromConvertedParserError(exception: HttpException): ErrorBody | undefined {
    if (!(exception instanceof BadRequestException)) return undefined;
    const response = exception.getResponse();
    if (typeof response !== 'object' || response === null) return undefined;
    const { message, error, statusCode, ...rest } = response as Record<string, unknown>;
    const isDefaultBody =
      Object.keys(rest).length === 0 && error === 'Bad Request' && statusCode === 400;
    if (!isDefaultBody || typeof message !== 'string') return undefined;
    if (/\bJSON\b/.test(message)) {
      return { statusCode: 400, code: 'INVALID_JSON', message: INVALID_JSON_MESSAGE };
    }
    // Express 5's router rewrites the URIError as "Failed to decode param '%FF'".
    if (message === 'URI malformed' || message.startsWith('Failed to decode param ')) {
      return {
        statusCode: 400,
        code: 'INVALID_URL',
        message: 'La dirección de la solicitud contiene caracteres mal codificados.',
      };
    }
    return undefined;
  }

  private fromHttpException(exception: HttpException): ErrorBody {
    const converted = this.fromConvertedParserError(exception);
    if (converted) return converted;
    const statusCode = exception.getStatus();
    const response = exception.getResponse();
    const body: Record<string, unknown> =
      typeof response === 'object' && response !== null ? { ...response } : { message: response };
    let message: string;
    if (Array.isArray(body.message)) {
      // A pipe without the Spanish exceptionFactory: keep its texts, one per issue.
      const texts = body.message.filter((m): m is string => typeof m === 'string');
      body.code ??= 'VALIDATION_ERROR';
      message = texts.length ? texts.join('. ') : statusMessage(statusCode);
    } else {
      message = translate(typeof body.message === 'string' ? body.message : '', statusCode);
    }
    return { ...body, statusCode, message };
  }

  private fromPrismaError(error: Prisma.PrismaClientKnownRequestError, method?: string): ErrorBody {
    switch (error.code) {
      case 'P2002': {
        const fields = uniqueFields(error.meta);
        this.logger.warn(
          `Unique constraint failed (${error.code}) on ${fields.join(', ') || 'unknown fields'}`,
        );
        const named = fields.map((f) => `«${fieldLabel(f)}»`).join(', ');
        return {
          statusCode: 409,
          code: 'DUPLICATE_RECORD',
          message: named
            ? `Ya existe un registro con el mismo valor en ${named}.`
            : 'Ya existe un registro con esos mismos datos.',
          ...(fields.length ? { fields } : {}),
        };
      }
      case 'P2025':
      case 'P2001':
      case 'P2015':
        return {
          statusCode: 404,
          code: 'RECORD_NOT_FOUND',
          message: 'El registro no existe o ya fue eliminado.',
        };
      case 'P2003':
      case 'P2014':
        this.logger.warn(`Relation constraint failed (${error.code})`);
        return method === 'DELETE'
          ? {
              statusCode: 409,
              code: 'RECORD_IN_USE',
              message:
                'No se puede eliminar porque tiene otros datos vinculados. Elimina o reasigna esos datos primero.',
            }
          : {
              statusCode: 409,
              code: 'RELATED_RECORD_MISSING',
              message: 'Uno de los registros relacionados no existe o ya fue eliminado.',
            };
      case 'P2000':
        return {
          statusCode: 400,
          code: 'VALUE_TOO_LONG',
          message: 'Uno de los valores enviados es demasiado largo.',
        };
      case 'P2034':
        return {
          statusCode: 409,
          code: 'CONCURRENT_UPDATE',
          message: 'Otra operación modificó estos datos al mismo tiempo. Intenta de nuevo.',
        };
      case 'P1001':
      case 'P1002':
      case 'P1008':
      case 'P1017':
      case 'P2024':
        this.logger.error(`Database unavailable (${error.code})`);
        return { statusCode: 503, code: 'DATABASE_UNAVAILABLE', message: statusMessage(503) };
      default:
        this.logger.error(`Unhandled Prisma error ${error.code}`, error.stack);
        return { statusCode: 500, code: 'INTERNAL_ERROR', message: statusMessage(500) };
    }
  }

  /** Errors of the JSON body parser (http-errors): malformed or too large a body. */
  private fromBodyParserError(exception: unknown): ErrorBody | undefined {
    if (typeof exception !== 'object' || exception === null) return undefined;
    const { type, status } = exception as { type?: unknown; status?: unknown };
    if (type === 'entity.parse.failed') {
      return {
        statusCode: 400,
        code: 'INVALID_JSON',
        message: INVALID_JSON_MESSAGE,
      };
    }
    if (type === 'entity.too.large') {
      return { statusCode: 413, code: 'PAYLOAD_TOO_LARGE', message: statusMessage(413) };
    }
    if (typeof status === 'number' && status >= 400 && status < 500) {
      return { statusCode: status, message: statusMessage(status) };
    }
    return undefined;
  }
}
