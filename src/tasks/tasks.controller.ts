import { Controller, Get, Post, Body, Patch, Param, Delete, Query } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse, ApiBearerAuth, ApiQuery } from '@nestjs/swagger';
import { TasksService } from './tasks.service';
import { parseListQuery } from '../common/pagination/pagination';
import {
  CreateTaskDto,
  ListTasksQueryDto,
  TaskSummaryQueryDto,
  UpdateTaskDto,
} from './dto/task.dto';
import { Roles } from '../common/decorators/roles.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { RequireSection } from '../common/decorators/require-section.decorator';

const LIST_KEYS = [
  'patientId',
  'assignedToId',
  'status',
  'priority',
  'search',
  'page',
  'limit',
] as const;
const SUMMARY_KEYS = ['patientId', 'assignedToId', 'priority', 'search'] as const;

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
  @Roles('MASTER', 'ASISTENTE', 'PROFESIONAL')
  @ApiOperation({
    summary: 'List tasks with filters',
    description:
      'Without `page` and `limit` the response is the whole list as an array. With either one it is `{ data, meta }`.',
  })
  @ApiResponse({
    status: 200,
    description:
      'Tasks list (array), or `{ data, meta: { page, limit, total, totalPages } }` when paged',
  })
  @ApiQuery({ name: 'patientId', required: false })
  @ApiQuery({ name: 'assignedToId', required: false })
  @ApiQuery({
    name: 'status',
    required: false,
    enum: ['PENDING', 'IN_PROGRESS', 'COMPLETED', 'CANCELLED'],
  })
  @ApiQuery({ name: 'priority', required: false, enum: ['LOW', 'MEDIUM', 'HIGH', 'URGENT'] })
  @ApiQuery({
    name: 'search',
    required: false,
    description: 'Title, description or patient name; cut to 100 characters',
  })
  @ApiQuery({
    name: 'page',
    required: false,
    type: Number,
    description: '1-based; switches the response to { data, meta }',
  })
  @ApiQuery({
    name: 'limit',
    required: false,
    type: Number,
    description: '1-100 (default 20 when paging)',
  })
  @ApiResponse({ status: 400, description: 'Invalid page, limit, status or priority' })
  async findAll(
    @Param('tenantId') tenantId: string,
    @Query() rawQuery: Record<string, unknown>,
    @CurrentUser() user?: any,
  ) {
    // Read loosely, as this endpoint always did: unknown or empty parameters are ignored.
    const query = parseListQuery(ListTasksQueryDto, rawQuery, LIST_KEYS);
    return this.tasksService.findAll(tenantId, query, user);
  }

  // Declared before `:taskId` so "summary" is not read as a task id.
  @Get('summary')
  @Roles('MASTER', 'ASISTENTE', 'PROFESIONAL')
  @ApiOperation({
    summary: 'Task counts per state',
    description:
      'Pending (PENDING + IN_PROGRESS), overdue, completed and cancelled counts of the tasks the caller can see, under the same filters as the list (status excluded).',
  })
  @ApiResponse({
    status: 200,
    description: '{ pending, overdue, completed, cancelled }',
  })
  @ApiQuery({ name: 'patientId', required: false })
  @ApiQuery({ name: 'assignedToId', required: false })
  @ApiQuery({ name: 'priority', required: false, enum: ['LOW', 'MEDIUM', 'HIGH', 'URGENT'] })
  @ApiQuery({ name: 'search', required: false })
  async summary(
    @Param('tenantId') tenantId: string,
    @Query() rawQuery: Record<string, unknown>,
    @CurrentUser() user?: any,
  ) {
    const query = parseListQuery(TaskSummaryQueryDto, rawQuery, SUMMARY_KEYS);
    return this.tasksService.summary(tenantId, query, user);
  }

  @Get(':taskId')
  @Roles('MASTER', 'ASISTENTE', 'PROFESIONAL')
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
