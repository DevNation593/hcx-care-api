import { CanActivate, ExecutionContext, ForbiddenException, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { IS_PUBLIC_KEY } from '../decorators/public.decorator';
import { SESSION_ROUTE_KEY } from '../decorators/session-route.decorator';

/**
 * When the clinic requires two-factor sign-in, an account that has not set it up reaches only its
 * session routes (logout, password change, two-factor setup) until it does.
 */
@Injectable()
export class MfaEnrollmentGuard implements CanActivate {
  constructor(private reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const targets = [context.getHandler(), context.getClass()];

    if (this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, targets)) return true;
    if (this.reflector.getAllAndOverride<boolean>(SESSION_ROUTE_KEY, targets)) return true;

    const user = context.switchToHttp().getRequest().user;
    if (user?.mfaEnrollmentRequired === true) {
      throw new ForbiddenException({
        statusCode: 403,
        code: 'MFA_ENROLLMENT_REQUIRED',
        message: 'Tu consultorio exige la verificación en dos pasos. Configúrala para continuar.',
      });
    }

    return true;
  }
}
