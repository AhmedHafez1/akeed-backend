import { Module } from '@nestjs/common';
import { DatabaseModule } from '../../infrastructure/database/database.module';
import { AuthModule } from '../auth/auth.module';
import { OrderIngestionModule } from '../order-ingestion/order-ingestion.module';
import { IntegrationApiKeyGuard } from './guards/integration-api-key.guard';
import { IntegrationKeysController } from './integration-keys.controller';
import { IntegrationKeysService } from './integration-keys.service';

/**
 * Integration API keys (US-05-01): session-authenticated management, and the
 * guard the order API (US-05-02) authenticates server requests with.
 */
@Module({
  imports: [DatabaseModule, AuthModule, OrderIngestionModule],
  controllers: [IntegrationKeysController],
  providers: [IntegrationKeysService, IntegrationApiKeyGuard],
  exports: [IntegrationApiKeyGuard],
})
export class IntegrationKeysModule {}
