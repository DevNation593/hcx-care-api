import * as fs from 'fs';
import * as path from 'path';
import { PLATFORM_ROUTE_KEY } from '../decorators/platform-route.decorator';
import { ROLES_KEY } from '../decorators/roles.decorator';
import { AppointmentsController } from '../../appointments/appointments.controller';
import { AuditLogController } from '../../audit-log/audit-log.controller';
import { BillingController } from '../../billing/billing.controller';
import { BranchesController } from '../../branches/branches.controller';
import { ReportsController } from '../../reports/reports.controller';
import { RecordDocumentsController } from '../../record-documents/record-documents.controller';
import { DocumentTemplatesController } from '../../document-templates/document-templates.controller';
import { CatalogsController } from '../../catalogs/catalogs.controller';
import { ClinicalModulesController } from '../../clinical-modules/clinical-modules.controller';
import { EncountersController } from '../../encounters/encounters.controller';
import {
  PatientFilesController,
  StorageController,
} from '../../patient-files/patient-files.controller';
import { ClinicalNotesController } from '../../clinical-notes/clinical-notes.controller';
import { ClinicalTimelineController } from '../../clinical-timeline/clinical-timeline.controller';
import { NextSessionPlansController } from '../../next-session-plans/next-session-plans.controller';
import { PatientTeamController } from '../../patient-team/patient-team.controller';
import { PatientsController } from '../../patients/patients.controller';
import { SpecialtiesController } from '../../specialties/specialties.controller';
import { SpecialtyRecordsController } from '../../specialty-records/specialty-records.controller';
import { SubscriptionController } from '../../subscription/subscription.controller';
import { PlatformLegacyAccessController } from '../../platform/platform-legacy-access.controller';
import { PlatformPaymentsController } from '../../platform/platform-payments.controller';
import { PlatformSummaryController } from '../../platform/platform-summary.controller';
import { PlatformTenantsController } from '../../platform/platform-tenants.controller';
import { TasksController } from '../../tasks/tasks.controller';
import { TenantSettingsController } from '../../tenant-settings/tenant-settings.controller';
import { TenantsController } from '../../tenants/tenants.controller';
import { UsersController } from '../../users/users.controller';

type Controller = { name: string; prototype: object };

const MASTER = ['MASTER'];
const CLINICAL = ['MASTER', 'PROFESIONAL'];
const TEAM = ['MASTER', 'ASISTENTE', 'PROFESIONAL'];

function handlerRoles(controller: Controller, handler: string): string[] | undefined {
  return Reflect.getMetadata(ROLES_KEY, (controller.prototype as Record<string, object>)[handler]);
}

function classRoles(controller: Controller): string[] | undefined {
  return Reflect.getMetadata(ROLES_KEY, controller);
}

const platformControllers: Controller[] = [
  PlatformTenantsController,
  PlatformSummaryController,
  PlatformPaymentsController,
  PlatformLegacyAccessController,
];

function controllerFiles(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return controllerFiles(full);
    return entry.name.endsWith('.controller.ts') ? [full] : [];
  });
}

