import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { MembershipsRepository } from '../../infrastructure/database/repositories/memberships.repository';
import { WhatsappConnectTicketsRepository } from '../../infrastructure/database/repositories/whatsapp-connect-tickets.repository';
import {
  SIGNUP_REPLACEABLE_STATES,
  WhatsappConnectionsRepository,
  WhatsappPhoneNumberInUseError,
  WhatsappAccountInUseError,
} from '../../infrastructure/database/repositories/whatsapp-connections.repository';
import {
  OwnNumberGraphClient,
  type OwnNumberGraphFailure,
} from '../../infrastructure/spokes/meta/own-number/own-number-graph.client';
import {
  checkBusinessToken,
  choosePhoneNumber,
  chooseWabaId,
  signupPathFromHints,
  type SignupSessionHints,
} from '../../infrastructure/spokes/meta/own-number/signup-assets.policy';
import { encryptConnectionSecret } from '../../infrastructure/spokes/meta/own-number/whatsapp-connection-credentials';
import {
  generateInstallToken,
  hashInstallToken,
} from '../../shared/commerce/install-token';
import { readMetaGraphConfig } from '../../shared/config/meta-graph.config';
import {
  isOwnNumberConnectAllowed,
  readWhatsappOwnNumberConfig,
  type WhatsappOwnNumberConfig,
} from '../../shared/config/whatsapp-own-number.config';
import { buildBackendLog } from '../../shared/logging/backend-log.util';
import type { AuthenticatedUser } from '../auth/guards/dual-auth.guard';
import type {
  CompleteWhatsappSignupDto,
  WhatsappConnectLocale,
  WhatsappConnectTicketClaimedDto,
  WhatsappConnectTicketIssuedDto,
  WhatsappSignupCompletedDto,
} from './dto/whatsapp-connect.dto';
import { assertWhatsappConnectionChangeAllowed } from './whatsapp-connection-access.policy';
import { WhatsappConnectionSetupProducer } from './whatsapp-connection-setup.producer';
import {
  whatsappConnectError,
  type WhatsappConnectErrorCode,
} from './whatsapp-connect.errors';

/** From the settings click to opening the connect page. */
export const CONNECT_TICKET_TTL_SECONDS = 600;
/**
 * From opening the page to finishing Meta's flow, which can include creating
 * a business and verifying a number by code.
 */
export const SIGNUP_TICKET_TTL_SECONDS = 1_800;

const REPLACEABLE: ReadonlySet<string> = new Set(SIGNUP_REPLACEABLE_STATES);

interface ConnectContext {
  config: WhatsappOwnNumberConfig & {
    metaAppId: string;
    embeddedSignupConfigId: string;
    connectPageBaseUrl: string;
  };
}

/**
 * Connecting a merchant's own WhatsApp number through Embedded Signup.
 *
 * An owner gets a 10-minute connect ticket. The top-level connect page trades
 * it once for a 30-minute signup ticket, then spends that once to finish.
 * Every step rechecks the switch, the member's owner role and
 * the organization's existing connection, because a ticket outlives the
 * session that asked for it. Ids from the browser are hints only: the token
 * Meta issues decides which account and number may be saved.
 */
@Injectable()
export class WhatsappConnectService {
  private readonly logger = new Logger(WhatsappConnectService.name);

  constructor(
    private readonly config: ConfigService,
    private readonly tickets: WhatsappConnectTicketsRepository,
    private readonly connections: WhatsappConnectionsRepository,
    private readonly memberships: MembershipsRepository,
    private readonly graph: OwnNumberGraphClient,
    private readonly setupQueue: WhatsappConnectionSetupProducer,
  ) {}

  async issueTicket(
    user: AuthenticatedUser,
    locale: WhatsappConnectLocale,
  ): Promise<WhatsappConnectTicketIssuedDto> {
    const { config } = this.requireConnect();
    assertWhatsappConnectionChangeAllowed(user.role);
    await this.assertNoBlockingConnection(user.orgId);

    const ticket = generateInstallToken();
    const issued = await this.tickets.issue({
      orgId: user.orgId,
      userId: user.userId,
      tokenHash: hashInstallToken(ticket),
      ttlSeconds: CONNECT_TICKET_TTL_SECONDS,
      revokeOtherUnused: true,
    });
    this.logger.log(
      buildBackendLog(WhatsappConnectService.name, {
        action: 'whatsapp_connect_ticket_issue',
        outcome: 'success',
        orgId: user.orgId,
        userId: user.userId,
      }),
    );
    const url = new URL(
      `${config.connectPageBaseUrl}/${locale}/whatsapp/connect`,
    );
    url.searchParams.set('ticket', ticket);
    return { connectUrl: url.toString(), expiresAt: toIso(issued.expiresAt) };
  }

