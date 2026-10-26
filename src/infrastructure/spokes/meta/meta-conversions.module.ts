import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { MetaConversionsClient } from './meta-conversions.client';

/**
 * The Conversions API sender on its own, so marketing events need none of
 * the WhatsApp module's queues and repositories.
 */
@Module({
  imports: [ConfigModule],
  providers: [MetaConversionsClient],
  exports: [MetaConversionsClient],
})
export class MetaConversionsModule {}
