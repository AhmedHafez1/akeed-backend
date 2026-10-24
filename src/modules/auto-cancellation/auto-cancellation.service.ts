import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import {
  VerificationAutoCancellationsRepository,
  type AutoCancellationPatch,
  type AutoCancellationRow,
  type AutoCancelSnapshot,
} from '../../infrastructure/database/repositories/verification-auto-cancellations.repository';
import { CommerceOutcomeRegistryService } from '../commerce-outcomes/commerce-outcome-registry.service';
import type {
  CommerceOutcomeDispatchCommand,
  CommerceOutcomeOperationResult,
} from '../../shared/commerce/commerce-outcome';
import { isSyntheticOrder } from '../../shared/commerce/synthetic-order';
import {
  buildBackendLog,
  normalizeError,
} from '../../shared/logging/backend-log.util';
import {
  AUTO_CANCEL_CONFIRMATION_TIMEOUT_MS,
  AUTO_CANCEL_LEASE_MS,
  AUTO_CANCEL_PAUSE_RECHECK_MS,
  AUTO_CANCEL_REASON_TEXT,
  AUTO_CANCEL_STOPPABLE_STATUSES,
  autoCancelRetryDelayMs,
  evaluateAutoCancel,
  type AutoCancelDecision,
  type AutoCancelFacts,
  type AutoCancelSkipReason,
  type AutoCancelStopReason,
} from '../../shared/verification/auto-cancel.policy';
import { assertOrganizationWriteAllowed } from '../auth/organization-role';
import type { AuthenticatedUser } from '../auth/guards/dual-auth.guard';
import { AutoCancellationProducer } from './auto-cancellation.producer';
import {
  AUTO_CANCELLATION_CONFIRM_DELAY_MS,
  AUTO_CANCELLATION_CONFIRM_REPEAT_MS,
  AUTO_CANCELLATION_SWEEP_BATCH,
} from './auto-cancellation.constants';

const ACTION = 'automatic_no_reply_cancellation' as const;

/** A due time this close to now runs now rather than being rescheduled. */
const DUE_TOLERANCE_MS = 1_000;

/** The facts of one snapshot, as the pure decision reads them. */
export function factsOf(snapshot: AutoCancelSnapshot): AutoCancelFacts {
  const { verification, order, integration } = snapshot;
  const metadata =
    verification.metadata && typeof verification.metadata === 'object'
      ? (verification.metadata as Record<string, unknown>)
      : {};
  const blocked = metadata.follow_up_skipped ?? metadata.follow_up_failed;
  return {
    enabled: integration.autoCancelEnabled === true,
    isTestOrder: isSyntheticOrder(order),
    status: verification.status,
    confirmedAt: verification.confirmedAt,
    canceledAt: verification.canceledAt,
    merchantCanceledAt: verification.merchantCanceledAt,
    excludedAt: verification.autoCancelExcludedAt,
    customerLastMessageAt: verification.customerLastMessageAt,
    initialDeliveredAt: snapshot.initialDeliveredAt,
    followUpAttempted:
      (verification.followUpAttempts ?? 0) > 0 ||
      Boolean(verification.followUpSentAt),
    followUpBlockedReason: typeof blocked === 'string' ? blocked : null,
    followUpDeliveredAt: snapshot.followUpDeliveredAt,
  };
}

/** A decision not to cancel, as the reason a scheduled row stops with. */
function stopReasonOf(reason: AutoCancelSkipReason): AutoCancelStopReason {
  switch (reason) {
    case 'disabled':
      return 'feature_disabled';
    case 'customer_replied':
      return 'customer_reply';
    case 'excluded':
      return 'excluded';
    default:
      return 'status_changed';
  }
}

function isStoppable(status: string): boolean {
  return (AUTO_CANCEL_STOPPABLE_STATUSES as readonly string[]).includes(status);
}

/** What a step under the lock decided, and what to schedule after it. */
interface Step {
  next?: { kind: 'execute' | 'confirm'; rowId: string; at: Date };
  claim?: { row: AutoCancellationRow; command: CommerceOutcomeDispatchCommand };
}

