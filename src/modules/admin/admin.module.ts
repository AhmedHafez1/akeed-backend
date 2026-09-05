import { Module } from '@nestjs/common';
import { DatabaseModule } from '../../infrastructure/database';
import { AuthModule } from '../auth/auth.module';
import { AdminAccessGuard } from './admin-access.guard';
import { AdminController } from './admin.controller';
import { AdminFunnelService } from './admin-funnel.service';
import { AdminHealthRuleService } from './admin-health-rule.service';
import { AdminQueryRepository } from './admin-query.repository';
import { AdminStoresService } from './admin-stores.service';
import { StandalonePilotController } from './standalone-pilot.controller';
import { StandalonePilotRepository } from './standalone-pilot.repository';
import { StandalonePilotService } from './standalone-pilot.service';
import { MessageDispatchResolutionService } from './message-dispatch-resolution.service';
import { WebhookQueueModule } from '../webhook-queue/webhook-queue.module';

@Module({
  imports: [AuthModule, DatabaseModule, WebhookQueueModule],
  controllers: [AdminController, StandalonePilotController],
  providers: [
    AdminAccessGuard,
    AdminQueryRepository,
    AdminStoresService,
    AdminFunnelService,
    AdminHealthRuleService,
    StandalonePilotRepository,
    StandalonePilotService,
    MessageDispatchResolutionService,
  ],
})
export class AdminModule {}
