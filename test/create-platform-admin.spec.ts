import { readInput } from '../prisma/create-platform-admin';

describe('platform:create-admin input', () => {
  const args = ['--email', 'dueno@psic.com', '--first-name', 'Ana', '--last-name=Ruiz'];

  it('reads the flags, in both spellings, before the environment', () => {
    expect(
      readInput([...args, '--password=Segura123'], { PLATFORM_ADMIN_EMAIL: 'otro@psic.com' }),
    ).toEqual({
      email: 'dueno@psic.com',
      password: 'Segura123',
      firstName: 'Ana',
      lastName: 'Ruiz',
      generated: false,
    });
  });

  it('still accepts the PLATFORM_ADMIN_* variables alone', () => {
    expect(
      readInput([], {
        PLATFORM_ADMIN_EMAIL: 'dueno@psic.com',
        PLATFORM_ADMIN_PASSWORD: 'Segura123',
        PLATFORM_ADMIN_FIRST_NAME: 'Ana',
        PLATFORM_ADMIN_LAST_NAME: 'Ruiz',
      }),
    ).toMatchObject({ email: 'dueno@psic.com', password: 'Segura123', generated: false });
  });

  it('generates a password when none is given', () => {
    const first = readInput(args, {});
    const second = readInput(args, {});
    expect(first.generated).toBe(true);
    expect(first.password).toMatch(/^[A-Za-z0-9_-]{16}$/);
    expect(first.password).not.toBe(second.password);
  });

  it('refuses missing names, a short password, a bad email and unknown options', () => {
    expect(() => readInput(['--email', 'dueno@psic.com'], {})).toThrow(
      'Falta --first-name, --last-name',
    );
    expect(() => readInput([...args, '--password', 'corta'], {})).toThrow('al menos 8');
    expect(() => readInput(['--email', 'no-es-correo', ...args.slice(2)], {})).toThrow(
      'Correo no válido',
    );
    expect(() => readInput([...args, '--rol', 'ADMIN'], {})).toThrow('Opción desconocida: --rol');
  });
});
