import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';
import { CreateDemoRequestDto } from './demo-request.dto';

const valid = {
  name: '  Ana Vega ',
  clinic: 'Centro Vida',
  email: ' Ana@Example.com ',
  phone: '+593 99 123-4567',
  teamSize: '2-5',
  acceptPrivacy: true,
};

const errorsOf = (input: object) =>
  validateSync(plainToInstance(CreateDemoRequestDto, input)).map((error) => error.property);

describe('CreateDemoRequestDto', () => {
  it('accepts a complete request and normalizes the text', () => {
    const dto = plainToInstance(CreateDemoRequestDto, valid);
    expect(validateSync(dto)).toEqual([]);
    expect(dto.name).toBe('Ana Vega');
    expect(dto.email).toBe('ana@example.com');
  });

  it.each([
    ['name', { name: 'A' }],
    ['clinic', { clinic: ' ' }],
    ['email', { email: 'no-es-correo' }],
    ['phone', { phone: '12' }],
    ['teamSize', { teamSize: '100' }],
    ['message', { message: 'x'.repeat(501) }],
    ['acceptPrivacy', { acceptPrivacy: false }],
  ])('rejects an invalid %s', (field, override) => {
    expect(errorsOf({ ...valid, ...override })).toEqual([field]);
  });
});
