import { NestFactory, HttpAdapterHost } from '@nestjs/core';
import { AppModule } from './app.module';
import { GlobalExceptionFilter } from './shared/filters/global-exception.filter';
import { runMigrations } from './infrastructure/database/migrate';

async function bootstrap() {
  await runMigrations();

  const app = await NestFactory.create(AppModule, { rawBody: true });
  const adapterHost = app.get(HttpAdapterHost);
  app.useGlobalFilters(new GlobalExceptionFilter(adapterHost));

  await app.listen(process.env.PORT ?? 3000);
}
bootstrap().catch((err) => {
  console.error('Error during bootstrap', err);
  process.exit(1);
});
