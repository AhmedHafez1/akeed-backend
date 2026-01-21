import { HttpService } from '@nestjs/axios';
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { firstValueFrom } from 'rxjs';

@Injectable()
export class WhatsAppService {
  private readonly logger = new Logger(WhatsAppService.name);
  private readonly apiUrl: string;
  private readonly accessToken: string;
  private readonly phoneNumberId: string;

  constructor(
    private readonly httpService: HttpService,
    private readonly configService: ConfigService,
  ) {
    this.accessToken = this.configService.get<string>('WA_ACCESS_TOKEN')!;
    this.phoneNumberId = this.configService.get<string>('WA_PHONE_NUMBER_ID')!;

    // Basic validation to ensure env vars are present
    if (!this.accessToken) {
      this.logger.warn(
        'WA_ACCESS_TOKEN is not defined in environment variables',
      );
    }
    if (!this.phoneNumberId) {
      this.logger.warn(
        'WA_PHONE_NUMBER_ID is not defined in environment variables',
      );
    }

    this.apiUrl = `https://graph.facebook.com/v24.0/${this.phoneNumberId}/messages`;
  }

  async sendVerificationTemplate(
    to: string,
    orderNumber: string,
    totalPrice: string,
    verificationId: string,
  ): Promise<any> {
    const payload = {
      messaging_product: 'whatsapp',
      to: to,
      type: 'template',
      template: {
        name: 'akeed_cod_verification',
        language: {
          code: 'ar',
        },
        components: [
          {
            type: 'body',
            parameters: [
              {
                type: 'text',
                text: orderNumber,
              },
              {
                type: 'text',
                text: totalPrice,
              },
            ],
          },
          {
            type: 'button',
            sub_type: 'quick_reply',
            index: 0,
            parameters: [
              {
                type: 'payload',
                payload: `confirm_${verificationId}`,
              },
            ],
          },
          {
            type: 'button',
            sub_type: 'quick_reply',
            index: 1,
            parameters: [
              {
                type: 'payload',
                payload: `cancel_${verificationId}`,
              },
            ],
          },
        ],
      },
    };

    try {
      const response = await firstValueFrom(
        this.httpService.post(this.apiUrl, payload, {
          headers: {
            Authorization: `Bearer ${this.accessToken}`,
            'Content-Type': 'application/json',
          },
        }),
      );
      return response.data;
    } catch (error) {
      this.logger.error('Error sending WhatsApp message');
      throw error;
    }
  }
}
