import { Controller, Get, Post, Body, Patch, Param, Query } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse, ApiBearerAuth } from '@nestjs/swagger';
import { AppointmentStatus } from '@prisma/client';
import { AppointmentsService } from './appointments.service';
import {
  CreateAppointmentDto,
  UpdateAppointmentDto,
  CancelAppointmentDto,
  ListAppointmentsQueryDto,
} from './dto/appointment.dto';
import { Roles } from '../common/decorators/roles.decorator';
import { AuthUser, CurrentUser } from '../common/decorators/current-user.decorator';
import { RequireSection } from '../common/decorators/require-section.decorator';
import { RequirePermission } from '../common/permissions/permission-catalog';
import { PermissionChecker } from '../common/permissions/permission-checker.service';

@ApiTags('appointments')
@ApiBearerAuth('access-token')
@RequireSection('core.agenda.calendar')
@Roles('MASTER', 'ASISTENTE', 'PROFESIONAL')
@Controller('tenants/:tenantId/appointments')
export class AppointmentsController {
  constructor(
    private readonly appointmentsService: AppointmentsService,
    private readonly permissions: PermissionChecker,
  ) {}

  @Post()
  @ApiOperation({
    summary: 'Create appointment with conflict detection',
    description: 'Validates working hours and checks for time slot conflicts',
  })
  @ApiResponse({ status: 201, description: 'Appointment created' })
  @ApiResponse({
    status: 409,
    description: 'Time slot conflict',
    schema: {
      example: {
        statusCode: 409,
        code: 'APPOINTMENT_CONFLICT',
        error: 'APPOINTMENT_CONFLICT',
        message: 'This time slot conflicts with existing appointment(s)',
        details: {
          conflicts: [
            {
              id: 'appointment-id',
              patient: 'Juan Pérez',
              startTime: '2024-03-15T10:00:00Z',
              endTime: '2024-03-15T11:00:00Z',
            },
          ],
        },
      },
    },
  })
  @RequirePermission('appointments.create')
  async create(
    @Param('tenantId') tenantId: string,
    @Body() createAppointmentDto: CreateAppointmentDto,
    @CurrentUser() actor: AuthUser,
  ) {
    return this.appointmentsService.create(tenantId, createAppointmentDto, actor);
  }

  @Get()
  @ApiOperation({ summary: 'List appointments with filters' })
  @ApiResponse({ status: 200, description: 'Appointments list' })
  async findAll(
    @Param('tenantId') tenantId: string,
    @Query() filters: ListAppointmentsQueryDto,
    @CurrentUser() actor: AuthUser,
  ) {
    return this.appointmentsService.findAll(tenantId, filters, actor);
  }

  @Get(':appointmentId')
  @ApiOperation({ summary: 'Get appointment details' })
  @ApiResponse({ status: 200, description: 'Appointment found' })
  @ApiResponse({ status: 404, description: 'Appointment not found' })
  async findOne(
    @Param('tenantId') tenantId: string,
    @Param('appointmentId') appointmentId: string,
    @CurrentUser() actor: AuthUser,
  ) {
    return this.appointmentsService.findOne(tenantId, appointmentId, actor);
  }

  @Patch(':appointmentId')
  @ApiOperation({ summary: 'Update appointment (checks conflicts if time changed)' })
  @ApiResponse({ status: 200, description: 'Appointment updated' })
  @ApiResponse({ status: 409, description: 'Time slot conflict' })
  @RequirePermission('appointments.update')
  async update(
    @Param('tenantId') tenantId: string,
    @Param('appointmentId') appointmentId: string,
    @Body() updateAppointmentDto: UpdateAppointmentDto,
    @CurrentUser() actor: AuthUser,
  ) {
    // Cancelling through this route exercises the same permission as the cancel route.
    if (updateAppointmentDto.status === AppointmentStatus.CANCELLED) {
      await this.permissions.assertAllowed(actor, 'appointments.cancel');
    }
    return this.appointmentsService.update(tenantId, appointmentId, updateAppointmentDto, actor);
  }

  @Post(':appointmentId/cancel')
  @ApiOperation({ summary: 'Cancel appointment' })
  @ApiResponse({ status: 200, description: 'Appointment cancelled' })
  @RequirePermission('appointments.cancel')
  async cancel(
    @Param('tenantId') tenantId: string,
    @Param('appointmentId') appointmentId: string,
    @Body() cancelDto: CancelAppointmentDto,
    @CurrentUser() actor: AuthUser,
  ) {
    return this.appointmentsService.cancel(tenantId, appointmentId, cancelDto.reason, actor);
  }
}