  async claimTicket(ticket: string): Promise<WhatsappConnectTicketClaimedDto> {
    const consumed = await this.tickets.consume(hashInstallToken(ticket), {
      lifetimeSeconds: CONNECT_TICKET_TTL_SECONDS,
    });
    if (!consumed)
      throw this.fail('claim', null, 'WHATSAPP_CONNECT_TICKET_INVALID');
    const { config } = await this.recheck(
      consumed.orgId,
      consumed.userId,
      'claim',
    );

    const signupTicket = generateInstallToken();
    const issued = await this.tickets.issue({
      orgId: consumed.orgId,
      userId: consumed.userId,
      tokenHash: hashInstallToken(signupTicket),
      ttlSeconds: SIGNUP_TICKET_TTL_SECONDS,
    });
    this.logger.log(
      buildBackendLog(WhatsappConnectService.name, {
        action: 'whatsapp_connect_ticket_claim',
        outcome: 'success',
        orgId: consumed.orgId,
      }),
    );
    return {
      signupTicket,
      expiresAt: toIso(issued.expiresAt),
      appId: config.metaAppId,
      configId: config.embeddedSignupConfigId,
      graphApiVersion: readMetaGraphConfig(this.config).apiVersion,
    };
  }

  async completeSignup(
    input: CompleteWhatsappSignupDto,
  ): Promise<WhatsappSignupCompletedDto> {
    const consumed = await this.tickets.consume(
      hashInstallToken(input.signupTicket),
      { lifetimeSeconds: SIGNUP_TICKET_TTL_SECONDS },
    );
    if (!consumed)
      throw this.fail('complete', null, 'WHATSAPP_CONNECT_TICKET_INVALID');
    const { orgId } = consumed;
    const { config } = await this.recheck(orgId, consumed.userId, 'complete');

    const appSecret = this.config.getOrThrow<string>('META_APP_SECRET');
    // First provider call: the code expires 30 seconds after Meta issues it.
    const exchanged = await this.graph.exchangeCode({
      appId: config.metaAppId,
      appSecret,
      code: input.code,
    });
    if (!exchanged.ok)
      throw this.providerFail(
        orgId,
        'code_exchange',
        exchanged,
        'WHATSAPP_SIGNUP_CODE_REJECTED',
      );
    const { businessToken } = exchanged.value;

    const inspected = await this.graph.inspectToken({
      appId: config.metaAppId,
      appSecret,
      businessToken,
    });
    if (!inspected.ok)
      throw this.providerFail(
        orgId,
        'token_inspect',
        inspected,
        'WHATSAPP_SIGNUP_TOKEN_UNVERIFIED',
      );
    const tokenCheck = checkBusinessToken(inspected.value, config.metaAppId);
    if (!tokenCheck.ok)
      throw this.fail(
        'complete',
        orgId,
        'WHATSAPP_SIGNUP_TOKEN_UNVERIFIED',
        tokenCheck.reason,
      );

    const hints: SignupSessionHints = {
      wabaIds: input.wabaIds ?? [],
      phoneNumberId: input.phoneNumberId ?? null,
      isOnBusinessApp: input.isOnBusinessApp ?? null,
    };
    const waba = chooseWabaId(inspected.value, hints);
    if (!waba.ok)
      throw this.fail(
        'complete',
        orgId,
        assetCode(waba.reason),
        `waba_${waba.reason}`,
      );

    const numbers = await this.graph.listWabaPhoneNumbers({
      wabaId: waba.id,
      businessToken,
    });
    if (!numbers.ok)
      throw this.providerFail(
        orgId,
        'phone_numbers_read',
        numbers,
        'WHATSAPP_SIGNUP_ASSET_UNVERIFIED',
      );
    const phone = choosePhoneNumber(numbers.value, hints.phoneNumberId);
    if (!phone.ok)
      throw this.fail(
        'complete',
        orgId,
        assetCode(phone.reason),
        `phone_${phone.reason}`,
      );

    const signupPath = signupPathFromHints(hints);
    let saved: Awaited<
      ReturnType<WhatsappConnectionsRepository['saveSignupForOrg']>
    >;
    try {
      saved = await this.connections.saveSignupForOrg(orgId, {
        wabaId: waba.id,
        phoneNumberId: phone.phoneNumber.id,
        displayPhoneNumber: phone.phoneNumber.displayPhoneNumber,
        signupPath,
        businessTokenEncrypted: encryptConnectionSecret(
          businessToken,
          this.config.getOrThrow<string>('SHOPIFY_TOKEN_ENCRYPTION_KEY'),
        ),
      });
    } catch (error) {
      if (error instanceof WhatsappAccountInUseError)
        throw this.fail(
          'complete',
          orgId,
          'WHATSAPP_ACCOUNT_ALREADY_CONNECTED',
        );
      if (error instanceof WhatsappPhoneNumberInUseError)
        throw this.fail('complete', orgId, 'WHATSAPP_NUMBER_ALREADY_CONNECTED');
      throw error;
    }
    if (!saved.saved)
      throw this.fail(
        'complete',
        orgId,
        'WHATSAPP_CONNECTION_EXISTS',
        'changed_during_signup',
      );

    // The saved row is already due for setup, so a queue that is down only
    // delays it until the sweep finds the row.
    const queued = await this.setupQueue.enqueueSetup(
      saved.connection.id,
      saved.connection.signupGeneration,
    );
    this.logger.log(
      buildBackendLog(WhatsappConnectService.name, {
        action: 'whatsapp_signup_complete',
        outcome: 'success',
        orgId,
        connectionId: saved.connection.id,
        wabaId: waba.id,
        phoneNumberId: phone.phoneNumber.id,
        signupPath,
        setupQueued: queued,
      }),
    );
    return {
      state: 'connecting',
      displayPhoneNumber: phone.phoneNumber.displayPhoneNumber,
      signupPath,
    };
  }

