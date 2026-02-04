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
  UsePipes,
  ValidationPipe,
} from '@nestjs/common';
import type { Response } from 'express';
import { WhatsAppWebhookService } from './whatsapp.webhook.service';
import {
  WhatsAppWebhookPayloadDto,
  WhatsAppWebhookVerifyDto,
} from './dto/whatsapp-webhook.dto';

@Controller('webhooks/whatsapp')
@UsePipes(
  new ValidationPipe({
    transform: true,
    whitelist: false,
  }),
)
export class WhatsAppWebhookController {
  private readonly logger = new Logger(WhatsAppWebhookController.name);

  constructor(private readonly service: WhatsAppWebhookService) {}

  @Get()
  verifyWebhook(
    @Query() query: WhatsAppWebhookVerifyDto,
    @Res() res: Response,
  ): Response {
    const { mode, token, challenge } = query;

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
  async handleIncoming(
    @Body() payload: WhatsAppWebhookPayloadDto,
  ): Promise<{ status: string; message?: string }> {
    return this.service.processIncoming(payload);
  }
}
