import { Controller, HttpCode, HttpStatus, Param, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { RequireSection } from '../common/decorators/require-section.decorator';
import { Roles } from '../common/decorators/roles.decorator';
import { MfaService } from './mfa.service';

@ApiTags('auth')
@ApiBearerAuth('access-token')
@Controller('tenants/:tenantId/users')
export class UserMfaController {
  constructor(private readonly mfa: MfaService) {}

  @Roles('MASTER')
  @RequireSection('core.admin.team')
  @Post(':userId/mfa/reset')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Remove the second factor of a team member who lost it - Master only',
    description:
      'Ends their sessions. If the clinic requires two-factor sign-in they set it up again at their next sign-in.',
  })
  reset(
    @Param('tenantId') tenantId: string,
    @Param('userId') userId: string,
    @CurrentUser() actor: { userId: string },
  ) {
    return this.mfa.resetForUser(tenantId, actor.userId, userId);
  }
}
