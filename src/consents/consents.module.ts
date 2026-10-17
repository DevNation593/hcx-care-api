import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { ConsentTemplatesController } from './consent-templates.controller';
import { ConsentTemplatesService } from './consent-templates.service';

@Module({
  imports: [PrismaModule],
  controllers: [ConsentTemplatesController],
  providers: [ConsentTemplatesService],
  exports: [ConsentTemplatesService],
})
export class ConsentsModule {}
