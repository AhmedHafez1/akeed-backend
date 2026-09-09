import {
  Module,
  type DynamicModule,
  type ModuleMetadata,
  type Provider,
} from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { DatabaseModule } from '../../infrastructure/database/database.module';
import { BillingController } from './billing.controller';
import { BillingRepository } from './billing.repository';
import { BillingService } from './billing.service';

export interface BillingModuleOptions {
  imports?: ModuleMetadata['imports'];
  /** Provider adapters bound to `PAYMENTS_PORT`. */
  ports?: Provider[];
}

/**
 * Merchant billing.
 *
 * The payment provider arrives as a port binding rather than an import, the
 * same way commerce and messaging spokes reach `VerificationCoreModule`. This
 * module names no processor, so adding a second one is a change to
 * `app.module.ts` and a new spoke, not a change here.
 */
@Module({})
export class BillingModule {
  static register(options: BillingModuleOptions = {}): DynamicModule {
    return {
      module: BillingModule,
      imports: [ConfigModule, DatabaseModule, ...(options.imports ?? [])],
      controllers: [BillingController],
      providers: [BillingService, BillingRepository, ...(options.ports ?? [])],
      exports: [BillingService],
    };
  }
}
