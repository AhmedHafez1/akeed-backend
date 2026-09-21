import {
  ValidationPipe,
  type CanActivate,
  type ExecutionContext,
  type INestApplication,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { ThrottlerModule } from '@nestjs/throttler';
import type { Server } from 'node:http';
import request from 'supertest';
import { OrderImportsRepository } from '../../infrastructure/database/repositories/order-imports.repository';
import {
  BULK_IMPORT_CONFIG,
  parseBulkImportConfig,
  type BulkImportConfig,
} from '../../shared/config/bulk-import.config';
import {
  DualAuthGuard,
  type AuthenticatedUser,
} from '../auth/guards/dual-auth.guard';
import { StandaloneOrderIngestionService } from '../order-ingestion/standalone-order-ingestion.service';
import { StandaloneSourceResolver } from '../order-ingestion/standalone-source-resolver';
import { MulterModule } from '@nestjs/platform-express';
import { OrderImportAccessGuard } from './guards/order-import-access.guard';
import { OrderImportUploadThrottleGuard } from './guards/order-import-upload-throttle.guard';
import { PhoneService } from '../../shared/services/phone.service';
import { OrderEligibilityService } from '../verification-core/order-eligibility.service';
import { StandaloneOrderEligibilityStrategy } from '../../infrastructure/spokes/standalone/services/standalone-order-eligibility.strategy';
import { OrderImportCommitProducer } from './order-import-commit.producer';
import { OrderImportCommitService } from './order-import-commit.service';
import { OrderImportDetailService } from './order-import-detail.service';
import { OrderImportMappingService } from './order-import-mapping.service';
import { OrderImportRowsService } from './order-import-rows.service';
import { OrderImportsController } from './order-imports.controller';
import { OrderImportReleaseService } from './release/order-import-release.service';
import { OrderImportReleaseRepository } from '../../infrastructure/database/repositories/order-import-release.repository';
import { OrdersRepository } from '../../infrastructure/database/repositories/orders.repository';
import { orderImportMulterOptions } from './order-imports.module';
import { OrderImportsService } from './order-imports.service';
import { ImportFileParser } from './parsers/import-file-parser';
import { RowValidationService } from './validation/row-validation.service';

const FIVE_MB = 5 * 1024 * 1024;

/**
 * The upload route over real HTTP: multer limits, guard order, the throttle
 * and the worker parser are all the production ones. Authentication and the
 * database are faked, so the test proves what reaches the repository.
 */
describe('order-import routes over HTTP', () => {
  jest.setTimeout(60_000);

  let app: INestApplication;
  const server = () => app.getHttpServer() as Server;
  let bulkImport: BulkImportConfig;
  let currentUser: AuthenticatedUser;
  const standalone = {
    id: 'int-1',
    orgId: 'org-1',
    platformType: 'standalone',
    onboardingStatus: 'completed',
    timezone: 'Africa/Cairo',
    assumeCodWhenPaymentMissing: false,
  };
  const integrations = { findActiveByOrg: jest.fn() };
  const resolver = new StandaloneSourceResolver(integrations as never);
  const repository = {
    listOpenDrafts: jest.fn(),
    createDraftWithRows: jest.fn(),
    discardDraft: jest.fn(),
    findMappingProfile: jest.fn(),
    findBatchForMapping: jest.fn(),
    columnValueCounts: jest.fn(),
    saveMapping: jest.fn(),
    readCounts: jest.fn(),
    findBatchForValidation: jest.fn(),
    listRowsForValidation: jest.fn(),
    writeValidation: jest.fn(),
    findOrdersByExternalIds: jest.fn(),
    findRecentOrdersByPhones: jest.fn(),
    findRecentOrdersByOrderNumbers: jest.fn(),
    pageRows: jest.fn(),
    findRow: jest.fn(),
    setIncludeOverride: jest.fn(),
    findBatchDetail: jest.fn(),
    readSampleRows: jest.fn(),
    countRowsWithIssue: jest.fn(),
    findRecentDuplicate: jest.fn(),
    findBatchForCommit: jest.fn(),
    findBatchByCommitKey: jest.fn(),
    claimForCommit: jest.fn(),
  };

  const commitProducer = { enqueue: jest.fn() };

  const fakeAuth: CanActivate = {
    canActivate(context: ExecutionContext) {
      context.switchToHttp().getRequest<{ user: AuthenticatedUser }>().user =
        currentUser;
      return true;
    },
  };

  const releases = {
    holdCounts: jest.fn(),
  };
  const ordersRepository = {
    countLifecycleByImportBatch: jest.fn(),
  };
  const release = {
    quote: jest.fn(),
    start: jest.fn(),
    stop: jest.fn(),
    resume: jest.fn(),
  };

  beforeAll(async () => {
    // The module's own controller, guards, parser and multer options, without
    // the database and auth modules behind them.
    const moduleRef = await Test.createTestingModule({
      imports: [
        ThrottlerModule.forRoot({ throttlers: [{ ttl: 60_000, limit: 60 }] }),
        MulterModule.register(
          orderImportMulterOptions(parseBulkImportConfig({})),
        ),
      ],
      controllers: [OrderImportsController],
      providers: [
        OrderImportsService,
        OrderImportMappingService,
        OrderImportDetailService,
        OrderImportRowsService,
        OrderImportCommitService,
        RowValidationService,
        PhoneService,
        {
          provide: OrderEligibilityService,
          useValue: new OrderEligibilityService([
            new StandaloneOrderEligibilityStrategy(),
          ]),
        },
        ImportFileParser,
        OrderImportAccessGuard,
        OrderImportUploadThrottleGuard,
        {
          provide: ConfigService,
          useValue: {
            get: (key: string) =>
              key === BULK_IMPORT_CONFIG ? bulkImport : undefined,
          },
        },
        { provide: OrderImportsRepository, useValue: repository },
        { provide: OrderImportReleaseRepository, useValue: releases },
        { provide: OrdersRepository, useValue: ordersRepository },
        { provide: OrderImportReleaseService, useValue: release },
        { provide: OrderImportCommitProducer, useValue: commitProducer },
        {
          provide: StandaloneOrderIngestionService,
          useValue: {
            resolveWritableSource: (user: AuthenticatedUser, codes: never) =>
              resolver.resolveWritable(user, codes),
          },
        },
      ],
    })
      .overrideGuard(DualAuthGuard)
      .useValue(fakeAuth)
      .compile();
    app = moduleRef.createNestApplication();
    // The app-wide pipe from main.ts, so route pipes are tested behind it.
    app.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        transform: true,
        forbidNonWhitelisted: false,
      }),
    );
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  let userCounter = 0;
  beforeEach(() => {
    jest.clearAllMocks();
    bulkImport = parseBulkImportConfig({
      STANDALONE_BULK_IMPORT_ENABLED: 'true',
      BULK_IMPORT_QUOTE_SECRET: 'test-quote-secret-0123456789abcdef',
    });
    // A fresh user per test keeps the per-user upload throttle independent.
    currentUser = {
      userId: `user-${++userCounter}`,
      orgId: 'org-1',
      role: 'owner',
      source: 'supabase',
    };
    integrations.findActiveByOrg.mockResolvedValue([standalone]);
    repository.listOpenDrafts.mockResolvedValue([]);
    repository.findMappingProfile.mockResolvedValue(null);
    repository.createDraftWithRows.mockResolvedValue({
      batchId: '5f1c6f7e-6d7a-4a53-9c6e-0d9b1c2e3f40',
      shortCode: 'ABC123',
      createdAt: '2026-09-19T09:00:00.000Z',
      duplicateFileOf: null,
    });
  });

  const csv = Buffer.from('order_id,name\r\nA-1,أحمد\r\n', 'utf8');
  const upload = (body: Buffer = csv, fileName = 'طلبات.csv', field = 'file') =>
    request(server()).post('/api/order-imports').attach(field, body, fileName);

  it('accepts an owner upload and answers 201 with the draft', async () => {
    const response = await upload();
    expect(response.status).toBe(201);
    expect(response.body).toMatchObject({
      batchId: '5f1c6f7e-6d7a-4a53-9c6e-0d9b1c2e3f40',
      status: 'draft',
      fileName: 'طلبات.csv',
      format: 'csv',
      headers: ['order_id', 'name'],
      rowCount: 1,
    });
    expect(repository.createDraftWithRows).toHaveBeenCalledTimes(1);
  });

  it.each([
    [
      'the flag is off',
      () => {
        bulkImport = { ...bulkImport, enabled: false };
      },
      403,
      'IMPORT_DISABLED',
    ],
    [
      'the caller is a viewer',
      () => {
        currentUser = { ...currentUser, role: 'viewer' };
      },
      403,
      'IMPORT_ROLE_REQUIRED',
    ],
    [
      'the store is Shopify',
      () => {
        integrations.findActiveByOrg.mockResolvedValue([
          { ...standalone, platformType: 'shopify' },
        ]);
      },
      403,
      'IMPORT_SOURCE_UNSUPPORTED',
    ],
    [
      'onboarding is not completed',
      () => {
        integrations.findActiveByOrg.mockResolvedValue([
          { ...standalone, onboardingStatus: 'pending' },
        ]);
      },
      409,
      'IMPORT_SETUP_INCOMPLETE',
    ],
  ])(
    'refuses before reading the body when %s',
    async (_label, arrange, status, code) => {
      arrange();
      const response = await upload();
      expect(response.status).toBe(status);
      expect(response.body).toMatchObject({ statusCode: status, code });
      // The gate runs before the multipart interceptor, so nothing downstream ran.
      expect(repository.listOpenDrafts).not.toHaveBeenCalled();
      expect(repository.createDraftWithRows).not.toHaveBeenCalled();
    },
  );

  it('accepts exactly 5 MB and refuses 5 MB + 1 byte with IMPORT_FILE_TOO_LARGE', async () => {
    // 5,000 rows of four 255-character cells, padded to exactly 5 MB.
    const row = ['a', 'b', 'c', 'd']
      .map((letter) => letter.repeat(255))
      .join(',');
    let text = `h1,h2,h3,h4\r\n${Array.from({ length: 5_000 }, () => row).join('\r\n')}`;
    text += ' '.repeat(FIVE_MB - Buffer.byteLength(text));
    const exact = Buffer.from(text, 'utf8');
    expect(exact.length).toBe(FIVE_MB);

    const accepted = await upload(exact, 'exact.csv');
    expect(accepted.status).toBe(201);
    expect(accepted.body).toMatchObject({ rowCount: 5_000 });

    const tooLarge = await upload(
      Buffer.concat([exact, Buffer.from(' ')]),
      'big.csv',
    );
    expect(tooLarge.status).toBe(413);
    expect(tooLarge.body).toMatchObject({
      statusCode: 413,
      code: 'IMPORT_FILE_TOO_LARGE',
    });
    expect(repository.createDraftWithRows).toHaveBeenCalledTimes(1);
  });

  it('refuses a request without a file', async () => {
    const response = await request(server())
      .post('/api/order-imports')
      .field('note', 'no file');
    expect(response.status).toBe(400);
    expect(response.body).toMatchObject({ code: 'IMPORT_FILE_REQUIRED' });
  });

  it.each([
    [
      'a file under another field name',
      (r: request.Test) => r.attach('upload', csv, 'a.csv'),
    ],
    [
      'two files',
      (r: request.Test) =>
        r.attach('file', csv, 'a.csv').attach('file', csv, 'b.csv'),
    ],
  ])('refuses %s', async (_label, attach) => {
    const response = await attach(request(server()).post('/api/order-imports'));
    expect(response.status).toBe(400);
    expect(response.body).toMatchObject({ code: 'IMPORT_FILE_REQUIRED' });
    expect(repository.createDraftWithRows).not.toHaveBeenCalled();
  });

  it('refuses an upload cut off mid-body without creating a batch', async () => {
    const boundary = 'akeed-boundary';
    const response = await request(server())
      .post('/api/order-imports')
      .set('Content-Type', `multipart/form-data; boundary=${boundary}`)
      .send(
        `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="a.csv"\r\n` +
          'Content-Type: text/csv\r\n\r\norder_id,name\r\nA-1,Al',
      );
    expect(response.status).toBe(400);
    expect(response.body).toMatchObject({ code: 'IMPORT_FILE_REQUIRED' });
    expect(repository.createDraftWithRows).not.toHaveBeenCalled();
  });

  it('refuses a protected workbook by content, whatever its name', async () => {
    const response = await upload(
      Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1, 0]),
      'orders.csv',
    );
    expect(response.status).toBe(422);
    expect(response.body).toMatchObject({ code: 'IMPORT_FILE_UNREADABLE' });
    expect(repository.createDraftWithRows).not.toHaveBeenCalled();
  });

  it('allows 10 uploads a minute per user and answers the 11th with IMPORT_RATE_LIMITED', async () => {
    for (let attempt = 0; attempt < 10; attempt++)
      expect((await upload()).status).toBe(201);
    const limited = await upload();
    expect(limited.status).toBe(429);
    expect(limited.body).toMatchObject({
      statusCode: 429,
      code: 'IMPORT_RATE_LIMITED',
    });
    expect(limited.headers['retry-after']).toBeDefined();

    currentUser = { ...currentUser, userId: 'someone-else' };
    expect((await upload()).status).toBe(201);
  });

  describe('DELETE /api/order-imports/:id', () => {
    it('discards a draft with 204', async () => {
      repository.discardDraft.mockResolvedValue({ outcome: 'discarded' });
      const response = await request(server()).delete(
        '/api/order-imports/5f1c6f7e-6d7a-4a53-9c6e-0d9b1c2e3f40',
      );
      expect(response.status).toBe(204);
      expect(repository.discardDraft).toHaveBeenCalledWith(
        'org-1',
        '5f1c6f7e-6d7a-4a53-9c6e-0d9b1c2e3f40',
      );
    });

    it('answers 404 for a malformed id without touching the database', async () => {
      const response = await request(server()).delete(
        '/api/order-imports/not-a-uuid',
      );
      expect(response.status).toBe(404);
      expect(response.body).toMatchObject({ code: 'IMPORT_BATCH_NOT_FOUND' });
      expect(repository.discardDraft).not.toHaveBeenCalled();
    });

    it('refuses a viewer', async () => {
      currentUser = { ...currentUser, role: 'viewer' };
      const response = await request(server()).delete(
        '/api/order-imports/5f1c6f7e-6d7a-4a53-9c6e-0d9b1c2e3f40',
      );
      expect(response.status).toBe(403);
      expect(response.body).toMatchObject({ code: 'IMPORT_ROLE_REQUIRED' });
    });
  });

  describe('GET /api/order-imports/template', () => {
    it('downloads the Arabic workbook, uncached, for any member', async () => {
      currentUser = { ...currentUser, role: 'viewer' };
      const response = await request(server())
        .get('/api/order-imports/template?format=xlsx&locale=ar')
        .buffer(true)
        .parse((res, callback) => {
          const chunks: Buffer[] = [];
          res.on('data', (chunk: Buffer) => chunks.push(chunk));
          res.on('end', () => callback(null, Buffer.concat(chunks)));
        });
      expect(response.status).toBe(200);
      expect(response.headers['content-type']).toContain('spreadsheetml');
      expect(response.headers['content-disposition']).toBe(
        'attachment; filename="akeed-orders-template-ar.xlsx"',
      );
      expect(response.headers['cache-control']).toBe('no-store');
      expect((response.body as Buffer).subarray(0, 2).toString()).toBe('PK');
    });

    it('is hidden while the flag is off', async () => {
      bulkImport = { ...bulkImport, enabled: false };
      const response = await request(server()).get(
        '/api/order-imports/template',
      );
      expect(response.status).toBe(403);
      expect(response.body).toMatchObject({ code: 'IMPORT_DISABLED' });
    });
  });

  it('answers the upload with the detected mapping', async () => {
    const response = await upload(
      Buffer.from('Order #,Customer Name,Mobile,Total\r\n#1,أحمد,010,50\r\n'),
    );
    expect(response.status).toBe(201);
    const body = response.body as {
      suggestions: { fields: { field: string; columns: string[] }[] };
    };
    expect(
      Object.fromEntries(
        body.suggestions.fields.map((field) => [field.field, field.columns]),
      ),
    ).toMatchObject({
      orderReference: ['Order #'],
      customerName: ['Customer Name'],
      phone: ['Mobile'],
      amount: ['Total'],
    });
  });

  describe('PUT /api/order-imports/:id/mapping', () => {
    const batchId = '5f1c6f7e-6d7a-4a53-9c6e-0d9b1c2e3f40';
    const body = {
      mapping: { phone: 'phone', customerName: ['name'], amount: 'total' },
      options: { country: 'eg', defaultCurrency: 'egp', dateFormat: 'auto' },
    };
    const put = (payload: unknown = body) =>
      request(server())
        .put(`/api/order-imports/${batchId}/mapping`)
        .send(payload as object);

    beforeEach(() => {
      repository.findBatchForMapping.mockResolvedValue({
        status: 'draft',
        expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
        headers: ['phone', 'name', 'total'],
        mapping: null,
      });
      repository.saveMapping.mockResolvedValue({
        outcome: 'saved',
        mappingProfileId: 'profile-1',
      });
      repository.readCounts.mockResolvedValue({});
      repository.findBatchForValidation.mockResolvedValue({
        status: 'draft',
        expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
        integrationId: 'int-1',
        mapping: {
          confirmed: true,
          columns: {
            phone: 'phone',
            customerName: ['name'],
            amount: 'total',
            orderReference: null,
            currency: null,
            paymentMethod: null,
            orderDate: null,
            city: null,
            address: null,
            notes: null,
          },
        },
        options: {
          country: 'EG',
          defaultCurrency: 'EGP',
          dateFormat: 'auto',
          paymentValueMap: {},
        },
      });
      repository.listRowsForValidation.mockResolvedValue([
        {
          rowNumber: 2,
          raw: { phone: '1012345678', name: 'Ahmed', total: '750' },
          issues: [],
          includeOverride: false,
        },
      ]);
      repository.findOrdersByExternalIds.mockResolvedValue([]);
      repository.findRecentOrdersByPhones.mockResolvedValue([]);
      repository.findRecentOrdersByOrderNumbers.mockResolvedValue([]);
      repository.writeValidation.mockResolvedValue('saved');
    });

    it('validates the rows after saving, with the session source', async () => {
      const response = await put();
      expect(response.status).toBe(200);
      expect(repository.findBatchForValidation).toHaveBeenCalledWith(
        'org-1',
        batchId,
      );
      expect(repository.writeValidation).toHaveBeenCalledWith(
        expect.objectContaining({
          orgId: 'org-1',
          batchId,
          validationVersion: 1,
          rows: [
            expect.objectContaining({
              rowNumber: 2,
              normalized: expect.objectContaining({
                customerPhone: '+201012345678',
                totalPrice: '750.00',
                currency: 'EGP',
              }) as unknown,
              outcome: 'excluded',
              issues: [
                {
                  code: 'PAYMENT_UNKNOWN_EXCLUDED',
                  field: 'paymentMethod',
                },
              ],
            }),
          ],
        }),
      );
    });

    it('saves the mapping for an owner and answers 200', async () => {
      const response = await put();
      expect(response.status).toBe(200);
      expect(response.body).toMatchObject({
        batchId,
        status: 'draft',
        mapping: { phone: 'phone', customerName: ['name'], amount: 'total' },
        options: { country: 'EG', defaultCurrency: 'EGP', dateFormat: 'auto' },
        mappingProfileId: 'profile-1',
      });
      expect(repository.findBatchForMapping).toHaveBeenCalledWith(
        'org-1',
        batchId,
      );
    });

    it('refuses a viewer before reading the batch', async () => {
      currentUser = { ...currentUser, role: 'viewer' };
      const response = await put();
      expect(response.status).toBe(403);
      expect(response.body).toMatchObject({ code: 'IMPORT_ROLE_REQUIRED' });
      expect(repository.findBatchForMapping).not.toHaveBeenCalled();
    });

    it("answers 404 for another organization's batch", async () => {
      repository.findBatchForMapping.mockResolvedValue(null);
      const response = await put();
      expect(response.status).toBe(404);
      expect(response.body).toMatchObject({ code: 'IMPORT_BATCH_NOT_FOUND' });
      expect(repository.saveMapping).not.toHaveBeenCalled();
    });

    it.each([
      [
        'an unsupported currency',
        { ...body, options: { ...body.options, defaultCurrency: 'XYZ' } },
        'options.defaultCurrency',
      ],
      ['an unknown property', { ...body, extra: true }, 'extra'],
      [
        'a bad date format',
        { ...body, options: { ...body.options, dateFormat: 'DD/MM' } },
        'options.dateFormat',
      ],
      [
        'three name columns',
        {
          ...body,
          mapping: { ...body.mapping, customerName: ['a', 'b', 'c'] },
        },
        'mapping.customerName',
      ],
      [
        'a payment choice that is neither cod nor not_cod',
        {
          ...body,
          options: { ...body.options, paymentValueMap: { cod: 'maybe' } },
        },
        'options.paymentValueMap',
      ],
      ['a missing options object', { mapping: body.mapping }, 'options'],
    ])(
      'answers IMPORT_VALIDATION_FAILED for %s',
      async (_label, payload, field) => {
        const response = await put(payload);
        expect(response.status).toBe(400);
        expect(response.body).toMatchObject({
          code: 'IMPORT_VALIDATION_FAILED',
        });
        expect(
          (response.body as { fieldErrors: Record<string, string> })
            .fieldErrors,
        ).toHaveProperty([field]);
        expect(repository.findBatchForMapping).not.toHaveBeenCalled();
      },
    );

    it('answers IMPORT_MAPPING_INCOMPLETE with 422 for a missing required field', async () => {
      const response = await put({
        ...body,
        mapping: { ...body.mapping, amount: null },
      });
      expect(response.status).toBe(422);
      expect(response.body).toMatchObject({
        code: 'IMPORT_MAPPING_INCOMPLETE',
        fieldErrors: { amount: expect.any(String) as string },
      });
    });

    it('answers IMPORT_BATCH_EXPIRED with 410 for an expired draft', async () => {
      repository.findBatchForMapping.mockResolvedValue({
        status: 'draft',
        expiresAt: new Date(Date.now() - 1_000).toISOString(),
        headers: ['phone', 'name', 'total'],
        mapping: null,
      });
      const response = await put();
      expect(response.status).toBe(410);
      expect(response.body).toMatchObject({ code: 'IMPORT_BATCH_EXPIRED' });
    });
  });

  describe('rows', () => {
    const batchId = '5f1c6f7e-6d7a-4a53-9c6e-0d9b1c2e3f40';
    const draft = {
      status: 'draft',
      expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
      headers: ['phone', 'name'],
      mapping: {
        columns: {
          phone: 'phone',
          customerName: ['name'],
          amount: null,
          orderReference: null,
          currency: null,
          paymentMethod: null,
          orderDate: null,
          city: null,
          address: null,
          notes: null,
        },
      },
    };
    const stored = (rowNumber: number) => ({
      rowNumber,
      raw: { phone: '010', name: 'Ahmed', ignored: 'x' },
      normalized: { paymentMethod: '' },
      outcome: 'excluded',
      issues: [{ code: 'POSSIBLE_DUPLICATE', params: { orderNumber: '#1' } }],
      includeOverride: false,
      collapsedInto: null,
    });

    beforeEach(() => {
      repository.findBatchForMapping.mockResolvedValue(draft);
    });

    it('pages rows in row order with the mapped raw cells', async () => {
      repository.pageRows.mockResolvedValue([stored(2), stored(3), stored(4)]);
      const response = await request(server()).get(
        `/api/order-imports/${batchId}/rows?outcome=excluded&limit=2`,
      );
      expect(response.status).toBe(200);
      const body = response.body as {
        rows: { rowNumber: number; raw: unknown }[];
        nextCursor: string;
      };
      expect(body.rows.map((row) => row.rowNumber)).toEqual([2, 3]);
      expect(body.rows[0].raw).toEqual({ phone: '010', customerName: 'Ahmed' });
      expect(repository.pageRows).toHaveBeenCalledWith({
        orgId: 'org-1',
        batchId,
        outcome: 'excluded',
        afterRowNumber: 0,
        limit: 3,
      });

      await request(server()).get(
        `/api/order-imports/${batchId}/rows?cursor=${body.nextCursor}`,
      );
      expect(repository.pageRows).toHaveBeenLastCalledWith(
        expect.objectContaining({ afterRowNumber: 3, limit: 51 }),
      );
    });

    it('lets a viewer read rows', async () => {
      currentUser = { ...currentUser, role: 'viewer' };
      repository.pageRows.mockResolvedValue([]);
      const response = await request(server()).get(
        `/api/order-imports/${batchId}/rows`,
      );
      expect(response.status).toBe(200);
      expect(response.body).toEqual({ rows: [], nextCursor: null });
    });

    it.each([
      ['limit=101', 'limit'],
      ['limit=0', 'limit'],
      ['outcome=pending', 'outcome'],
      ['cursor=!!', 'cursor'],
    ])('answers IMPORT_VALIDATION_FAILED for %s', async (query, field) => {
      const response = await request(server()).get(
        `/api/order-imports/${batchId}/rows?${query}`,
      );
      expect(response.status).toBe(400);
      expect(response.body).toMatchObject({
        code: 'IMPORT_VALIDATION_FAILED',
        fieldErrors: { [field]: expect.any(String) as unknown },
      });
    });

    it("answers 404 for another organization's batch", async () => {
      repository.findBatchForMapping.mockResolvedValue(null);
      const response = await request(server()).get(
        `/api/order-imports/${batchId}/rows`,
      );
      expect(response.status).toBe(404);
      expect(repository.pageRows).not.toHaveBeenCalled();
    });

    const patch = (payload: unknown = { include: true }, rowNumber = '2') =>
      request(server())
        .patch(`/api/order-imports/${batchId}/rows/${rowNumber}`)
        .send(payload as object);

    it('includes a possible duplicate and answers the row and counts', async () => {
      repository.setIncludeOverride.mockImplementation(
        (input: { decide: (row: unknown) => string | null }) =>
          Promise.resolve({
            outcome: input.decide(stored(2)) === 'ready' ? 'saved' : 'x',
          }),
      );
      repository.findRow.mockResolvedValue({
        ...stored(2),
        outcome: 'ready',
        includeOverride: true,
      });
      repository.readCounts.mockResolvedValue({ ready: 1 });
      const response = await patch();
      expect(response.status).toBe(200);
      expect(response.body).toMatchObject({
        row: { rowNumber: 2, outcome: 'ready', includeOverride: true },
        counts: { ready: 1 },
      });
    });

    it('refuses to include any other row with IMPORT_BATCH_STATE_CONFLICT', async () => {
      repository.setIncludeOverride.mockImplementation(
        (input: { decide: (row: unknown) => string | null }) =>
          Promise.resolve({
            outcome:
              input.decide({
                ...stored(2),
                issues: [{ code: 'ORDER_TOO_OLD' }],
              }) === null
                ? 'not_includable'
                : 'saved',
          }),
      );
      const response = await patch();
      expect(response.status).toBe(409);
      expect(response.body).toMatchObject({
        code: 'IMPORT_BATCH_STATE_CONFLICT',
      });
    });

    it('refuses a viewer', async () => {
      currentUser = { ...currentUser, role: 'viewer' };
      const response = await patch();
      expect(response.status).toBe(403);
      expect(repository.setIncludeOverride).not.toHaveBeenCalled();
    });

    it('refuses a committed batch', async () => {
      repository.findBatchForMapping.mockResolvedValue({
        ...draft,
        status: 'committing',
      });
      const response = await patch();
      expect(response.status).toBe(409);
      expect(repository.setIncludeOverride).not.toHaveBeenCalled();
    });

    it.each([
      [{ include: 'yes' }, '2', 'include'],
      [{}, '2', 'include'],
      [{ include: true }, 'two', 'rowNumber'],
    ])(
      'answers IMPORT_VALIDATION_FAILED for %j on row %s',
      async (payload, row, field) => {
        const response = await patch(payload, row);
        expect(response.status).toBe(400);
        expect(response.body).toMatchObject({
          code: 'IMPORT_VALIDATION_FAILED',
          fieldErrors: { [field]: expect.any(String) as unknown },
        });
      },
    );
  });
  describe('GET /api/order-imports and /:id (US-04.6-05)', () => {
    const batchId = '5f1c6f7e-6d7a-4a53-9c6e-0d9b1c2e3f40';
    const columns = {
      phone: 'Mobile',
      customerName: ['Customer Name'],
      amount: 'Total',
      orderReference: null,
      currency: null,
      paymentMethod: 'Payment',
      orderDate: 'Date',
      city: null,
      address: null,
      notes: null,
    };
    const batch = (overrides: Record<string, unknown> = {}) => ({
      batchId,
      shortCode: 'ABC123',
      status: 'draft',
      fileName: 'orders.csv',
      fileFormat: 'csv',
      fileSha256: 'a'.repeat(64),
      rowCount: 2,
      headers: ['Mobile', 'Customer Name', 'Total', 'Payment', 'Date', 'Note'],
      mapping: {
        dictionaryVersion: 1,
        confirmed: true,
        columns,
        sources: {
          phone: 'auto',
          customerName: 'auto',
          amount: 'merchant',
          orderReference: 'none',
          currency: 'none',
          paymentMethod: 'saved',
          orderDate: 'auto',
          city: 'none',
          address: 'none',
          notes: 'none',
        },
      },
      options: {
        country: 'EG',
        defaultCurrency: 'EGP',
        dateFormat: 'DMY',
        paymentValueMap: { cash: 'cod' },
      },
      counts: { total: 2, ready: 1, invalid: 0, duplicate: 0, excluded: 1 },
      orderDateMin: '2026-09-12',
      orderDateMax: '2026-09-18',
      createdAt: '2026-09-19T09:00:00.000Z',
      expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
      ...overrides,
    });

    beforeEach(() => {
      repository.findBatchDetail.mockResolvedValue(batch());
      repository.readSampleRows.mockResolvedValue([
        {
          rowNumber: 2,
          raw: {
            Mobile: '01012345678',
            'Customer Name': 'Ahmed Ali',
            Total: '750',
            Payment: 'Cash',
            Date: '05/06/2026',
            Note: '',
          },
          issues: [],
        },
      ]);
      repository.countRowsWithIssue.mockResolvedValue(3);
      repository.findRecentDuplicate.mockResolvedValue(null);
      repository.columnValueCounts.mockImplementation(
        (_org: string, _batch: string, column: string) =>
          Promise.resolve(
            column === 'Payment'
              ? [{ value: 'Cash', count: 2 }]
              : [{ value: '05/06/2026', count: 2 }],
          ),
      );
    });

    const get = (id = batchId) =>
      request(server()).get(`/api/order-imports/${id}`);

    it('answers the stored mapping, counts and banners for an owner', async () => {
      const response = await get();
      expect(response.status).toBe(200);
      const body = response.body as {
        suggestions: {
          fields: { field: string; columns: string[]; source: string }[];
          unmappedColumns: string[];
        };
      };
      expect(response.body).toMatchObject({
        batchId,
        status: 'draft',
        mappingConfirmed: true,
        rowCount: 2,
        headers: batch().headers,
        counts: { ready: 1, excluded: 1 },
        orderDateMin: '2026-09-12',
        orderDateMax: '2026-09-18',
        oldOrderCount: 3,
        options: { dateFormat: 'DMY' },
        paymentValues: {
          column: 'Payment',
          values: [
            expect.objectContaining({
              normalizedValue: 'cash',
              classification: 'cod',
              count: 2,
            }) as unknown,
          ],
        },
        dateFormat: { column: 'Date', ambiguous: true },
        sampleRows: [expect.objectContaining({ rowNumber: 2 }) as unknown],
        permissions: { canEdit: true },
      });
      expect(response.body).not.toHaveProperty('duplicateFileOf');
      const fields = Object.fromEntries(
        body.suggestions.fields.map((field) => [field.field, field]),
      );
      expect(fields.amount).toMatchObject({
        columns: ['Total'],
        source: 'merchant',
      });
      expect(fields.paymentMethod).toMatchObject({ source: 'saved' });
      expect(fields.city).toMatchObject({ columns: [], source: 'none' });
      expect(body.suggestions.unmappedColumns).toEqual(['Note']);
      expect(repository.findBatchDetail).toHaveBeenCalledWith('org-1', batchId);
      expect(repository.countRowsWithIssue).toHaveBeenCalledWith(
        'org-1',
        batchId,
        'ORDER_TOO_OLD',
      );
    });

    it('lets a viewer read the batch without edit permission', async () => {
      currentUser = { ...currentUser, role: 'viewer' };
      const response = await get();
      expect(response.status).toBe(200);
      expect(response.body).toMatchObject({ permissions: { canEdit: false } });
    });

    it('reports an earlier upload of the same file', async () => {
      repository.findRecentDuplicate.mockResolvedValue({
        batchId: '6f1c6f7e-6d7a-4a53-9c6e-0d9b1c2e3f41',
        createdAt: '2026-09-19T08:50:00.000Z',
        status: 'draft',
      });
      const response = await get();
      expect(response.body).toMatchObject({
        duplicateFileOf: { batchId: '6f1c6f7e-6d7a-4a53-9c6e-0d9b1c2e3f41' },
      });
      expect(repository.findRecentDuplicate).toHaveBeenCalledWith(
        'org-1',
        'a'.repeat(64),
        new Date('2026-09-18T09:00:00.000Z'),
        undefined,
        { batchId, createdAt: '2026-09-19T09:00:00.000Z' },
      );
    });

    it('reads a draft past its expiry as expired', async () => {
      repository.findBatchDetail.mockResolvedValue(
        batch({ expiresAt: new Date(Date.now() - 1_000).toISOString() }),
      );
      const response = await get();
      expect(response.status).toBe(200);
      expect(response.body).toMatchObject({ status: 'expired' });
    });

    it('describes an unconfirmed suggestion as not yet confirmed', async () => {
      repository.findBatchDetail.mockResolvedValue(
        batch({ mapping: { ...batch().mapping, confirmed: false } }),
      );
      const response = await get();
      expect(response.body).toMatchObject({ mappingConfirmed: false });
    });

    it('answers 404 for a batch of another organization or a malformed id', async () => {
      repository.findBatchDetail.mockResolvedValue(null);
      const missing = await get();
      expect(missing.status).toBe(404);
      expect(missing.body).toMatchObject({ code: 'IMPORT_BATCH_NOT_FOUND' });
      const malformed = await get('not-a-uuid');
      expect(malformed.status).toBe(404);
      expect(repository.findBatchDetail).toHaveBeenCalledTimes(1);
    });

    it('is hidden while the flag is off', async () => {
      bulkImport = { ...bulkImport, enabled: false };
      const detail = await get();
      const list = await request(server()).get(
        '/api/order-imports?status=draft',
      );
      expect(detail.status).toBe(403);
      expect(list.status).toBe(403);
      expect(list.body).toMatchObject({ code: 'IMPORT_DISABLED' });
    });

    it('lists the open drafts with the caller permission', async () => {
      const draft = {
        batchId,
        fileName: 'orders.csv',
        rowCount: 2,
        createdAt: '2026-09-19T09:00:00.000Z',
        expiresAt: '2026-09-20T09:00:00.000Z',
      };
      repository.listOpenDrafts.mockResolvedValue([draft]);
      currentUser = { ...currentUser, role: 'viewer' };
      const response = await request(server()).get(
        '/api/order-imports?status=draft',
      );
      expect(response.status).toBe(200);
      expect(response.body).toEqual({
        drafts: [draft],
        permissions: { canEdit: false },
      });
      expect(repository.listOpenDrafts).toHaveBeenCalledWith(
        'org-1',
        expect.any(Date),
      );
    });

    it('refuses any list but open drafts until the history exists', async () => {
      const response = await request(server()).get('/api/order-imports');
      expect(response.status).toBe(400);
      expect(response.body).toMatchObject({
        code: 'IMPORT_VALIDATION_FAILED',
        fieldErrors: { status: expect.any(String) as unknown },
      });
    });
  });

  /**
   * Commit is the one request a merchant is most likely to send twice: a
   * double-click, a refresh, a retry after a timeout. Every one of those must
   * reach the same batch and the same job.
   */
  describe('POST /api/order-imports/:id/commit', () => {
    const batchId = '5f1c6f7e-6d7a-4a53-9c6e-0d9b1c2e3f40';
    const key = `commit-${batchId}`;
    const commitBatch = (overrides: Record<string, unknown> = {}) => ({
      id: batchId,
      status: 'draft',
      expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
      integrationId: 'int-1',
      shortCode: 'ABC123',
      platformStoreUrl: 'store-1.akeed.local',
      mapping: { confirmed: true },
      counts: { total: 2, ready: 1 },
      commitIdempotencyKey: null,
      ...overrides,
    });

    beforeEach(() => {
      repository.findBatchForCommit.mockResolvedValue(commitBatch());
      repository.findBatchByCommitKey.mockResolvedValue(null);
      repository.claimForCommit.mockResolvedValue('claimed');
      // `detail()` answers the 202 body from the ordinary read path.
      repository.findBatchDetail.mockResolvedValue({
        batchId,
        shortCode: 'ABC123',
        status: 'committing',
        fileName: 'orders.csv',
        fileFormat: 'csv',
        fileSha256: 'a'.repeat(64),
        rowCount: 2,
        headers: ['Mobile'],
        mapping: null,
        options: null,
        counts: { total: 2, ready: 1, readyAtCommit: 1 },
        orderDateMin: null,
        orderDateMax: null,
        createdAt: '2026-09-19T09:00:00.000Z',
        expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
      });
      repository.readSampleRows.mockResolvedValue([]);
      repository.countRowsWithIssue.mockResolvedValue(0);
      repository.findRecentDuplicate.mockResolvedValue(null);
      repository.columnValueCounts.mockResolvedValue([]);
    });

    const commit = (id = batchId, header: string | null = key) => {
      const call = request(server()).post(`/api/order-imports/${id}/commit`);
      return header === null ? call : call.set('Idempotency-Key', header);
    };

    it('claims the draft, enqueues one job and answers 202', async () => {
      const response = await commit();

      expect(response.status).toBe(202);
      expect(repository.claimForCommit).toHaveBeenCalledWith(
        expect.objectContaining({ orgId: 'org-1', batchId, key }),
      );
      expect(commitProducer.enqueue).toHaveBeenCalledWith({
        batchId,
        orgId: 'org-1',
      });
      expect((response.body as { status: string }).status).toBe('committing');
    });

    it('replays the same key without enqueuing a second job', async () => {
      // The double-click: the batch has already moved to `committing`, so the
      // conditional update never fires again.
      repository.findBatchForCommit.mockResolvedValue(
        commitBatch({ status: 'committing', commitIdempotencyKey: key }),
      );

      const response = await commit();

      expect(response.status).toBe(202);
      expect(repository.claimForCommit).not.toHaveBeenCalled();
      expect(commitProducer.enqueue).not.toHaveBeenCalled();
    });

    it('refuses a different key on a batch that has moved on', async () => {
      // The second tab: it must be told to refresh, not start a rival import.
      repository.findBatchForCommit.mockResolvedValue(
        commitBatch({ status: 'committing', commitIdempotencyKey: key }),
      );

      const response = await commit(batchId, 'commit-from-another-tab');

      expect(response.status).toBe(409);
      expect(response.body).toMatchObject({
        code: 'IMPORT_BATCH_STATE_CONFLICT',
        status: 'committing',
      });
      expect(commitProducer.enqueue).not.toHaveBeenCalled();
    });

    it('refuses a key already used by another batch in the org', async () => {
      repository.findBatchByCommitKey.mockResolvedValue({ id: 'other-batch' });

      const response = await commit();

      expect(response.status).toBe(409);
      expect(response.body).toMatchObject({
        code: 'IMPORT_IDEMPOTENCY_CONFLICT',
      });
      expect(repository.claimForCommit).not.toHaveBeenCalled();
    });

    it('reports a unique violation the pre-check missed as the same conflict', async () => {
      repository.claimForCommit.mockResolvedValue('key_taken');

      const response = await commit();

      expect(response.status).toBe(409);
      expect(response.body).toMatchObject({
        code: 'IMPORT_IDEMPOTENCY_CONFLICT',
      });
      expect(commitProducer.enqueue).not.toHaveBeenCalled();
    });

    it('answers the winner state when a rival claimed between read and update', async () => {
      repository.claimForCommit.mockResolvedValue('not_draft');
      repository.findBatchForCommit
        .mockResolvedValueOnce(commitBatch())
        .mockResolvedValueOnce(
          commitBatch({ status: 'committing', commitIdempotencyKey: key }),
        );

      const response = await commit();

      expect(response.status).toBe(202);
      expect(commitProducer.enqueue).not.toHaveBeenCalled();
    });

    it('refuses a batch with nothing ready', async () => {
      repository.findBatchForCommit.mockResolvedValue(
        commitBatch({ counts: { total: 2, ready: 0 } }),
      );

      const response = await commit();

      expect(response.status).toBe(409);
      expect(response.body).toMatchObject({ code: 'IMPORT_NOTHING_TO_IMPORT' });
      expect(repository.claimForCommit).not.toHaveBeenCalled();
    });

    it('refuses an expired draft', async () => {
      repository.findBatchForCommit.mockResolvedValue(
        commitBatch({ expiresAt: new Date(Date.now() - 1_000).toISOString() }),
      );

      const response = await commit();

      expect(response.status).toBe(410);
      expect(response.body).toMatchObject({ code: 'IMPORT_BATCH_EXPIRED' });
    });

    it('refuses a draft whose mapping was never confirmed', async () => {
      repository.findBatchForCommit.mockResolvedValue(
        commitBatch({ mapping: null }),
      );

      const response = await commit();

      expect(response.status).toBe(422);
      expect(response.body).toMatchObject({
        code: 'IMPORT_MAPPING_INCOMPLETE',
      });
    });

    it.each([
      ['no header', null, 'IMPORT_IDEMPOTENCY_KEY_REQUIRED'],
      ['a short key', 'abc', 'IMPORT_VALIDATION_FAILED'],
      ['a key with spaces', 'not a valid key', 'IMPORT_VALIDATION_FAILED'],
    ])('refuses %s', async (_label, header, code) => {
      const response = await commit(batchId, header);

      expect(response.status).toBe(400);
      expect(response.body).toMatchObject({ code });
      expect(repository.claimForCommit).not.toHaveBeenCalled();
    });

    it('hides another org batch behind the same not-found as an unknown id', async () => {
      repository.findBatchForCommit.mockResolvedValue(null);

      const response = await commit();

      expect(response.status).toBe(404);
      expect(response.body).toMatchObject({ code: 'IMPORT_BATCH_NOT_FOUND' });
    });

    it('refuses a viewer before it reads the batch', async () => {
      currentUser = { ...currentUser, role: 'viewer' };

      const response = await commit();

      expect(response.status).toBe(403);
      expect(repository.findBatchForCommit).not.toHaveBeenCalled();
    });

    it('refuses everyone when the flag is off', async () => {
      bulkImport = parseBulkImportConfig({});

      const response = await commit();

      expect(response.status).toBe(403);
      expect(response.body).toMatchObject({ code: 'IMPORT_DISABLED' });
    });
  });
  describe('start checkpoint routes (US-04.6-07)', () => {
    const batchId = '5f1c6f7e-6d7a-4a53-9c6e-0d9b1c2e3f40';
    const route = (name: string) => `/api/order-imports/${batchId}/${name}`;

    it('serves the quote to an owner with the session source', async () => {
      release.quote.mockResolvedValue({ orders: 3, blockers: [] });

      const response = await request(server()).get(route('start-quote'));

      expect(response.status).toBe(200);
      expect(release.quote).toHaveBeenCalledWith(
        currentUser,
        expect.objectContaining({ id: standalone.id }),
        batchId,
      );
    });

    it('passes the key and the validated body to start and answers 202', async () => {
      release.start.mockResolvedValue({ batchId, status: 'releasing' });

      const response = await request(server())
        .post(route('start'))
        .set('Idempotency-Key', `start-${batchId}`)
        .send({
          attestationVersion: 'bulk-import-consent-v1',
          quoteToken: 'q.t',
        });

      expect(response.status).toBe(202);
      expect(release.start).toHaveBeenCalledWith(
        currentUser,
        expect.objectContaining({ id: standalone.id }),
        batchId,
        `start-${batchId}`,
        { attestationVersion: 'bulk-import-consent-v1', quoteToken: 'q.t' },
      );
    });

    it('answers IMPORT_VALIDATION_FAILED for an unknown body property', async () => {
      const response = await request(server())
        .post(route('start'))
        .set('Idempotency-Key', `start-${batchId}`)
        .send({ attestationVersion: 'bulk-import-consent-v1', orders: 5 });

      expect(response.status).toBe(400);
      expect(response.body).toMatchObject({ code: 'IMPORT_VALIDATION_FAILED' });
      expect(release.start).not.toHaveBeenCalled();
    });

    it('answers stop with the counts and resume with the batch', async () => {
      release.stop.mockResolvedValue({
        batchId,
        status: 'stopped',
        released: 2,
        withdrawn: 1,
      });
      release.resume.mockResolvedValue({ batchId, status: 'releasing' });

      const stopped = await request(server()).post(route('stop'));
      const resumed = await request(server()).post(route('resume'));

      expect(stopped.status).toBe(200);
      expect(stopped.body).toMatchObject({ released: 2, withdrawn: 1 });
      expect(resumed.status).toBe(200);
    });

    it.each([
      ['get', 'start-quote'],
      ['post', 'start'],
      ['post', 'stop'],
      ['post', 'resume'],
    ] as const)('refuses a viewer on %s %s', async (method, name) => {
      currentUser = { ...currentUser, role: 'viewer' };

      const response = await request(server())[method](route(name));

      expect(response.status).toBe(403);
      expect(release.quote).not.toHaveBeenCalled();
      expect(release.start).not.toHaveBeenCalled();
      expect(release.stop).not.toHaveBeenCalled();
      expect(release.resume).not.toHaveBeenCalled();
    });

    it('hides the start routes while the flag is off', async () => {
      bulkImport = parseBulkImportConfig({});

      const response = await request(server()).post(route('start'));

      expect(response.status).toBe(403);
      expect(response.body).toMatchObject({ code: 'IMPORT_DISABLED' });
    });

    it('answers a malformed id with not-found', async () => {
      const response = await request(server()).post(
        '/api/order-imports/not-a-uuid/stop',
      );

      expect(response.status).toBe(404);
      expect(response.body).toMatchObject({ code: 'IMPORT_BATCH_NOT_FOUND' });
    });
  });
});
