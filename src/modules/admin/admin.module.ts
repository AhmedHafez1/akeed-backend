import { Module } from '@nestjs/common';
import { DatabaseModule } from '../../infrastructure/database';
import { AuthModule } from '../auth/auth.module';
import { AdminAccessGuard } from './admin-access.guard';
import { AdminController } from './admin.controller';
import { AdminFunnelService } from './admin-funnel.service';
import { AdminHealthRuleService } from './admin-health-rule.service';
import { AdminQueryRepository } from './admin-query.repository';
import { AdminStoresService } from './admin-stores.service';

@Module({
  imports: [AuthModule, DatabaseModule],
  controllers: [AdminController],
  providers: [
    AdminAccessGuard,
    AdminQueryRepository,
    AdminStoresService,
    AdminFunnelService,
    AdminHealthRuleService,
  ],
})
export class AdminModule {}
