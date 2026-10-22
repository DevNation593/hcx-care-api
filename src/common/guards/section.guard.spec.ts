import { ExecutionContext, ForbiddenException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { PrismaService } from '../../prisma/prisma.service';
import { Public } from '../decorators/public.decorator';
import { PlatformRoute } from '../decorators/platform-route.decorator';
import { RequireSection } from '../decorators/require-section.decorator';
import { SectionGuard } from './section.guard';

@RequireSection('core.tasks')
class TasksLikeController {
  handler() {}
}

@RequireSection('core.tasks')
@PlatformRoute()
class GatedPlatformController {
  handler() {}
}

@RequireSection('core.tasks')
class PublicHandlerController {
  @Public()
  handler() {}
}

class UngatedController {
  handler() {}
}

describe('SectionGuard', () => {
  const prisma = { tenantModule: { findUnique: jest.fn() } };
  const guard = new SectionGuard(new Reflector(), prisma as unknown as PrismaService);

  const contextFor = (controller: { prototype: { handler: () => void } }) =>
    ({
      getHandler: () => controller.prototype.handler,
      getClass: () => controller,
      switchToHttp: () => ({
        getRequest: () => ({ user: { userId: 'user-1', tenantId: 'tenant-1', role: 'MASTER' } }),
      }),
    }) as unknown as ExecutionContext;

  beforeEach(() => {
    jest.resetAllMocks();
  });

  it('passes when the route requires no section', async () => {
    await expect(guard.canActivate(contextFor(UngatedController))).resolves.toBe(true);
    expect(prisma.tenantModule.findUnique).not.toHaveBeenCalled();
  });

  it('passes when the section row is enabled', async () => {
    prisma.tenantModule.findUnique.mockResolvedValue({ enabled: true });

    await expect(guard.canActivate(contextFor(TasksLikeController))).resolves.toBe(true);
    expect(prisma.tenantModule.findUnique).toHaveBeenCalledWith({
      where: { tenantId_moduleKey: { tenantId: 'tenant-1', moduleKey: 'core.tasks' } },
      select: { enabled: true },
    });
  });

  it('rejects a disabled section with SECTION_NOT_ENABLED', async () => {
    prisma.tenantModule.findUnique.mockResolvedValue({ enabled: false });

    const attempt = guard.canActivate(contextFor(TasksLikeController));
    await expect(attempt).rejects.toThrow(ForbiddenException);
    await expect(attempt).rejects.toMatchObject({
      status: 403,
      response: {
        statusCode: 403,
        code: 'SECTION_NOT_ENABLED',
        message: 'Esta sección no está habilitada para tu consultorio.',
        section: 'core.tasks',
      },
    });
  });

  it('rejects when the tenant has no row for the section', async () => {
    prisma.tenantModule.findUnique.mockResolvedValue(null);

    await expect(guard.canActivate(contextFor(TasksLikeController))).rejects.toMatchObject({
      response: { code: 'SECTION_NOT_ENABLED', section: 'core.tasks' },
    });
  });

  it('skips platform routes', async () => {
    await expect(guard.canActivate(contextFor(GatedPlatformController))).resolves.toBe(true);
    expect(prisma.tenantModule.findUnique).not.toHaveBeenCalled();
  });

  it('skips public routes', async () => {
    await expect(guard.canActivate(contextFor(PublicHandlerController))).resolves.toBe(true);
    expect(prisma.tenantModule.findUnique).not.toHaveBeenCalled();
  });
});
