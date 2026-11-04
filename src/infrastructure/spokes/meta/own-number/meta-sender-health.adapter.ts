import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { WhatsappConnectionsRepository } from '../../../database/repositories/whatsapp-connections.repository';
import { OwnNumberGraphClient } from './own-number-graph.client';
import { readBusinessToken } from './whatsapp-connection-credentials';
import { classifyOwnNumberFailure } from './own-number-send-failure.policy';
import type {
  SenderHealthPort,
  SenderHealthResult,
} from '../../../../shared/ports/sender-recovery.port';

@Injectable()
export class MetaSenderHealthAdapter implements SenderHealthPort {
  constructor(
    private readonly connections: WhatsappConnectionsRepository,
    private readonly graph: OwnNumberGraphClient,
    private readonly config: ConfigService,
  ) {}
  async check(input: {
    orgId: string;
    connectionId: string;
    signupGeneration: number;
  }): Promise<SenderHealthResult> {
    const row = await this.connections.findByOrg(input.orgId);
    if (
      !row ||
      row.id !== input.connectionId ||
      row.signupGeneration !== input.signupGeneration ||
      !['active', 'verifying'].includes(row.state)
    )
      return { status: 'unknown' };
    const token = readBusinessToken(
      row,
      this.config.get<string>('SHOPIFY_TOKEN_ENCRYPTION_KEY') ?? '',
    );
    if (!token)
      return {
        status: 'BLOCKED',
        failure: classifyOwnNumberFailure({
          localCode: 'sender_credentials_unavailable',
        }),
      };
    return this.graph.readHealth(row.phoneNumberId, token);
  }
}
