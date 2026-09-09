import type { DrizzleDB } from './database.provider';

export type CreditTransaction = Parameters<
  Parameters<DrizzleDB['transaction']>[0]
>[0];
