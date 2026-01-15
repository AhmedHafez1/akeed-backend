import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';

import { DatabaseModule } from '../infrastructure/database/database.module';
import { VerificationHubService } from './services/verification-hub.service';

@Module({
  imports: [
    DatabaseModule,
    ConfigModule.forRoot({
      isGlobal: true,
      envFilePath: !process.env.NODE_ENV
        ? '.env'
        : `.env.${process.env.NODE_ENV}`,
    }),
  ],
  providers: [VerificationHubService],
  exports: [VerificationHubService],
})
export class CoreModule {}
