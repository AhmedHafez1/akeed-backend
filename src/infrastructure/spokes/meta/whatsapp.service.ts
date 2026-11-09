import { customerButtonPayload } from '../../../shared/messaging/change-request-messaging';
import {
  MetaSendContextService,
  type MetaSendContext,
} from './own-number/meta-send-context.service';
import {
  MerchantMessageFailure,
  type MerchantAttemptContext,
} from '../../../shared/ports/sender-recovery.port';
import { classifyOwnNumberFailure } from './own-number/own-number-send-failure.policy';
import type { ResolvedSender } from '../../../shared/ports/sender-resolver.port';
import {
  ConfirmedMessageRejection,
  type FreeFormTextOutcome,
  type MessagingSenderStatus,
  type MessagingPort,
} from '../../../shared/ports/messaging.port';
import { MESSAGE_TEXT_MAX_LENGTH } from '../../../shared/messaging/message-texts.types';

/** Record 4.10.3: a free-form message outside the window. */
const WINDOW_CLOSED_ERROR_CODE = 131047;
/** Sent for an order detail the caller gave no value for. */
const MISSING_DETAIL = '-';
/**
 * Refusals of an image-header send that the text template can still carry:
 * the image could not be fetched or read (131052, 131053), or the twin's
 * parameters, name or state do not match what was sent (132000, 132001,
 * 132012, 132015, 132016). The message was not sent, so one text send follows.
 */
