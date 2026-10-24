import { Controller, Get, Post, Put, Delete, Param, Body, Query, Headers } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse, ApiBearerAuth, ApiQuery } from '@nestjs/swagger';
import { NotificationsService } from './notifications.service';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { RequireFeature } from '../common/decorators/require-feature.decorator';
import { RequireSection } from '../common/decorators/require-section.decorator';
import { NotificationPreferencesService } from './notification-preferences.service';
import { WebPushService } from './web-push/web-push.service';
import {
  RegisterFcmTokenDto,
  RemoveWebPushSubscriptionDto,
  UpdateNotificationPreferencesDto,
  WebPushSubscriptionDto,
} from './dto/notification.dto';

@ApiTags('notifications')
@ApiBearerAuth('access-token')
@Controller('tenants/:tenantId/notifications')
export class NotificationsController {
  constructor(
    private readonly notificationsService: NotificationsService,
    private readonly preferences: NotificationPreferencesService,
    private readonly webPush: WebPushService,
  ) {}

  @Get('preferences')
  @ApiOperation({ summary: 'What the current user wants to be notified about' })
  getPreferences(@CurrentUser() user: any) {
    return this.preferences.get(user.userId);
  }

  @Put('preferences')
  @ApiOperation({
    summary: 'Update the notification preferences of the current user',
    description: 'The server applies them: a reminder that is turned off is never created.',
  })
  updatePreferences(@CurrentUser() user: any, @Body() dto: UpdateNotificationPreferencesDto) {
    return this.preferences.update(user.userId, dto);
  }

  @Get('web-push/public-key')
  @ApiOperation({ summary: 'VAPID public key browsers subscribe with' })
  getWebPushKey() {
    return { enabled: this.webPush.isEnabled, publicKey: this.webPush.publicKey };
  }

  @Post('web-push/subscriptions')
  @RequireFeature('webPush')
  @RequireSection('core.agenda.notifications')
  @ApiOperation({
    summary: 'Register this browser for Web Push',
    description:
      'Body: the result of PushSubscription.toJSON(). A user can register several browsers.',
  })
  subscribeWebPush(
    @Param('tenantId') tenantId: string,
    @CurrentUser() user: any,
    @Body() dto: WebPushSubscriptionDto,
    @Headers('user-agent') userAgent?: string,
  ) {
    return this.webPush.subscribe(tenantId, user.userId, dto, userAgent);
  }

  @Delete('web-push/subscriptions')
  @ApiOperation({ summary: 'Stop sending Web Push to this browser' })
  unsubscribeWebPush(@CurrentUser() user: any, @Body() dto: RemoveWebPushSubscriptionDto) {
    return this.webPush.unsubscribe(user.userId, dto.endpoint);
  }

  @Get()
  @ApiOperation({ summary: 'Get user notifications' })
  @ApiQuery({ name: 'unreadOnly', required: false, type: Boolean })
  @ApiResponse({ status: 200, description: 'Notifications list' })
  async getUserNotifications(
    @Param('tenantId') tenantId: string,
    @CurrentUser() user: any,
    @Query('unreadOnly') unreadOnly?: string,
  ) {
    const notifications = await this.notificationsService.getUserNotifications(
      tenantId,
      user.userId,
      unreadOnly === 'true',
    );
    // Transform readAt to isRead and body to message for frontend compatibility
    return notifications.map((n: any) => ({
      ...n,
      isRead: !!n.readAt,
      message: n.body || n.message,
    }));
  }

  @Post('fcm-token')
  @ApiOperation({
    summary: 'Register the FCM token of the mobile app',
    description:
      'Mobile only. Browsers use web-push/subscriptions: a browser endpoint is not an FCM token.',
  })
  @ApiResponse({ status: 201, description: 'FCM token registered' })
  async registerFcmToken(
    @Param('tenantId') tenantId: string,
    @Body() dto: RegisterFcmTokenDto,
    @CurrentUser() user: any,
  ) {
    return this.notificationsService.registerFcmToken(tenantId, user.userId, dto.token);
  }

  @Delete('fcm-token')
  @ApiOperation({
    summary: 'Remove FCM token (logout / disable push)',
    description: 'Call this on logout to stop receiving push notifications on this device.',
  })
  @ApiResponse({ status: 200, description: 'FCM token removed' })
  async removeFcmToken(@Param('tenantId') tenantId: string, @CurrentUser() user: any) {
    return this.notificationsService.removeFcmToken(tenantId, user.userId);
  }

  @Post(':notificationId/read')
  @ApiOperation({ summary: 'Mark notification as read' })
  @ApiResponse({ status: 200, description: 'Notification marked as read' })
  async markAsRead(
    @Param('tenantId') tenantId: string,
    @Param('notificationId') notificationId: string,
    @CurrentUser() user: any,
  ) {
    const notification = await this.notificationsService.markAsRead(
      tenantId,
      notificationId,
      user.userId,
    );
    if (notification) {
      return {
        ...notification,
        isRead: true,
        message: (notification as any).body || (notification as any).message,
      };
    }
    return notification;
  }

  @Post('read-all')
  @ApiOperation({ summary: 'Mark all notifications as read' })
  @ApiResponse({ status: 200, description: 'All notifications marked as read' })
  async markAllAsRead(@Param('tenantId') tenantId: string, @CurrentUser() user: any) {
    return this.notificationsService.markAllAsRead(tenantId, user.userId);
  }
}
