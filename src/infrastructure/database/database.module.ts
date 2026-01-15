import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { drizzleProvider } from './database.provider';

import { OrdersRepository } from './repositories/orders.repository';
import { VerificationsRepository } from './repositories/verifications.repository';

@Module({
  imports: [ConfigModule],
  providers: [drizzleProvider, OrdersRepository, VerificationsRepository],
  exports: [drizzleProvider, OrdersRepository, VerificationsRepository],
})
export class DatabaseModule {}
