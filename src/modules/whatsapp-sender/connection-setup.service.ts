import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { CONNECTION_SETUP_SWEEP_LIMIT } from './whatsapp-connection-setup-queue.constants';
import {
  WhatsappConnectionsRepository,
  type SetupClaim,
  type SetupProgressPatch,
  type WhatsappConnectionRecord,
} from '../../infrastructure/database/repositories/whatsapp-connections.repository';
import {
  OwnNumberGraphClient,
  type OwnNumberGraphFailure,
} from '../../infrastructure/spokes/meta/own-number/own-number-graph.client';
import {
  decideNumberPath,
  generateRegistrationPin,
} from '../../infrastructure/spokes/meta/own-number/own-number-setup.policy';
import {
  encryptConnectionSecret,
  readBusinessToken,
  readRegistrationPin,
} from '../../infrastructure/spokes/meta/own-number/whatsapp-connection-credentials';
import { buildBackendLog } from '../../shared/logging/backend-log.util';
import { ConnectionTemplatesService } from './connection-templates.service';
import { WhatsappConnectionSetupProducer } from './whatsapp-connection-setup.producer';

/** One attempt holds the connection this long at most. */
export const SETUP_LEASE_MS = 5 * 60_000;
/** Attempts before setup stops and waits for staff. */
export const SETUP_MAX_ATTEMPTS = 6;
/**
 * Meta allows 10 registration requests per number in 72 hours, and a
 * blocked number waits the full 72. Registration gets two tries.
 */
export const REGISTER_MAX_ATTEMPTS = 2;
const SETUP_RETRY_DELAYS_MS = [
  60_000,
  5 * 60_000,
  30 * 60_000,
  2 * 60 * 60_000,
  6 * 60 * 60_000,
];
/** Meta's code for too many registration requests. */
const REGISTER_RATE_LIMIT_CODE = 133016;
const REGISTER_BLOCK_MS = 72 * 60 * 60_000;

/** Why an attempt stopped. Stable, and shown to staff as a code. */
export type SetupErrorCode =
  | 'credentials_unreadable'
  | 'subscription_unavailable'
  | 'subscription_rejected'
  | 'number_unavailable'
  | 'number_rejected'
  | 'number_not_in_account'
  | 'path_mismatch'
  | 'path_unverified'
  | 'pin_unreadable'
  | 'register_unresolved'
  | 'register_rejected'
  | 'register_rate_limited'
  | 'templates_unavailable'
  | 'templates_credentials';

type StepOutcome =
  | { kind: 'next'; patch: SetupProgressPatch }
  | {
      kind: 'fail';
      code: SetupErrorCode;
      retryable: boolean;
      delayMs?: number;
      /** What Meta reported, recorded before the attempt ends. */
      patch?: SetupProgressPatch;
    }
  | { kind: 'continue_later'; at: Date }
  | { kind: 'complete' };

export function setupRetryDelayMs(attempts: number): number {
  const index = Math.min(
    Math.max(attempts, 1) - 1,
    SETUP_RETRY_DELAYS_MS.length - 1,
  );
  return SETUP_RETRY_DELAYS_MS[index];
}

/**
 * Prepares a merchant's account and number after signup, as a resumable job.
 *
 * Steps, each safe to run again: subscribe Akeed's app to the account, read
 * the number from Meta and decide its path, register a new number with a PIN
 * stored before it is used, and submit the registry's templates. The row is
 * the record: a worker claims it with a lease, every write checks the claim,
 * and Meta is called outside any transaction. A newer signup, a disconnect or
 * a lost lease ends the attempt without a write.
 *
 * Done means `verifying`, not ready: the number sends only after the health
 * check moves it on. Contacts and history sync are never called.
 */
@Injectable()
export class ConnectionSetupService {
  private readonly logger = new Logger(ConnectionSetupService.name);

  constructor(
    private readonly config: ConfigService,
    private readonly connections: WhatsappConnectionsRepository,
    private readonly graph: OwnNumberGraphClient,
    private readonly templates: ConnectionTemplatesService,
    private readonly producer: WhatsappConnectionSetupProducer,
  ) {}

  /** Queues every setup that is due. The row decides; a job only nudges. */
  async sweep(): Promise<number> {
    const due = await this.connections.findDueSetups(
      CONNECTION_SETUP_SWEEP_LIMIT,
    );
    for (const setup of due)
      await this.producer.enqueueSetup(setup.id, setup.signupGeneration);
    if (due.length > 0)
      this.logger.log(
        buildBackendLog(ConnectionSetupService.name, {
          action: 'whatsapp_connection_setup_sweep',
          outcome: 'success',
          queued: due.length,
        }),
      );
    return due.length;
  }

