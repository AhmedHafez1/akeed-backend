import {
  Controller,
  Get,
  Post,
  Query,
  Body,
  HttpStatus,
  Logger,
  HttpCode,
  UsePipes,
  ValidationPipe,
  ForbiddenException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
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

  constructor(
    private readonly service: WhatsAppWebhookService,
    private readonly configService: ConfigService,
  ) {}

  @Get()
  @HttpCode(HttpStatus.OK)
  verifyWebhook(@Query() query: WhatsAppWebhookVerifyDto): string {
    const { mode, token, challenge } = query;
    const verifyToken =
      this.configService.getOrThrow<string>('WA_VERIFY_TOKEN');

    if (mode === 'subscribe' && token === verifyToken) {
      this.logger.log('Webhook verified successfully.');
      return challenge;
    }

    this.logger.error('Webhook verification failed.');
    throw new ForbiddenException('Webhook verification failed');
  }

  @Post()
  @HttpCode(200)
  async handleIncoming(
    @Body() payload: WhatsAppWebhookPayloadDto,
  ): Promise<{ status: string; message?: string }> {
    return this.service.processIncoming(payload);
  }
}