describe('role matrix', () => {
  it.each([
    [UsersController, 'create', MASTER],
    [UsersController, 'update', MASTER],
    [UsersController, 'deactivate', MASTER],
    [UsersController, 'activate', MASTER],
    [SubscriptionController, 'upgradePlan', MASTER],
    [SubscriptionController, 'listPayments', MASTER],
    [SubscriptionController, 'downgradePlan', MASTER],
    [SubscriptionController, 'customizeFeatures', MASTER],
    [TenantsController, 'update', MASTER],
    [TenantsController, 'completeOnboarding', MASTER],
    [TenantSettingsController, 'update', MASTER],
    [SpecialtiesController, 'setSpecialties', MASTER],
    [SpecialtiesController, 'setSpecialtiesLegacy', MASTER],
    [SpecialtiesController, 'updateModule', MASTER],
    [PatientsController, 'remove', MASTER],
    [TasksController, 'remove', MASTER],
    [BillingController, 'listInvoices', MASTER],
    [BillingController, 'getInvoice', MASTER],
    [TasksController, 'create', CLINICAL],
    [TasksController, 'update', CLINICAL],
    [SpecialtyRecordsController, 'create', CLINICAL],
    [SpecialtyRecordsController, 'list', CLINICAL],
    [SpecialtyRecordsController, 'alerts', CLINICAL],
    [SpecialtyRecordsController, 'update', CLINICAL],
    [SpecialtyRecordsController, 'remove', CLINICAL],
    [ClinicalModulesController, 'listModules', CLINICAL],
    [ClinicalModulesController, 'listForms', CLINICAL],
    [ClinicalModulesController, 'findForm', CLINICAL],
    [ClinicalModulesController, 'createForm', MASTER],
    [ClinicalModulesController, 'updateForm', MASTER],
    [SpecialtyRecordsController, 'findOne', CLINICAL],
    [EncountersController, 'list', CLINICAL],
    [EncountersController, 'start', CLINICAL],
    [EncountersController, 'update', CLINICAL],
    [EncountersController, 'close', CLINICAL],
    [EncountersController, 'remove', CLINICAL],
    [CatalogsController, 'searchDiagnosisCodes', CLINICAL],
    [CatalogsController, 'listMedications', CLINICAL],
    [CatalogsController, 'createMedication', CLINICAL],
    [CatalogsController, 'updateMedication', CLINICAL],
    [BranchesController, 'list', TEAM],
    [BranchesController, 'create', MASTER],
    [BranchesController, 'update', MASTER],
    [BranchesController, 'setProfessionals', MASTER],
    [ReportsController, 'activity', MASTER],
    [RecordDocumentsController, 'issue', CLINICAL],
    [DocumentTemplatesController, 'list', CLINICAL],
    [DocumentTemplatesController, 'create', MASTER],
    [DocumentTemplatesController, 'update', MASTER],
    [PatientFilesController, 'list', CLINICAL],
    [PatientFilesController, 'upload', CLINICAL],
    [PatientFilesController, 'download', CLINICAL],
    [PatientFilesController, 'remove', CLINICAL],
    [StorageController, 'breakdown', MASTER],
    [StorageController, 'files', MASTER],
    [ClinicalNotesController, 'findAll', CLINICAL],
    [ClinicalNotesController, 'findOne', CLINICAL],
    [ClinicalNotesController, 'remove', CLINICAL],
    [NextSessionPlansController, 'findAll', CLINICAL],
    [NextSessionPlansController, 'findByPatient', CLINICAL],
    [NextSessionPlansController, 'remove', CLINICAL],
    [ClinicalNotesController, 'create', ['PROFESIONAL']],
    [ClinicalNotesController, 'update', ['PROFESIONAL']],
    [NextSessionPlansController, 'create', ['PROFESIONAL']],
    [NextSessionPlansController, 'update', ['PROFESIONAL']],
    [PatientsController, 'create', TEAM],
    [PatientsController, 'update', TEAM],
  ] as [Controller, string, string[]][])('%p.%s requires %j', (controller, handler, expected) => {
    expect(handlerRoles(controller, handler)).toEqual(expected);
  });

  it.each([
    [AuditLogController, MASTER],
    // Confirming a payment is what enables a paid plan: only the platform ADMIN can do it.
    [PlatformTenantsController, ['ADMIN']],
    [PlatformSummaryController, ['ADMIN']],
    [PlatformPaymentsController, ['ADMIN']],
    [PlatformLegacyAccessController, ['ADMIN']],
    [ClinicalTimelineController, CLINICAL],
    [AppointmentsController, TEAM],
    [PatientTeamController, TEAM],
  ] as [Controller, string[]][])('%p requires %j on every handler', (controller, expected) => {
    expect(classRoles(controller)).toEqual(expected);
  });

  const controllers: Controller[] = [
    AppointmentsController,
    AuditLogController,
    BillingController,
    BranchesController,
    CatalogsController,
    ClinicalModulesController,
    ClinicalNotesController,
    EncountersController,
    ClinicalTimelineController,
    NextSessionPlansController,
    PatientFilesController,
    ReportsController,
    RecordDocumentsController,
    DocumentTemplatesController,
    PatientTeamController,
    PatientsController,
    SpecialtiesController,
    StorageController,
    SpecialtyRecordsController,
    SubscriptionController,
    TasksController,
    TenantSettingsController,
    TenantsController,
    UsersController,
  ];

  // ADMIN is reserved for future use and the legacy names no longer resolve.
  it.each(controllers)('%p grants nothing to ADMIN, CLIENTE or PSICOLOGO', (controller) => {
    const declared = [
      ...(classRoles(controller) ?? []),
      ...Object.getOwnPropertyNames(controller.prototype).flatMap(
        (handler) => handlerRoles(controller, handler) ?? [],
      ),
    ];
    expect(declared).not.toEqual(expect.arrayContaining(['ADMIN']));
    expect(declared).not.toEqual(expect.arrayContaining(['CLIENTE']));
    expect(declared).not.toEqual(expect.arrayContaining(['PSICOLOGO']));
  });

  it('no handler in the API requires SOPORTE', () => {
    const files = controllerFiles(path.resolve(__dirname, '../..'));
    expect(files.length).toBeGreaterThan(10);

    const offenders: string[] = [];
    for (const file of files) {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const exported = Object.values(require(file)) as unknown[];
      for (const value of exported) {
        if (typeof value !== 'function' || !value.prototype) continue;
        const controller = value as Controller;
        if (classRoles(controller)?.includes('SOPORTE')) offenders.push(controller.name);
        for (const handler of Object.getOwnPropertyNames(controller.prototype)) {
          if (handlerRoles(controller, handler)?.includes('SOPORTE')) {
            offenders.push(`${controller.name}.${handler}`);
          }
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it.each(platformControllers)('%p is a platform route', (controller) => {
    expect(Reflect.getMetadata(PLATFORM_ROUTE_KEY, controller)).toBe(true);
  });
});
