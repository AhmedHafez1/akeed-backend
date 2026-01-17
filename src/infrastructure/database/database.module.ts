import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { drizzleProvider } from './database.provider';

import { OrdersRepository } from './repositories/orders.repository';
import { VerificationsRepository } from './repositories/verifications.repository';
import { IntegrationsRepository } from './repositories/integrations.repository';

@Module({
  imports: [ConfigModule],
  providers: [
    drizzleProvider,
    OrdersRepository,
    VerificationsRepository,
    IntegrationsRepository,
  ],
  exports: [
    drizzleProvider,
    OrdersRepository,
    VerificationsRepository,
    IntegrationsRepository,
  ],
})
export class DatabaseModule {}
