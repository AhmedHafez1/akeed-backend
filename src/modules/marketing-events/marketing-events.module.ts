import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { MetaConversionsModule } from '../../infrastructure/spokes/meta/meta-conversions.module';
import { MarketingEventsController } from './marketing-events.controller';
import {
  MARKETING_ACCOUNT_LOOKUP,
  MarketingEventsService,
  supabaseAccountLookup,
} from './marketing-events.service';

/** Server-side ad conversions (Meta Conversions API) for the public site. */
@Module({
  imports: [ConfigModule, MetaConversionsModule],
  controllers: [MarketingEventsController],
  providers: [
    MarketingEventsService,
    {
      provide: MARKETING_ACCOUNT_LOOKUP,
      inject: [ConfigService],
      useFactory: supabaseAccountLookup,
    },
  ],
})
export class MarketingEventsModule {}
