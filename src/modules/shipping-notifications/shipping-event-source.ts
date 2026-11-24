import type { PlatformType } from '../../shared/interfaces/commerce-source.interface';
import type {
  ShippingStage,
  ShippingTracking,
  ShippingTrigger,
} from '../../shared/shipping/shipping-notification.types';

/** The order a store event is about, and the facts eligibility needs. */
export interface ShippingOrderRef {
  externalOrderId: string;
  /** The store's own creation time of the order, ISO, when it is readable. */
  sourceCreatedAt: string | null;
  /** When the store cancelled the order, ISO; null while it is not. */
  sourceCancelledAt: string | null;
  isTest: boolean;
}

/** The merchant's shipping settings a source matches against. */
export interface ShippingDetectionSettings {
  fulfillmentTriggerEnabled: boolean;
  tags: readonly string[];
}

/** What in the event makes the order count as shipped. */
export interface ShippingDetection {
  stage: ShippingStage;
  trigger: ShippingTrigger;
  /** The saved tag that matched, in the merchant's spelling. */
  matchedTag?: string;
  tracking?: ShippingTracking;
}

/**
 * A platform's reading of its store order-update events. Pure: it reads the
 * stored payload and never calls the provider. The core resolves the order,
 * the verification and the settings itself.
 */
export interface ShippingEventSource {
  readonly platform: PlatformType;

  /** The order the event is about; null when the payload has no usable id. */
  readOrderRef(rawPayload: Record<string, unknown>): ShippingOrderRef | null;

  /** Whether the event shows the order shipped under these settings. */
  detect(
    rawPayload: Record<string, unknown>,
    settings: ShippingDetectionSettings,
  ): ShippingDetection | null;
}

/** DI token for the registered shipping event sources, one per platform. */
export const SHIPPING_EVENT_SOURCES = Symbol('SHIPPING_EVENT_SOURCES');
