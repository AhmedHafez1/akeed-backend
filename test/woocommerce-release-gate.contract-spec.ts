import {
  EASYORDERS_MIGRATIONS,
  easyOrdersConformanceDriver,
  installEasyOrders,
} from './contracts/easyorders-conformance-driver';
import {
  assembleConformanceWorld,
  conformanceBeside,
  createConformanceBase,
  defineSourceConformance,
} from './contracts/source-conformance-harness';
import {
  WOOCOMMERCE_MIGRATIONS,
  installWooCommerce,
  wooCommerceConformanceDriver,
} from './contracts/woocommerce-conformance-driver';

/**
 * US-07-06 release gate: one WooCommerce store through connect, order, send,
 * customer outcome and store update, over PostgreSQL, with two tenants and a
 * Shopify, a Standalone and an EasyOrders source beside it. Real
 * repositories and services; the edges are fakes: the provider fake under
 * the real restricted outbound client (never a store), the messaging port
 * (never Meta) and the BullMQ queues, whose jobs are recorded and run in
 * process.
 *
 * The matrix is the shared source conformance harness, the one EasyOrders
 * runs. What only WooCommerce decides is in its driver.
 */

const base = createConformanceBase({
  namespacePrefix: 'e07_gate',
  messageIdPrefix: 'wamid-e07',
});
const wooCommerce = installWooCommerce(base);
const easyOrders = installEasyOrders(base);
// EasyOrders is bound beside WooCommerce, as the application binds both.
const world = assembleConformanceWorld(base, [
  wooCommerce.spoke,
  easyOrders.spoke,
]);
const { driver } = wooCommerceConformanceDriver(world, wooCommerce);

defineSourceConformance({
  title: 'WooCommerce release gate PostgreSQL contract (US-07-06)',
  world,
  driver,
  migrations: [...EASYORDERS_MIGRATIONS, ...WOOCOMMERCE_MIGRATIONS],
  besides: [
    world.shopifyBeside(),
    world.standaloneBeside(),
    conformanceBeside(
      world,
      easyOrdersConformanceDriver(world, easyOrders).driver,
    ),
  ],
});
