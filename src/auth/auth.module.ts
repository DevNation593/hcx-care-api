import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { PassportModule } from '@nestjs/passport';
import { ConfigModule } from '@nestjs/config';
import { APP_GUARD, APP_INTERCEPTOR } from '@nestjs/core';
import { AuthService } from './auth.service';
import { AuthController } from './auth.controller';
import { JwtStrategy } from './strategies/jwt.strategy';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { PasswordChangeGuard } from '../common/guards/password-change.guard';
import { MfaEnrollmentGuard } from '../common/guards/mfa-enrollment.guard';
import { ClinicalAccessModule } from '../clinical-access/clinical-access.module';
import { MfaService } from './mfa.service';
import { UserMfaController } from './user-mfa.controller';
import { RolesGuard } from '../common/guards/roles.guard';
import { TenantGuard } from '../common/guards/tenant.guard';
import { SubscriptionGuard } from '../common/guards/subscription.guard';
import { SectionGuard } from '../common/guards/section.guard';
import { PermissionGuard } from '../common/guards/permission.guard';
import { RlsContextInterceptor } from '../common/interceptors/rls-context.interceptor';
import { MailModule } from '../mail/mail.module';

@Module({
  imports: [PassportModule, JwtModule.register({}), ConfigModule, MailModule, ClinicalAccessModule],
  controllers: [AuthController, UserMfaController],
  providers: [
    AuthService,
    MfaService,
    JwtStrategy,
    {
      provide: APP_GUARD,
      useClass: JwtAuthGuard,
    },
    {
      provide: APP_GUARD,
      useClass: PasswordChangeGuard,
    },
    {
      provide: APP_GUARD,
      useClass: MfaEnrollmentGuard,
    },
    {
      provide: APP_GUARD,
      useClass: TenantGuard,
    },
    {
      provide: APP_GUARD,
      useClass: RolesGuard,
    },
    {
      provide: APP_GUARD,
      useClass: SubscriptionGuard,
    },
    {
      provide: APP_GUARD,
      useClass: SectionGuard,
    },
    {
      provide: APP_GUARD,
      useClass: PermissionGuard,
    },
    {
      provide: APP_INTERCEPTOR,
      useClass: RlsContextInterceptor,
    },
  ],
  exports: [AuthService],
})
export class AuthModule {}
