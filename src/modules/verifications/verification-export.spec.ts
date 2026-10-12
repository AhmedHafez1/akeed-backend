import { buildVerificationsCsv } from './verification-export';
import type { VerificationExportRow } from '../../infrastructure/database/repositories/verifications.repository';

const baseRow: VerificationExportRow = {
  orderNumber: '#22',
  customerName: 'Ahmed Hafez',
  customerPhone: '+201148675077',
  totalPrice: '950.00',
  currency: 'EGP',
  shippingRegion: 'Giza',
  shippingAddress: '5 Nile St',
  lineItems: [
    {
      name: 'T-shirt',
      quantity: 2,
      unitPrice: '400.00',
      options: [{ name: 'Size', value: 'L' }, { value: 'Black' }],
    },
  ],
  status: 'confirmed',
  createdAt: '2026-10-12T04:36:00.000Z',
  confirmedAt: '2026-10-12T04:43:00.000Z',
  canceledAt: null,
};

describe('buildVerificationsCsv', () => {
  it('starts with a byte order mark and a header row', () => {
    const csv = buildVerificationsCsv([], 'UTC');
    expect(csv.charCodeAt(0)).toBe(0xfeff);
    expect(csv.slice(1)).toBe(
      'Order,Customer,Phone,Total,Currency,Status,Order time,Confirmed at,Canceled at,City / region,Address,Items\r\n',
    );
  });

  it('writes times in the reporting zone and lists the items', () => {
    const [, line] = buildVerificationsCsv([baseRow], 'Africa/Cairo').split(
      '\r\n',
    );
    expect(line).toBe(
      '#22,Ahmed Hafez,+201148675077,950.00,EGP,confirmed,2026-10-12 07:36,2026-10-12 07:43,,Giza,5 Nile St,"2 x T-shirt (L, Black)"',
    );
  });

  it('quotes commas, quotes and line breaks', () => {
    const [, line] = buildVerificationsCsv(
      [
        {
          ...baseRow,
          customerName: 'Sara "Soso"',
          shippingAddress: 'Flat 2,\nBuilding 9',
          lineItems: null,
        },
      ],
      'UTC',
    ).split('\r\n', 2);
    expect(line).toContain('"Sara ""Soso"""');
    expect(line).toContain('"Flat 2,');
  });

  it('keeps a formula-looking value as text but leaves phone numbers alone', () => {
    const [, line] = buildVerificationsCsv(
      [
        {
          ...baseRow,
          customerName: '=HYPERLINK("http://x")',
          shippingAddress: '@home',
          lineItems: null,
        },
      ],
      'UTC',
    ).split('\r\n');
    expect(line).toContain(`"'=HYPERLINK(""http://x"")"`);
    expect(line).toContain(",'@home,");
    expect(line).toContain(',+201148675077,');
  });
});