/**
 * Cancels unanswered orders in their store when the store switched it on.
 *
 * The order of every attempt is fixed: claim the row under the verification
 * lock and re-check every rule; ask the store for the order's current state;
 * re-check the customer and the merchant once more under the lock and mark
 * the dispatch; send the cancel; record success only once the store shows
 * the order canceled. A customer message that arrives after the dispatch
 * mark cannot change the order any more and is flagged for the merchant.
 */
@Injectable()
export class AutoCancellationService {
  private readonly logger = new Logger(AutoCancellationService.name);

  constructor(
    private readonly repo: VerificationAutoCancellationsRepository,
    private readonly commerceOutcomes: CommerceOutcomeRegistryService,
    private readonly producer: AutoCancellationProducer,
  ) {}

  /**
   * Called once the escalation moved the order to `no_reply`. Creates the
   * row once: a repeated escalation finds it and does nothing. Never throws.
   */
  async scheduleAfterNoReply(verificationId: string): Promise<void> {
    try {
      const step = await this.repo.withLockedVerification(
        verificationId,
        async (snapshot, tx): Promise<Step> => {
          if (snapshot.row) return {};
          const decision = evaluateAutoCancel(factsOf(snapshot), new Date());
          if (
            decision.kind === 'skip' &&
            (decision.reason === 'disabled' || decision.reason === 'test_order')
          )
            return {};
          const row = await this.repo.insert(tx, {
            orgId: snapshot.verification.orgId,
            verificationId,
            orderId: snapshot.order.id,
            integrationId: snapshot.integration.id,
            ...this.rowStateOf(decision),
          });
          if (!row) return {};
          await this.repo.appendEvent(tx, {
            orgId: row.orgId,
            verificationId,
            ...this.eventOf(decision),
          });
          return decision.kind === 'schedule'
            ? { next: { kind: 'execute', rowId: row.id, at: decision.dueAt } }
            : {};
        },
      );
      this.log('auto-cancellation-schedule', 'success', { verificationId });
      await this.follow(step);
    } catch (error) {
      this.logger.error(
        buildBackendLog(AutoCancellationService.name, {
          action: 'auto-cancellation-schedule',
          outcome: 'failure',
          verificationId,
          ...normalizeError(error),
        }),
      );
    }
  }

  /** One attempt at the store for a due row. Safe to run twice. */
  async execute(rowId: string): Promise<void> {
    const row = await this.repo.findById(rowId);
    if (!row) return;
    const claimed = await this.claim(row);
    if (!claimed?.claim) {
      await this.follow(claimed);
      return;
    }
    const { command } = claimed.claim;
    let token = claimed.claim.row.attempts;

    const inspection =
      await this.commerceOutcomes.inspectForCancellation(command);
    switch (inspection.state) {
      case 'already_canceled':
        await this.finish(rowId, token, {
          status: 'applied',
          providerStatus: inspection.providerStatus,
        });
        return;
      case 'not_cancellable':
        await this.settle(rowId, token, 'skipped', inspection.reason, {
          providerStatus: inspection.providerStatus,
        });
        return;
      case 'unsupported':
        await this.settle(rowId, token, 'skipped', 'source_unsupported');
        return;
      case 'permanent_failure':
        await this.settle(rowId, token, 'failed', inspection.errorCode);
        return;
      case 'retryable_failure':
        await this.retry(
          rowId,
          token,
          inspection.errorCode,
          inspection.retryAfterMs,
        );
        return;
      case 'cancellable':
        break;
    }

    const marked = await this.markDispatch(
      rowId,
      token,
      inspection.providerStatus,
    );
    if (!marked) return;
    token = marked.attempts;

    const result = await this.commerceOutcomes.dispatch({
      ...command,
      cancellation: {
        restock: marked.restock !== false,
        notifyCustomer: marked.notifyCustomer === true,
        staffNote: `Canceled by Akeed: ${AUTO_CANCEL_REASON_TEXT}.`,
      },
    });
    switch (result.status) {
      case 'applied':
        await this.finish(rowId, token, {
          status: 'applied',
          providerStatus: result.providerStatus,
        });
        return;
      case 'pending_provider_operation':
      case 'accepted_without_reference':
        await this.awaitPlatform(
          rowId,
          token,
          result.status === 'pending_provider_operation'
            ? result.providerOperationId
            : null,
        );
        return;
      case 'retryable_failure':
        await this.retry(rowId, token, result.errorCode, result.retryAfterMs);
        return;
      case 'permanent_failure':
        await this.settle(rowId, token, 'failed', result.errorCode);
        return;
      case 'unsupported':
        await this.settle(rowId, token, 'failed', result.reason);
        return;
    }
  }

