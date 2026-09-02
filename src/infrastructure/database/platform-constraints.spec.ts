import { PgDialect, getTableConfig } from 'drizzle-orm/pg-core';
import { billingFreePlanClaims, integrations } from './schema';
import { SUPPORTED_PLATFORM_TYPES } from '../../shared/interfaces/commerce-source.interface';

describe('commerce platform database constraints', () => {
  const dialect = new PgDialect();

  it.each([
    [integrations, 'integrations_platform_type_check'],
    [billingFreePlanClaims, 'billing_free_plan_claims_platform_type_check'],
  ] as const)(
    'keeps %s aligned with the canonical platform values',
    (table, name) => {
      const constraint = getTableConfig(table).checks.find(
        (entry) => entry.name === name,
      );
      expect(constraint).toBeDefined();
      const sql = dialect.sqlToQuery(constraint!.value).sql;
      for (const platform of SUPPORTED_PLATFORM_TYPES) {
        expect(sql).toContain(`'${platform}'`);
      }
    },
  );
});
