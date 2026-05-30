import { NestFactory, HttpAdapterHost } from '@nestjs/core';
import { ValidationPipe, Logger } from '@nestjs/common';
import { AppModule } from './app.module';
import { GlobalExceptionFilter } from './shared/filters/global-exception.filter';
import { runMigrations } from './infrastructure/database/migrate';
import {
  buildBackendLog,
  normalizeError,
} from './shared/logging/backend-log.util';

const logger = new Logger('Bootstrap');

async function bootstrap() {
  await runMigrations();

  const app = await NestFactory.create(AppModule, { rawBody: true });
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
