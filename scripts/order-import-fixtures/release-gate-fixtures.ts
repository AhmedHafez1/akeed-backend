/**
 * The US-04.6-10 AC1 fixtures that carry whole-file merchant data rather than
 * a single parser quirk. Like the rest of the pack, every expectation (the
 * parsed grid and the per-row manifest) is written by hand from the stories.
 *
 * ASSUMPTION / REQUIRES VALIDATION: these are synthetic best estimates of real
 * merchant files. Anonymized pilot samples replace or join them once the pilot
 * provides them (US-04.6-10 pilot checklist, section 6).
 */
import type { CellObject } from 'xlsx';
import {
  csvOf,
  egyptStore,
  excelSerial,
  text,
  withBom,
  workbook,
  type OrderImportFixture,
} from './build-fixtures';

// A subset of Shopify's own orders export, in its column order. Rows after the
// first of an order repeat only `Name` and the line-item columns.
const SHOPIFY_HEADERS = [
  'Name',
  'Email',
  'Financial Status',
  'Currency',
  'Subtotal',
  'Total',
  'Created at',
  'Lineitem quantity',
  'Lineitem name',
  'Lineitem price',
  'Shipping Name',
  'Shipping Address1',
  'Shipping City',
  'Shipping Phone',
  'Billing Name',
  'Billing Phone',
  'Notes',
  'Payment Gateway',
];

function shopifyOrder(values: Partial<Record<string, string>>): string[] {
  return SHOPIFY_HEADERS.map((header) => values[header] ?? '');
}

const SHOPIFY_ROWS = [
  shopifyOrder({
    Name: '#1001',
    Email: 'buyer1@example.test',
    'Financial Status': 'pending',
    Currency: 'EGP',
    Subtotal: '700.00',
    Total: '750.00',
    'Created at': '2026-09-18 14:05:00 +0300',
    'Lineitem quantity': '1',
    'Lineitem name': 'Cotton shirt - M',
    'Lineitem price': '300.00',
    'Shipping Name': 'Nour Adel',
    'Shipping Address1': '12 Tahrir St',
    'Shipping City': 'Cairo',
    'Shipping Phone': '+201012345678',
    'Billing Name': 'Nour Adel',
    'Billing Phone': '+201012345678',
    'Payment Gateway': 'Cash on Delivery (COD)',
  }),
  shopifyOrder({
    Name: '#1001',
    Email: 'buyer1@example.test',
    'Lineitem quantity': '2',
    'Lineitem name': 'Socks',
    'Lineitem price': '100.00',
  }),
  shopifyOrder({
    Name: '#1001',
    Email: 'buyer1@example.test',
    'Lineitem quantity': '1',
    'Lineitem name': 'Cap',
    'Lineitem price': '200.00',
  }),
  shopifyOrder({
    Name: '#1002',
    Email: 'buyer2@example.test',
    'Financial Status': 'pending',
    Currency: 'EGP',
    Subtotal: '420.00',
    Total: '450.00',
    'Created at': '2026-09-19 09:40:00 +0300',
    'Lineitem quantity': '1',
    'Lineitem name': 'Scarf',
    'Lineitem price': '420.00',
    'Shipping Name': 'Karim Samir',
    'Shipping Address1': '5 Corniche Rd',
    'Shipping City': 'Alexandria',
    'Shipping Phone': '+201198765432',
    'Billing Name': 'Karim Samir',
    'Payment Gateway': 'Cash on Delivery (COD)',
  }),
  shopifyOrder({
    Name: '#1003',
    Email: 'buyer3@example.test',
    'Financial Status': 'paid',
    Currency: 'EGP',
    Subtotal: '980.00',
    Total: '1,030.00',
    'Created at': '2026-09-19 11:15:00 +0300',
    'Lineitem quantity': '1',
    'Lineitem name': 'Jacket',
    'Lineitem price': '980.00',
    'Shipping Name': 'Laila Fathy',
    'Shipping City': 'Giza',
    'Shipping Phone': '+201555123456',
    'Payment Gateway': 'shopify_payments',
  }),
];

