import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { UpdateTenantDto } from './tenant.dto';

describe('UpdateTenantDto', () => {
  const parse = (body: Record<string, unknown>) => plainToInstance(UpdateTenantDto, body);
  const errorsFor = async (body: Record<string, unknown>) =>
    (await validate(parse(body))).map((error) => error.property);

  it('rejects a blank name instead of leaving the clinic without one', async () => {
    expect(await errorsFor({ name: '   ' })).toEqual(['name']);
  });

  it('trims the texts and lowercases the email', () => {
    const dto = parse({ name: '  Consultorio Bienestar ', email: ' Contacto@Bienestar.EC ' });
    expect(dto.name).toBe('Consultorio Bienestar');
    expect(dto.email).toBe('contacto@bienestar.ec');
  });

  it('accepts an empty phone or address, which clears them', async () => {
    expect(await errorsFor({ phone: '', address: '' })).toEqual([]);
  });

  it('rejects an invalid email and over-long fields', async () => {
    expect(await errorsFor({ email: 'no-es-correo' })).toEqual(['email']);
    expect(await errorsFor({ name: 'x'.repeat(121), address: 'x'.repeat(301) })).toEqual([
      'name',
      'address',
    ]);
  });
});
