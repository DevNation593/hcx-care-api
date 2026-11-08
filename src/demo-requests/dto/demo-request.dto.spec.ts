import { ArgumentMetadata, BadRequestException, ValidationPipe } from '@nestjs/common';
import { VALIDATION_PIPE_OPTIONS } from '../../common/validation-options';
import { CreateDemoRequestDto } from './demo-request.dto';

const valid = {
  name: '  Ana Vega ',
  clinic: 'Centro Vida',
  email: ' Ana@Example.com ',
  phone: '+593 99 123-4567',
  teamSize: '2-5',
  acceptPrivacy: true,
};

// The same pipe, with the same implicit conversion, that main.ts installs globally.
const pipe = new ValidationPipe(VALIDATION_PIPE_OPTIONS);
const metadata: ArgumentMetadata = { type: 'body', metatype: CreateDemoRequestDto };

const parse = (input: object) => pipe.transform(input, metadata) as Promise<CreateDemoRequestDto>;

async function rejectedFields(input: object): Promise<string[]> {
  try {
    await parse(input);
  } catch (error) {
    expect(error).toBeInstanceOf(BadRequestException);
    const messages = (error as BadRequestException).getResponse() as { message: string[] };
    return [...new Set(messages.message.map((message) => message.split(' ')[0]))];
  }
  throw new Error('The request was accepted');
}

describe('CreateDemoRequestDto', () => {
  it('accepts a complete request and normalizes the text', async () => {
    const dto = await parse(valid);
    expect(dto.name).toBe('Ana Vega');
    expect(dto.email).toBe('ana@example.com');
    expect(dto.acceptPrivacy).toBe(true);
  });

  it.each([
    ['name', { name: 'A' }],
    ['clinic', { clinic: ' ' }],
    ['email', { email: 'no-es-correo' }],
    ['phone', { phone: '12' }],
    ['teamSize', { teamSize: '100' }],
    ['message', { message: 'x'.repeat(501) }],
    ['acceptPrivacy', { acceptPrivacy: false }],
  ])('rejects an invalid %s', async (field, override) => {
    expect(await rejectedFields({ ...valid, ...override })).toEqual([field]);
  });

  // Implicit conversion turns any non-empty string into true: consent must be the literal true.
  it.each([['false'], ['true'], ['0'], [1], [null]])(
    'rejects the privacy consent sent as %p',
    async (acceptPrivacy) => {
      expect(await rejectedFields({ ...valid, acceptPrivacy })).toEqual(['acceptPrivacy']);
    },
  );

  it('rejects a request without the privacy consent', async () => {
    const { acceptPrivacy: _omitted, ...withoutConsent } = valid;
    expect(await rejectedFields(withoutConsent)).toEqual(['acceptPrivacy']);
  });

  it('rejects fields the form does not send', async () => {
    expect(await rejectedFields({ ...valid, status: 'CLOSED' })).toEqual(['property']);
  });
});
