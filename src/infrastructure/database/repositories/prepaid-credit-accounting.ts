import { ConflictException, Injectable } from '@nestjs/common';
import { and, eq } from 'drizzle-orm';
import type { CreditTransaction } from '../credit-transaction';
import { creditLedgerEntries, verificationMessageDispatches } from '../schema';
import { CreditAccountingRepository } from './credit-accounting.repository';
import { creditDenial } from '../../../shared/billing/credit-eligibility';

type Dispatch = typeof verificationMessageDispatches.$inferSelect;

export function reconciliationRequired(): never {
  throw new ConflictException({
    code: 'PAYMENT_PENDING_RECONCILIATION',
    reason: 'PAYMENT_PENDING_RECONCILIATION',
    message: 'Credit accounting requires reconciliation.',
  });
}

@Injectable()
export class PrepaidCreditAccounting {
  constructor(readonly repository: CreditAccountingRepository) {}

  async lock(tx: CreditTransaction, orgId: string) {
    try {
      return await this.repository.lockAccount(tx, orgId);
    } catch {
      return reconciliationRequired();
    }
  }

  async reservation(tx: CreditTransaction, dispatch: Dispatch) {
    const reservation = await this.repository.lockReservation(
      tx,
      dispatch.orgId,
      dispatch.dispatchKey,
    );
    if (
      reservation &&
      (reservation.dispatchId !== dispatch.id ||
        reservation.verificationId !== dispatch.verificationId ||
        reservation.kind !== dispatch.kind ||
        reservation.generation !== dispatch.generation ||
        reservation.quantity !== 1)
    )
      reconciliationRequired();
    return reservation;
  }

  async hold(tx: CreditTransaction, dispatch: Dispatch) {
    const account = await this.lock(tx, dispatch.orgId);
    const existing = await this.reservation(tx, dispatch);
    if (existing) {
      if (existing.status !== 'held') reconciliationRequired();
      return;
    }
    const denial = creditDenial(this.repository.summary(account));
    if (denial)
      throw new ConflictException({
        code: denial,
        reason: denial,
        message: 'Credit is not available for this send.',
      });
    await this.repository.insertReservation(tx, {
      orgId: dispatch.orgId,
      dispatchId: dispatch.id,
      verificationId: dispatch.verificationId,
      kind: dispatch.kind,
      generation: dispatch.generation,
      quantity: 1,
      billableKey: dispatch.dispatchKey,
    });
    await this.repository.updateProjection(tx, {
      orgId: dispatch.orgId,
      expectedVersion: account.version,
      postedBalance: account.postedBalance,
      heldCredits: account.heldCredits + 1,
    });
  }

  async transition(
    tx: CreditTransaction,
    dispatch: Dispatch,
    action: 'consume' | 'release' | 'reverse',
    actorId?: string,
  ) {
    const account = await this.lock(tx, dispatch.orgId);
    const reservation = await this.reservation(tx, dispatch);
    if (!reservation) reconciliationRequired();
    const entries = await tx
      .select()
      .from(creditLedgerEntries)
      .where(
        and(
          eq(creditLedgerEntries.orgId, dispatch.orgId),
          eq(creditLedgerEntries.reservationId, reservation.id),
        ),
      );
    const consumption = entries.find((entry) => entry.type === 'consumption');
    const reversal = entries.find((entry) => entry.type === 'failure_reversal');
    if (
      (consumption &&
        (consumption.quantity !== -1 ||
          consumption.dispatchId !== dispatch.id)) ||
      (reversal &&
        (reversal.quantity !== 1 ||
          reversal.sourceLedgerEntryId !== consumption?.id))
    )
      reconciliationRequired();
    if (reservation.status === 'held' && entries.length)
      reconciliationRequired();
    if (reservation.status === 'consumed' && (!consumption || reversal))
      reconciliationRequired();
    if (
      reservation.status === 'released' &&
      Boolean(consumption) !== Boolean(reversal)
    )
      reconciliationRequired();
    if (action === 'consume' && consumption) return;
    if (action === 'reverse' && reversal) return;
    if (action === 'release' && reservation.status === 'released') return;
    if (action === 'release' && reservation.status !== 'held')
      reconciliationRequired();
    if (action === 'consume' && reservation.status !== 'held')
      reconciliationRequired();
    if (action === 'reverse' && reservation.status !== 'consumed')
      reconciliationRequired();
    const quantity = action === 'consume' ? -1 : action === 'reverse' ? 1 : 0;
    if (quantity) {
      const type = action === 'consume' ? 'consumption' : 'failure_reversal';
      await this.repository.insertLedgerEntry(tx, {
        orgId: dispatch.orgId,
        type,
        quantity,
        idempotencyKey: `${type}:${dispatch.dispatchKey}`,
        reservationId: reservation.id,
        dispatchId: dispatch.id,
        actorId,
        sourceLedgerEntryId: action === 'reverse' ? consumption!.id : undefined,
        reason:
          action === 'consume'
            ? 'provider_accepted'
            : 'provider_delivery_failed',
        postedBalanceBefore: account.postedBalance,
        postedBalanceAfter: account.postedBalance + quantity,
      });
    }
    await this.repository.resolveReservation(
      tx,
      dispatch.orgId,
      reservation.id,
      reservation.status as 'held' | 'consumed',
      {
        status: action === 'consume' ? 'consumed' : 'released',
        resolutionCode:
          action === 'consume'
            ? 'provider_accepted'
            : action === 'reverse'
              ? 'provider_delivery_failed'
              : 'provider_not_accepted',
        resolvedBy: actorId,
      },
    );
    await this.repository.updateProjection(tx, {
      orgId: dispatch.orgId,
      expectedVersion: account.version,
      postedBalance: account.postedBalance + quantity,
      heldCredits:
        account.heldCredits - (reservation.status === 'held' ? 1 : 0),
    });
  }

  async assertReleased(tx: CreditTransaction, dispatch: Dispatch) {
    const reservation = await this.reservation(tx, dispatch);
    if (!reservation || reservation.status !== 'released')
      reconciliationRequired();
    const [consumption] = await tx
      .select()
      .from(creditLedgerEntries)
      .where(
        and(
          eq(creditLedgerEntries.reservationId, reservation.id),
          eq(creditLedgerEntries.type, 'consumption'),
        ),
      );
    const [reversal] = await tx
      .select()
      .from(creditLedgerEntries)
      .where(
        and(
          eq(creditLedgerEntries.reservationId, reservation.id),
          eq(creditLedgerEntries.type, 'failure_reversal'),
        ),
      );
    if (Boolean(consumption) !== Boolean(reversal)) reconciliationRequired();
  }
}
