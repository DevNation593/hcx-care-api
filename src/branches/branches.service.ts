import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma, TenantType } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { CreateBranchDto, UpdateBranchDto } from './dto/branch.dto';

export const MAIN_BRANCH_NAME = 'Sede principal';

type BranchDb = PrismaService | Prisma.TransactionClient;

const isUniqueViolation = (error: unknown) =>
  (error as Prisma.PrismaClientKnownRequestError)?.code === 'P2002';

const nameTaken = () =>
  new ConflictException({
    statusCode: 409,
    code: 'BRANCH_NAME_TAKEN',
    message: 'Ya existe una sede con ese nombre.',
  });

const clean = (value?: string | null) => value?.trim() || null;

const cleanRooms = (rooms: string[]) => [
  ...new Set(rooms.map((room) => room.trim()).filter(Boolean)),
];

/** Throws BRANCH_NOT_AVAILABLE (400) unless the branch is an active one of the tenant. */
export async function assertBranchAvailable(
  db: BranchDb,
  tenantId: string,
  branchId: string,
): Promise<void> {
  const branch = await db.branch.findFirst({
    where: { id: branchId, tenantId, isActive: true },
    select: { id: true },
  });
  if (!branch) {
    throw new BadRequestException({
      statusCode: 400,
      code: 'BRANCH_NOT_AVAILABLE',
      message: 'La sede no existe o está inactiva.',
    });
  }
}

/**
 * A professional tied to one or more branches is booked only in those.
 * Throws PROFESSIONAL_NOT_IN_BRANCH (409) otherwise.
 */
export async function assertProfessionalInBranch(
  db: BranchDb,
  tenantId: string,
  professionalId: string,
  branchId: string,
): Promise<void> {
  const assignments = await db.professionalBranch.findMany({
    where: { tenantId, userId: professionalId },
    select: { branchId: true },
  });
  if (assignments.length > 0 && !assignments.some((row) => row.branchId === branchId)) {
    throw new ConflictException({
      statusCode: 409,
      code: 'PROFESSIONAL_NOT_IN_BRANCH',
      message: 'El profesional no atiende en esa sede.',
    });
  }
}

@Injectable()
export class BranchesService {
  constructor(private readonly prisma: PrismaService) {}

  /** Every branch with the professionals tied to it; an empty list means no restriction. */
  async list(tenantId: string) {
    const branches = await this.prisma.branch.findMany({
      where: { tenantId },
      include: { professionals: { select: { userId: true } } },
      orderBy: [{ isMain: 'desc' }, { name: 'asc' }],
    });
    return branches.map(({ professionals, ...branch }) => ({
      ...branch,
      professionalIds: professionals.map(({ userId }) => userId),
    }));
  }

  /**
   * Replaces the professionals who attend in a branch. A professional tied to no branch
   * attends in all of them, so this only narrows where the listed ones can be booked.
   */
  async setProfessionals(tenantId: string, branchId: string, userIds: string[]) {
    const unique = [...new Set(userIds)];

    return this.transaction(async (tx) => {
      const branch = await tx.branch.findFirst({
        where: { id: branchId, tenantId },
        select: { id: true },
      });
      if (!branch) throw new NotFoundException('Sede no encontrada');

      const professionals = await tx.user.findMany({
        where: {
          id: { in: unique },
          tenantId,
          isActive: true,
          professionalProfile: { isActive: true },
        },
        select: { id: true },
      });
      if (professionals.length !== unique.length) {
        throw new BadRequestException({
          statusCode: 400,
          code: 'BRANCH_PROFESSIONAL_INVALID',
          message: 'Solo se pueden asignar profesionales activos del consultorio.',
        });
      }

      await tx.professionalBranch.deleteMany({ where: { branchId, tenantId } });
      if (unique.length > 0) {
        await tx.professionalBranch.createMany({
          data: unique.map((userId) => ({ userId, branchId, tenantId })),
        });
      }
      return { branchId, professionalIds: unique };
    });
  }

