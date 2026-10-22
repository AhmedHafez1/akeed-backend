import { sql, type SQL } from 'drizzle-orm';

/**
 * Where a store's customers' phones are from, as a one-row subquery over the
 * store's real (non-test) orders: `top_customer_country`, its share 0-100
 * (`top_customer_country_share`) of the orders whose country is known, and
 * how many countries there are (`customer_country_count`). With no such order
 * the first two are NULL and the count is 0. Ties go to the first code
 * alphabetically, so the result is stable.
 *
 * `integrationId` is the SQL for the store's id, typically `i.id` inside a
 * LATERAL join. The `is_test = false` predicate matches the partial index
 * `idx_orders_integration_customer_country`.
 */
export function customerCountriesSql(integrationId: SQL): SQL {
  return sql`
    SELECT
      (array_agg(country_counts.customer_country
        ORDER BY country_counts.order_count DESC, country_counts.customer_country))[1]
        AS top_customer_country,
      ROUND(
        MAX(country_counts.order_count) * 100.0
          / NULLIF(SUM(country_counts.order_count), 0)
      )::int AS top_customer_country_share,
      COUNT(*)::int AS customer_country_count
    FROM (
      SELECT country_order.customer_country, COUNT(*)::int AS order_count
      FROM orders country_order
      WHERE country_order.integration_id = ${integrationId}
        AND country_order.is_test = false
        AND country_order.customer_country IS NOT NULL
      GROUP BY country_order.customer_country
    ) country_counts
  `;
}
