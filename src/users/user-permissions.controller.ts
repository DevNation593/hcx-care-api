import { Controller, ForbiddenException, Get, Param } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { AuthUser, CurrentUser } from '../common/decorators/current-user.decorator';
import { UserPermissionsService } from './user-permissions.service';

@ApiTags('users')
@ApiBearerAuth('access-token')
@Controller('tenants/:tenantId/users/:userId/permissions')
export class UserPermissionsController {
  constructor(private readonly permissionsService: UserPermissionsService) {}

  @Get()
  @ApiOperation({
    summary: 'Permissions of a user',
    description: 'Effective permissions inherited from the caller’s clinic role.',
  })
  describe(
    @Param('tenantId') tenantId: string,
    @Param('userId') userId: string,
    @CurrentUser() user: AuthUser,
  ) {
    const targetId = userId === 'me' ? user.userId : userId;
    if (targetId !== user.userId) {
      throw new ForbiddenException('Solo puedes consultar los permisos de tu rol');
    }
    return this.permissionsService.describe(tenantId, targetId);
  }
}
