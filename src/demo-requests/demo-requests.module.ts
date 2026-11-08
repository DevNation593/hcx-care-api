import { Module } from '@nestjs/common';
import { MailModule } from '../mail/mail.module';
import { PrismaModule } from '../prisma/prisma.module';
import { DemoRequestsController, PlatformDemoRequestsController } from './demo-requests.controller';
import { DemoRequestsService } from './demo-requests.service';

@Module({
  imports: [PrismaModule, MailModule],
  controllers: [DemoRequestsController, PlatformDemoRequestsController],
  providers: [DemoRequestsService],
})
export class DemoRequestsModule {}