  /** The switch and signup settings, or the unavailable code. */
  private requireConnect(): ConnectContext {
    const config = readWhatsappOwnNumberConfig(this.config);
    if (
      !isOwnNumberConnectAllowed(config) ||
      !config.metaAppId ||
      !config.embeddedSignupConfigId ||
      !config.connectPageBaseUrl
    )
      throw whatsappConnectError('WHATSAPP_CONNECT_UNAVAILABLE');
    return {
      config: {
        ...config,
        metaAppId: config.metaAppId,
        embeddedSignupConfigId: config.embeddedSignupConfigId,
        connectPageBaseUrl: config.connectPageBaseUrl,
      },
    };
  }

  /** What may have changed since the ticket was issued. */
  private async recheck(
    orgId: string,
    userId: string,
    step: 'claim' | 'complete',
  ): Promise<ConnectContext> {
    let context: ConnectContext;
    try {
      context = this.requireConnect();
    } catch (error) {
      this.logFailure(step, orgId, 'WHATSAPP_CONNECT_UNAVAILABLE');
      throw error;
    }
    const membership = await this.memberships.findByOrgAndUser(orgId, userId);
    if (membership?.role !== 'owner')
      throw this.fail(step, orgId, 'WHATSAPP_CONNECTION_OWNER_REQUIRED');
    try {
      await this.assertNoBlockingConnection(orgId);
    } catch (error) {
      this.logFailure(step, orgId, 'WHATSAPP_CONNECTION_EXISTS');
      throw error;
    }
    return context;
  }

  private async assertNoBlockingConnection(orgId: string): Promise<void> {
    const existing = await this.connections.findByOrg(orgId);
    if (existing && !REPLACEABLE.has(existing.state))
      throw whatsappConnectError('WHATSAPP_CONNECTION_EXISTS');
  }

  private providerFail(
    orgId: string,
    call: string,
    failure: OwnNumberGraphFailure,
    rejectedCode: WhatsappConnectErrorCode,
  ) {
    return this.fail(
      'complete',
      orgId,
      failure.kind === 'rejected'
        ? rejectedCode
        : 'WHATSAPP_SIGNUP_PROVIDER_UNAVAILABLE',
      `${call}_${failure.kind}`,
    );
  }

  private fail(
    step: 'claim' | 'complete',
    orgId: string | null,
    code: WhatsappConnectErrorCode,
    reason?: string,
  ) {
    this.logFailure(step, orgId, code, reason);
    return whatsappConnectError(code);
  }

  private logFailure(
    step: 'claim' | 'complete',
    orgId: string | null,
    code: WhatsappConnectErrorCode,
    reason?: string,
  ): void {
    this.logger.warn(
      buildBackendLog(WhatsappConnectService.name, {
        action:
          step === 'claim'
            ? 'whatsapp_connect_ticket_claim'
            : 'whatsapp_signup_complete',
        outcome: 'failure',
        orgId: orgId ?? undefined,
        errorCode: code,
        reason: reason ?? null,
      }),
    );
  }
}

function assetCode(
  reason: 'unverified' | 'ambiguous',
): WhatsappConnectErrorCode {
  return reason === 'ambiguous'
    ? 'WHATSAPP_SIGNUP_ASSET_AMBIGUOUS'
    : 'WHATSAPP_SIGNUP_ASSET_UNVERIFIED';
}

function toIso(value: string | Date): string {
  return new Date(value).toISOString();
}
