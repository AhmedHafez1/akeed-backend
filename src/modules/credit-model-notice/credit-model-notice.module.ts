import { BullModule } from '@nestjs/bullmq';
import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { DatabaseModule } from '../../infrastructure/database/database.module';
import { CreditModelNoticesRepository } from '../../infrastructure/database/repositories/credit-model-notices.repository';
import { AuthModule } from '../auth/auth.module';
import { CREDIT_MODEL_NOTICE_QUEUE } from './credit-model-notice.constants';
import { CreditModelNoticeController } from './credit-model-notice.controller';
import { CreditModelNoticeProcessor } from './credit-model-notice.processor';
import { CreditModelNoticeScheduler } from './credit-model-notice.scheduler';
import { CreditModelNoticeService } from './credit-model-notice.service';

@Module({
  imports: [
    ConfigModule,
    DatabaseModule,
    AuthModule,
    BullModule.registerQueue({ name: CREDIT_MODEL_NOTICE_QUEUE }),
  ],
  controllers: [CreditModelNoticeController],
  providers: [
    CreditModelNoticesRepository,
    CreditModelNoticeService,
    CreditModelNoticeProcessor,
    CreditModelNoticeScheduler,
  ],
})
export class CreditModelNoticeModule {}
