import { Injectable, NotFoundException } from '@nestjs/common';
import {
  CUSTOM_MODULE_PREFIX,
  findClinicalModule,
} from '../clinical-modules/clinical-module-registry';
import { PrismaService } from '../prisma/prisma.service';
import {
  formatVerificationCode,
  normalizeVerificationCode,
} from '../specialty-records/verification-code';

const notFound = () =>
  new NotFoundException({
    statusCode: 404,
    code: 'DOCUMENT_NOT_FOUND',
    message: 'No existe un documento con ese código.',
  });

const initials = (...names: string[]) =>
  names
    .flatMap((name) => name.trim().split(/\s+/))
    .filter(Boolean)
    .map((word) => `${word[0].toUpperCase()}.`)
    .join(' ');

/**
 * What anyone holding a document can check with its code: that the clinic issued it, who signed
 * it and whether it is still in force. It never returns the content of the document, and of the
 * patient only the initials, enough to match the bearer without disclosing who they are.
 */
@Injectable()
export class DocumentVerificationService {
  constructor(private readonly prisma: PrismaService) {}

  async verify(rawCode: string) {
    const code = normalizeVerificationCode(rawCode ?? '');
    if (!code) throw notFound();

    const record = await this.prisma.specialtyRecord.findUnique({
      where: { verificationCode: code },
      select: {
        moduleKey: true,
        schemaVersion: true,
        recordDate: true,
        version: true,
        updatedAt: true,
        deletedAt: true,
        amendedBy: { select: { createdAt: true } },
        tenant: { select: { name: true } },
        specialty: { select: { name: true } },
        patient: { select: { firstName: true, lastName: true } },
        formDefinition: { select: { name: true } },
        professional: {
          select: {
            firstName: true,
            lastName: true,
            professionalProfile: { select: { professionalTitle: true, licenseNumber: true } },
          },
        },
      },
    });
    if (!record) throw notFound();

    const documentType = record.moduleKey.startsWith(CUSTOM_MODULE_PREFIX)
      ? record.formDefinition?.name
      : findClinicalModule(record.moduleKey, record.schemaVersion)?.name;

    return {
      code: formatVerificationCode(code),
      // A removed record is a document its author withdrew.
      status: record.deletedAt ? ('WITHDRAWN' as const) : ('VALID' as const),
      documentType: documentType ?? 'Documento clínico',
      issuedAt: record.recordDate,
      // The paper may predate a correction, made in place before signatures or by an addendum
      // since: the holder is told to ask for the current one.
      correctedAt: record.amendedBy?.createdAt ?? (record.version > 1 ? record.updatedAt : null),
      withdrawnAt: record.deletedAt,
      clinic: record.tenant.name,
      specialty: record.specialty?.name ?? null,
      professional: {
        name: `${record.professional.firstName} ${record.professional.lastName}`.trim(),
        title: record.professional.professionalProfile?.professionalTitle ?? null,
        licenseNumber: record.professional.professionalProfile?.licenseNumber ?? null,
      },
      patientInitials: initials(record.patient.firstName, record.patient.lastName),
    };
  }
}
