/** Snapshot of the verified number that received a customer's reply. */
export interface MerchantReplySender {
  connectionId: string;
  phoneNumberId: string;
  signupGeneration: number;
}

export function merchantReplySenderReady(
  connection: {
    id: string;
    orgId: string;
    phoneNumberId: string;
    signupGeneration: number;
    state: string;
    degradedClass: string | null;
    thankYouEnabled: boolean;
  } | null,
  sender: MerchantReplySender,
  orgId: string,
): boolean {
  return Boolean(
    connection &&
    connection.orgId === orgId &&
    connection.id === sender.connectionId &&
    connection.phoneNumberId === sender.phoneNumberId &&
    connection.signupGeneration === sender.signupGeneration &&
    connection.state === 'active' &&
    !connection.degradedClass &&
    connection.thankYouEnabled === true,
  );
}
