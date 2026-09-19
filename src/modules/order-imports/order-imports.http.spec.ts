import {
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
import { OrderImportsController } from './order-imports.controller';
import { orderImportMulterOptions } from './order-imports.module';
import { OrderImportsService } from './order-imports.service';
import { ImportFileParser } from './parsers/import-file-parser';

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
  };
  const integrations = { findActiveByOrg: jest.fn() };
  const resolver = new StandaloneSourceResolver(integrations as never);
  const repository = {
    listOpenDrafts: jest.fn(),
    createDraftWithRows: jest.fn(),
    discardDraft: jest.fn(),
  };

  const fakeAuth: CanActivate = {
    canActivate(context: ExecutionContext) {
      context.switchToHttp().getRequest<{ user: AuthenticatedUser }>().user =
        currentUser;
      return true;
    },
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
});
