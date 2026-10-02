import { NestFactory, HttpAdapterHost } from '@nestjs/core';
import { ValidationPipe, Logger } from '@nestjs/common';
import { AppModule } from './app.module';
import { GlobalExceptionFilter } from './shared/filters/global-exception.filter';
import { runMigrations } from './infrastructure/database/migrate';
import { applyOrderApiEdge } from './modules/order-api/edge/order-api.edge';
import {
  buildBackendLog,
  normalizeError,
} from './shared/logging/backend-log.util';

const logger = new Logger('Bootstrap');

async function bootstrap() {
  await runMigrations();

  const app = await NestFactory.create(AppModule, { rawBody: true });
  app.enableShutdownHooks();
  // Before anything else registers middleware: the order API reads its body
  // under its own size limit, ahead of the app-wide parser.
  applyOrderApiEdge(app);
  const adapterHost = app.get(HttpAdapterHost);
  app.useGlobalFilters(new GlobalExceptionFilter(adapterHost));
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      transform: true,
      forbidNonWhitelisted: false,
    }),
  );

  await app.listen(process.env.PORT ?? 3000);
}
bootstrap().catch((err) => {
  logger.error(
    buildBackendLog('Bootstrap', {
      action: 'bootstrap',
      outcome: 'failure',
      ...normalizeError(err),
    }),
  );
  process.exit(1);
});