  /**
   * Whether the store finished a cancellation it accepted. Success is
   * recorded only when the order reads canceled; a store that never gets
   * there within the timeout fails the row for the merchant.
   */
  async confirm(rowId: string): Promise<void> {
    const row = await this.repo.findById(rowId);
    if (!row || row.status !== 'awaiting_platform') return;
    const snapshot = await this.repo.readSnapshotUnlocked(row.verificationId);
    if (!snapshot) return;
    const command = this.commandOf(snapshot);
    const timedOut =
      Date.now() - new Date(row.dispatchedAt ?? row.updatedAt).getTime() >
      AUTO_CANCEL_CONFIRMATION_TIMEOUT_MS;

    if (row.providerOperationId) {
      const operation = await this.commerceOutcomes.resolveOperation(
        command,
        row.providerOperationId,
      );
      if (operation.state === 'failed') {
        await this.settle(rowId, row.attempts, 'failed', operation.errorCode);
        return;
      }
      if (operation.state === 'running') {
        if (timedOut) {
          await this.settle(
            rowId,
            row.attempts,
            'failed',
            'platform_confirmation_timeout',
          );
        } else {
          await this.producer.enqueueConfirm(
            rowId,
            new Date(Date.now() + AUTO_CANCELLATION_CONFIRM_REPEAT_MS),
          );
        }
        return;
      }
    }

    const inspection =
      await this.commerceOutcomes.inspectForCancellation(command);
    if (inspection.state === 'already_canceled') {
      await this.finish(rowId, row.attempts, {
        status: 'applied',
        providerStatus: inspection.providerStatus,
      });
      return;
    }
    if (
      inspection.state === 'not_cancellable' ||
      inspection.state === 'permanent_failure' ||
      inspection.state === 'unsupported' ||
      timedOut
    ) {
      await this.settle(
        rowId,
        row.attempts,
        'failed',
        timedOut
          ? 'platform_confirmation_timeout'
          : 'platform_cancel_not_applied',
      );
      return;
    }
    await this.producer.enqueueConfirm(
      rowId,
      new Date(Date.now() + AUTO_CANCELLATION_CONFIRM_REPEAT_MS),
    );
  }

  /**
   * Picks up what a lost job would have done: due rows, paused rows whose
   * receipts may have arrived, claims a dead worker left, and cancellations
   * the store has not confirmed.
   */
  async sweep(): Promise<void> {
    const now = new Date();
    const [due, paused, abandoned, awaiting] = await Promise.all([
      this.repo.listDue(now.toISOString(), AUTO_CANCELLATION_SWEEP_BATCH),
      this.repo.listPaused(
        new Date(now.getTime() - AUTO_CANCEL_PAUSE_RECHECK_MS).toISOString(),
        AUTO_CANCELLATION_SWEEP_BATCH,
      ),
      this.repo.listExpiredLeases(
        now.toISOString(),
        AUTO_CANCELLATION_SWEEP_BATCH,
      ),
      this.repo.listAwaitingPlatform(AUTO_CANCELLATION_SWEEP_BATCH),
    ]);
    for (const row of [...due, ...abandoned])
      await this.producer.enqueueExecute(row.id, now);
    for (const row of awaiting) await this.producer.enqueueConfirm(row.id, now);
    for (const row of paused) await this.reevaluate(row.id);
    this.log('auto-cancellation-sweep', 'success', {
      due: due.length,
      paused: paused.length,
      abandoned: abandoned.length,
      awaiting: awaiting.length,
    });
  }

