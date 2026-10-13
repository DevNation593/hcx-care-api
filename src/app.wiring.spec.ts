import { ConfigModule } from '@nestjs/config';
import { Reflector } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import { AppointmentsController } from './appointments/appointments.controller';
import { AppointmentsModule } from './appointments/appointments.module';
import { BranchesController } from './branches/branches.controller';
import { BranchesModule } from './branches/branches.module';
import { CatalogsController } from './catalogs/catalogs.controller';
import { CatalogsModule } from './catalogs/catalogs.module';
import { ClinicalModulesController } from './clinical-modules/clinical-modules.controller';
import { ClinicalModulesModule } from './clinical-modules/clinical-modules.module';
import { PermissionGuard } from './common/guards/permission.guard';
import { PermissionChecker } from './common/permissions/permission-checker.service';
import { PermissionsModule } from './common/permissions/permissions.module';
import { EncountersController } from './encounters/encounters.controller';
import { EncountersModule } from './encounters/encounters.module';
import { FILE_STORAGE } from './patient-files/file-storage';
import { PatientFilesController } from './patient-files/patient-files.controller';
import { PatientFilesModule } from './patient-files/patient-files.module';
import { SupabaseFileStorage } from './patient-files/supabase-file-storage';
import { ReportsModule } from './reports/reports.module';
import { RecordDocumentsModule } from './record-documents/record-documents.module';
import { DocumentTemplatesModule } from './document-templates/document-templates.module';
import { DocumentVerificationModule } from './document-verification/document-verification.module';
import { PrismaModule } from './prisma/prisma.module';
import { PrismaService } from './prisma/prisma.service';
import { SpecialtyRecordsController } from './specialty-records/specialty-records.controller';
import { SpecialtyRecordsModule } from './specialty-records/specialty-records.module';

/**
 * The unit specs build services by hand, so a missing provider would only show when the API
 * starts. This compiles the modules that have no external connection to resolve.
 */
describe('module wiring', () => {
  it('resolves the clinical, branch, catalog and permission modules without a database', async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true, ignoreEnvFile: true }),
        PrismaModule,
        PermissionsModule,
        AppointmentsModule,
        BranchesModule,
        CatalogsModule,
        ClinicalModulesModule,
        EncountersModule,
        PatientFilesModule,
        ReportsModule,
        RecordDocumentsModule,
        DocumentTemplatesModule,
        DocumentVerificationModule,
        SpecialtyRecordsModule,
      ],
      providers: [PermissionGuard, Reflector],
    })
      .overrideProvider(PrismaService)
      .useValue({})
      .compile();

    for (const controller of [
      AppointmentsController,
      BranchesController,
      CatalogsController,
      ClinicalModulesController,
      EncountersController,
      PatientFilesController,
      SpecialtyRecordsController,
    ]) {
      expect(moduleRef.get(controller, { strict: false })).toBeInstanceOf(controller);
    }
    expect(moduleRef.get(PermissionChecker, { strict: false })).toBeInstanceOf(PermissionChecker);
    expect(moduleRef.get(PermissionGuard)).toBeInstanceOf(PermissionGuard);
  });
});

describe('clinical file storage wiring', () => {
  const supabase = {
    STORAGE_DRIVER: 'supabase',
    SUPABASE_URL: 'https://project.supabase.co',
    SUPABASE_SECRET_KEY: 'sb_secret_test-key',
    SUPABASE_STORAGE_BUCKET: 'clinical-files',
  };
  const previous = Object.keys(supabase).map((name) => [name, process.env[name]] as const);
  const compile = () =>
    Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true, ignoreEnvFile: true }),
        PrismaModule,
        PatientFilesModule,
      ],
    })
      .overrideProvider(PrismaService)
      .useValue({})
      .compile();

  afterEach(() => {
    for (const [name, value] of previous) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  });

  it('keeps the files of the API in the Supabase bucket when STORAGE_DRIVER selects it', async () => {
    Object.assign(process.env, supabase);

    const moduleRef = await compile();

    expect(moduleRef.get(FILE_STORAGE, { strict: false })).toBeInstanceOf(SupabaseFileStorage);
  });

  it('does not start with a Supabase driver that is missing its configuration', async () => {
    Object.assign(process.env, { ...supabase, SUPABASE_SECRET_KEY: '' });

    await expect(compile()).rejects.toThrow('SUPABASE_SECRET_KEY');
  });
});
