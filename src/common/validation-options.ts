import { ValidationPipeOptions } from '@nestjs/common';
import { validationExceptionFactory } from './errors/validation-errors';

/**
 * Options of the global ValidationPipe (src/main.ts). Specs that check how a DTO reads a request
 * build the pipe with these, so they see the same implicit conversion the API applies.
 * A rejected request answers which field is wrong and why, in Spanish (validationExceptionFactory).
 */
export const VALIDATION_PIPE_OPTIONS: ValidationPipeOptions = {
  whitelist: true,
  forbidNonWhitelisted: true,
  transform: true,
  transformOptions: {
    enableImplicitConversion: true,
  },
  exceptionFactory: validationExceptionFactory,
};
