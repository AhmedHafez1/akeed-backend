import type { DrizzleDB } from './database.provider';

export type CreditTransaction = Parameters<
  Parameters<DrizzleDB['transaction']>[0]
>[0];

/**
 * The narrowest handle a credit write needs. Widening it structurally lets the
 * Standalone provisioning transaction — typed against its own schema generic —
 * seed a credit account without either module casting the other's handle away.
 */
export type CreditWriter = Pick<CreditTransaction, 'insert'>;
