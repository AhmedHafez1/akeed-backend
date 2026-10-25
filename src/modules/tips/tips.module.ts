import { Module } from '@nestjs/common';
import { DatabaseModule } from '../../infrastructure/database/database.module';
import { AuthModule } from '../auth/auth.module';
import { TipsController } from './tips.controller';
import { TipsService } from './tips.service';

/** Admin-published tips and updates on the merchant dashboard. */
@Module({
  imports: [DatabaseModule, AuthModule],
  controllers: [TipsController],
  providers: [TipsService],
})
export class TipsModule {}
