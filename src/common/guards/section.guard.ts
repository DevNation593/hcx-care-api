import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { PrismaService } from '../../prisma/prisma.service';
import { IS_PUBLIC_KEY } from '../decorators/public.decorator';
import { PLATFORM_ROUTE_KEY } from '../decorators/platform-route.decorator';
import { REQUIRE_SECTION_KEY } from '../decorators/require-section.decorator';
import { SectionKey } from '../sections/section-catalog';
import { assertSectionInEffect } from '../sections/section-in-effect';

@Injectable()
export class SectionGuard implements CanActivate {
  constructor(
    private reflector: Reflector,
    private prisma: PrismaService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const targets = [context.getHandler(), context.getClass()];
    const section = this.reflector.getAllAndOverride<SectionKey | undefined>(
      REQUIRE_SECTION_KEY,
      targets,
    );
    if (!section) return true;

    const skipped = [IS_PUBLIC_KEY, PLATFORM_ROUTE_KEY].some((key) =>
      this.reflector.getAllAndOverride<boolean>(key, targets),
    );
    if (skipped) return true;

    const tenantId = context.switchToHttp().getRequest().user?.tenantId;
    await assertSectionInEffect(this.prisma, tenantId, section);
    return true;
  }
}
