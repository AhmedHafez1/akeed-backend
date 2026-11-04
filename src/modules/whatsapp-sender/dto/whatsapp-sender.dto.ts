import type { SenderAlert } from '../../../shared/notifications/sender-alert.policy';
import type { LastAcceptedSender } from '../../../infrastructure/database/repositories/whatsapp-sender-read.repository';
/**
 * What the connect screen needs to launch Embedded Signup. Public Meta ids
 * only: never a token, PIN, ticket or ciphertext.
 */
export interface WhatsappSenderAvailabilityDto {
  sendingEnabled: boolean;
  permissions: { canDisconnect: boolean; canUpdateThankYou: boolean };
  lastAcceptedSend: LastAcceptedSender | null;
  alerts: SenderAlert[];
  /** Connect is on and this organization is allowed. */
  available: boolean;
  /** Meta app id; null unless `available`. */
  appId: string | null;
  /** Embedded Signup configuration id; null unless `available`. */
  configId: string | null;
  /** `available` and the member is the owner, who alone may connect. */
  canConnect: boolean;
}
