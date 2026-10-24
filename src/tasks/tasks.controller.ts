import { Controller, Get, Post, Body, Patch, Param, Delete, Query } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse, ApiBearerAuth, ApiQuery } from '@nestjs/swagger';
import { TasksService } from './tasks.service';
import { CreateTaskDto, UpdateTaskDto } from './dto/task.dto';
import { Roles } from '../common/decorators/roles.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { RequireSection } from '../common/decorators/require-section.decorator';

@ApiTags('tasks')
@ApiBearerAuth('access-token')
@RequireSection('core.agenda.tasks')
@Controller('tenants/:tenantId/tasks')
export class TasksController {
  constructor(private readonly tasksService: TasksService) {}

  @Roles('MASTER', 'PROFESIONAL')
  @Post()
  @ApiOperation({ summary: 'Create task' })
  @ApiResponse({ status: 201, description: 'Task created' })
  async create(
    @Param('tenantId') tenantId: string,
    @Body() createTaskDto: CreateTaskDto,
    @CurrentUser() user: any,
  ) {
    return this.tasksService.create(tenantId, user, createTaskDto);
  }

  @Get()
  @ApiOperation({ summary: 'List tasks with filters' })
  @ApiQuery({ name: 'patientId', required: false })
  @ApiQuery({ name: 'assignedToId', required: false })
  @ApiQuery({ name: 'status', required: false })
  @ApiQuery({ name: 'priority', required: false })
  @ApiResponse({ status: 200, description: 'Tasks list' })
  async findAll(
    @Param('tenantId') tenantId: string,
    @Query('patientId') patientId?: string,
    @Query('assignedToId') assignedToId?: string,
    @Query('status') status?: string,
    @Query('priority') priority?: string,
    @CurrentUser() user?: any,
  ) {
    return this.tasksService.findAll(tenantId, { patientId, assignedToId, status, priority }, user);
  }

  @Get(':taskId')
  @ApiOperation({ summary: 'Get task details' })
  @ApiResponse({ status: 200, description: 'Task found' })
  async findOne(
    @Param('tenantId') tenantId: string,
    @Param('taskId') taskId: string,
    @CurrentUser() user: any,
  ) {
    return this.tasksService.findOne(tenantId, taskId, user);
  }

  @Roles('MASTER', 'PROFESIONAL')
  @Patch(':taskId')
  @ApiOperation({ summary: 'Update task' })
  @ApiResponse({ status: 200, description: 'Task updated' })
  async update(
    @Param('tenantId') tenantId: string,
    @Param('taskId') taskId: string,
    @Body() updateTaskDto: UpdateTaskDto,
    @CurrentUser() user: any,
  ) {
    return this.tasksService.update(tenantId, taskId, updateTaskDto, user);
  }

  @Roles('MASTER')
  @Delete(':taskId')
  @ApiOperation({ summary: 'Delete task - Master only' })
  @ApiResponse({ status: 200, description: 'Task deleted' })
  async remove(@Param('tenantId') tenantId: string, @Param('taskId') taskId: string) {
    return this.tasksService.delete(tenantId, taskId);
  }
}
