import {
  ConfirmedMessageRejection,
  type MessagingSenderStatus,
} from '../../../shared/ports/messaging.port';
import { HttpService } from '@nestjs/axios';
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { isAxiosError } from 'axios';
import { firstValueFrom } from 'rxjs';
import type { TemplateVariableKey } from '../../../shared/messaging/template-registry.types';
import {
  toSentTemplateIdentity,
  type SelectedCodTemplate,
  type SentTemplateIdentity,
} from '../../../shared/messaging/cod-template-selector';
import {
  buildBackendLog,
  normalizeError,
} from '../../../shared/logging/backend-log.util';
import { WhatsAppResponse } from './models/whatsapp-response.interface';

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
        buildBackendLog(WhatsAppService.name, {
          action: 'whatsapp-service-config-validate',
          outcome: 'failure',
          errorCode: 'missing_wa_access_token',
        }),
      );
    }
    if (!this.phoneNumberId) {
      this.logger.warn(
        buildBackendLog(WhatsAppService.name, {
          action: 'whatsapp-service-config-validate',
          outcome: 'failure',
          errorCode: 'missing_wa_phone_number_id',
        }),
      );
    }

    this.apiUrl = `https://graph.facebook.com/v24.0/${this.phoneNumberId}/messages`;
  }

  getSenderStatus(): MessagingSenderStatus {
    return {
      sender: 'akeed_shared',
      status:
        this.accessToken && this.phoneNumberId
          ? 'configured'
          : 'not_configured',
    };
  }

  async sendVerificationTemplate(params: {
    to: string;
    customerName?: string | null;
    storeName?: string | null;
    orderNumber: string;
    totalPrice: string;
    verificationId: string;
    template: SelectedCodTemplate;
  }): Promise<WhatsAppResponse & { template: SentTemplateIdentity }> {
    const { template } = params;
    const bodyParameterValueByKey: Record<TemplateVariableKey, string> = {
      customer: (params.customerName ?? '').trim() || 'Customer',
      store: (params.storeName ?? '').trim() || 'Akeed Store',
      order: params.orderNumber,
      total: params.totalPrice,
    };

    // The registry gives the format and the variables in send order; a named
    // variable carries the parameter name the template was registered with.
    const bodyParameters = template.variables.map((variable) => {
      const text = bodyParameterValueByKey[variable.key];

      if (template.parameterFormat === 'named') {
        return {
          type: 'text' as const,
          parameter_name: variable.name ?? variable.key,
          text,
        };
      }

      return {
        type: 'text' as const,
        text,
      };
    });

    const payload = {
      messaging_product: 'whatsapp',
      to: params.to,
      type: 'template',
      template: {
        name: template.templateName,
        language: {
          code: template.languageCode,
        },
        components: [
          {
            type: 'body',
            parameters: bodyParameters,
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
      return {
        ...(response.data as WhatsAppResponse),
        template: toSentTemplateIdentity(template),
      };
    } catch (error) {
      const context = this.buildSafeErrorContext(error, {
        verificationId: params.verificationId,
        resolvedLanguage: template.language,
        templateName: template.templateName,
      });
      this.logger.error(
        buildBackendLog(WhatsAppService.name, {
          action: 'whatsapp-template-send',
          outcome: 'failure',
          verificationId: params.verificationId,
          to: params.to,
          resolvedLanguage: template.language,
          variantKey: template.variantKey,
          templateName: template.templateName,
          languageCode: template.languageCode,
          context,
          ...normalizeError(error),
        }),
      );
      if (
        isAxiosError<{ error?: { code?: number } }>(error) &&
        [400, 401, 403, 404, 422].includes(error.response?.status ?? 0) &&
        Number.isInteger(error.response?.data?.error?.code)
      ) {
        throw new ConfirmedMessageRejection('provider_rejected');
      }
      throw new Error(`WhatsApp send failed: ${context}`);
    }
  }

  private buildSafeErrorContext(
    error: unknown,
    params: {
      verificationId: string;
      resolvedLanguage: string;
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
