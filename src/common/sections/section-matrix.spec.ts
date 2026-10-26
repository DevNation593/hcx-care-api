import { REQUIRE_SECTION_KEY } from '../decorators/require-section.decorator';
import { AppointmentsController } from '../../appointments/appointments.controller';
import { BillingController } from '../../billing/billing.controller';
import { BillingProfilesController } from '../../billing-profiles/billing-profiles.controller';
import { BranchesController } from '../../branches/branches.controller';
import { CashRegistersController } from '../../cash-registers/cash-registers.controller';
import { CatalogsController } from '../../catalogs/catalogs.controller';
import { ConsentTemplatesController } from '../../consents/consent-templates.controller';
import { ReportsController } from '../../reports/reports.controller';
import { RecordDocumentsController } from '../../record-documents/record-documents.controller';
import { DocumentTemplatesController } from '../../document-templates/document-templates.controller';
import { ClinicalModulesController } from '../../clinical-modules/clinical-modules.controller';
import { EncountersController } from '../../encounters/encounters.controller';
import { InvoicingController } from '../../invoicing/invoicing.controller';
import { ProductsController } from '../../inventory/products.controller';
import { StockController } from '../../inventory/stock.controller';
import { NotificationsController } from '../../notifications/notifications.controller';
import {
  BillableSessionsController,
  OrdersController,
  PaymentsController,
} from '../../orders/orders.controller';
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
import { TasksController } from '../../tasks/tasks.controller';
import { ConsentDocumentsController } from '../../treatment-sessions/consent-documents.controller';
import { TreatmentSessionsController } from '../../treatment-sessions/treatment-sessions.controller';
import { TreatmentsController } from '../../treatments/treatments.controller';
import { UsersController } from '../../users/users.controller';
import { SectionKey } from './section-catalog';

type Controller = { name: string; prototype: object };

function handlerSection(controller: Controller, handler: string): SectionKey | undefined {
  return Reflect.getMetadata(
    REQUIRE_SECTION_KEY,
    (controller.prototype as Record<string, object>)[handler],
  );
}

function classSection(controller: Controller): SectionKey | undefined {
  return Reflect.getMetadata(REQUIRE_SECTION_KEY, controller);
}

describe('section matrix', () => {
  it.each([
    [AppointmentsController, 'core.agenda.calendar'],
    [TasksController, 'core.agenda.tasks'],
    [PatientsController, 'core.patients.records'],
    [PatientTeamController, 'core.patients.team'],
    [PatientFilesController, 'core.patients.files'],
    [StorageController, 'core.patients.files'],
    [RecordDocumentsController, 'core.patients.files'],
    [ClinicalNotesController, 'core.clinical.notes'],
    [NextSessionPlansController, 'core.clinical.nextSession'],
    [ClinicalTimelineController, 'core.clinical.timeline'],
    [SpecialtyRecordsController, 'core.clinical.specialties'],
    [ClinicalModulesController, 'core.clinical.specialties'],
    [EncountersController, 'core.clinical.specialties'],
    [CatalogsController, 'core.clinical.specialties'],
    [DocumentTemplatesController, 'core.clinical.specialties'],
    [TreatmentsController, 'core.treatments.catalog'],
    [TreatmentSessionsController, 'core.treatments.sessions'],
    [ConsentDocumentsController, 'core.treatments.sessions'],
    [ConsentTemplatesController, 'core.treatments.consents'],
    [BillingProfilesController, 'core.billing.profiles'],
    [OrdersController, 'core.billing.orders'],
    [BillableSessionsController, 'core.billing.orders'],
    [PaymentsController, 'core.billing.orders'],
    [CashRegistersController, 'core.billing.cash'],
    [ProductsController, 'core.billing.inventory'],
    [StockController, 'core.billing.inventory'],
    [InvoicingController, 'core.billing.invoicing'],
    [BillingController, 'core.billing.invoicing'],
    [ReportsController, 'core.admin.reports'],
  ] as [Controller, SectionKey][])('%p requires %s on every handler', (controller, expected) => {
    expect(classSection(controller)).toBe(expected);
  });

  it.each([
    [UsersController, 'create', 'core.admin.team'],
    [UsersController, 'update', 'core.admin.team'],
    [UsersController, 'deactivate', 'core.admin.team'],
    [UsersController, 'activate', 'core.admin.team'],
    [ClinicalModulesController, 'createForm', 'core.clinical.forms'],
    [ClinicalModulesController, 'updateForm', 'core.clinical.forms'],
    [DocumentTemplatesController, 'create', 'core.clinical.templates'],
    [DocumentTemplatesController, 'update', 'core.clinical.templates'],
    [BranchesController, 'create', 'core.admin.branches'],
    [BranchesController, 'update', 'core.admin.branches'],
    [BranchesController, 'setProfessionals', 'core.admin.branches'],
    [NotificationsController, 'subscribeWebPush', 'core.agenda.notifications'],
  ] as [Controller, string, SectionKey][])('%p.%s requires %s', (controller, handler, expected) => {
    expect(handlerSection(controller, handler)).toBe(expected);
  });

  it.each([
    [ClinicalModulesController, 'listForms'],
    [ClinicalModulesController, 'findForm'],
    [DocumentTemplatesController, 'list'],
  ] as [Controller, string][])(
    '%p.%s stays readable with the specialties submodule alone',
    (controller, handler) => {
      expect(handlerSection(controller, handler)).toBeUndefined();
      expect(classSection(controller)).toBe('core.clinical.specialties');
    },
  );

  it.each(['findAll', 'findOne', 'updateSelf', 'uploadAvatar', 'changePassword'])(
    'UsersController.%s requires no section',
    (handler) => {
      expect(classSection(UsersController)).toBeUndefined();
      expect(handlerSection(UsersController, handler)).toBeUndefined();
    },
  );

  it('lets every role list the branches', () => {
    expect(classSection(BranchesController)).toBeUndefined();
    expect(handlerSection(BranchesController, 'list')).toBeUndefined();
  });

  it.each(['listSpecialties', 'listModules'])(
    'SpecialtiesController.%s requires no section',
    (handler) => {
      expect(classSection(SpecialtiesController)).toBeUndefined();
      expect(handlerSection(SpecialtiesController, handler)).toBeUndefined();
    },
  );
});
