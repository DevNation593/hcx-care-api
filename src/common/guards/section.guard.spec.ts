import { ExecutionContext, ForbiddenException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { PrismaService } from '../../prisma/prisma.service';
import { Public } from '../decorators/public.decorator';
import { PlatformRoute } from '../decorators/platform-route.decorator';
import { RequireSection } from '../decorators/require-section.decorator';
import { SectionGuard } from './section.guard';

@RequireSection('core.agenda.tasks')
class TasksLikeController {
  handler() {}
}

@RequireSection('core.admin')
class ModuleLikeController {
  handler() {}
}

@RequireSection('core.agenda.tasks')
@PlatformRoute()
class GatedPlatformController {
  handler() {}
}

@RequireSection('core.agenda.tasks')
class PublicHandlerController {
  @Public()
  handler() {}
}

class UngatedController {
  handler() {}
}

describe('SectionGuard', () => {
  const prisma = { tenantModule: { findMany: jest.fn() } };
  const guard = new SectionGuard(new Reflector(), prisma as unknown as PrismaService);
  const enabledRows = (...keys: string[]) =>
    prisma.tenantModule.findMany.mockResolvedValue(keys.map((moduleKey) => ({ moduleKey })));

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
    expect(prisma.tenantModule.findMany).not.toHaveBeenCalled();
  });

  it('passes when the submodule and its module are enabled', async () => {
    enabledRows('core.agenda', 'core.agenda.tasks');

    await expect(guard.canActivate(contextFor(TasksLikeController))).resolves.toBe(true);
    expect(prisma.tenantModule.findMany).toHaveBeenCalledWith({
      where: {
        tenantId: 'tenant-1',
        moduleKey: { in: ['core.agenda', 'core.agenda.tasks'] },
        enabled: true,
      },
      select: { moduleKey: true },
    });
  });

  it('reads only its own row for a module', async () => {
    enabledRows('core.admin');

    await expect(guard.canActivate(contextFor(ModuleLikeController))).resolves.toBe(true);
    expect(prisma.tenantModule.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ moduleKey: { in: ['core.admin'] } }),
      }),
    );
  });

  it('rejects a disabled submodule with SECTION_NOT_ENABLED', async () => {
    enabledRows('core.agenda');

    const attempt = guard.canActivate(contextFor(TasksLikeController));
    await expect(attempt).rejects.toThrow(ForbiddenException);
    await expect(attempt).rejects.toMatchObject({
      status: 403,
      response: {
        statusCode: 403,
        code: 'SECTION_NOT_ENABLED',
        message: 'Esta sección no está habilitada para tu consultorio.',
        section: 'core.agenda.tasks',
      },
    });
  });

  it('rejects an enabled submodule whose module is off', async () => {
    enabledRows('core.agenda.tasks');

    await expect(guard.canActivate(contextFor(TasksLikeController))).rejects.toMatchObject({
      response: { code: 'SECTION_NOT_ENABLED', section: 'core.agenda.tasks' },
    });
  });

  it('rejects when the tenant has no rows', async () => {
    enabledRows();

    await expect(guard.canActivate(contextFor(TasksLikeController))).rejects.toMatchObject({
      response: { code: 'SECTION_NOT_ENABLED', section: 'core.agenda.tasks' },
    });
  });

  it('skips platform routes', async () => {
    await expect(guard.canActivate(contextFor(GatedPlatformController))).resolves.toBe(true);
    expect(prisma.tenantModule.findMany).not.toHaveBeenCalled();
  });

  it('skips public routes', async () => {
    await expect(guard.canActivate(contextFor(PublicHandlerController))).resolves.toBe(true);
    expect(prisma.tenantModule.findMany).not.toHaveBeenCalled();
  });
});
