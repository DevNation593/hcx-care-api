import { ForbiddenException } from '@nestjs/common';
import { ClinicalActor } from '../clinical-access/clinical-actor';
import { SignerVerificationService } from '../clinical-access/signer-verification.service';
import { ConsentDocumentsService } from './consent-documents.service';
import { SessionMediaService } from './session-media.service';
import { TreatmentSessionsController } from './treatment-sessions.controller';
import { TreatmentSessionsService } from './treatment-sessions.service';

describe('TreatmentSessionsController', () => {
  const actor: ClinicalActor = { userId: 'pro', role: 'PROFESIONAL', specialtyId: 'aesthetics' };
  const sessions = { complete: jest.fn() };
  const signer = { verify: jest.fn() };
  const controller = new TreatmentSessionsController(
    sessions as unknown as TreatmentSessionsService,
    {} as ConsentDocumentsService,
    {} as SessionMediaService,
    signer as unknown as SignerVerificationService,
  );

  beforeEach(() => {
    jest.resetAllMocks();
    sessions.complete.mockResolvedValue({ id: 'session-1', status: 'CLINICAL_COMPLETE' });
  });

  describe('complete', () => {
    it('verifies the password before completing and closing', async () => {
      signer.verify.mockRejectedValue(
        new ForbiddenException({ statusCode: 403, code: 'SIGNATURE_PASSWORD_INVALID' }),
      );
      const dto = { closeEncounter: true, password: 'wrong', encounterSummary: 'Ok' };

      await expect(controller.complete('tenant-1', 'session-1', actor, dto)).rejects.toMatchObject({
        status: 403,
        response: { code: 'SIGNATURE_PASSWORD_INVALID' },
      });
      expect(signer.verify).toHaveBeenCalledWith('pro', 'wrong');
      expect(sessions.complete).not.toHaveBeenCalled();
    });

    it('completes and closes once the password is verified', async () => {
      signer.verify.mockResolvedValue(undefined);
      const dto = { closeEncounter: true, password: 'right', encounterSummary: 'Ok' };

      await expect(controller.complete('tenant-1', 'session-1', actor, dto)).resolves.toEqual({
        id: 'session-1',
        status: 'CLINICAL_COMPLETE',
      });
      expect(signer.verify).toHaveBeenCalledWith('pro', 'right');
      expect(signer.verify.mock.invocationCallOrder[0]).toBeLessThan(
        sessions.complete.mock.invocationCallOrder[0],
      );
      expect(sessions.complete).toHaveBeenCalledWith('tenant-1', 'session-1', actor, dto);
    });

    it('asks no password when the encounter stays open', async () => {
      for (const dto of [
        { procedureNotes: 'Sin incidencias.' },
        { closeEncounter: false, password: 'ignored' },
      ]) {
        await controller.complete('tenant-1', 'session-1', actor, dto);
      }

      expect(signer.verify).not.toHaveBeenCalled();
      expect(sessions.complete).toHaveBeenCalledTimes(2);
    });
  });
});
