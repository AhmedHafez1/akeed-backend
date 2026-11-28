export interface PublicStatsDto {
  /** Distinct real orders a customer confirmed on WhatsApp. */
  confirmed_orders_total: number;
  /** Active integrations, including standalone order sources. */
  active_stores_total: number | null;
  as_of: string;
}
