import { Injectable } from '@nestjs/common';
import { EasyOrdersConnectionsRepository } from '../../database/repositories/easyorders-connections.repository';
import type {
  SourceCredentialStatus,
  SourceSetupBlockedReason,
  SourceSetupContribution,
  SourceSetupContributor,
} from '../../../shared/commerce/source-setup';

const CREDENTIAL_STATUS: Record<string, SourceCredentialStatus> = {
  ok: 'ok',
  store_inactive: 'store_inactive',
  credentials_rejected: 'rejected',
};

/**
 * What the EasyOrders connection adds to setup and health (US-06-05), from
 * the connection row alone: no provider call, so the credential status is the
 * last answer EasyOrders gave, not a live check.
 *
 * An inactive store is not a setup blocker: the contract record (section 2)
 * treats it as a retryable health state, and its orders simply wait.
 */
@Injectable()
export class EasyOrdersSetupContributor implements SourceSetupContributor {
  readonly platformType = 'easyorders';
  readonly readableWhenDisconnected = true;

  constructor(private readonly connections: EasyOrdersConnectionsRepository) {}

  async describe(source: {
    id: string;
    orgId: string;
  }): Promise<SourceSetupContribution | null> {
    const connection = await this.connections.findByIntegration(
      source.id,
      source.orgId,
    );
    if (!connection) return null;

    const disconnected = connection.disconnectedAt !== null;
    const secretsMissing =
      !disconnected &&
      (connection.ordersWebhookSecretEncrypted === null ||
        connection.statusWebhookSecretEncrypted === null);
    const credentials: SourceCredentialStatus = disconnected
      ? 'removed'
      : (CREDENTIAL_STATUS[connection.health] ?? 'ok');

    // A missing webhook secret blocks nothing: it is learned from the first
    // verified delivery, and orders are read back from EasyOrders until then.
    const blockedReasons: SourceSetupBlockedReason[] = [];
    if (disconnected) blockedReasons.push('source_disconnected');
    else {
      if (credentials === 'rejected')
        blockedReasons.push('credentials_rejected');
      if (!connection.currency || !connection.phoneCountry)
        blockedReasons.push('order_defaults_missing');
    }

    return {
      connectionState: disconnected ? 'disconnected' : 'connected',
      disconnectedAt: connection.disconnectedAt,
      store: {
        reference: connection.storeId,
        verified: connection.storeVerifiedAt !== null,
      },
      orderDefaults: {
        currency: connection.currency,
        phoneCountry: connection.phoneCountry,
      },
      blockedReasons,
      credentials: { status: credentials },
      delivery: {
        secretsMissing,
        rejectedCount: connection.rejectedDeliveries,
        lastRejectedAt: connection.lastRejectedAt,
      },
    };
  }
}