  async create(tenantId: string, dto: CreateBranchDto) {
    try {
      return await this.transaction(async (tx) => {
        await this.assertRoomForAnother(tx, tenantId);
        await this.assertNameFree(tx, tenantId, dto.name);
        const hasMain = await tx.branch.count({ where: { tenantId, isMain: true } });

        return tx.branch.create({
          data: {
            tenantId,
            name: dto.name.trim(),
            address: clean(dto.address),
            city: clean(dto.city),
            phone: clean(dto.phone),
            openingHours: clean(dto.openingHours),
            rooms: cleanRooms(dto.rooms ?? []),
            // The first branch of a clinic is its main one.
            isMain: hasMain === 0,
          },
        });
      });
    } catch (error) {
      if (isUniqueViolation(error)) throw nameTaken();
      throw error;
    }
  }

  /** «Sede Norte» and «sede norte» are the same branch to the people choosing one. */
  private async assertNameFree(db: BranchDb, tenantId: string, name: string, exceptId?: string) {
    const taken = await db.branch.findFirst({
      where: {
        tenantId,
        name: { equals: name.trim(), mode: 'insensitive' },
        ...(exceptId ? { id: { not: exceptId } } : {}),
      },
      select: { id: true },
    });
    if (taken) throw nameTaken();
  }

  async update(tenantId: string, branchId: string, dto: UpdateBranchDto) {
    try {
      return await this.transaction(async (tx) => {
        const branch = await tx.branch.findFirst({ where: { id: branchId, tenantId } });
        if (!branch) throw new NotFoundException('Sede no encontrada');

        const becomesMain = dto.isMain === true && !branch.isMain;
        const isMain = becomesMain || (branch.isMain && dto.isMain !== false);
        const isActive = typeof dto.isActive === 'boolean' ? dto.isActive : branch.isActive;

        if (branch.isMain && dto.isMain === false) {
          throw new ConflictException({
            statusCode: 409,
            code: 'BRANCH_MAIN_REQUIRED',
            message: 'Elige otra sede como principal en lugar de quitar la actual.',
          });
        }
        if (isMain && !isActive) {
          throw new ConflictException({
            statusCode: 409,
            code: 'BRANCH_MAIN_REQUIRED',
            message: 'La sede principal no puede estar inactiva.',
          });
        }
        if (isActive && !branch.isActive) await this.assertRoomForAnother(tx, tenantId);
        if (typeof dto.name === 'string' && dto.name.trim() !== branch.name) {
          await this.assertNameFree(tx, tenantId, dto.name, branchId);
        }

        if (becomesMain) {
          await tx.branch.updateMany({
            where: { tenantId, isMain: true },
            data: { isMain: false },
          });
        }

        return tx.branch.update({
          where: { id: branchId },
          data: {
            ...(typeof dto.name === 'string' ? { name: dto.name.trim() } : {}),
            ...(dto.address !== undefined ? { address: clean(dto.address) } : {}),
            ...(dto.city !== undefined ? { city: clean(dto.city) } : {}),
            ...(dto.phone !== undefined ? { phone: clean(dto.phone) } : {}),
            ...(dto.openingHours !== undefined ? { openingHours: clean(dto.openingHours) } : {}),
            ...(Array.isArray(dto.rooms) ? { rooms: cleanRooms(dto.rooms) } : {}),
            isActive,
            isMain,
          },
        });
      });
    } catch (error) {
      if (isUniqueViolation(error)) throw nameTaken();
      throw error;
    }
  }

  /**
   * The plan sets how many branches can be active. A practice of one professional works from one
   * place whatever its plan says.
   */
  private async assertRoomForAnother(tx: Prisma.TransactionClient, tenantId: string) {
    const [tenant, active] = await Promise.all([
      tx.tenant.findUnique({
        where: { id: tenantId },
        select: { tenantType: true, subscription: { select: { maxBranches: true } } },
      }),
      tx.branch.count({ where: { tenantId, isActive: true } }),
    ]);
    const personal = (tenant?.tenantType ?? TenantType.PERSONAL) === TenantType.PERSONAL;
    const limit = personal ? 1 : (tenant?.subscription?.maxBranches ?? 1);
    if (active >= limit) {
      throw new ConflictException({
        statusCode: 409,
        code: 'BRANCH_LIMIT_REACHED',
        message: personal
          ? 'Un consultorio individual trabaja con una sola sede.'
          : limit === 1
            ? 'Tu plan incluye una sola sede activa.'
            : `Tu plan incluye hasta ${limit} sedes activas.`,
        limit,
      });
    }
  }

  private transaction<T>(callback: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T> {
    return this.prisma.$transaction(async (tx) => {
      await this.prisma.applyRlsContext(tx);
      return callback(tx);
    });
  }
}
