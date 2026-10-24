import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { CreateTreatmentDto, UpdateTreatmentDto } from './treatment.dto';

// Same options as the global ValidationPipe in main.ts.
const check = async <T extends object>(type: new () => T, body: unknown) =>
  validate(plainToInstance(type, body, { enableImplicitConversion: true }), {
    whitelist: true,
    forbidNonWhitelisted: true,
  });

const fieldsWithErrors = async <T extends object>(type: new () => T, body: unknown) =>
  (await check(type, body)).map((error) => error.property);

describe('CreateTreatmentDto', () => {
  const version = { price: 10, taxRatePercent: 12, durationMinutes: 30 };

  it('accepts a treatment with its first version', async () => {
    expect(await check(CreateTreatmentDto, { name: 'Botox', code: 'BTX-01', version })).toEqual([]);
  });

  it('stores the code trimmed and in uppercase', async () => {
    const dto = plainToInstance(CreateTreatmentDto, { name: 'Botox', code: ' btx.01_a ', version });
    expect(await validate(dto)).toEqual([]);
    expect(dto.code).toBe('BTX.01_A');
  });

  it.each([
    [{ name: 'Botox', code: 'BTX-01' }],
    [{ name: 'Botox', code: 'BTX-01', version: null }],
    [{ name: 'Botox', code: 'BTX-01', version: 'x' }],
  ])('rejects a missing or malformed version %j', async (body) => {
    expect(await fieldsWithErrors(CreateTreatmentDto, body)).toEqual(['version']);
  });

  // The invoicing provider takes [A-Za-z0-9._-]{1,25}; five are kept for the fallback suffix.
  it.each([undefined, null, '', ' ', '-BTX', 'BTX 01', 'BTX/01', 'Ñ1', 'A'.repeat(21)])(
    'rejects the code %j',
    async (code) => {
      expect(await fieldsWithErrors(CreateTreatmentDto, { name: 'Botox', code, version })).toEqual([
        'code',
      ]);
    },
  );

  it('accepts a code of 20 characters', async () => {
    expect(
      await check(CreateTreatmentDto, { name: 'Botox', code: 'A'.repeat(20), version }),
    ).toEqual([]);
  });
});

describe('UpdateTreatmentDto', () => {
  it('accepts a partial body and null for the nullable fields', async () => {
    expect(await check(UpdateTreatmentDto, {})).toEqual([]);
    expect(await check(UpdateTreatmentDto, { name: 'Toxina', isActive: false })).toEqual([]);
    expect(await check(UpdateTreatmentDto, { code: 'tox-02' })).toEqual([]);
    expect(await check(UpdateTreatmentDto, { category: null, specialtyId: null })).toEqual([]);
  });

  it.each(['name', 'code', 'isActive'])('rejects null for %s', async (field) => {
    expect(await fieldsWithErrors(UpdateTreatmentDto, { [field]: null })).toEqual([field]);
  });
});
