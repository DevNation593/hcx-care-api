import { ForbiddenException, Injectable } from '@nestjs/common';
import * as bcrypt from 'bcrypt';
import { PrismaService } from '../prisma/prisma.service';

const invalid = (message: string) =>
  new ForbiddenException({ statusCode: 403, code: 'SIGNATURE_PASSWORD_INVALID', message });

/**
 * A signature revalidates who signs: the professional types their password again, even with a
 * valid session. Closing an encounter, saving an addendum and saving a record outside any
 * encounter are signatures; the encounter a treatment session closes by itself is not asked.
 * It answers 403, never 401: a wrong password must not end the session. The password is only
 * compared, never stored nor logged.
 */
@Injectable()
export class SignerVerificationService {
  constructor(private readonly prisma: PrismaService) {}

  async verify(userId: string, password: string | undefined): Promise<void> {
    if (!password) throw invalid('Para firmar escribe tu contraseña.');
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { password: true, isActive: true },
    });
    if (!user?.isActive || !(await bcrypt.compare(password, user.password))) {
      throw invalid('La contraseña no es correcta. Escríbela de nuevo para firmar.');
    }
  }
}
