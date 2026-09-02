import type { CodStatus } from './commerce-source.interface';

export interface NormalizedOrder {
  /** Trusted tenant identity resolved by the ingestion boundary. */
  orgId: string;
  /** Trusted commerce-source identity resolved by the ingestion boundary. */
  integrationId: string;
  /** Stable order identifier assigned by the source. */
  externalOrderId: string;
  /** Optional merchant-facing source reference. */
  orderNumber?: string;
  /** Customer phone number in E.164 format. */
  customerPhone: string;
  customerName?: string;
  /** Decimal monetary amount represented as text. */
  totalPrice: string;
  /** Source currency code. */
  currency: string;
  paymentMethod?: string;
  /** Normalized payment evidence collected at the source boundary. */
  paymentSignals?: string[];
  /** Explicit COD disposition; omitted by legacy producers. */
  codStatus?: CodStatus;
  /** Opaque provider payload. Platform-specific code owns its interpretation. */
  rawPayload?: Record<string, unknown>;
}
