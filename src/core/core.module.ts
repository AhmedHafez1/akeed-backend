import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { AuthModule } from './modules/auth/auth.module';
import { OrganizationsModule } from './modules/organizations/organizations.module';
import { OrdersModule } from './modules/orders/orders.module';
import { VerificationsModule } from './modules/verifications/verifications.module';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      envFilePath: !process.env.NODE_ENV
        ? '.env'
        : `.env.${process.env.NODE_ENV}`,
    }),
    AuthModule,
    OrganizationsModule,
    OrdersModule,
    VerificationsModule,
  ],
  exports: [AuthModule, OrganizationsModule, OrdersModule, VerificationsModule],
})
export class CoreModule {}
