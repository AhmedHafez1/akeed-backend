import { TEMPLATE_LANGUAGES } from '../messaging/template-registry.types';
import { shippingTrackingLine } from './shipping-tracking-line';

describe('shippingTrackingLine', () => {
  it('shows the number only; the button opens the link', () => {
    expect(
      shippingTrackingLine('en', {
        number: '1Z999',
        url: 'https://track.example/1Z999',
      } as { number: string }),
    ).toBe('Tracking: 1Z999');
    expect(shippingTrackingLine('ar', { number: 'ABC123' })).toBe(
      'للتتبع: ABC123',
    );
  });

  it('says the courier will make contact when there is only a link', () => {
    expect(
      shippingTrackingLine('fr', {
        url: 'https://suivi.example/9',
      } as { number?: string }),
    ).toBe('Le livreur vous contactera avant la livraison.');
  });

  it('says the courier will make contact when there is no tracking', () => {
    expect(shippingTrackingLine('en', null)).toBe(
      'The courier will contact you before delivery.',
    );
  });

  it.each(TEMPLATE_LANGUAGES)(
    'fills the line with a fixed sentence when there is no tracking (%s)',
    (language) => {
      const line = shippingTrackingLine(language, null);
      expect(line.length).toBeGreaterThan(0);
      expect(shippingTrackingLine(language, { number: '  ' })).toBe(line);
    },
  );

  it.each(TEMPLATE_LANGUAGES)(
    'never carries a line break or a run of spaces (%s)',
    (language) => {
      const line = shippingTrackingLine(language, {
        number: 'A\nB\t  C',
      });
      expect(line).not.toMatch(/[\r\n\t]| {2,}/);
    },
  );
});
