import { Module } from '@nestjs/common';
import { DatabaseModule } from '../../infrastructure/database/database.module';
import { AuthModule } from '../auth/auth.module';
import { ReviewPromptController } from './review-prompt.controller';
import { ReviewPromptService } from './review-prompt.service';

/** The App Store review banner in the embedded Shopify dashboard. */
@Module({
  imports: [DatabaseModule, AuthModule],
  controllers: [ReviewPromptController],
  providers: [ReviewPromptService],
})
export class ReviewPromptModule {}