  /** A paused or excluded-then-included row looks at the rules again. */
  async reevaluate(rowId: string, actorUserId?: string): Promise<void> {
    const row = await this.repo.findById(rowId);
    if (!row) return;
    const step = await this.repo.withLockedVerification(
      row.verificationId,
      async (snapshot, tx): Promise<Step> => {
        const current = snapshot.row;
        if (!current) return {};
        const reopenable =
          current.status === 'paused' ||
          (current.status === 'stopped' && current.reason === 'excluded');
        if (!reopenable) return {};
        const decision = evaluateAutoCancel(factsOf(snapshot), new Date());
        if (decision.kind === 'pause' && current.status === 'paused') {
          if (current.reason !== decision.reason)
            await this.repo.update(tx, current.id, { reason: decision.reason });
          return {};
        }
        if (decision.kind === 'skip' && current.status === 'stopped') return {};
        const state = this.rowStateOf(decision);
        await this.repo.update(tx, current.id, state);
        await this.repo.appendEvent(tx, {
          orgId: current.orgId,
          verificationId: current.verificationId,
          actorUserId: actorUserId ?? null,
          ...(decision.kind === 'schedule'
            ? {
                event: 'resumed' as const,
                detail: { dueAt: decision.dueAt.toISOString() },
              }
            : this.eventOf(decision)),
        });
        return decision.kind === 'schedule'
          ? { next: { kind: 'execute', rowId: current.id, at: decision.dueAt } }
          : {};
      },
    );
    await this.follow(step);
  }

  /** The merchant keeps this order out of the automatic cancellation. */
  async exclude(user: AuthenticatedUser, verificationId: string) {
    return this.setExclusion(user, verificationId, true);
  }

  /** The merchant lets the automatic cancellation decide this order again. */
  async include(user: AuthenticatedUser, verificationId: string) {
    return this.setExclusion(user, verificationId, false);
  }

  private async setExclusion(
    user: AuthenticatedUser,
    verificationId: string,
    excluded: boolean,
  ): Promise<{ verificationId: string; excluded: boolean }> {
    assertOrganizationWriteAllowed(user.role, {
      message: 'Owner or admin role is required to change auto-cancel.',
      code: 'VERIFICATION_ROLE_REQUIRED',
    });
    const outcome = await this.repo.withLockedVerification(
      verificationId,
      async (snapshot, tx) => {
        const { verification, row } = snapshot;
        if (verification.orgId !== user.orgId) return 'not_found' as const;
        if (
          row &&
          VerificationAutoCancellationsRepository.isCommitted(row.status)
        )
          return 'in_progress' as const;
        if (
          verification.status === 'no_reply' ||
          verification.status === 'confirmed' ||
          verification.status === 'canceled'
        )
          return 'not_allowed' as const;
        const already = Boolean(verification.autoCancelExcludedAt) === excluded;
        if (already) return { rowId: row?.id ?? null, changed: false };
        await this.repo.setExclusion(
          tx,
          verificationId,
          excluded ? user.userId : null,
        );
        if (excluded && row && isStoppable(row.status)) {
          await this.repo.update(tx, row.id, {
            status: 'stopped',
            reason: 'excluded',
            dueAt: null,
          });
        }
        await this.repo.appendEvent(tx, {
          orgId: verification.orgId,
          verificationId,
          event: excluded ? 'excluded' : 'included',
          actorUserId: user.userId,
        });
        return { rowId: row?.id ?? null, changed: true };
      },
    );
    if (outcome === null || outcome === 'not_found')
      throw new NotFoundException('Verification not found');
    if (outcome === 'in_progress')
      throw new ConflictException({
        statusCode: 409,
        error: 'Conflict',
        message: 'The store is already canceling this order.',
        code: 'AUTO_CANCEL_ALREADY_IN_PROGRESS',
      });
    if (outcome === 'not_allowed')
      throw new BadRequestException({
        statusCode: 400,
        error: 'Bad Request',
        message:
          'An order marked no reply, confirmed, or canceled cannot change auto-cancel.',
        code: 'AUTO_CANCEL_EXCLUDE_NOT_ALLOWED',
      });
    if (!excluded && outcome.changed && outcome.rowId)
      await this.reevaluate(outcome.rowId, user.userId);
    this.log(
      excluded ? 'auto-cancellation-exclude' : 'auto-cancellation-include',
      'success',
      { orgId: user.orgId, verificationId, changed: outcome.changed },
    );
    return { verificationId, excluded };
  }

