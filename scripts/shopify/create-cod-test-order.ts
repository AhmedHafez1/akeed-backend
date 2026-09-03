import 'reflect-metadata';
import { Logger, Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import dotenv from 'dotenv';
import { ShopifyTestOrderModule } from '../../src/infrastructure/spokes/shopify/shopify-test-order.module';
import { ShopifyTestOrderService } from '../../src/infrastructure/spokes/shopify/services/shopify-test-order.service';

dotenv.config({
  path: process.env.NODE_ENV ? `.env.${process.env.NODE_ENV}` : '.env',
  quiet: true,
});

interface CliOptions {
  store: string;
  phone: string;
  amount?: string;
  currencyCode?: string;
}

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      envFilePath: process.env.NODE_ENV
        ? `.env.${process.env.NODE_ENV}`
        : '.env',
    }),
    ShopifyTestOrderModule,
  ],
})
class ShopifyTestOrderCliModule {}

function readOptions(args: string[]): CliOptions {
  const values = new Map<string, string>();
  for (const argument of args) {
    const match = /^--([^=]+)=(.+)$/.exec(argument);
    if (!match) throw new Error(`Invalid argument: ${argument}`);
    values.set(match[1], match[2]);
  }

  const store = values.get('store');
  const phone = values.get('phone');
  if (!store || !phone) {
    throw new Error(
      'Usage: pnpm shopify:test-cod --store=shop.myshopify.com --phone=+201001234567 [--amount=49.95] [--currency=USD]',
    );
  }

  return {
    store,
    phone,
    amount: values.get('amount'),
    currencyCode: values.get('currency'),
  };
}

async function main(): Promise<void> {
  if (process.env.NODE_ENV === 'production') {
    throw new Error('Shopify test-order generation is disabled in production');
  }

  const options = readOptions(process.argv.slice(2));
  const app = await NestFactory.createApplicationContext(
    ShopifyTestOrderCliModule,
    { logger: ['error', 'warn'] },
  );

  try {
    const order = await app
      .get(ShopifyTestOrderService)
      .createCodOrder(options);
    process.stdout.write(
      [
        `Created ${order.name}`,
        `ID: ${order.id}`,
        `Test order: ${order.test}`,
        `Financial status: ${order.displayFinancialStatus}`,
        'Shopify will deliver the orders/create webhook asynchronously.',
      ].join('\n') + '\n',
    );
  } finally {
    await app.close();
  }

  process.exit(0);
}

const logger = new Logger('ShopifyTestOrderCli');
void main().catch((error: unknown) => {
  logger.error(error instanceof Error ? error.message : 'Test order failed');
  process.exit(1);
});