const IMAGE_HEADER_FALLBACK_ERROR_CODES: ReadonlySet<number> = new Set([
  131052, 131053, 132000, 132001, 132012, 132015, 132016,
]);
const CONFIRMED_REJECTION_STATUSES = [400, 401, 403, 404, 422];
import { HttpService } from '@nestjs/axios';
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { readMetaGraphConfig } from '../../../shared/config/meta-graph.config';
import { isAxiosError } from 'axios';
import { firstValueFrom } from 'rxjs';
import type { OrderDetailValues } from '../../../shared/messaging/order-detail-values';
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
    private readonly sendContext?: MetaSendContextService,
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

    this.apiUrl = `${readMetaGraphConfig(this.configService).baseUrl}/${this.phoneNumberId}/messages`;
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
    beforeTemplateAttempt?: (identity: SentTemplateIdentity) => Promise<void>;
    confirmationCycle?: number;
    sender?: ResolvedSender;
    dispatchContext?: {
      orgId: string;
      dispatchId: string;
      merchantAttempt?: MerchantAttemptContext;
    };
    fallbacks?: { customer?: string; store?: string };
    detailValues?: OrderDetailValues;
  }): Promise<WhatsAppResponse & { template: SentTemplateIdentity }> {
    const { template } = params;
    if (params.sender?.kind === 'merchant_own' && !this.sendContext)
      throw new ConfirmedMessageRejection('sender_context_unavailable');
    const context =
      params.sender && this.sendContext
        ? await this.sendContext.resolve(params)
        : { url: this.apiUrl, token: this.accessToken };
    const bodyParameterValueByKey: Record<TemplateVariableKey, string> = {
      customer:
        (params.customerName ?? '').trim() ||
        params.fallbacks?.customer ||
        'Customer',
      store:
        (params.storeName ?? '').trim() ||
        params.fallbacks?.store ||
        'Akeed Store',
      order: params.orderNumber,
      total: params.totalPrice,
      // The provider rejects an empty parameter. The caller does not send a
      // template the order cannot fill, so the dash is a last resort.
      items: params.detailValues?.items || MISSING_DETAIL,
      region: params.detailValues?.region || MISSING_DETAIL,
      address: params.detailValues?.address || MISSING_DETAIL,
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

    const buildPayload = (
      name: string,
      languageCode: string,
      imageUrl?: string,
    ) => ({
      messaging_product: 'whatsapp',
      to: params.to,
      type: 'template',
      ...(params.sender?.kind === 'merchant_own' &&
      params.dispatchContext?.merchantAttempt
        ? {
            biz_opaque_callback_data:
              params.dispatchContext.merchantAttempt.attemptId,
          }
        : {}),
      template: {
        name,
        language: {
          code: languageCode,
        },
        components: [
          ...(imageUrl
            ? [
                {
                  type: 'header',
                  parameters: [{ type: 'image', image: { link: imageUrl } }],
                },
              ]
            : []),
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
                payload: template.changeRequestOfKey
                  ? customerButtonPayload(
                      'confirmed',
                      params.verificationId,
                      params.confirmationCycle ?? 1,
                    )
                  : `confirm_${params.verificationId}`,
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
                payload: template.changeRequestOfKey
                  ? customerButtonPayload(
                      'canceled',
                      params.verificationId,
                      params.confirmationCycle ?? 1,
                    )
                  : `cancel_${params.verificationId}`,
              },
            ],
          },
          ...(template.changeRequestOfKey
            ? [
                {
                  type: 'button',
                  sub_type: 'quick_reply',
                  index: 2,
                  parameters: [
                    {
                      type: 'payload',
                      payload: customerButtonPayload(
                        'change_requested',
                        params.verificationId,
                        params.confirmationCycle ?? 1,
                      ),
                    },
                  ],
                },
              ]
            : []),
        ],
      },
    });

    const image =
      params.sender?.kind === 'merchant_own' ? undefined : template.imageHeader;
    if (image) {
      const sent: SentTemplateIdentity = {
        ...toSentTemplateIdentity(template),
        templateName: image.templateName,
        languageCode: image.languageCode,
      };
      try {
        await params.beforeTemplateAttempt?.(sent);
        const response = await this.postMessage(
          buildPayload(image.templateName, image.languageCode, image.imageUrl),
          context,
        );
        return { ...(response.data as WhatsAppResponse), template: sent };
      } catch (error) {
        const code = this.confirmedRejectionCode(error);
        if (
          code === undefined ||
          !IMAGE_HEADER_FALLBACK_ERROR_CODES.has(code)
        ) {
          this.failSend(error, params, sent, context.token);
        }
        this.logger.warn(
          buildBackendLog(WhatsAppService.name, {
            action: 'whatsapp-template-send-image-fallback',
            outcome: 'retry',
            verificationId: params.verificationId,
            variantKey: template.variantKey,
            templateName: image.templateName,
            fallbackTemplateName: template.templateName,
            providerErrorCode: code,
            ...this.safeError(error, context.token),
          }),
        );
      }
    }

    try {
      await params.beforeTemplateAttempt?.(toSentTemplateIdentity(template));
      const response = await this.postMessage(
        buildPayload(template.templateName, template.languageCode),
        context,
      );
      return {
        ...(response.data as WhatsAppResponse),
        template: toSentTemplateIdentity(template),
      };
    } catch (error) {
      if (params.sender?.kind === 'merchant_own') {
        const response = isAxiosError<{ error?: { code?: unknown } }>(error)
          ? error.response
          : undefined;
        const failure = classifyOwnNumberFailure({
          code: response?.data?.error?.code,
          httpStatus: response?.status,
          transport: !response,
        });
        this.logger.error(
          buildBackendLog(WhatsAppService.name, {
            action: 'whatsapp-merchant-send',
            outcome: 'failure',
            verificationId: params.verificationId,
            failureClass: failure.class,
            errorCode: failure.code ?? 'outcome_unknown',
            ...this.safeError(error, context.token),
          }),
        );
        throw new MerchantMessageFailure(failure);
      }
      this.failSend(error, params, template, context.token);
    }
  }

  private postMessage(
    payload: Record<string, unknown>,
    context: MetaSendContext,
  ) {
    return firstValueFrom(
      this.httpService.post(context.url, payload, {
        ...(context.timeout ? { timeout: context.timeout } : {}),
        headers: {
          Authorization: `Bearer ${context.token}`,
          'Content-Type': 'application/json',
        },
      }),
    );
  }

  /** The provider's error code for a refusal it confirmed, else undefined. */
  private confirmedRejectionCode(error: unknown): number | undefined {
    if (
      isAxiosError<{ error?: { code?: number } }>(error) &&
      CONFIRMED_REJECTION_STATUSES.includes(error.response?.status ?? 0) &&
      Number.isInteger(error.response?.data?.error?.code)
    ) {
      return error.response?.data?.error?.code;
    }
    return undefined;
  }

  /** Logs a failed template send and throws what the caller classifies. */
  private failSend(
    error: unknown,
    params: { verificationId: string; to: string },
    template: SentTemplateIdentity,
    token: string,
  ): never {
    const context = this.withoutToken(
      this.buildSafeErrorContext(error, {
        verificationId: params.verificationId,
        resolvedLanguage: template.language,
        templateName: template.templateName,
      }),
      token,
    );
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
        ...this.safeError(error, token),
      }),
    );
    const code = this.confirmedRejectionCode(error);
    if (code !== undefined) {
      throw new ConfirmedMessageRejection('provider_rejected', String(code));
    }
    throw new Error(`WhatsApp send failed: ${context}`);
  }

  /**
   * A text message, in the same envelope as a template send.
   * Sent once, never retried. 131047 is the closed window,
   * an expected outcome. Never throws.
   */
  async sendFreeFormText(
    params: Parameters<NonNullable<MessagingPort['sendFreeFormText']>>[0],
  ): Promise<FreeFormTextOutcome> {
    if (!params.body || params.body.length > MESSAGE_TEXT_MAX_LENGTH) {
      return { outcome: 'rejected', code: 'body_length' };
    }
    const payload = {
      messaging_product: 'whatsapp',
      to: params.to,
      type: 'text',
      text: { body: params.body },
    };
    let context: MetaSendContext = {
      url: this.apiUrl,
      token: this.accessToken,
    };
    try {
      if (params.sender || params.dispatchContext) {
        if (!this.sendContext)
          return { outcome: 'rejected', code: 'sender_context_unavailable' };
        context = await this.sendContext.resolveFreeForm(params);
      }
      const response = await firstValueFrom(
        this.httpService.post(context.url, payload, {
          ...(context.timeout ? { timeout: context.timeout } : {}),
          headers: {
            Authorization: `Bearer ${context.token}`,
            'Content-Type': 'application/json',
          },
        }),
      );
      const providerMessageId = (response.data as WhatsAppResponse)
        ?.messages?.[0]?.id;
      return providerMessageId
        ? { outcome: 'accepted', providerMessageId }
        : { outcome: 'failed', code: 'missing_provider_message_id' };
    } catch (error) {
      if (error instanceof ConfirmedMessageRejection)
        return { outcome: 'rejected', code: error.code };
      const metaCode = isAxiosError<{ error?: { code?: number } }>(error)
        ? error.response?.data?.error?.code
        : undefined;
      const status = isAxiosError(error) ? error.response?.status : undefined;
      const outcome: FreeFormTextOutcome =
        metaCode === WINDOW_CLOSED_ERROR_CODE
          ? { outcome: 'window_closed' }
          : Number.isInteger(metaCode) &&
              CONFIRMED_REJECTION_STATUSES.includes(status ?? 0)
            ? { outcome: 'rejected', code: 'provider_rejected' }
            : { outcome: 'failed', code: 'provider_error' };
      const fields = {
        action: 'whatsapp-text-send',
        verificationId: params.verificationId,
        reason: outcome.outcome,
        providerErrorCode: metaCode ?? 'unknown',
        ...(status ? { httpStatus: status } : {}),
      };
      if (outcome.outcome === 'window_closed') {
        this.logger.warn(
          buildBackendLog(WhatsAppService.name, {
            ...fields,
            outcome: 'skipped',
          }),
        );
      } else {
        this.logger.error(
          buildBackendLog(WhatsAppService.name, {
            ...fields,
            outcome: 'failure',
            ...this.safeError(error, context.token),
          }),
        );
      }
      return outcome;
    }
  }

  /**
   * An error from the provider can quote the request, and with it the access
   * token. Nothing built from one is logged or thrown with the token in it.
   */
  private withoutToken(text: string, token?: string): string {
    for (const secret of [this.accessToken, token]) {
      if (!secret) continue;
      for (const value of [
        secret,
        encodeURIComponent(secret),
        encodeURI(secret),
      ])
        text = text.split(value).join('[REDACTED]');
    }
    return text;
  }

  private safeError(
    error: unknown,
    token?: string,
  ): ReturnType<typeof normalizeError> {
    return Object.fromEntries(
      Object.entries(normalizeError(error)).map(([key, value]) => [
        key,
        typeof value === 'string'
          ? this.withoutToken(value, token)
          : Array.isArray(value)
            ? value.map((item: string) => this.withoutToken(item, token))
            : value,
      ]),
    );
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
    // No response means the connection failed; its message is often empty.
    const networkCodes = error.response
      ? []
      : (normalizeError(error).errorCauseCodes ?? []);

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
      networkCodes.length > 0 ? `network=${networkCodes.join(',')}` : '',
      rateLimitLabel.trim(),
    ]
      .filter(Boolean)
      .join(' ');
  }
}
