/**
 * What the connect screen needs to launch Embedded Signup. Public Meta ids
 * only: never a token, PIN, ticket or ciphertext.
 */
export interface WhatsappSenderAvailabilityDto {
  /** Connect is on and this organization is allowed. */
  available: boolean;
  /** Meta app id; null unless `available`. */
  appId: string | null;
  /** Embedded Signup configuration id; null unless `available`. */
  configId: string | null;
  /** `available` and the member is the owner, who alone may connect. */
  canConnect: boolean;
}
