import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';

async function bootstrap() {
  const app = await NestFactory.create(AppModule, { rawBody: true });
  await app.listen(process.env.PORT ?? 3000);
}
bootstrap().catch((err) => {
  // We can't use the Nest logger here as it's not initialized yet.
  console.error('Error during bootstrap', err);
  process.exit(1);
});