  /** One attempt. Returns false when there was nothing to claim. */
  async run(connectionId: string, signupGeneration: number): Promise<boolean> {
    let row = await this.connections.claimSetup(
      connectionId,
      signupGeneration,
      SETUP_LEASE_MS,
    );
    if (!row) {
      this.log('skipped', { id: connectionId }, { reason: 'not_claimed' });
      return false;
    }
    const claim: SetupClaim = {
      id: row.id,
      signupGeneration: row.signupGeneration,
      setupAttempts: row.setupAttempts,
    };
    const key = this.config.getOrThrow<string>('SHOPIFY_TOKEN_ENCRYPTION_KEY');
    const token = readBusinessToken(row, key);
    if (!token) {
      await this.finish(claim, row, {
        kind: 'fail',
        code: 'credentials_unreadable',
        retryable: false,
      });
      return true;
    }

    for (;;) {
      const outcome = await this.step(row, token, key, claim);
      if (outcome.kind !== 'next') {
        await this.finish(claim, row, outcome);
        return true;
      }
      const updated = await this.connections.recordSetupProgress(
        claim,
        outcome.patch,
      );
      if (!updated) {
        this.log('skipped', row, { reason: 'claim_lost', step: row.setupStep });
        return true;
      }
      this.log('success', updated, { step: row.setupStep });
      row = updated;
    }
  }

  private async step(
    row: WhatsappConnectionRecord,
    token: string,
    key: string,
    claim: SetupClaim,
  ): Promise<StepOutcome> {
    switch (row.setupStep) {
      case 'subscribe':
        return this.subscribe(row, token);
      case 'verify_number':
        return this.verifyNumber(row, token);
      case 'register':
        return this.register(row, token, key, claim);
      case 'provision':
        return this.provision(row, token);
      case 'done':
        return { kind: 'complete' };
    }
  }

  /** Reads first, because Meta does not say whether subscribing twice is safe. */
  private async subscribe(
    row: WhatsappConnectionRecord,
    token: string,
  ): Promise<StepOutcome> {
    const appId = this.config.get<string>('META_APP_ID')?.trim();
    // Without the app id the read cannot tell whether Akeed is subscribed.
    if (!appId)
      return {
        kind: 'fail',
        code: 'subscription_unavailable',
        retryable: true,
      };
    const current = await this.graph.isAppSubscribed({
      wabaId: row.wabaId,
      appId,
      businessToken: token,
    });
    if (!current.ok) return providerFail(current, 'subscription');
    if (!current.value) {
      const subscribed = await this.graph.subscribeApp({
        wabaId: row.wabaId,
        businessToken: token,
      });
      if (!subscribed.ok) return providerFail(subscribed, 'subscription');
    }
    return {
      kind: 'next',
      patch: { setupStep: 'verify_number', subscribedAt: 'now' },
    };
  }

  /**
   * The number must still belong to the stored account, and Meta's own read
   * decides its path. The browser's hint alone never leads to `/register`.
   */
  private async verifyNumber(
    row: WhatsappConnectionRecord,
    token: string,
  ): Promise<StepOutcome> {
    const numbers = await this.graph.listWabaPhoneNumbers({
      wabaId: row.wabaId,
      businessToken: token,
    });
    if (!numbers.ok) return providerFail(numbers, 'number');
    if (!numbers.value.some((n) => n.id === row.phoneNumberId))
      return { kind: 'fail', code: 'number_not_in_account', retryable: false };
    const status = await this.graph.readPhoneNumber({
      phoneNumberId: row.phoneNumberId,
      businessToken: token,
    });
    if (!status.ok) return providerFail(status, 'number');
    const provider = {
      providerIsOnBizApp: status.value.isOnBizApp,
      providerPlatformType: status.value.platformType,
    };
    const decision = decideNumberPath(row.signupPath, status.value);
    switch (decision.kind) {
      case 'refuse':
        // Record what Meta said, then stop for staff.
        return {
          kind: 'fail',
          code: decision.code,
          retryable: false,
          patch: provider,
        };
      case 'register':
        return {
          kind: 'next',
          patch: {
            setupStep: 'register',
            numberVerifiedAt: 'now',
            ...provider,
          },
        };
      case 'already_registered':
      case 'coexistence':
        return {
          kind: 'next',
          patch: {
            setupStep: 'provision',
            numberVerifiedAt: 'now',
            ...provider,
          },
        };
    }
  }

