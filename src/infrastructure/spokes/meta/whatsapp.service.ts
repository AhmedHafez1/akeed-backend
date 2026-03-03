import { HttpService } from '@nestjs/axios';
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { firstValueFrom } from 'rxjs';
import { WhatsAppResponse } from './models/whatsapp-response.interface';

type VerificationTemplateLanguage = 'ar' | 'en';
type VerificationTemplatePreference = 'auto' | VerificationTemplateLanguage;

@Injectable()
export class WhatsAppService {
  private readonly logger = new Logger(WhatsAppService.name);
  private readonly apiUrl: string;
  private readonly accessToken: string;
  private readonly phoneNumberId: string;
  private readonly arabicCountryCallingCodes = [
    '966', // Saudi Arabia
    '971', // UAE
    '973', // Bahrain
    '974', // Qatar
    '965', // Kuwait
    '968', // Oman
    '20', // Egypt
    '962', // Jordan
    '964', // Iraq
    '963', // Syria
    '961', // Lebanon
    '970', // Palestine
    '212', // Morocco
    '213', // Algeria
    '216', // Tunisia
    '218', // Libya
    '222', // Mauritania
    '249', // Sudan
    '252', // Somalia
    '253', // Djibouti
    '269', // Comoros
    '967', // Yemen
  ] as const;

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
    preferredLanguage: VerificationTemplatePreference = 'auto',
  ): Promise<WhatsAppResponse> {
    const resolvedLanguage = this.resolveTemplateLanguage(
      preferredLanguage,
      to,
    );

    const payload = {
      messaging_product: 'whatsapp',
      to: to,
      type: 'template',
      template: {
        name: 'akeed_cod_verification',
        language: {
          code: resolvedLanguage,
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
      return response.data as WhatsAppResponse;
    } catch (error) {
      this.logger.error('Error sending WhatsApp message');
      throw error;
    }
  }

  private resolveTemplateLanguage(
    preferredLanguage: VerificationTemplatePreference,
    phoneNumber: string,
  ): VerificationTemplateLanguage {
    if (preferredLanguage === 'ar' || preferredLanguage === 'en') {
      return preferredLanguage;
    }

    return this.isArabicPhoneNumber(phoneNumber) ? 'ar' : 'en';
  }

  private isArabicPhoneNumber(phoneNumber: string): boolean {
    const normalizedNumber = phoneNumber.replace(/[^\d+]/g, '');
    const internationalDigits = normalizedNumber.startsWith('+')
      ? normalizedNumber.slice(1)
      : normalizedNumber.startsWith('00')
        ? normalizedNumber.slice(2)
        : normalizedNumber;

    return this.arabicCountryCallingCodes.some((dialCode) =>
      internationalDigits.startsWith(dialCode),
    );
  }
}
