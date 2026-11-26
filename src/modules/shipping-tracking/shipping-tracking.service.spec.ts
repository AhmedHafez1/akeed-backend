import type {
  ShippingNotificationsRepository,
  ShippingTrackingLookup,
} from '../../infrastructure/database/repositories/shipping-notifications.repository';
import { ShippingTrackingService } from './shipping-tracking.service';

const CODE = 'Xk3pQ9vT2mLr8sYwB4nHcA';
const NOW = new Date('2026-11-25T12:00:00.000Z');

function shipment(
  overrides: Partial<ShippingTrackingLookup> = {},
): ShippingTrackingLookup {
  return {
    id: 'ship-1',
    createdAt: '2026-11-20T12:00:00.000Z',
    trackingNumber: null,
    trackingUrl: null,
    trackingCompany: null,
    storeName: 'Cairo Store',
    orderNumber: '#1042',
    messageLanguage: 'en',
    storeLanguage: 'auto',
    ...overrides,
  };
}

function harness(found: ShippingTrackingLookup | null) {
  const repository = {
    findByTrackingCode: jest.fn().mockResolvedValue(found),
    markTrackingOpened: jest.fn().mockResolvedValue(undefined),
  };
  const service = new ShippingTrackingService(
    repository as unknown as ShippingNotificationsRepository,
  );
  return { repository, service };
}

describe('ShippingTrackingService', () => {
  it('never looks up a malformed code', async () => {
    const h = harness(shipment());
    await expect(h.service.open('../etc', NOW)).resolves.toEqual({
      kind: 'unavailable',
    });
    expect(h.repository.findByTrackingCode).not.toHaveBeenCalled();
  });

  it('shows the neutral page for an unknown code', async () => {
    const h = harness(null);
    await expect(h.service.open(CODE, NOW)).resolves.toEqual({
      kind: 'unavailable',
    });
    expect(h.repository.markTrackingOpened).not.toHaveBeenCalled();
  });

  it('shows the neutral page for a link older than 90 days', async () => {
    const h = harness(shipment({ createdAt: '2026-08-26T11:59:00.000Z' }));
    await expect(h.service.open(CODE, NOW)).resolves.toEqual({
      kind: 'unavailable',
    });
  });

  it('redirects to the stored carrier link and records the open', async () => {
    const h = harness(
      shipment({
        trackingUrl: 'https://carrier.example/t/9',
        trackingNumber: '9',
        trackingCompany: 'Bosta',
      }),
    );
    await expect(h.service.open(CODE, NOW)).resolves.toEqual({
      kind: 'redirect',
      url: 'https://carrier.example/t/9',
    });
    expect(h.repository.markTrackingOpened).toHaveBeenCalledWith('ship-1');
  });

  it('redirects to a known courier page built from the number', async () => {
    const h = harness(
      shipment({ trackingNumber: '12345', trackingCompany: 'bosta' }),
    );
    await expect(h.service.open(CODE, NOW)).resolves.toEqual({
      kind: 'redirect',
      url: 'https://bosta.co/en-eg/tracking-shipments?shipment-number=12345',
    });
  });

  it('shows the number for an unknown courier, in the message language', async () => {
    const h = harness(
      shipment({
        trackingNumber: 'M-77',
        trackingCompany: 'Mylerz',
        messageLanguage: 'ar',
      }),
    );
    await expect(h.service.open(CODE, NOW)).resolves.toEqual({
      kind: 'page',
      language: 'ar',
      storeName: 'Cairo Store',
      orderNumber: '#1042',
      courier: 'Mylerz',
      trackingNumber: 'M-77',
    });
  });

  it('shows the order alone when there is nothing to track', async () => {
    const h = harness(shipment({ messageLanguage: null, storeLanguage: 'tr' }));
    await expect(h.service.open(CODE, NOW)).resolves.toEqual({
      kind: 'page',
      language: 'tr',
      storeName: 'Cairo Store',
      orderNumber: '#1042',
      courier: null,
      trackingNumber: null,
    });
  });

  it('falls back to Arabic when no language is known', async () => {
    const h = harness(
      shipment({ messageLanguage: null, storeLanguage: 'auto' }),
    );
    await expect(h.service.open(CODE, NOW)).resolves.toMatchObject({
      kind: 'page',
      language: 'ar',
    });
  });

  it('still answers when the open cannot be recorded', async () => {
    const h = harness(shipment({ trackingNumber: 'N1' }));
    h.repository.markTrackingOpened.mockRejectedValue(new Error('db down'));
    await expect(h.service.open(CODE, NOW)).resolves.toMatchObject({
      kind: 'page',
    });
  });
});
