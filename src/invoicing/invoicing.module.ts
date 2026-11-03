import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaModule } from '../prisma/prisma.module';
import { ClinicalAccessModule } from '../clinical-access/clinical-access.module';
import { PatientFilesModule } from '../patient-files/patient-files.module';
import { EmiteFacilProvider } from './provider/emite-facil.provider';
import { ConnectionService } from './connection.service';
import { InvoiceRequestsService } from './invoice-requests.service';
import { InvoiceWorkerService } from './invoice-worker.service';
import { InvoiceArtifactsService } from './invoice-artifacts.service';
import { InvoiceResolver } from './invoice-resolver';
import { InvoiceWebhookService } from './invoice-webhook.service';
import { InvoicingController, InvoicingWebhookController } from './invoicing.controller';
import { IssuerService } from './issuer.service';
import { SriClient } from './sri/sri-client';
@Module({
  imports: [PrismaModule, ClinicalAccessModule, PatientFilesModule],
  controllers: [InvoicingController, InvoicingWebhookController],
  providers: [
    EmiteFacilProvider,
    ConnectionService,
    InvoiceRequestsService,
    InvoiceWorkerService,
    InvoiceArtifactsService,
    InvoiceResolver,
    InvoiceWebhookService,
    IssuerService,
    {
      provide: SriClient,
      useFactory: (config: ConfigService) =>
        new SriClient({
          testBaseUrl:
            process.env.NODE_ENV === 'test' ? config.get<string>('SRI_TEST_BASE_URL') : undefined,
        }),
      inject: [ConfigService],
    },
  ],
  exports: [InvoiceRequestsService],
})
export class InvoicingModule {}
