import {
  buildStandaloneOrderEnvelope,
  type CanonicalOrder,
  type CanonicalOrderInput,
  type StandaloneIngestionChannel,
} from '../../shared/commerce/standalone-order-envelope';

/**
 * The canonical order the worker will judge for a channel's input, built by
 * the same envelope code `StandaloneOrderIngestionService` accepts through,
 * but without accepting, holding or dispatching anything.
 *
 * A channel that has to show an eligibility decision before the order exists
 * (the import review step) previews here, so no channel adapter calls the
 * envelope builder itself (the adapter boundary, US-04.6-10).
 */
export function previewCanonicalOrder(
  channel: StandaloneIngestionChannel,
  order: CanonicalOrderInput,
): CanonicalOrder {
  return buildStandaloneOrderEnvelope({ ingestionType: channel, order })
    .canonicalOrder;
}