const SHOPIFY_CSV =
  // Shopify quotes a field only when it needs to; Total "1,030.00" does.
  csvOf(
    [SHOPIFY_HEADERS, ...SHOPIFY_ROWS].map((row) =>
      row.map((cell) => (/[",\n]/.test(cell) ? `"${cell}"` : cell)),
    ),
  );

const MIXED_PAYMENTS = [
  'COD',
  'Cash',
  'كاش',
  'عند الاستلام',
  'Paid',
  'Visa',
  'مدفوع',
  'InstaPay',
  '',
];

const dayFirst = (iso: string): CellObject => ({
  t: 'n',
  v: excelSerial(iso),
  z: 'yyyy-mm-dd',
});

const DATE_CASES: [string, string | number | CellObject][] = [
  ['D-1', '2026-09-18'],
  ['D-2', dayFirst('2026-09-17')],
  // A serial left in General format reaches validation as a bare number.
  ['D-3', excelSerial('2026-09-15')],
  ['D-4', '2026-09-11'],
  ['D-5', '2026-09-12'],
  ['D-6', '2026-09-20'],
  ['D-7', '2026-09-21'],
  ['D-8', 'yesterday'],
  ['D-9', '2026-09-18T23:30:00Z'],
  ['D-10', '18/09/2026'],
  ['D-11', '09/18/2026'],
  ['D-12', '18-9-26'],
];

export const RELEASE_GATE_FIXTURES: OrderImportFixture[] = [
  {
    file: 'shopify-orders-export.csv',
    description:
      "A Shopify orders export: `Name` holds `#1001`, one order's line items spread over three rows, and a Payment Gateway column.",
    build: () => text(SHOPIFY_CSV),
    expected: {
      format: 'csv',
      encoding: 'utf-8',
      delimiter: ',',
      sheetName: null,
      ignoredSheets: [],
      headers: SHOPIFY_HEADERS,
      rowCount: 5,
      rows: SHOPIFY_ROWS.map((cells, index) => ({
        rowNumber: index + 2,
        cells,
      })),
    },
    manifest: egyptStore({
      assumeCodWhenPaymentMissing: false,
      autoMapped: true,
      mapping: {
        // Name is the order reference here: its samples are `#1001`.
        orderReference: 'Name',
        customerName: ['Shipping Name'],
        phone: 'Shipping Phone',
        amount: 'Total',
        currency: 'Currency',
        paymentMethod: 'Payment Gateway',
        orderDate: 'Created at',
        city: 'Shipping City',
        address: 'Shipping Address1',
        notes: 'Notes',
      },
      // `shopify_payments` is not a known value; the merchant marks it.
      paymentValueMap: { shopify_payments: 'not_cod' },
      rows: [
        {
          rowNumber: 2,
          outcome: 'ready',
          issues: [],
          normalized: {
            orderNumber: '#1001',
            customerName: 'Nour Adel',
            customerPhone: '+201012345678',
            totalPrice: '750.00',
            orderDate: '2026-09-18',
          },
        },
        // The line-item rows collapse into the order's first row.
        {
          rowNumber: 3,
          outcome: 'duplicate',
          issues: ['DUPLICATE_IN_FILE', 'PAYMENT_UNKNOWN_EXCLUDED'],
          collapsedInto: 2,
        },
        {
          rowNumber: 4,
          outcome: 'duplicate',
          issues: ['DUPLICATE_IN_FILE', 'PAYMENT_UNKNOWN_EXCLUDED'],
          collapsedInto: 2,
        },
        {
          rowNumber: 5,
          outcome: 'ready',
          issues: [],
          normalized: { orderNumber: '#1002', totalPrice: '450.00' },
        },
        {
          rowNumber: 6,
          outcome: 'excluded',
          issues: ['PAYMENT_NOT_COD'],
          normalized: { totalPrice: '1030.00' },
        },
      ],
    }),
  },
  {
    file: 'no-reference.csv',
    description:
      'No order reference column: identical rows collapse, a genuine repeat on another day stays.',
    build: () =>
      withBom(
        csvOf([
          ['Customer Name', 'Mobile', 'Amount', 'Payment Method', 'Order Date'],
          ['Ahmed Ali', '01012345678', '750', 'COD', '2026-09-18'],
          ['Ahmed Ali', '01012345678', '750', 'COD', '2026-09-18'],
          ['Ahmed Ali', '01012345678', '750', 'COD', '2026-09-17'],
          ['Mona Hassan', '01198765432', '300', 'COD', '2026-09-18'],
        ]),
      ),
    expected: {
      format: 'csv',
      encoding: 'utf-8',
      delimiter: ',',
      sheetName: null,
      ignoredSheets: [],
      headers: [
        'Customer Name',
        'Mobile',
        'Amount',
        'Payment Method',
        'Order Date',
      ],
      rowCount: 4,
      rows: [
        {
          rowNumber: 2,
          cells: ['Ahmed Ali', '01012345678', '750', 'COD', '2026-09-18'],
        },
        {
          rowNumber: 3,
          cells: ['Ahmed Ali', '01012345678', '750', 'COD', '2026-09-18'],
        },
        {
          rowNumber: 4,
          cells: ['Ahmed Ali', '01012345678', '750', 'COD', '2026-09-17'],
        },
        {
          rowNumber: 5,
          cells: ['Mona Hassan', '01198765432', '300', 'COD', '2026-09-18'],
        },
      ],
    },
    manifest: egyptStore({
      assumeCodWhenPaymentMissing: false,
      autoMapped: true,
      mapping: {
        customerName: ['Customer Name'],
        phone: 'Mobile',
        amount: 'Amount',
        paymentMethod: 'Payment Method',
        orderDate: 'Order Date',
      },
      rows: [
        { rowNumber: 2, outcome: 'ready', issues: [] },
        {
          rowNumber: 3,
          outcome: 'duplicate',
          issues: ['DUPLICATE_IN_FILE'],
          collapsedInto: 2,
        },
        { rowNumber: 4, outcome: 'ready', issues: [] },
        { rowNumber: 5, outcome: 'ready', issues: [] },
      ],
    }),
  },
  {
    file: 'mixed-payments.csv',
    description:
      'Every payment value of the epic catalogue, auto-classified, with a blank one.',
    build: () =>
      text(
        csvOf([
          ['Order Number', 'Name', 'Phone', 'Amount', 'Payment'],
          ...MIXED_PAYMENTS.map((payment, index) => [
            `M-${index + 1}`,
            `Customer ${index + 1}`,
            `0101234${String(5670 + index)}`,
            '500',
            payment,
          ]),
        ]),
      ),
    expected: {
      format: 'csv',
      encoding: 'utf-8',
      delimiter: ',',
      sheetName: null,
      ignoredSheets: [],
      headers: ['Order Number', 'Name', 'Phone', 'Amount', 'Payment'],
      rowCount: 9,
      rows: MIXED_PAYMENTS.map((payment, index) => ({
        rowNumber: index + 2,
        cells: [
          `M-${index + 1}`,
          `Customer ${index + 1}`,
          `0101234${String(5670 + index)}`,
          '500',
          payment,
        ],
      })),
    },
    manifest: egyptStore({
      assumeCodWhenPaymentMissing: false,
      autoMapped: true,
      mapping: {
        orderReference: 'Order Number',
        customerName: ['Name'],
        phone: 'Phone',
        amount: 'Amount',
        paymentMethod: 'Payment',
      },
      rows: [
        ...[2, 3, 4, 5].map((rowNumber) => ({
          rowNumber,
          outcome: 'ready' as const,
          issues: [],
          normalized: { paymentMethod: 'cash on delivery' },
        })),
        ...[6, 7, 8, 9].map((rowNumber) => ({
          rowNumber,
          outcome: 'excluded' as const,
          issues: ['PAYMENT_NOT_COD'],
        })),
        // Blank, and the store does not assume COD for a missing payment.
        {
          rowNumber: 10,
          outcome: 'excluded',
          issues: ['PAYMENT_UNKNOWN_EXCLUDED'],
        },
      ],
    }),
  },
  {
    file: 'old-and-future-dates.xlsx',
    description:
      'Order dates around the 7-day age window and the 1-day future limit, in every accepted shape plus text.',
    build: () =>
      workbook([
        {
          name: 'Orders',
          rows: [
            [
              'Order ID',
              'Customer Name',
              'Phone',
              'Amount',
              'Payment Method',
              'Order Date',
            ],
            ...DATE_CASES.map(([reference, date], index) => [
              reference,
              `Customer ${index + 1}`,
              `0111234${String(5670 + index)}`,
              '300',
              'COD',
              date,
            ]),
          ],
        },
      ]),
    expected: {
      format: 'xlsx',
      encoding: null,
      delimiter: null,
      sheetName: 'Orders',
      ignoredSheets: [],
      headers: [
        'Order ID',
        'Customer Name',
        'Phone',
        'Amount',
        'Payment Method',
        'Order Date',
      ],
      rowCount: DATE_CASES.length,
      rows: DATE_CASES.map(([reference], index) => ({
        rowNumber: index + 2,
        cells: [
          reference,
          `Customer ${index + 1}`,
          `0111234${String(5670 + index)}`,
          '300',
          'COD',
          [
            '2026-09-18',
            '2026-09-17',
            String(excelSerial('2026-09-15')),
            '2026-09-11',
            '2026-09-12',
            '2026-09-20',
            '2026-09-21',
            'yesterday',
            '2026-09-18T23:30:00Z',
            '18/09/2026',
            '09/18/2026',
            '18-9-26',
          ][index],
        ],
      })),
    },
    manifest: egyptStore({
      assumeCodWhenPaymentMissing: false,
      autoMapped: true,
      mapping: {
        orderReference: 'Order ID',
        customerName: ['Customer Name'],
        phone: 'Phone',
        amount: 'Amount',
        paymentMethod: 'Payment Method',
        orderDate: 'Order Date',
      },
      dateFormat: 'auto',
      rows: [
        {
          rowNumber: 2,
          outcome: 'ready',
          issues: [],
          normalized: { orderDate: '2026-09-18' },
        },
        {
          rowNumber: 3,
          outcome: 'ready',
          issues: [],
          normalized: { orderDate: '2026-09-17' },
        },
        {
          rowNumber: 4,
          outcome: 'ready',
          issues: [],
          normalized: { orderDate: '2026-09-15' },
        },
        // 8 days before today in Cairo: too old to confirm now.
        { rowNumber: 5, outcome: 'excluded', issues: ['ORDER_TOO_OLD'] },
        // Exactly 7 days: still inside the window.
        {
          rowNumber: 6,
          outcome: 'ready',
          issues: [],
          normalized: { orderDate: '2026-09-12' },
        },
        // Tomorrow is allowed; the day after is a data error.
        {
          rowNumber: 7,
          outcome: 'ready',
          issues: [],
          normalized: { orderDate: '2026-09-20' },
        },
        { rowNumber: 8, outcome: 'invalid', issues: ['ORDER_DATE_FUTURE'] },
        { rowNumber: 9, outcome: 'invalid', issues: ['ORDER_DATE_INVALID'] },
        // 23:30 UTC is already the 19th in Cairo (UTC+3).
        {
          rowNumber: 10,
          outcome: 'ready',
          issues: [],
          normalized: { orderDate: '2026-09-19' },
        },
        {
          rowNumber: 11,
          outcome: 'ready',
          issues: [],
          normalized: { orderDate: '2026-09-18' },
        },
        {
          rowNumber: 12,
          outcome: 'ready',
          issues: [],
          normalized: { orderDate: '2026-09-18' },
        },
        {
          rowNumber: 13,
          outcome: 'ready',
          issues: [],
          normalized: { orderDate: '2026-09-18' },
        },
      ],
    }),
  },
  {
    file: 'formula-injection.csv',
    description:
      'Cells starting with =, +, -, @, tab and carriage return: stored as text, never evaluated.',
    build: () =>
      text(
        'Order Number,Customer Name,Phone,Amount,Payment,Notes\r\n' +
          'F-1,"=HYPERLINK(""http://example.test"",""Ahmed"")",01012345601,500,COD,ok\r\n' +
          'F-2,Mona Ali,01012345602,500,COD,+SUM(A1:A9)\r\n' +
          'F-3,Omar Samy,01012345603,500,COD,-2+3\r\n' +
          'F-4,Hala Adel,01012345604,500,COD,@SUM(1+1)\r\n' +
          'F-5,Rana Said,01012345605,500,COD,"\tcmd"\r\n' +
          'F-6,Ziad Nabil,01012345606,500,COD,"\rcalc"\r\n' +
          'F-7,Salma Ezz,01012345607,=500,COD,\r\n',
      ),
    expected: {
      format: 'csv',
      encoding: 'utf-8',
      delimiter: ',',
      sheetName: null,
      ignoredSheets: [],
      headers: [
        'Order Number',
        'Customer Name',
        'Phone',
        'Amount',
        'Payment',
        'Notes',
      ],
      rowCount: 7,
      rows: [
        {
          rowNumber: 2,
          cells: [
            'F-1',
            '=HYPERLINK("http://example.test","Ahmed")',
            '01012345601',
            '500',
            'COD',
            'ok',
          ],
        },
        {
          rowNumber: 3,
          cells: [
            'F-2',
            'Mona Ali',
            '01012345602',
            '500',
            'COD',
            '+SUM(A1:A9)',
          ],
        },
        {
          rowNumber: 4,
          cells: ['F-3', 'Omar Samy', '01012345603', '500', 'COD', '-2+3'],
        },
        {
          rowNumber: 5,
          cells: ['F-4', 'Hala Adel', '01012345604', '500', 'COD', '@SUM(1+1)'],
        },
        // Cells are trimmed at parse, so a leading tab or CR never reaches a
        // row; the other leading characters are escaped on export instead.
        {
          rowNumber: 6,
          cells: ['F-5', 'Rana Said', '01012345605', '500', 'COD', 'cmd'],
        },
        {
          rowNumber: 7,
          cells: ['F-6', 'Ziad Nabil', '01012345606', '500', 'COD', 'calc'],
        },
        {
          rowNumber: 8,
          cells: ['F-7', 'Salma Ezz', '01012345607', '=500', 'COD', ''],
        },
      ],
    },
    manifest: egyptStore({
      assumeCodWhenPaymentMissing: false,
      autoMapped: true,
      mapping: {
        orderReference: 'Order Number',
        customerName: ['Customer Name'],
        phone: 'Phone',
        amount: 'Amount',
        paymentMethod: 'Payment',
        notes: 'Notes',
      },
      rows: [
        // A formula-looking name is still a name: kept as text, never run.
        {
          rowNumber: 2,
          outcome: 'ready',
          issues: [],
          normalized: {
            customerName: '=HYPERLINK("http://example.test","Ahmed")',
          },
        },
        {
          rowNumber: 3,
          outcome: 'ready',
          issues: [],
          normalized: { notes: '+SUM(A1:A9)' },
        },
        {
          rowNumber: 4,
          outcome: 'ready',
          issues: [],
          normalized: { notes: '-2+3' },
        },
        {
          rowNumber: 5,
          outcome: 'ready',
          issues: [],
          normalized: { notes: '@SUM(1+1)' },
        },
        { rowNumber: 6, outcome: 'ready', issues: [] },
        { rowNumber: 7, outcome: 'ready', issues: [] },
        // An amount is a number; a formula is not one.
        { rowNumber: 8, outcome: 'invalid', issues: ['AMOUNT_INVALID'] },
      ],
    }),
  },
  {
    file: 'scientific-phones.xlsx',
    description:
      'Phone columns Excel shows in scientific notation, typed or formatted, beside numbers it keeps whole.',
    build: () =>
      workbook([
        {
          name: 'Orders',
          rows: [
            ['Order ID', 'Customer Name', 'Phone', 'Amount', 'Payment Method'],
            ['S-1', 'Adel Fouad', '2.01012E+11', 400, 'COD'],
            [
              'S-2',
              'Dina Magdy',
              { t: 'n', v: 201_012_345_602, z: '0.00E+00' },
              400,
              'COD',
            ],
            ['S-3', 'Hany Lotfy', 201_012_345_603, 400, 'COD'],
            [
              'S-4',
              'Rasha Aly',
              { t: 'n', v: 1_012_345_604, z: '00000000000' },
              400,
              'COD',
            ],
          ],
        },
      ]),
    expected: {
      format: 'xlsx',
      encoding: null,
      delimiter: null,
      sheetName: 'Orders',
      ignoredSheets: [],
      headers: [
        'Order ID',
        'Customer Name',
        'Phone',
        'Amount',
        'Payment Method',
      ],
      rowCount: 4,
      rows: [
        {
          rowNumber: 2,
          cells: ['S-1', 'Adel Fouad', '2.01012E+11', '400', 'COD'],
        },
        {
          rowNumber: 3,
          cells: ['S-2', 'Dina Magdy', '2.01E+11', '400', 'COD'],
        },
        {
          rowNumber: 4,
          cells: ['S-3', 'Hany Lotfy', '201012345603', '400', 'COD'],
        },
        {
          rowNumber: 5,
          cells: ['S-4', 'Rasha Aly', '01012345604', '400', 'COD'],
        },
      ],
    },
    manifest: egyptStore({
      assumeCodWhenPaymentMissing: false,
      autoMapped: true,
      mapping: {
        orderReference: 'Order ID',
        customerName: ['Customer Name'],
        phone: 'Phone',
        amount: 'Amount',
        paymentMethod: 'Payment Method',
      },
      rows: [
        {
          rowNumber: 2,
          outcome: 'invalid',
          issues: ['PHONE_SCIENTIFIC_NOTATION'],
        },
        {
          rowNumber: 3,
          outcome: 'invalid',
          issues: ['PHONE_SCIENTIFIC_NOTATION'],
        },
        {
          rowNumber: 4,
          outcome: 'ready',
          issues: [],
          normalized: { customerPhone: '+201012345603' },
        },
        {
          rowNumber: 5,
          outcome: 'ready',
          issues: [],
          normalized: { customerPhone: '+201012345604' },
        },
      ],
    }),
  },
];
