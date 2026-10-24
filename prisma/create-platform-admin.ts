import { PrismaClient } from '@prisma/client';
import * as bcrypt from 'bcrypt';
import { randomBytes } from 'crypto';

export interface PlatformAdminInput {
  email: string;
  password: string;
  firstName: string;
  lastName: string;
}

export async function createPlatformAdmin(
  client: PrismaClient,
  input: PlatformAdminInput,
): Promise<{ tenantId: string; userId: string }> {
  const existing = await client.user.findFirst({
    where: { email: { equals: input.email, mode: 'insensitive' } },
    select: { id: true },
  });
  if (existing) throw new Error(`Ya existe un usuario con el correo ${input.email}`);

  const passwordHash = await bcrypt.hash(input.password, 10);
  const platform = await client.tenant.findFirst({ where: { isPlatform: true } });
  const tenant =
    platform ??
    (await client.tenant.create({
      data: {
        name: 'Plataforma',
        email: input.email,
        isPlatform: true,
        onboardingCompleted: true,
      },
    }));

  const user = await client.user.create({
    data: {
      tenantId: tenant.id,
      email: input.email,
      password: passwordHash,
      firstName: input.firstName,
      lastName: input.lastName,
      role: 'ADMIN',
      isActive: true,
      emailVerified: true,
      mustChangePassword: false,
    },
  });
  return { tenantId: tenant.id, userId: user.id };
}

const OPTIONS = {
  email: 'PLATFORM_ADMIN_EMAIL',
  password: 'PLATFORM_ADMIN_PASSWORD',
  'first-name': 'PLATFORM_ADMIN_FIRST_NAME',
  'last-name': 'PLATFORM_ADMIN_LAST_NAME',
} as const;

const USAGE =
  'Uso: npm run platform:create-admin -- --email <correo> --first-name <nombre> --last-name <apellido> [--password <contraseña>]';

/**
 * Reads `--email`, `--first-name`, `--last-name` and `--password` (as `--name value` or
 * `--name=value`), each one falling back to its PLATFORM_ADMIN_* variable. Without a password,
 * one is generated: `generated` says so, because it is shown only once.
 */
export function readInput(
  argv: readonly string[],
  env: NodeJS.ProcessEnv,
): PlatformAdminInput & { generated: boolean } {
  const flags: Partial<Record<keyof typeof OPTIONS, string>> = {};
  for (let index = 0; index < argv.length; index += 1) {
    const match = argv[index].match(/^--([a-z-]+)(?:=(.*))?$/);
    const name = match?.[1] as keyof typeof OPTIONS | undefined;
    if (!name || !(name in OPTIONS))
      throw new Error(`Opción desconocida: ${argv[index]}\n${USAGE}`);
    flags[name] = match[2] ?? argv[++index];
  }
  const value = (name: keyof typeof OPTIONS) => (flags[name] ?? env[OPTIONS[name]])?.trim();

  const missing = (['email', 'first-name', 'last-name'] as const).filter((name) => !value(name));
  if (missing.length > 0) {
    throw new Error(`Falta ${missing.map((name) => `--${name}`).join(', ')}\n${USAGE}`);
  }
  const email = value('email')!;
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new Error(`Correo no válido: ${email}`);

  const given = value('password');
  if (given !== undefined && given.length < 8) {
    throw new Error('La contraseña debe tener al menos 8 caracteres');
  }
  return {
    email,
    password: given ?? randomBytes(12).toString('base64url'),
    firstName: value('first-name')!,
    lastName: value('last-name')!,
    generated: given === undefined,
  };
}

if (require.main === module) {
  let client: PrismaClient | undefined;
  Promise.resolve()
    .then(async () => {
      await import('dotenv/config');
      const { generated, ...input } = readInput(process.argv.slice(2), process.env);
      client = new PrismaClient();
      await createPlatformAdmin(client, input);
      console.log(`✅ Administrador de la plataforma creado: ${input.email}`);
      if (generated) {
        console.log(`Contraseña generada (guárdala, no se vuelve a mostrar): ${input.password}`);
      }
    })
    .catch((error: unknown) => {
      console.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    })
    .finally(() => client?.$disconnect());
}
