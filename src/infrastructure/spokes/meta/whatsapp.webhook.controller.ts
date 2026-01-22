import type { WhatsAppWebhookPayload } from './models/whatsapp-webhook-payload.interface';
import {
  Controller,
  Get,
  Post,
  Query,
  Body,
  Res,
  HttpStatus,
  Logger,
  HttpCode,
} from '@nestjs/common';
import type { Response } from 'express';
import { WhatsAppWebhookService } from './whatsapp.webhook.service';

@Controller('webhooks/whatsapp')
export class WhatsAppWebhookController {
  private readonly logger = new Logger(WhatsAppWebhookController.name);

  constructor(private readonly service: WhatsAppWebhookService) {}

  @Get()
  verifyWebhook(
    @Query('hub.mode') mode: string,
    @Query('hub.verify_token') token: string,
    @Query('hub.challenge') challenge: string,
    @Res() res: Response,
  ) {
    if (mode === 'subscribe' && token === process.env.WA_VERIFY_TOKEN) {
      this.logger.log('Webhook verified successfully.');
      return res.status(HttpStatus.OK).send(challenge);
    } else {
      this.logger.error('Webhook verification failed.');
      return res.sendStatus(HttpStatus.FORBIDDEN);
    }
  }

  @Post()
  @HttpCode(200)
  async handleIncoming(@Body() payload: WhatsAppWebhookPayload) {
    try {
      await this.service.handleIncoming(payload);
      return { status: 'success' };
    } catch (e) {
      this.logger.error('Error handling webhook payload:', e);
      // Always return 200 OK to prevent Meta from disabling the webhook
      return { status: 'error', message: 'Internal Server Error' };
    }
  }
}
