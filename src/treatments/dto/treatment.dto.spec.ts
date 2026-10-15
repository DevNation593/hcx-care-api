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
    expect(await check(CreateTreatmentDto, { name: 'Botox', version })).toEqual([]);
  });

  it.each([
    [{ name: 'Botox' }],
    [{ name: 'Botox', version: null }],
    [{ name: 'Botox', version: 'x' }],
  ])('rejects a missing or malformed version %j', async (body) => {
    expect(await fieldsWithErrors(CreateTreatmentDto, body)).toEqual(['version']);
  });
});

describe('UpdateTreatmentDto', () => {
  it('accepts a partial body and null for the nullable fields', async () => {
    expect(await check(UpdateTreatmentDto, {})).toEqual([]);
    expect(await check(UpdateTreatmentDto, { name: 'Toxina', isActive: false })).toEqual([]);
    expect(await check(UpdateTreatmentDto, { category: null, specialtyId: null })).toEqual([]);
  });

  it.each(['name', 'isActive'])('rejects null for %s', async (field) => {
    expect(await fieldsWithErrors(UpdateTreatmentDto, { [field]: null })).toEqual([field]);
  });
});
