import { sql, type SQL } from 'drizzle-orm';
import { EXPECTED_CATEGORY_BY_PURPOSE } from '../../shared/messaging/template-provider.types';
import {
  COD_CONFIRMATION_PURPOSE,
  TEMPLATE_LANGUAGES,
  type TemplateLanguage,
} from '../../shared/messaging/template-registry.types';

/**
 * Whether the templates a store sends are healthy at the provider (US-08-04
 * criterion 6), as two boolean SQL expressions over the `integrations` row
 * aliased `store`.
 *
 * For each language the store can send in (both under `auto`, one when the
 * language is forced), its template is the one it selected (stored key, else
 * its old variant column) when that row is active, else the language default.
 *
 * - `unavailable`: for some language neither the selection nor the default
 *   may be sent, so its sends are skipped.
 * - `degraded`: not unavailable, but a template in use is unhealthy: the
 *   selection is not approved and the default stands in, or the template in
 *   use was moved to another category.
 *
 * A row the provider has not been read for (no sync yet) counts as healthy,
 * which is how sending treats it too.
 */
export function templateHealthSql(store: SQL = sql`i`): {
  unavailable: SQL;
  degraded: SQL;
} {
  const purpose = COD_CONFIRMATION_PURPOSE;
  const expected = EXPECTED_CATEGORY_BY_PURPOSE[purpose];
  const sendable = sql`(t.review_status IS NULL OR t.review_status = 'approved')`;
  const moved = (column: SQL) =>
    sql`(${column} IS NOT NULL AND ${column} NOT IN (${expected}, 'unknown'))`;
  const healthy = sql`(${sendable} AND NOT ${moved(sql`t.category`)} AND NOT ${moved(sql`t.pending_category`)})`;

  const perLanguage = (language: TemplateLanguage) => {
    const key = sql.raw(`cod_template_${language}_key`);
    const variant = sql.raw(`cod_template_${language}_variant`);
    const selected = sql`t."key" = COALESCE(${store}.${key}, ${`cod_confirm.${language}.`} || ${store}.${variant})`;
    const row = (condition: SQL) =>
      sql`EXISTS (SELECT 1 FROM whatsapp_templates t WHERE t.purpose = ${purpose} AND t.language = ${language} AND t.is_active AND ${condition})`;
    const selectionSendable = row(sql`${selected} AND ${sendable}`);
    const selectionUnhealthy = row(sql`${selected} AND NOT ${healthy}`);
    const defaultSendable = row(sql`t.is_default AND ${sendable}`);
    const defaultUnhealthy = row(sql`t.is_default AND NOT ${healthy}`);
    const other = language === 'ar' ? 'en' : 'ar';
    const sends = sql`COALESCE(${store}.default_language::text, 'auto') <> ${other}`;
    return {
      unavailable: sql`(${sends} AND NOT ${selectionSendable} AND NOT ${defaultSendable})`,
      degraded: sql`(${sends} AND (${selectionUnhealthy} OR (NOT ${selectionSendable} AND ${defaultUnhealthy})))`,
    };
  };

  const languages = TEMPLATE_LANGUAGES.map(perLanguage);
  const unavailable = sql`(${sql.join(
    languages.map((entry) => entry.unavailable),
    sql` OR `,
  )})`;
  const degraded = sql`(NOT ${unavailable} AND (${sql.join(
    languages.map((entry) => entry.degraded),
    sql` OR `,
  )}))`;
  return { unavailable, degraded };
}
