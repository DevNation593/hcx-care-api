import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { PlatformRoute } from '../common/decorators/platform-route.decorator';
import { Public } from '../common/decorators/public.decorator';
import { Roles } from '../common/decorators/roles.decorator';
import { DemoRequestsService } from './demo-requests.service';
import {
  CreateDemoRequestDto,
  ListDemoRequestsQueryDto,
  UpdateDemoRequestDto,
} from './dto/demo-request.dto';

// Spam limit per address. DEMO_REQUEST_THROTTLE_LIMIT is only meant for the e2e setup.
const DEMO_REQUEST_THROTTLE = {
  default: { limit: Number(process.env.DEMO_REQUEST_THROTTLE_LIMIT) || 3, ttl: 10 * 60 * 1000 },
};

@ApiTags('demo-requests')
@Controller('demo-requests')
export class DemoRequestsController {
  constructor(private readonly demoRequests: DemoRequestsService) {}

  @Public()
  @Throttle(DEMO_REQUEST_THROTTLE)
  @Post()
  @HttpCode(HttpStatus.ACCEPTED)
  @ApiOperation({ summary: 'Ask for a demo from the public site' })
  create(@Body() dto: CreateDemoRequestDto) {
    return this.demoRequests.create(dto);
  }
}

@ApiTags('platform')
@ApiBearerAuth('access-token')
@PlatformRoute()
@Roles('ADMIN')
@Controller('platform/demo-requests')
export class PlatformDemoRequestsController {
  constructor(private readonly demoRequests: DemoRequestsService) {}

  @Get()
  @ApiOperation({ summary: 'Latest demo requests, newest first (up to 200)' })
  list(@Query() query: ListDemoRequestsQueryDto) {
    return this.demoRequests.list(query.status);
  }

  @Patch(':id')
  @ApiOperation({ summary: 'Mark a demo request as new, contacted or closed' })
  update(@Param('id') id: string, @Body() dto: UpdateDemoRequestDto) {
    return this.demoRequests.updateStatus(id, dto.status);
  }
}
