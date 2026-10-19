import { INestApplication } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { IS_PUBLIC_KEY } from '../common/decorators/public.decorator';
import { SpecialtyCatalogController } from './specialty-catalog.controller';
import { SpecialtyCatalogService } from './specialty-catalog.service';
import { SpecialtiesController } from './specialties.controller';

describe('SpecialtyCatalogController', () => {
  let app: INestApplication;
  const catalog = {
    listActive: jest.fn().mockResolvedValue([
      {
        id: 'psy',
        code: 'PSYCHOLOGY',
        name: 'Psicología',
        description: null,
        modules: [{ id: 'notes', moduleKey: 'psychology.notes' }],
      },
    ]),
  };

  beforeAll(async () => {
    const module = await Test.createTestingModule({
      controllers: [SpecialtyCatalogController],
      providers: [{ provide: SpecialtyCatalogService, useValue: catalog }],
    }).compile();
    app = module.createNestApplication();
    await app.init();
  });

  afterAll(async () => {
    await app?.close();
  });

  it('serves the catalog at GET /specialties', async () => {
    await request(app.getHttpServer())
      .get('/specialties')
      .expect(200)
      .expect([
        {
          id: 'psy',
          code: 'PSYCHOLOGY',
          name: 'Psicología',
          description: null,
          modules: [{ id: 'notes', moduleKey: 'psychology.notes' }],
        },
      ]);
    expect(catalog.listActive).toHaveBeenCalledTimes(1);
  });

  it('marks only the catalog route public', () => {
    const reflector = new Reflector();
    expect(reflector.get(IS_PUBLIC_KEY, SpecialtyCatalogController.prototype.list)).toBe(true);
    expect(reflector.get(IS_PUBLIC_KEY, SpecialtiesController)).toBeUndefined();
    expect(
      reflector.get(IS_PUBLIC_KEY, SpecialtiesController.prototype.listSpecialties),
    ).toBeUndefined();
  });
});
