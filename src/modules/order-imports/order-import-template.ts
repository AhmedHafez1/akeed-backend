import { utils, write, type CellObject } from 'xlsx';
import { toCsv } from './csv-writer.util';
import type {
  OrderImportTemplateFormat,
  OrderImportTemplateLocale,
} from './dto/order-import.dto';

export const TEMPLATE_FIELDS = [
  'order_id',
  'customer_name',
  'phone',
  'amount',
  'currency',
  'payment_method',
  'order_date',
  'city',
  'address',
  'notes',
] as const;

type TemplateField = (typeof TEMPLATE_FIELDS)[number];

const HEADER_LABELS: Record<
  OrderImportTemplateLocale,
  Record<TemplateField, string>
> = {
  en: {
    order_id: 'order_id',
    customer_name: 'customer_name',
    phone: 'phone',
    amount: 'amount',
    currency: 'currency',
    payment_method: 'payment_method',
    order_date: 'order_date',
    city: 'city',
    address: 'address',
    notes: 'notes',
  },
  ar: {
    order_id: 'رقم الطلب',
    customer_name: 'اسم العميل',
    phone: 'رقم الهاتف',
    amount: 'المبلغ',
    currency: 'العملة',
    payment_method: 'طريقة الدفع',
    order_date: 'تاريخ الطلب',
    city: 'المدينة',
    address: 'العنوان',
    notes: 'ملاحظات',
  },
};

/** Two Egyptian cash-on-delivery examples, written the way merchants write them. */
const EXAMPLE_ROWS: Record<
  OrderImportTemplateLocale,
  Record<TemplateField, string>[]
> = {
  en: [
    {
      order_id: 'EG-1001',
      customer_name: 'Ahmed Mohamed',
      phone: '01001234567',
      amount: '350.00',
      currency: 'EGP',
      payment_method: 'Cash on delivery',
      order_date: '2026-09-18',
      city: 'Cairo',
      address: '12 Tahrir Street, Dokki',
      notes: 'Call before delivery',
    },
    {
      order_id: 'EG-1002',
      customer_name: 'Mona Ali',
      phone: '01112345678',
      amount: '1250.50',
      currency: 'EGP',
      payment_method: 'Cash on delivery',
      order_date: '2026-09-18',
      city: 'Alexandria',
      address: '5 Fouad Street, Downtown',
      notes: '',
    },
  ],
  ar: [
    {
      order_id: 'EG-1001',
      customer_name: 'أحمد محمد',
      phone: '01001234567',
      amount: '350.00',
      currency: 'EGP',
      payment_method: 'الدفع عند الاستلام',
      order_date: '2026-09-18',
      city: 'القاهرة',
      address: '12 شارع التحرير، الدقي',
      notes: 'الاتصال قبل التوصيل',
    },
    {
      order_id: 'EG-1002',
      customer_name: 'منى علي',
      phone: '01112345678',
      amount: '1250.50',
      currency: 'EGP',
      payment_method: 'الدفع عند الاستلام',
      order_date: '2026-09-18',
      city: 'الإسكندرية',
      address: '5 شارع فؤاد، وسط البلد',
      notes: '',
    },
  ],
};

export interface OrderImportTemplateFile {
  fileName: string;
  contentType: string;
  body: Buffer;
}

function xlsxCell(field: TemplateField, value: string): CellObject {
  // Phones stay text so Excel keeps the leading zero; amounts are numbers the
  // merchant can sum.
  if (field === 'amount' && value !== '')
    return { t: 'n', v: Number(value), z: '0.00' };
  return { t: 's', v: value, z: '@' };
}

/** The sample file for `GET /api/order-imports/template` (AC11). */
export function buildOrderImportTemplate(
  format: OrderImportTemplateFormat,
  locale: OrderImportTemplateLocale,
): OrderImportTemplateFile {
  const headers = TEMPLATE_FIELDS.map((field) => HEADER_LABELS[locale][field]);
  const rows = EXAMPLE_ROWS[locale];
  const fileName = `akeed-orders-template-${locale}.${format}`;

  if (format === 'csv')
    return {
      fileName,
      contentType: 'text/csv; charset=utf-8',
      body: Buffer.from(
        toCsv([
          headers,
          ...rows.map((row) => TEMPLATE_FIELDS.map((field) => row[field])),
        ]),
        'utf8',
      ),
    };

  const sheet = utils.aoa_to_sheet([
    headers,
    ...rows.map((row) =>
      TEMPLATE_FIELDS.map((field) => xlsxCell(field, row[field])),
    ),
  ]);
  sheet['!cols'] = TEMPLATE_FIELDS.map(() => ({ wch: 20 }));
  const book = utils.book_new();
  utils.book_append_sheet(book, sheet, locale === 'ar' ? 'الطلبات' : 'Orders');
  if (locale === 'ar') book.Workbook = { Views: [{ RTL: true }] };
  return {
    fileName,
    contentType:
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    body: write(book, {
      type: 'buffer',
      bookType: 'xlsx',
      compression: true,
    }) as Buffer,
  };
}
