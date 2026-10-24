import {
  Controller,
  Get,
  Post,
  Body,
  Patch,
  Param,
  Delete,
  Query,
  UseInterceptors,
  UploadedFile,
  BadRequestException,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse, ApiBearerAuth, ApiQuery } from '@nestjs/swagger';
import { FileInterceptor } from '@nestjs/platform-express';
import { UsersService } from './users.service';
import {
  CreateTenantUserDto,
  UpdateUserDto,
  ActivateUserDto,
  ChangePasswordDto,
} from './dto/user.dto';
import { UpdateSelfProfileDto } from './dto/update-self-profile.dto';
import { Roles } from '../common/decorators/roles.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { UserRole } from '@prisma/client';
import { RequireSection } from '../common/decorators/require-section.decorator';

@ApiTags('users')
@ApiBearerAuth('access-token')
@Controller('tenants/:tenantId/users')
export class UsersController {
  constructor(private readonly usersService: UsersService) {}

  @Get()
  @ApiOperation({ summary: 'List all users in tenant' })
  @ApiQuery({
    name: 'role',
    required: false,
    enum: UserRole,
  })
  @ApiQuery({ name: 'isActive', required: false, type: Boolean })
  @ApiResponse({ status: 200, description: 'Users list' })
  async findAll(
    @Param('tenantId') tenantId: string,
    @Query('role') role?: string,
    @Query('isActive') isActive?: string,
  ) {
    const filters: any = {};
    if (role) filters.role = role;
    if (isActive !== undefined) filters.isActive = isActive === 'true';

    return this.usersService.findAll(tenantId, filters);
  }

  @Roles('MASTER')
  @RequireSection('core.admin.team')
  @Post()
  @ApiOperation({ summary: 'Create an active clinic team member - Master only' })
  @ApiResponse({ status: 201, description: 'Team member created' })
  async create(
    @Param('tenantId') tenantId: string,
    @Body() dto: CreateTenantUserDto,
    @CurrentUser() actor: { userId: string },
  ) {
    return this.usersService.createForTenant(tenantId, dto, actor.userId);
  }

  @Get(':userId')
  @ApiOperation({ summary: 'Get user by ID' })
  @ApiResponse({ status: 200, description: 'User found' })
  @ApiResponse({ status: 404, description: 'User not found' })
  async findOne(@Param('tenantId') tenantId: string, @Param('userId') userId: string) {
    return this.usersService.findOne(tenantId, userId);
  }

  @Patch('me')
  @ApiOperation({ summary: 'Update the authenticated user profile' })
  @ApiResponse({ status: 200, description: 'Own profile updated' })
  async updateSelf(
    @Param('tenantId') tenantId: string,
    @CurrentUser() user: any,
    @Body() updateSelfProfileDto: UpdateSelfProfileDto,
  ) {
    return this.usersService.updateSelf(tenantId, user.userId, updateSelfProfileDto);
  }

  @Roles('MASTER')
  @RequireSection('core.admin.team')
  @Patch(':userId')
  @ApiOperation({ summary: 'Update user - Master only' })
  @ApiResponse({ status: 200, description: 'User updated' })
  async update(
    @Param('tenantId') tenantId: string,
    @Param('userId') userId: string,
    @Body() updateUserDto: UpdateUserDto,
    @CurrentUser() actor: { userId: string },
  ) {
    return this.usersService.update(tenantId, userId, updateUserDto, actor.userId);
  }

  @Roles('MASTER')
  @RequireSection('core.admin.team')
  @Delete(':userId')
  @ApiOperation({ summary: 'Deactivate user - Master only (soft delete)' })
  @ApiResponse({ status: 200, description: 'User deactivated and seat freed' })
  async deactivate(
    @Param('tenantId') tenantId: string,
    @Param('userId') userId: string,
    @CurrentUser() actor: { userId: string },
  ) {
    return this.usersService.deactivate(tenantId, userId, actor.userId);
  }

  @Roles('MASTER')
  @RequireSection('core.admin.team')
  @Post(':userId/activate')
  @ApiOperation({ summary: 'Activate a pending legacy invitation - Master only' })
  @ApiResponse({ status: 201, description: 'Pending invitation activated' })
  @ApiResponse({ status: 403, description: 'Provider-managed users require provider access grant' })
  @ApiResponse({ status: 409, description: 'ACTIVATION_NOT_PENDING' })
  async activate(
    @Param('tenantId') tenantId: string,
    @Param('userId') userId: string,
    @Body() activateUserDto: ActivateUserDto,
    @CurrentUser() actor: { userId: string },
  ) {
    return this.usersService.activate(tenantId, userId, activateUserDto.password, actor.userId);
  }

  @Post(':userId/avatar')
  @UseInterceptors(
    FileInterceptor('file', {
      limits: { fileSize: 5 * 1024 * 1024 }, // 5MB
    }),
  )
  @ApiOperation({ summary: 'Upload/update user avatar' })
  @ApiResponse({ status: 200, description: 'Avatar updated' })
  async uploadAvatar(
    @Param('tenantId') tenantId: string,
    @Param('userId') userId: string,
    @UploadedFile() file: any,
    @CurrentUser() currentUser: any,
  ) {
    if (!file) {
      throw new BadRequestException('No se subió ningún archivo');
    }
    return this.usersService.uploadAvatar(
      tenantId,
      userId,
      currentUser.userId,
      currentUser.role,
      file,
    );
  }

  @Post('me/change-password')
  @ApiOperation({
    summary: 'Change own password',
    description:
      'Authenticated user changes their own password by providing current and new password.',
  })
  @ApiResponse({ status: 200, description: 'Password changed successfully' })
  @ApiResponse({ status: 400, description: 'Current password is incorrect' })
  async changePassword(
    @Param('tenantId') tenantId: string,
    @Body() changePasswordDto: ChangePasswordDto,
    @CurrentUser() user: any,
  ) {
    return this.usersService.changePassword(
      tenantId,
      user.userId,
      changePasswordDto.currentPassword,
      changePasswordDto.newPassword,
    );
  }
}
