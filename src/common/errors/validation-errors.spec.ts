import { ArgumentMetadata, BadRequestException, ValidationPipe } from '@nestjs/common';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsEmail,
  IsEnum,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  Min,
  MinLength,
  ValidateNested,
} from 'class-validator';
import { VALIDATION_PIPE_OPTIONS } from '../validation-options';
import { summarizeIssues } from './validation-errors';

enum Color {
  RED = 'RED',
  BLUE = 'BLUE',
}

class LineDto {
  @IsInt()
  @Min(1)
  quantity!: number;
}

class SampleDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(5)
  firstName!: string;

  @IsEmail()
  email!: string;

  @IsString()
  @MinLength(8)
  password!: string;

  @IsOptional()
  @IsEnum(Color)
  color?: Color;

  @IsOptional()
  @Matches(/^\d{4}$/, { message: 'El código debe tener 4 dígitos.' })
  code?: string;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(1)
  @ValidateNested({ each: true })
  @Type(() => LineDto)
  lines?: LineDto[];
}

const pipe = new ValidationPipe(VALIDATION_PIPE_OPTIONS);
const metadata: ArgumentMetadata = { type: 'body', metatype: SampleDto };
const valid = { firstName: 'Ana', email: 'ana@example.com', password: 'secreta123' };

async function rejection(input: object) {
  try {
    await pipe.transform(input, metadata);
  } catch (error) {
    expect(error).toBeInstanceOf(BadRequestException);
    return (error as BadRequestException).getResponse() as {
      code: string;
      message: string;
      details: { field: string; message: string }[];
    };
  }
  throw new Error('The request was accepted');
}

const issueOf = async (input: object, field: string) =>
  (await rejection(input)).details.find((issue) => issue.field === field)?.message;

describe('validationExceptionFactory', () => {
  it('answers a VALIDATION_ERROR whose message says which field fails and why', async () => {
    const body = await rejection({ ...valid, email: 'no-es-correo' });
    expect(body.code).toBe('VALIDATION_ERROR');
    expect(body.message).toBe(
      'El campo «Correo electrónico» debe ser un correo electrónico válido.',
    );
    expect(body.details).toEqual([
      {
        field: 'email',
        message: 'El campo «Correo electrónico» debe ser un correo electrónico válido.',
      },
    ]);
  });

  it.each([
    [{ firstName: '' }, 'firstName', 'El campo «Nombre» es obligatorio.'],
    [
      { firstName: 'Anastasia' },
      'firstName',
      'El campo «Nombre» debe tener como máximo 5 caracteres.',
    ],
    [{ password: 'corta' }, 'password', 'El campo «Contraseña» debe tener al menos 8 caracteres.'],
    [{ color: 'GREEN' }, 'color', 'El campo «color» debe ser uno de estos valores: RED, BLUE.'],
  ])('translates %p', async (override, field, message) => {
    expect(await issueOf({ ...valid, ...override }, field)).toBe(message);
  });

  it('keeps the custom message a DTO declares', async () => {
    expect(await issueOf({ ...valid, code: 'abc' }, 'code')).toBe(
      'El código debe tener 4 dígitos.',
    );
  });

  it('names a field the endpoint does not accept', async () => {
    expect(await issueOf({ ...valid, role: 'MASTER' }, 'role')).toBe(
      'El campo «Rol» no está permitido.',
    );
  });

  it('points at the item of a list that fails', async () => {
    expect(await issueOf({ ...valid, lines: [{ quantity: 0 }] }, 'lines[0].quantity')).toBe(
      'El campo «Cantidad» (elemento 1) debe ser mayor o igual a 1.',
    );
    expect(await issueOf({ ...valid, lines: [{ quantity: 1 }, { quantity: 1 }] }, 'lines')).toBe(
      'El campo «Líneas» debe tener como máximo 1 elemento.',
    );
  });

  it('summarizes several issues and counts the rest', async () => {
    const body = await rejection({});
    expect(body.details.length).toBeGreaterThan(3);
    expect(body.message).toMatch(/^El campo «Nombre» .+ Y \d+ problemas? más\.$/);
  });
});

describe('summarizeIssues', () => {
  it('has a message even without issues', () => {
    expect(summarizeIssues([])).toBe('Los datos enviados no son válidos.');
  });
});