  /**
   * New-number path only. The PIN is stored, encrypted, before the request,
   * and every retry uses that same PIN. The number is read first: one Meta
   * already shows on Cloud API was registered by an earlier attempt whose
   * answer was lost, and is not registered again.
   */
  private async register(
    row: WhatsappConnectionRecord,
    token: string,
    key: string,
    claim: SetupClaim,
  ): Promise<StepOutcome> {
    if (row.signupPath !== 'new_number' || row.providerIsOnBizApp !== false)
      return { kind: 'fail', code: 'path_unverified', retryable: false };
    const status = await this.graph.readPhoneNumber({
      phoneNumberId: row.phoneNumberId,
      businessToken: token,
    });
    if (!status.ok) return providerFail(status, 'number');
    if (status.value.isOnBizApp !== false)
      return { kind: 'fail', code: 'path_mismatch', retryable: false };
    if (
      decideNumberPath('new_number', status.value).kind === 'already_registered'
    )
      return {
        kind: 'next',
        patch: {
          setupStep: 'provision',
          registeredAt: 'now',
          providerPlatformType: status.value.platformType,
        },
      };

    let pin = readRegistrationPin(row, key);
    if (!pin) {
      const stored = await this.connections.storeRegistrationPinOnce(
        claim,
        encryptConnectionSecret(generateRegistrationPin(), key),
      );
      if (!stored)
        return { kind: 'fail', code: 'pin_unreadable', retryable: true };
      pin = readRegistrationPin(stored, key);
    }
    if (!pin) return { kind: 'fail', code: 'pin_unreadable', retryable: false };

    const registered = await this.graph.registerPhoneNumber({
      phoneNumberId: row.phoneNumberId,
      businessToken: token,
      pin,
    });
    if (registered.ok)
      return {
        kind: 'next',
        patch: { setupStep: 'provision', registeredAt: 'now' },
      };
    if (registered.kind !== 'rejected')
      return { kind: 'fail', code: 'register_unresolved', retryable: true };
    if (registered.graphErrorCode === REGISTER_RATE_LIMIT_CODE)
      return {
        kind: 'fail',
        code: 'register_rate_limited',
        retryable: true,
        delayMs: REGISTER_BLOCK_MS,
      };
    return { kind: 'fail', code: 'register_rejected', retryable: false };
  }

  private async provision(
    row: WhatsappConnectionRecord,
    token: string,
  ): Promise<StepOutcome> {
    const result = await this.templates.run(row, token);
    switch (result.outcome) {
      case 'settled':
        return { kind: 'complete' };
      case 'more':
        return {
          kind: 'continue_later',
          at: result.nextRunAt ?? new Date(Date.now() + 60_000),
        };
      case 'credentials':
        return { kind: 'fail', code: 'templates_credentials', retryable: true };
      case 'provider_unavailable':
      case 'skipped':
        return { kind: 'fail', code: 'templates_unavailable', retryable: true };
    }
  }

  private async finish(
    claim: SetupClaim,
    row: WhatsappConnectionRecord,
    outcome: Exclude<StepOutcome, { kind: 'next' }>,
  ): Promise<void> {
    if (outcome.kind === 'complete') {
      const done = await this.connections.completeSetup(claim);
      this.log(done ? 'success' : 'skipped', row, {
        step: 'done',
        ...(done ? {} : { reason: 'claim_lost' }),
      });
      return;
    }
    if (outcome.kind === 'continue_later') {
      const released = await this.connections.releaseSetup(claim, {
        status: 'pending',
        errorCode: null,
        nextAttemptAt: outcome.at,
      });
      if (released)
        await this.producer.enqueueSetup(
          claim.id,
          claim.signupGeneration,
          Math.max(outcome.at.getTime() - Date.now(), 0),
        );
      return;
    }
    if (outcome.patch)
      await this.connections.recordSetupProgress(claim, outcome.patch);
    const attempts = claim.setupAttempts;
    const cap =
      row.setupStep === 'register' ? REGISTER_MAX_ATTEMPTS : SETUP_MAX_ATTEMPTS;
    const exhausted = !outcome.retryable || attempts >= cap;
    const delayMs = outcome.delayMs ?? setupRetryDelayMs(attempts);
    const released = await this.connections.releaseSetup(claim, {
      status: exhausted ? 'exhausted' : 'failed',
      errorCode: outcome.code,
      nextAttemptAt: exhausted ? null : new Date(Date.now() + delayMs),
    });
    this.log('failure', row, {
      step: row.setupStep,
      errorCode: outcome.code,
      attempts,
      exhausted,
      ...(released ? {} : { reason: 'claim_lost' }),
    });
  }

  private log(
    outcome: 'success' | 'failure' | 'skipped',
    row: Partial<Pick<WhatsappConnectionRecord, 'id' | 'orgId'>>,
    fields: Record<string, unknown>,
  ): void {
    const context = {
      action: 'whatsapp_connection_setup',
      outcome,
      ...(row.orgId ? { orgId: row.orgId } : {}),
      ...(row.id ? { connectionId: row.id } : {}),
      ...fields,
    };
    if (outcome === 'failure')
      this.logger.warn(buildBackendLog(ConnectionSetupService.name, context));
    else this.logger.log(buildBackendLog(ConnectionSetupService.name, context));
  }
}

/** A refusal is not retried; no answer is. */
function providerFail(
  failure: OwnNumberGraphFailure,
  area: 'subscription' | 'number',
): StepOutcome {
  return failure.kind === 'rejected'
    ? { kind: 'fail', code: `${area}_rejected`, retryable: false }
    : { kind: 'fail', code: `${area}_unavailable`, retryable: true };
}
