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
  UseGuards,
  ValidationPipe,
  ForbiddenException,
} from '@nestjs/common';
import { SkipThrottle } from '@nestjs/throttler';
import { ConfigService } from '@nestjs/config';
import { WhatsAppWebhookService } from './whatsapp.webhook.service';
import { WhatsAppWebhookPayloadDto } from './dto/whatsapp-webhook.dto';
import { MetaWebhookSignatureGuard } from '../../../shared/guards/meta-webhook-signature.guard';
import { buildBackendLog } from '../../../shared/logging/backend-log.util';

@SkipThrottle()
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
  verifyWebhook(
    @Query('hub.mode') mode: string,
    @Query('hub.verify_token') token: string,
    @Query('hub.challenge') challenge: string,
  ): string {
    const verifyToken = this.normalizeToken(
      this.configService.getOrThrow<string>('WA_VERIFY_TOKEN'),
    );
    const requestToken = this.normalizeToken(token);
    const isTokenMatch = requestToken === verifyToken;

    if (mode === 'subscribe' && isTokenMatch) {
      this.logger.log(
        buildBackendLog(WhatsAppWebhookController.name, {
          action: 'meta-webhook-verify',
          outcome: 'success',
        }),
      );
      return challenge;
    }

    this.logger.error(
      buildBackendLog(WhatsAppWebhookController.name, {
        action: 'meta-webhook-verify',
        outcome: 'failure',
        mode,
        tokenLength: token?.length ?? 0,
        challengeLength: challenge?.length ?? 0,
      }),
    );
    throw new ForbiddenException('Webhook verification failed');
  }

  private normalizeToken(value: string): string {
    return value.trim();
  }

  @Post()
  @UseGuards(MetaWebhookSignatureGuard)
  @HttpCode(200)
  async handleIncoming(
    @Body() payload: WhatsAppWebhookPayloadDto,
  ): Promise<{ status: string; message?: string }> {
    return this.service.processIncoming(payload);
  }
}
