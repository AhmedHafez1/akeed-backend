import { HttpService } from '@nestjs/axios';
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { isAxiosError } from 'axios';
import { firstValueFrom } from 'rxjs';
import {
  getCodTemplateDefinition,
  type CodTemplateSelection,
} from '../../../shared/messaging/cod-template-catalog';
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

  async sendVerificationTemplate(params: {
    to: string;
    customerName?: string | null;
    storeName?: string | null;
    orderNumber: string;
    totalPrice: string;
    verificationId: string;
    preferredLanguage?: VerificationTemplatePreference;
    templateSelection?: Partial<CodTemplateSelection>;
  }): Promise<WhatsAppResponse> {
    const preferredLanguage = params.preferredLanguage ?? 'auto';
    const resolvedLanguage = this.resolveTemplateLanguage(
      preferredLanguage,
      params.to,
    );
    const templateDefinition = getCodTemplateDefinition({
      language: resolvedLanguage,
      selection: params.templateSelection,
    });
    const bodyParameters = templateDefinition.bodyParameterOrder.map(
      (parameterKey) => {
        if (parameterKey === 'order') {
          return params.orderNumber;
        }

        if (parameterKey === 'total') {
          return params.totalPrice;
        }

        if (parameterKey === 'customer') {
          return (params.customerName ?? '').trim() || 'Customer';
        }

        if (parameterKey === 'store') {
          return (params.storeName ?? '').trim() || 'Akeed Store';
        }

        return '';
      },
    );

    const payload = {
      messaging_product: 'whatsapp',
      to: params.to,
      type: 'template',
      template: {
        name: templateDefinition.metaTemplateName,
        language: {
          code: templateDefinition.metaLanguageCode,
        },
        components: [
          {
            type: 'body',
            parameters: bodyParameters.map((parameterValue) => ({
              type: 'text',
              text: parameterValue,
            })),
          },
          {
            type: 'button',
            sub_type: 'quick_reply',
            index: 0,
            parameters: [
              {
                type: 'payload',
                payload: `confirm_${params.verificationId}`,
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
                payload: `cancel_${params.verificationId}`,
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
      const context = this.buildSafeErrorContext(error, {
        verificationId: params.verificationId,
        resolvedLanguage,
        templateName: templateDefinition.metaTemplateName,
      });
      this.logger.error(`WhatsApp send failed: ${context}`);
      throw new Error(`WhatsApp send failed: ${context}`);
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

  private buildSafeErrorContext(
    error: unknown,
    params: {
      verificationId: string;
      resolvedLanguage: VerificationTemplateLanguage;
      templateName: string;
    },
  ): string {
    if (!isAxiosError(error)) {
      return [
        `verificationId=${params.verificationId}`,
        `language=${params.resolvedLanguage}`,
        `template=${params.templateName}`,
        `message=${error instanceof Error ? error.message : String(error)}`,
      ].join(' ');
    }

    const responseData = error.response?.data as
      | {
          error?: {
            message?: string;
            type?: string;
            code?: number;
            error_subcode?: number;
            fbtrace_id?: string;
          };
        }
      | undefined;
    const metaError = responseData?.error;
    const status = error.response?.status;
    const rateLimitLabel = status === 429 ? ' rate_limited=true' : '';

    return [
      `verificationId=${params.verificationId}`,
      `language=${params.resolvedLanguage}`,
      `template=${params.templateName}`,
      `status=${status ?? 'unknown'}`,
      `code=${metaError?.code ?? 'unknown'}`,
      `subcode=${metaError?.error_subcode ?? 'unknown'}`,
      `type=${metaError?.type ?? 'unknown'}`,
      `fbtraceId=${metaError?.fbtrace_id ?? 'unknown'}`,
      `message=${metaError?.message ?? error.message}`,
      rateLimitLabel.trim(),
    ]
      .filter(Boolean)
      .join(' ');
  }
}
