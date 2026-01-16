import { Module } from '@nestjs/common';
import { HttpModule } from '@nestjs/axios';
import { WhatsAppService } from './whatsapp.service';
import { ConfigModule } from '@nestjs/config';

@Module({
  imports: [HttpModule, ConfigModule],
  providers: [WhatsAppService],
  exports: [WhatsAppService],
})
export class MetaModule {}