  /**
   * Takes the row for this attempt, or decides it does not run now: stopped
   * for a rule that no longer holds, paused, or moved to a later time.
   */
  private async claim(row: AutoCancellationRow): Promise<Step | null> {
    return this.repo.withLockedVerification(
      row.verificationId,
      async (snapshot, tx): Promise<Step> => {
        const current = snapshot.row;
        if (!current) return {};
        const now = new Date();
        const leaseExpired =
          current.status === 'in_progress' &&
          (!current.leaseUntil ||
            new Date(current.leaseUntil).getTime() <= now.getTime());
        const due =
          current.status === 'scheduled' &&
          (!current.dueAt ||
            new Date(current.dueAt).getTime() <=
              now.getTime() + DUE_TOLERANCE_MS);
        if (!due && !leaseExpired) return {};

        // A claim a dead worker left may already have reached the store; it
        // is resumed, and the store read decides what happened.
        if (!leaseExpired || !current.dispatchedAt) {
          const decision = evaluateAutoCancel(factsOf(snapshot), now);
          if (decision.kind !== 'schedule') {
            const patch: AutoCancellationPatch =
              decision.kind === 'pause'
                ? { status: 'paused', reason: decision.reason, dueAt: null }
                : {
                    status: 'stopped',
                    reason: stopReasonOf(decision.reason),
                    dueAt: null,
                  };
            await this.repo.update(tx, current.id, {
              ...patch,
              leaseUntil: null,
            });
            await this.repo.appendEvent(tx, {
              orgId: current.orgId,
              verificationId: current.verificationId,
              event: decision.kind === 'pause' ? 'paused' : 'stopped',
              detail: { reason: patch.reason },
            });
            return {};
          }
          if (decision.dueAt.getTime() > now.getTime() + DUE_TOLERANCE_MS) {
            await this.repo.update(tx, current.id, {
              status: 'scheduled',
              dueAt: decision.dueAt.toISOString(),
              leaseUntil: null,
            });
            return {
              next: { kind: 'execute', rowId: current.id, at: decision.dueAt },
            };
          }
        }

        const claimed = await this.repo.update(tx, current.id, {
          status: 'in_progress',
          attempts: current.attempts + 1,
          leaseUntil: new Date(
            now.getTime() + AUTO_CANCEL_LEASE_MS,
          ).toISOString(),
          restock: current.restock ?? snapshot.integration.autoCancelRestock,
          notifyCustomer:
            current.notifyCustomer ??
            snapshot.integration.autoCancelNotifyCustomer,
        });
        if (!claimed) return {};
        return { claim: { row: claimed, command: this.commandOf(snapshot) } };
      },
    );
  }

