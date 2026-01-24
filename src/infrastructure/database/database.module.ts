import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { drizzleProvider } from './database.provider';

import { OrdersRepository } from './repositories/orders.repository';
import { VerificationsRepository } from './repositories/verifications.repository';
import { IntegrationsRepository } from './repositories/integrations.repository';
import { OrganizationsRepository } from './repositories/organizations.repository';

@Module({
  imports: [ConfigModule],
  providers: [
    drizzleProvider,
    OrdersRepository,
    VerificationsRepository,
    IntegrationsRepository,
    OrganizationsRepository,
  ],
  exports: [
    drizzleProvider,
    OrdersRepository,
    VerificationsRepository,
    IntegrationsRepository,
    OrganizationsRepository,
  ],
})
export class DatabaseModule {}
