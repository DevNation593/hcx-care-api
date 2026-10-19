import { REQUIRE_SECTION_KEY } from '../decorators/require-section.decorator';
import { AppointmentsController } from '../../appointments/appointments.controller';
import { BillingController } from '../../billing/billing.controller';
import { CatalogsController } from '../../catalogs/catalogs.controller';
import { ReportsController } from '../../reports/reports.controller';
import { RecordDocumentsController } from '../../record-documents/record-documents.controller';
import { DocumentTemplatesController } from '../../document-templates/document-templates.controller';
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
import { TasksController } from '../../tasks/tasks.controller';
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
    [AppointmentsController, 'core.calendar'],
    [PatientsController, 'core.patients'],
    [PatientTeamController, 'core.patients'],
    [TasksController, 'core.tasks'],
    [ClinicalNotesController, 'core.clinicalNotes'],
    [ClinicalTimelineController, 'core.clinicalNotes'],
    [NextSessionPlansController, 'core.clinicalNotes'],
    [SpecialtyRecordsController, 'core.specialties'],
    [ClinicalModulesController, 'core.specialties'],
    [EncountersController, 'core.specialties'],
    [CatalogsController, 'core.specialties'],
    [PatientFilesController, 'core.storage'],
    [StorageController, 'core.storage'],
    [BillingController, 'core.billing'],
    [ReportsController, 'core.calendar'],
    [RecordDocumentsController, 'core.storage'],
    [DocumentTemplatesController, 'core.specialties'],
  ] as [Controller, SectionKey][])('%p requires %s on every handler', (controller, expected) => {
    expect(classSection(controller)).toBe(expected);
  });

  it.each([
    [UsersController, 'create', 'core.team'],
    [UsersController, 'update', 'core.team'],
    [UsersController, 'deactivate', 'core.team'],
    [UsersController, 'activate', 'core.team'],
  ] as [Controller, string, SectionKey][])('%p.%s requires %s', (controller, handler, expected) => {
    expect(handlerSection(controller, handler)).toBe(expected);
  });

  it.each(['findAll', 'findOne', 'updateSelf', 'uploadAvatar', 'changePassword'])(
    'UsersController.%s requires no section',
    (handler) => {
      expect(classSection(UsersController)).toBeUndefined();
      expect(handlerSection(UsersController, handler)).toBeUndefined();
    },
  );

  it.each(['listSpecialties', 'listModules'])(
    'SpecialtiesController.%s requires no section',
    (handler) => {
      expect(classSection(SpecialtiesController)).toBeUndefined();
      expect(handlerSection(SpecialtiesController, handler)).toBeUndefined();
    },
  );
});
