import { Module } from '@nestjs/common';
import { DatabaseModule } from '../../../infrastructure/database/database.module';
import { VerificationsController } from '../../controllers/verifications.controller';
import { VerificationsService } from '../../services/verifications.service';
import { TestVerificationService } from '../../services/test-verification.service';
import { AuthModule } from '../auth/auth.module';

@Module({
  imports: [DatabaseModule, AuthModule],
  controllers: [VerificationsController],
  providers: [VerificationsService, TestVerificationService],
  exports: [VerificationsService, TestVerificationService],
})
export class VerificationsModule {}
