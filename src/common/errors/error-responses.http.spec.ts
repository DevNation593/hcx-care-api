import {
  Body,
  Controller,
  Delete,
  Get,
  INestApplication,
  Post,
  ValidationPipe,
} from '@nestjs/common';
import { APP_FILTER } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import { Prisma } from '@prisma/client';
import { IsEmail, IsNotEmpty, IsString } from 'class-validator';
import request from 'supertest';
import { VALIDATION_PIPE_OPTIONS } from '../validation-options';
import { AllExceptionsFilter } from './all-exceptions.filter';

class ContactDto {
  @IsString()
  @IsNotEmpty()
  firstName!: string;

  @IsEmail()
  email!: string;
}

@Controller('probe')
class ProbeController {
  @Post()
  create(@Body() body: ContactDto) {
    return body;
  }

  @Delete()
  remove() {
    throw new Prisma.PrismaClientKnownRequestError('fk', { code: 'P2003', clientVersion: 'test' });
  }

  @Get('crash')
  crash() {
    throw new Error('database password leaked in this text');
  }
}

describe('Error responses over HTTP', () => {
  let app: INestApplication;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [ProbeController],
      providers: [{ provide: APP_FILTER, useClass: AllExceptionsFilter }],
    }).compile();
    app = moduleRef.createNestApplication({ logger: false });
    app.useGlobalPipes(new ValidationPipe(VALIDATION_PIPE_OPTIONS));
    await app.init();
  });

  afterAll(() => app.close());

  it('answers an invalid body with the Spanish reason and one issue per field', async () => {
    const res = await request(app.getHttpServer()).post('/probe').send({ email: 'x' }).expect(400);
    expect(res.body).toMatchObject({
      statusCode: 400,
      code: 'VALIDATION_ERROR',
      message:
        'El campo «Nombre» es obligatorio. El campo «Correo electrónico» debe ser un correo electrónico válido.',
    });
    expect(res.body.details).toContainEqual({
      field: 'email',
      message: 'El campo «Correo electrónico» debe ser un correo electrónico válido.',
    });
  });

  it('explains why a record in use cannot be deleted', async () => {
    const res = await request(app.getHttpServer()).delete('/probe').expect(409);
    expect(res.body).toMatchObject({ code: 'RECORD_IN_USE' });
  });

  it('answers an unknown route in Spanish', async () => {
    const res = await request(app.getHttpServer()).get('/nada').expect(404);
    expect(res.body.message).toBe('El recurso solicitado no existe.');
  });

  it('hides the cause of an unexpected error', async () => {
    const res = await request(app.getHttpServer()).get('/probe/crash').expect(500);
    expect(res.body.code).toBe('INTERNAL_ERROR');
    expect(JSON.stringify(res.body)).not.toContain('password');
  });
});
