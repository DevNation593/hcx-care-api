import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { BillingProfilesController } from './billing-profiles.controller';
import { BillingProfilesService } from './billing-profiles.service';

@Module({
  imports: [PrismaModule],
  controllers: [BillingProfilesController],
  providers: [BillingProfilesService],
  exports: [BillingProfilesService],
})
export class BillingProfilesModule {}
