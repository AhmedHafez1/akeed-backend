import { AnnouncementUnsubscribeService } from './announcement-unsubscribe.service';
import { BullModule } from '@nestjs/bullmq';
import { AnnouncementEmailsRepository } from '../../infrastructure/database/repositories/announcement-emails.repository';
import { AnnouncementEmailService } from './announcement-email.service';
import {
  AnnouncementEmailScheduler,
  AnnouncementEmailProcessor,
  ANNOUNCEMENT_EMAIL_QUEUE,
} from './announcement-email.scheduler';
import { AnnouncementUnsubscribeController } from './announcement-unsubscribe.controller';
import { Module } from '@nestjs/common';
import { DatabaseModule } from '../../infrastructure/database/database.module';
import { AuthModule } from '../auth/auth.module';
import { TipsController } from './tips.controller';
import { TipsService } from './tips.service';

/** Admin-published tips and updates on the merchant dashboard. */
@Module({
  imports: [
    DatabaseModule,
    AuthModule,
    BullModule.registerQueue({ name: ANNOUNCEMENT_EMAIL_QUEUE }),
  ],
  controllers: [TipsController, AnnouncementUnsubscribeController],
  providers: [
    AnnouncementUnsubscribeService,
    TipsService,
    AnnouncementEmailsRepository,
    AnnouncementEmailService,
    AnnouncementEmailScheduler,
    AnnouncementEmailProcessor,
  ],
  exports: [AnnouncementEmailService],
})
export class TipsModule {}
