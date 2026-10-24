import { CanActivate, ExecutionContext, ForbiddenException, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { PrismaService } from '../../prisma/prisma.service';
import { IS_PUBLIC_KEY } from '../decorators/public.decorator';
import { PLATFORM_ROUTE_KEY } from '../decorators/platform-route.decorator';
import { REQUIRE_SECTION_KEY } from '../decorators/require-section.decorator';
import { SectionKey, isSectionInEffect, sectionDefinition } from '../sections/section-catalog';

function sectionWithParent(section: SectionKey): SectionKey[] {
  const { parent } = sectionDefinition(section);
  return parent ? [parent, section] : [section];
}

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

    // Fail closed: a missing row is treated exactly like a disabled section. A submodule
    // also needs its module's row on.
    const rows = tenantId
      ? await this.prisma.tenantModule.findMany({
          where: { tenantId, moduleKey: { in: sectionWithParent(section) }, enabled: true },
          select: { moduleKey: true },
        })
      : [];

    if (!isSectionInEffect(section, new Set(rows.map(({ moduleKey }) => moduleKey)))) {
      throw new ForbiddenException({
        statusCode: 403,
        code: 'SECTION_NOT_ENABLED',
        message: 'Esta sección no está habilitada para tu consultorio.',
        section,
      });
    }
    return true;
  }
}