  /**
   * The last check before the store is asked. Anything the customer or the
   * merchant did since the claim stops the attempt; after this mark, nothing
   * they do changes the order.
   */
  private async markDispatch(
    rowId: string,
    token: number,
    providerStatus?: string,
  ): Promise<AutoCancellationRow | null> {
    const row = await this.repo.findById(rowId);
    if (!row) return null;
    return this.repo.withLockedVerification(
      row.verificationId,
      async (snapshot, tx) => {
        const current = snapshot.row;
        if (
          !current ||
          current.status !== 'in_progress' ||
          current.attempts !== token
        )
          return null;
        if (current.dispatchedAt) return current;
        const decision = evaluateAutoCancel(factsOf(snapshot), new Date());
        if (decision.kind === 'skip') {
          const reason = stopReasonOf(decision.reason);
          await this.repo.update(tx, current.id, {
            status: 'stopped',
            reason,
            leaseUntil: null,
          });
          await this.repo.appendEvent(tx, {
            orgId: current.orgId,
            verificationId: current.verificationId,
            event: 'stopped',
            detail: { reason, stage: 'before_dispatch' },
          });
          return null;
        }
        const marked = await this.repo.update(tx, current.id, {
          dispatchedAt: new Date().toISOString(),
        });
        await this.repo.appendEvent(tx, {
          orgId: current.orgId,
          verificationId: current.verificationId,
          event: 'dispatch_started',
          detail: {
            attempt: current.attempts,
            restock: current.restock,
            notifyCustomer: current.notifyCustomer,
            providerStatus,
          },
        });
        return marked;
      },
    );
  }

  /** The store shows the order canceled: record it, then tag best effort. */
  private async finish(
    rowId: string,
    token: number,
    operation: CommerceOutcomeOperationResult,
  ): Promise<void> {
    const row = await this.repo.findById(rowId);
    if (!row) return;
    const done = await this.repo.withLockedVerification(
      row.verificationId,
      async (snapshot, tx) => {
        const current = snapshot.row;
        if (
          !current ||
          !['in_progress', 'awaiting_platform'].includes(current.status) ||
          current.attempts !== token
        )
          return null;
        const verificationCanceled = await this.repo.markVerificationCanceled(
          tx,
          current.verificationId,
          operation,
        );
        await this.repo.update(tx, current.id, {
          status: 'succeeded',
          reason: verificationCanceled ? null : 'status_changed',
          leaseUntil: null,
          completedAt: new Date().toISOString(),
        });
        await this.repo.appendEvent(tx, {
          orgId: current.orgId,
          verificationId: current.verificationId,
          event: 'succeeded',
          detail: {
            reason: AUTO_CANCEL_REASON_TEXT,
            verificationCanceled,
            providerStatus:
              operation.status === 'applied'
                ? operation.providerStatus
                : undefined,
          },
        });
        return this.commandOf(snapshot);
      },
    );
    if (!done) return;
    this.log('auto-cancellation-cancel', 'success', {
      orgId: done.orgId,
      verificationId: done.correlationId,
    });
    try {
      await this.commerceOutcomes.dispatch({
        ...done,
        action: 'merchant_cancellation_tagging',
      });
    } catch (error) {
      this.logger.warn(
        buildBackendLog(AutoCancellationService.name, {
          action: 'auto-cancellation-tag-order',
          outcome: 'retry',
          orgId: done.orgId,
          verificationId: done.correlationId,
          ...normalizeError(error),
        }),
      );
    }
  }

  /** The store accepted the cancel but has not shown it done yet. */
  private async awaitPlatform(
    rowId: string,
    token: number,
    providerOperationId: string | null,
  ): Promise<void> {
    const updated = await this.transition(
      rowId,
      token,
      {
        status: 'awaiting_platform',
        providerOperationId,
        leaseUntil: null,
      },
      'platform_pending',
      { providerOperationId },
    );
    if (updated)
      await this.producer.enqueueConfirm(
        rowId,
        new Date(Date.now() + AUTO_CANCELLATION_CONFIRM_DELAY_MS),
      );
  }

