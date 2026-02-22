import { NestFactory, HttpAdapterHost } from '@nestjs/core';
import { AppModule } from './app.module';
import { SecurityMiddleware } from './core/middleware/security.middleware';
import { GlobalExceptionFilter } from './shared/filters/global-exception.filter';

async function bootstrap() {
  const app = await NestFactory.create(AppModule, { rawBody: true });
  const securityMiddleware = new SecurityMiddleware();
  app.use(securityMiddleware.use.bind(securityMiddleware));
  const adapterHost = app.get(HttpAdapterHost);
  app.useGlobalFilters(new GlobalExceptionFilter(adapterHost));

  await app.listen(process.env.PORT ?? 3000);
}
bootstrap().catch((err) => {
  // We can't use the Nest logger here as it's not initialized yet.
  console.error('Error during bootstrap', err);
  process.exit(1);
});
