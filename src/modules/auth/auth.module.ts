import { Module } from '@nestjs/common';
import { DatabaseModule } from '../../infrastructure/database/database.module';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { DualAuthGuard } from './guards/dual-auth.guard';
import { TokenValidatorService } from './services/token-validator.service';

@Module({
  imports: [DatabaseModule],
  controllers: [AuthController],
  providers: [AuthService, DualAuthGuard, TokenValidatorService],
  exports: [AuthService, DualAuthGuard, TokenValidatorService],
})
export class AuthModule {}
