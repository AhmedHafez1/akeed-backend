import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  buildBackendLog,
  normalizeError,
} from '../../../shared/logging/backend-log.util';

/** Same Graph API version as the WhatsApp sender. */
export const META_CONVERSIONS_GRAPH_URL = 'https://graph.facebook.com/v24.0';
/** A slow Graph call must not hold a worker; the event is best effort. */
export const META_CONVERSIONS_TIMEOUT_MS = 5_000;

/** Customer information, already normalised and hashed where Meta asks. */
export interface MetaConversionUserData {
  em?: string[];
  external_id?: string[];
  client_ip_address?: string;
  client_user_agent?: string;
  fbp?: string;
  fbc?: string;
}

export interface MetaConversionEvent {
  event_name: string;
  event_time: number;
  event_id: string;
  event_source_url: string;
  action_source: 'website';
  user_data: MetaConversionUserData;
  custom_data?: Record<string, unknown>;
}

export type MetaConversionSendResult = 'sent' | 'disabled' | 'failed';

/**
 * Sends server events to a Meta Pixel through the Conversions API.
 *
 * Optional by design: without `META_PIXEL_ID` and `META_CAPI_ACCESS_TOKEN`
 * it reports `disabled` and sends nothing. `META_TEST_EVENT_CODE` routes the
 * events to Events Manager's Test events tab. It never throws, because a
 * caller is always somewhere tracking must not break.
 */
@Injectable()
export class MetaConversionsClient implements OnModuleInit {
  private readonly logger = new Logger(MetaConversionsClient.name);
  private readonly pixelId: string | undefined;
  private readonly accessToken: string | undefined;
  private readonly testEventCode: string | undefined;

  constructor(config: ConfigService) {
    this.pixelId = readOptional(config, 'META_PIXEL_ID');
    this.accessToken = readOptional(config, 'META_CAPI_ACCESS_TOKEN');
    this.testEventCode = readOptional(config, 'META_TEST_EVENT_CODE');
  }

  onModuleInit(): void {
    if (!this.isEnabled()) {
      this.logger.log(
        buildBackendLog(MetaConversionsClient.name, {
          action: 'meta_conversions_config',
          outcome: 'skipped',
          reason: 'META_PIXEL_ID or META_CAPI_ACCESS_TOKEN is not set',
        }),
      );
    }
  }

  isEnabled(): boolean {
    return Boolean(this.pixelId && this.accessToken);
  }

  async send(event: MetaConversionEvent): Promise<MetaConversionSendResult> {
    if (!this.pixelId || !this.accessToken) return 'disabled';

    try {
      const response = await fetch(
        `${META_CONVERSIONS_GRAPH_URL}/${encodeURIComponent(this.pixelId)}/events`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          // The token travels in the body so it never appears in a URL.
          body: JSON.stringify({
            data: [event],
            access_token: this.accessToken,
            ...(this.testEventCode
              ? { test_event_code: this.testEventCode }
              : {}),
          }),
          signal: AbortSignal.timeout(META_CONVERSIONS_TIMEOUT_MS),
        },
      );
      const payload = (await response.json().catch(() => null)) as {
        events_received?: number;
        fbtrace_id?: string;
        error?: { message?: string; code?: number; fbtrace_id?: string };
      } | null;

      if (!response.ok) {
        this.logger.warn(
          buildBackendLog(MetaConversionsClient.name, {
            action: 'meta_conversions_send',
            outcome: 'failure',
            eventName: event.event_name,
            eventId: event.event_id,
            httpStatus: response.status,
            graphErrorCode: payload?.error?.code,
            graphErrorMessage: payload?.error?.message,
            fbtraceId: payload?.error?.fbtrace_id,
          }),
        );
        return 'failed';
      }

      this.logger.log(
        buildBackendLog(MetaConversionsClient.name, {
          action: 'meta_conversions_send',
          outcome: 'success',
          eventName: event.event_name,
          eventId: event.event_id,
          eventsReceived: payload?.events_received,
          fbtraceId: payload?.fbtrace_id,
          testEvent: Boolean(this.testEventCode),
        }),
      );
      return 'sent';
    } catch (error) {
      this.logger.warn(
        buildBackendLog(MetaConversionsClient.name, {
          action: 'meta_conversions_send',
          outcome: 'failure',
          eventName: event.event_name,
          eventId: event.event_id,
          ...normalizeError(error),
        }),
      );
      return 'failed';
    }
  }
}

function readOptional(config: ConfigService, key: string): string | undefined {
  const value = config.get<string>(key)?.trim();
  return value ? value : undefined;
}