  /** A failure the store may get over: try again later, or give up. */
  private async retry(
    rowId: string,
    token: number,
    errorCode: string,
    retryAfterMs?: number,
  ): Promise<void> {
    const delay = autoCancelRetryDelayMs(token);
    if (delay === null) {
      await this.settle(rowId, token, 'failed', errorCode);
      return;
    }
    const at = new Date(Date.now() + Math.max(delay, retryAfterMs ?? 0));
    const updated = await this.transition(
      rowId,
      token,
      {
        status: 'scheduled',
        reason: errorCode,
        dueAt: at.toISOString(),
        leaseUntil: null,
        dispatchedAt: null,
      },
      'retry_scheduled',
      { errorCode, attempt: token, dueAt: at.toISOString() },
    );
    if (updated) await this.producer.enqueueExecute(rowId, at);
  }

  private async settle(
    rowId: string,
    token: number,
    status: 'failed' | 'skipped',
    reason: string,
    detail: Record<string, unknown> = {},
  ): Promise<void> {
    const updated = await this.transition(
      rowId,
      token,
      {
        status,
        reason: reason.slice(0, 64),
        leaseUntil: null,
        completedAt: new Date().toISOString(),
      },
      status,
      { reason, ...detail },
    );
    if (updated)
      this.log(
        'auto-cancellation-cancel',
        status === 'failed' ? 'failure' : 'skipped',
        { autoCancellationId: rowId, reason },
      );
  }

  /** Moves a row this attempt owns; false when another step moved it first. */
  private async transition(
    rowId: string,
    token: number,
    patch: AutoCancellationPatch,
    event: 'platform_pending' | 'retry_scheduled' | 'failed' | 'skipped',
    detail: Record<string, unknown>,
  ): Promise<boolean> {
    const row = await this.repo.findById(rowId);
    if (!row) return false;
    const moved = await this.repo.withLockedVerification(
      row.verificationId,
      async (snapshot, tx) => {
        const current = snapshot.row;
        if (
          !current ||
          !['in_progress', 'awaiting_platform'].includes(current.status) ||
          current.attempts !== token
        )
          return false;
        await this.repo.update(tx, current.id, patch);
        await this.repo.appendEvent(tx, {
          orgId: current.orgId,
          verificationId: current.verificationId,
          event,
          detail,
        });
        return true;
      },
    );
    return moved === true;
  }

  private commandOf(
    snapshot: AutoCancelSnapshot,
  ): CommerceOutcomeDispatchCommand {
    return {
      orgId: snapshot.verification.orgId,
      integrationId: snapshot.order.integrationId,
      externalOrderId: snapshot.order.externalOrderId,
      correlationId: snapshot.verification.id,
      action: ACTION,
    };
  }

  private rowStateOf(decision: AutoCancelDecision): AutoCancellationPatch & {
    status: AutoCancellationRow['status'];
  } {
    switch (decision.kind) {
      case 'schedule':
        return {
          status: 'scheduled',
          reason: null,
          dueAt: decision.dueAt.toISOString(),
        };
      case 'pause':
        return { status: 'paused', reason: decision.reason, dueAt: null };
      case 'skip':
        return { status: 'skipped', reason: decision.reason, dueAt: null };
    }
  }

  private eventOf(decision: AutoCancelDecision): {
    event: 'scheduled' | 'paused' | 'skipped';
    detail: Record<string, unknown>;
  } {
    switch (decision.kind) {
      case 'schedule':
        return {
          event: 'scheduled',
          detail: { dueAt: decision.dueAt.toISOString() },
        };
      case 'pause':
        return { event: 'paused', detail: { reason: decision.reason } };
      case 'skip':
        return { event: 'skipped', detail: { reason: decision.reason } };
    }
  }

  private async follow(step: Step | null | undefined): Promise<void> {
    if (!step?.next) return;
    const { kind, rowId, at } = step.next;
    if (kind === 'execute') await this.producer.enqueueExecute(rowId, at);
    else await this.producer.enqueueConfirm(rowId, at);
  }

  private log(
    action: string,
    outcome: 'success' | 'failure' | 'skipped' | 'retry',
    fields: Record<string, unknown>,
  ): void {
    this.logger.log(
      buildBackendLog(AutoCancellationService.name, {
        action,
        outcome,
        ...fields,
      }),
    );
  }
}
