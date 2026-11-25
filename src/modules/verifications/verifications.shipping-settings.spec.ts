import type { DashboardSettingsSummaryDto } from '../orders/dto/dashboard.dto';
import { VerificationsService } from './verifications.service';

/**
 * The dashboard's settings summary carries the shipping switch only where the
 * feature exists, so the Shipping column appears only for those stores.
 */
function summaryFor(
  source: Record<string, unknown> | undefined,
  availableFor: string[] | null,
): DashboardSettingsSummaryDto {
  const shipping =
    availableFor === null
      ? undefined
      : {
          isAvailableFor: (platform: string) => availableFor.includes(platform),
        };
  const service = new VerificationsService(
    null as never,
    null as never,
    null as never,
    null as never,
    null as never,
    null as never,
    undefined,
    undefined,
    undefined,
    undefined,
    shipping as never,
  );
  return (
    service as unknown as {
      resolveSettingsSummary: (source: unknown) => DashboardSettingsSummaryDto;
    }
  ).resolveSettingsSummary(source);
}

const shopify = (enabled: boolean | null) => ({
  platformType: 'shopify',
  isAutoVerifyEnabled: true,
  shippingNotificationsEnabled: enabled,
});

describe('dashboard settings summary: shipping_notifications_enabled', () => {
  it('is the store switch where the feature exists', () => {
    expect(summaryFor(shopify(true), ['shopify'])).toMatchObject({
      shipping_notifications_enabled: true,
    });
    expect(summaryFor(shopify(false), ['shopify'])).toMatchObject({
      shipping_notifications_enabled: false,
    });
    expect(summaryFor(shopify(null), ['shopify'])).toMatchObject({
      shipping_notifications_enabled: false,
    });
  });

  it('is absent with the env switch off or for a platform without a source', () => {
    expect(summaryFor(shopify(true), [])).not.toHaveProperty(
      'shipping_notifications_enabled',
    );
    expect(
      summaryFor({ ...shopify(true), platformType: 'woocommerce' }, [
        'shopify',
      ]),
    ).not.toHaveProperty('shipping_notifications_enabled');
    expect(summaryFor(shopify(true), null)).not.toHaveProperty(
      'shipping_notifications_enabled',
    );
  });

  it('is absent when the org has no source', () => {
    expect(summaryFor(undefined, ['shopify'])).not.toHaveProperty(
      'shipping_notifications_enabled',
    );
  });
});
