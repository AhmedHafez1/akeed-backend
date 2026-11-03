import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { VerificationMessageDispatchesRepository } from '../../../database/repositories/verification-message-dispatches.repository';
import { WhatsappConnectionsRepository } from '../../../database/repositories/whatsapp-connections.repository';
import { WhatsappConnectionTemplatesRepository } from '../../../database/repositories/whatsapp-connection-templates.repository';
import { readWhatsappOwnNumberConfig } from '../../../../shared/config/whatsapp-own-number.config';
import { readMetaGraphConfig } from '../../../../shared/config/meta-graph.config';
import {
  ConfirmedMessageRejection,
  type MessagingPort,
} from '../../../../shared/ports/messaging.port';
import { resolveSender } from '../../../../modules/whatsapp-sender/sender-resolution.policy';
import { readBusinessToken } from './whatsapp-connection-credentials';

export interface MetaSendContext {
  url: string;
  token: string;
  timeout?: number;
}

@Injectable()
export class MetaSendContextService {
  constructor(
    private readonly config: ConfigService,
    private readonly dispatches: VerificationMessageDispatchesRepository,
    private readonly connections: WhatsappConnectionsRepository,
    private readonly templates: WhatsappConnectionTemplatesRepository,
  ) {}

  async resolve(
    params: Parameters<MessagingPort['sendVerificationTemplate']>[0],
  ): Promise<MetaSendContext> {
    const refuse = (code: string): never => {
      throw new ConfirmedMessageRejection(code);
    };
    const sender = params.sender;
    const context = params.dispatchContext;
    if (!sender || !context) return refuse('sender_dispatch_missing');
    // The kill switch also fences an already-claimed merchant retry, before
    // reading its connection or decrypting anything.
    if (
      sender.kind === 'merchant_own' &&
      !readWhatsappOwnNumberConfig(this.config).sendingEnabled
    )
      return refuse('own_number_sending_disabled');
    const dispatch = await this.dispatches.findForSender(
      context.orgId,
      context.dispatchId,
      params.verificationId,
    );
    if (
      !dispatch ||
      dispatch.state !== 'sending' ||
      dispatch.senderKind !== sender.kind ||
      dispatch.senderConnectionId !== sender.connectionId ||
      (dispatch.senderReason !== null &&
        dispatch.senderReason !== sender.reason) ||
      dispatch.templateName !== params.template.templateName ||
      dispatch.languageCode !== params.template.languageCode
    )
      return refuse('sender_dispatch_mismatch');
    let token = this.config.get<string>('WA_ACCESS_TOKEN') ?? '';
    let phoneNumberId =
      dispatch.senderPhoneNumberId ??
      this.config.get<string>('WA_PHONE_NUMBER_ID');
    if (sender.kind === 'merchant_own') {
      const connection = await this.connections.findByOrg(context.orgId);
      if (
        !connection ||
        connection.id !== sender.connectionId ||
        !dispatch.senderPhoneNumberId ||
        connection.phoneNumberId !== dispatch.senderPhoneNumberId
      )
        return refuse('sender_connection_unavailable');
      const template = await this.templates.findForSend(
        context.orgId,
        connection.id,
        params.template,
      );
      if (
        resolveSender({ enabled: true, connection, template }).kind !==
        'merchant_own'
      )
        return refuse('sender_not_ready');
      const businessToken = readBusinessToken(
        connection,
        this.config.get<string>('SHOPIFY_TOKEN_ENCRYPTION_KEY') ?? '',
      );
      if (!businessToken) return refuse('sender_credentials_unavailable');
      token = businessToken;
      phoneNumberId = dispatch.senderPhoneNumberId;
    }
    return {
      url: `${readMetaGraphConfig(this.config).baseUrl}/${phoneNumberId}/messages`,
      token,
      ...(sender.kind === 'merchant_own' ? { timeout: 15_000 } : {}),
    };
  }
}
