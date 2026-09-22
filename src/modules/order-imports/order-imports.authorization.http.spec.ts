/* eslint-disable @typescript-eslint/require-await -- the in-memory fakes keep the async signatures of the repositories they replace. */
import {
  ForbiddenException,
  UnauthorizedException,
  ValidationPipe,
  type INestApplication,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { MulterModule } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import { ThrottlerModule } from '@nestjs/throttler';
import type { Server } from 'node:http';
import request from 'supertest';
import { OrderImportReleaseRepository } from '../../infrastructure/database/repositories/order-import-release.repository';
import { OrderImportsRepository } from '../../infrastructure/database/repositories/order-imports.repository';
import { OrdersRepository } from '../../infrastructure/database/repositories/orders.repository';
import { WebhookEventsRepository } from '../../infrastructure/database/repositories/webhook-events.repository';
import { StandaloneOrderEligibilityStrategy } from '../../infrastructure/spokes/standalone/services/standalone-order-eligibility.strategy';
import {
  BULK_IMPORT_CONFIG,
  parseBulkImportConfig,
  type BulkImportConfig,
} from '../../shared/config/bulk-import.config';
import { PhoneService } from '../../shared/services/phone.service';
import {
  DualAuthGuard,
  type AuthenticatedUser,
} from '../auth/guards/dual-auth.guard';
import { TokenValidatorService } from '../auth/services/token-validator.service';
import { StandaloneOrderIngestionService } from '../order-ingestion/standalone-order-ingestion.service';
import { StandaloneSendReadinessService } from '../order-ingestion/standalone-send-readiness.service';
import { StandaloneSourceResolver } from '../order-ingestion/standalone-source-resolver';
import { OrderEligibilityService } from '../verification-core/order-eligibility.service';
import { TestVerificationService } from '../verifications/test-verification.service';
import { VerificationsController } from '../verifications/verifications.controller';
import { VerificationsService } from '../verifications/verifications.service';
import { OrderImportAccessGuard } from './guards/order-import-access.guard';
import { OrderImportUploadThrottleGuard } from './guards/order-import-upload-throttle.guard';
import { OrderImportCommitProducer } from './order-import-commit.producer';
import { OrderImportCommitService } from './order-import-commit.service';
import { OrderImportDetailService } from './order-import-detail.service';
import { OrderImportMappingService } from './order-import-mapping.service';
import { OrderImportRowsService } from './order-import-rows.service';
import { OrderImportsController } from './order-imports.controller';
import { orderImportMulterOptions } from './order-imports.module';
import { OrderImportsService } from './order-imports.service';
import { ImportFileParser } from './parsers/import-file-parser';
import { OrderImportReleaseScheduler } from './release/order-import-release.scheduler';
import { OrderImportReleaseService } from './release/order-import-release.service';
import { signQuoteToken } from './release/quote-token';
import { RowValidationService } from './validation/row-validation.service';

/**
 * US-04.6-09 AC1 and AC5: every order-import route, and the Verifications
 * import filter, for every kind of caller.
 *
 * Only the database is faked. Authentication is the real `DualAuthGuard` in
 * front of a token table, and the controller, gates, source resolver and
 * services (release included) are the production ones, so an answer here is
 * the answer a merchant gets. The fakes hold one batch of organization A and
 * return it only for A's id and source, as every org-scoped query does.
 */

const ORG_A = '0a0a0a0a-0000-4000-8000-00000000000a';
const ORG_B = '0b0b0b0b-0000-4000-8000-00000000000b';
const ORG_SHOPIFY = '05050505-0000-4000-8000-000000000005';
const INT_A = 'int-a';
const BATCH = '5f1c6f7e-6d7a-4a53-9c6e-0d9b1c2e3f40';
const SECRET = 'test-quote-secret-0123456789abcdef';
const HOUR = 3_600_000;

type Principal =
  | 'owner'
  | 'admin'
  | 'viewer'
  | 'otherOrgOwner'
  | 'unauthenticated'
  | 'removedMember'
  | 'shopifyOrg'
  | 'flagOff';

const PRINCIPALS: Principal[] = [
  'owner',
  'admin',
  'viewer',
  'otherOrgOwner',
  'unauthenticated',
  'removedMember',
  'shopifyOrg',
  'flagOff',
];

const IDENTITIES: Record<
  Exclude<Principal, 'unauthenticated' | 'removedMember'>,
  Pick<AuthenticatedUser, 'orgId' | 'role'>
> = {
  owner: { orgId: ORG_A, role: 'owner' },
  admin: { orgId: ORG_A, role: 'admin' },
  viewer: { orgId: ORG_A, role: 'viewer' },
  otherOrgOwner: { orgId: ORG_B, role: 'owner' },
  shopifyOrg: { orgId: ORG_SHOPIFY, role: 'owner' },
  flagOff: { orgId: ORG_A, role: 'owner' },
};

const SOURCES: Record<string, Record<string, unknown>> = {
  [ORG_A]: { id: INT_A, orgId: ORG_A, platformType: 'standalone' },
  [ORG_B]: { id: 'int-b', orgId: ORG_B, platformType: 'standalone' },
  [ORG_SHOPIFY]: { id: 'int-s', orgId: ORG_SHOPIFY, platformType: 'shopify' },
};

function sourceOf(orgId: string) {
  return {
    platformStoreUrl: `store-${orgId}.akeed.local`,
    isActive: true,
    onboardingStatus: 'completed',
    isAutoVerifyEnabled: true,
    followUpEnabled: false,
    quietHoursEnabled: false,
    quietHoursStart: null,
    quietHoursEnd: null,
    timezone: 'Africa/Cairo',
    assumeCodWhenPaymentMissing: false,
    ...SOURCES[orgId],
  };
}

type Expected = { status: number; code?: string };

interface Endpoint {
  name: string;
  /** The state organization A's batch must be in for the call to succeed. */
  batchStatus: string;
  ok: number;
  read?: boolean;
  /** No batch id in the path: any member of any org reaches their own data. */
  orgWide?: boolean;
  call: (server: Server) => request.Test;
}

const MAPPING_BODY = {
  mapping: { phone: 'phone', customerName: ['name'], amount: 'total' },
  options: { country: 'EG', defaultCurrency: 'EGP', dateFormat: 'auto' },
};

function startBody() {
  return {
    attestationVersion: 'bulk-import-consent-v1',
    quoteToken: signQuoteToken(
      {
        batchId: BATCH,
        orders: 2,
        balance: 100,
        expiresAt: Date.now() + 600_000,
      },
      SECRET,
    ),
  };
}

const route = (suffix = '') => `/api/order-imports/${BATCH}${suffix}`;

const ENDPOINTS: Endpoint[] = [
  {
    name: 'POST / (upload)',
    batchStatus: 'draft',
    ok: 201,
    orgWide: true,
    call: (server) =>
      request(server)
        .post('/api/order-imports')
        .attach(
          'file',
          Buffer.from('phone,name,total\r\n0101,A,5\r\n'),
          'a.csv',
        ),
  },
  {
    name: 'GET /template',
    batchStatus: 'draft',
    ok: 200,
    read: true,
    orgWide: true,
    call: (server) =>
      request(server).get('/api/order-imports/template?format=csv&locale=en'),
  },
  {
    name: 'GET / (open drafts)',
    batchStatus: 'draft',
    ok: 200,
    read: true,
    orgWide: true,
    call: (server) => request(server).get('/api/order-imports?status=draft'),
  },
  {
    name: 'GET /:id',
    batchStatus: 'draft',
    ok: 200,
    read: true,
    call: (server) => request(server).get(route()),
  },
  {
    name: 'PUT /:id/mapping',
    batchStatus: 'draft',
    ok: 200,
    call: (server) => request(server).put(route('/mapping')).send(MAPPING_BODY),
  },
  {
    name: 'GET /:id/rows',
    batchStatus: 'draft',
    ok: 200,
    read: true,
    call: (server) => request(server).get(route('/rows')),
  },
  {
    name: 'PATCH /:id/rows/:rowNumber',
    batchStatus: 'draft',
    ok: 200,
    call: (server) =>
      request(server).patch(route('/rows/2')).send({ include: true }),
  },
  {
    name: 'POST /:id/commit',
    batchStatus: 'draft',
    ok: 202,
    call: (server) =>
      request(server)
        .post(route('/commit'))
        .set('Idempotency-Key', `commit-${BATCH}`),
  },
  {
    name: 'GET /:id/start-quote',
    batchStatus: 'awaiting_start',
    ok: 200,
    call: (server) => request(server).get(route('/start-quote')),
  },
  {
    name: 'POST /:id/start',
    batchStatus: 'awaiting_start',
    ok: 202,
    call: (server) =>
      request(server)
        .post(route('/start'))
        .set('Idempotency-Key', `start-${BATCH}`)
        .send(startBody()),
  },
  {
    name: 'POST /:id/stop',
    batchStatus: 'releasing',
    ok: 200,
    call: (server) => request(server).post(route('/stop')),
  },
  {
    name: 'POST /:id/resume',
    batchStatus: 'paused',
    ok: 200,
    call: (server) => request(server).post(route('/resume')),
  },
  {
    name: 'DELETE /:id',
    batchStatus: 'draft',
    ok: 204,
    call: (server) => request(server).delete(route()),
  },
];

/** Routes the kill switch leaves open (AC5): stop never traps orders. */
const OPEN_WHEN_DISABLED = new Set(['POST /:id/stop']);

function expected(endpoint: Endpoint, principal: Principal): Expected {
  switch (principal) {
    case 'unauthenticated':
      return { status: 401 };
    case 'removedMember':
      return { status: 403, code: 'ORGANIZATION_REQUIRED' };
    case 'flagOff':
      return OPEN_WHEN_DISABLED.has(endpoint.name)
        ? { status: endpoint.ok }
        : { status: 403, code: 'IMPORT_DISABLED' };
    case 'viewer':
      return endpoint.read
        ? { status: endpoint.ok }
        : { status: 403, code: 'IMPORT_ROLE_REQUIRED' };
    case 'shopifyOrg':
      if (!endpoint.read)
        return { status: 403, code: 'IMPORT_SOURCE_UNSUPPORTED' };
      return endpoint.orgWide
        ? { status: endpoint.ok }
        : { status: 404, code: 'IMPORT_BATCH_NOT_FOUND' };
    case 'otherOrgOwner':
      return endpoint.orgWide
        ? { status: endpoint.ok }
        : { status: 404, code: 'IMPORT_BATCH_NOT_FOUND' };
    default:
      return { status: endpoint.ok };
  }
}

describe('order-import authorization matrix (US-04.6-09)', () => {
  jest.setTimeout(60_000);

  let app: INestApplication;
  const server = () => app.getHttpServer() as Server;
  let bulkImport: BulkImportConfig;
  let userCounter = 0;

  /** Organization A's one batch; the fakes answer it only to A. */
  const state = {
    status: 'draft',
    pausedReason: null as string | null,
    startIdempotencyKey: null as string | null,
  };
  const ownBatch = (orgId: string, batchId: string) =>
    orgId === ORG_A && batchId === BATCH;
  const future = () => new Date(Date.now() + 24 * HOUR).toISOString();

  const detailRecord = () => ({
    batchId: BATCH,
    shortCode: 'ABC123',
    status: state.status,
    fileName: 'orders.csv',
    fileFormat: 'csv',
    fileSha256: 'a'.repeat(64),
    rowCount: 1,
    headers: ['phone', 'name', 'total'],
    mapping: null,
    options: null,
    counts: { total: 1, ready: 1 },
    orderDateMin: null,
    orderDateMax: null,
    createdAt: new Date(Date.now() - HOUR).toISOString(),
    expiresAt: future(),
    committedAt: null,
    startDeadlineAt: future(),
    startedAt: null,
    pausedReason: state.pausedReason,
    quietHoursUntil: null,
    stoppedAt: null,
    completedAt: null,
    storeTimezone: 'Africa/Cairo',
  });

  const imports = {
    listOpenDrafts: jest.fn(async (orgId: string) =>
      orgId === ORG_A
        ? [
            {
              batchId: BATCH,
              fileName: 'orders.csv',
              rowCount: 1,
              createdAt: new Date().toISOString(),
              expiresAt: future(),
            },
          ]
        : [],
    ),
    createDraftWithRows: jest.fn(async () => ({
      batchId: '6f1c6f7e-6d7a-4a53-9c6e-0d9b1c2e3f41',
      shortCode: 'NEW123',
      createdAt: new Date().toISOString(),
      duplicateFileOf: null,
    })),
    discardDraft: jest.fn(async (orgId: string, batchId: string) =>
      ownBatch(orgId, batchId) && state.status === 'draft'
        ? { outcome: 'discarded' }
        : { outcome: 'not_found' },
    ),
    findMappingProfile: jest.fn(async () => null),
    findBatchForMapping: jest.fn(async (orgId: string, batchId: string) =>
      ownBatch(orgId, batchId)
        ? {
            status: state.status,
            expiresAt: future(),
            headers: ['phone', 'name', 'total'],
            mapping: null,
          }
        : null,
    ),
    columnValueCounts: jest.fn(async () => []),
    saveMapping: jest.fn(async () => ({
      outcome: 'saved',
      mappingProfileId: 'profile-1',
    })),
    readCounts: jest.fn(async () => ({})),
    findBatchForValidation: jest.fn(async (orgId: string, batchId: string) =>
      ownBatch(orgId, batchId)
        ? {
            status: state.status,
            expiresAt: future(),
            integrationId: INT_A,
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
          }
        : null,
    ),
    listRowsForValidation: jest.fn(async () => []),
    writeValidation: jest.fn(async () => 'saved'),
    findOrdersByExternalIds: jest.fn(async () => []),
    findRecentOrdersByPhones: jest.fn(async () => []),
    findRecentOrdersByOrderNumbers: jest.fn(async () => []),
    pageRows: jest.fn(async () => []),
    findRow: jest.fn(async () => ({
      rowNumber: 2,
      raw: {},
      normalized: { paymentMethod: '' },
      outcome: 'ready',
      issues: [{ code: 'POSSIBLE_DUPLICATE' }],
      includeOverride: true,
      collapsedInto: null,
    })),
    setIncludeOverride: jest.fn(async () => ({ outcome: 'saved' })),
    findBatchDetail: jest.fn(async (orgId: string, batchId: string) =>
      ownBatch(orgId, batchId) ? detailRecord() : null,
    ),
    readSampleRows: jest.fn(async () => []),
    countRowsWithIssue: jest.fn(async () => 0),
    findRecentDuplicate: jest.fn(async () => null),
    findBatchForCommit: jest.fn(async (orgId: string, batchId: string) =>
      ownBatch(orgId, batchId)
        ? {
            id: BATCH,
            status: state.status,
            expiresAt: future(),
            integrationId: INT_A,
            shortCode: 'ABC123',
            platformStoreUrl: 'store-a.akeed.local',
            mapping: { confirmed: true },
            counts: { total: 1, ready: 1 },
            commitIdempotencyKey: null,
          }
        : null,
    ),
    findBatchByCommitKey: jest.fn(async () => null),
    claimForCommit: jest.fn(async () => {
      state.status = 'committing';
      return 'claimed';
    }),
  };

  const releases = {
    findBatch: jest.fn(async (orgId: string, batchId: string) =>
      ownBatch(orgId, batchId)
        ? {
            id: BATCH,
            orgId: ORG_A,
            integrationId: INT_A,
            status: state.status,
            startDeadlineAt: future(),
            startIdempotencyKey: state.startIdempotencyKey,
            pausedReason: state.pausedReason,
          }
        : null,
    ),
    holdCounts: jest.fn(async () => ({ held: 2, released: 0, withdrawn: 0 })),
    claimForStart: jest.fn(async (input: { key: string }) => {
      state.status = 'releasing';
      state.startIdempotencyKey = input.key;
      return 'claimed';
    }),
    markStopped: jest.fn(async () => {
      if (state.status === 'releasing' || state.status === 'paused')
        state.status = 'stopped';
      return true;
    }),
    resume: jest.fn(async () => {
      if (state.status !== 'paused') return false;
      state.status = 'releasing';
      state.pausedReason = null;
      return true;
    }),
  };
  const webhookEvents = { withdrawHeld: jest.fn(async () => []) };
  const readiness = {
    evaluate: jest.fn(async () => ({
      ready: true,
      blockers: [],
      snapshot: {
        accountingMode: 'prepaid_credit',
        creditsAvailable: 100,
        slotsRemaining: null,
      },
    })),
  };
  const scheduler = { ensure: jest.fn(), remove: jest.fn() };
  const commitProducer = { enqueue: jest.fn() };
  const verifications = {
    listByOrg: jest.fn(async () => ({ data: [], page_context: undefined })),
    getStatsByOrg: jest.fn(),
  };

  const integrations = {
    findActiveByOrg: jest.fn(async (orgId: string) =>
      SOURCES[orgId] ? [sourceOf(orgId)] : [],
    ),
  };
  const resolver = new StandaloneSourceResolver(integrations as never);

  /** The session: a bearer token names the principal, as a JWT would. */
  const tokenValidator = {
    validateToken: jest.fn(async (token: string) => {
      const principal = token.split(':')[0] as Principal;
      if (principal === 'removedMember')
        throw new ForbiddenException({
          statusCode: 403,
          error: 'Forbidden',
          message: 'Authenticated user has no organization',
          code: 'ORGANIZATION_REQUIRED',
        });
      const identity =
        IDENTITIES[principal as keyof typeof IDENTITIES] ??
        (() => {
          throw new UnauthorizedException('Invalid or expired token');
        })();
      return { userId: token, source: 'supabase', ...identity };
    }),
  };

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [
        ThrottlerModule.forRoot({ throttlers: [{ ttl: 60_000, limit: 600 }] }),
        MulterModule.register(
          orderImportMulterOptions(parseBulkImportConfig({})),
        ),
      ],
      controllers: [OrderImportsController, VerificationsController],
      providers: [
        OrderImportsService,
        OrderImportMappingService,
        OrderImportDetailService,
        OrderImportRowsService,
        OrderImportCommitService,
        OrderImportReleaseService,
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
        DualAuthGuard,
        { provide: TokenValidatorService, useValue: tokenValidator },
        {
          provide: ConfigService,
          useValue: {
            get: (key: string) =>
              key === BULK_IMPORT_CONFIG ? bulkImport : undefined,
          },
        },
        { provide: OrderImportsRepository, useValue: imports },
        { provide: OrderImportReleaseRepository, useValue: releases },
        { provide: WebhookEventsRepository, useValue: webhookEvents },
        {
          provide: OrdersRepository,
          useValue: { countLifecycleByImportBatch: async () => [] },
        },
        { provide: StandaloneSendReadinessService, useValue: readiness },
        { provide: OrderImportReleaseScheduler, useValue: scheduler },
        { provide: OrderImportCommitProducer, useValue: commitProducer },
        {
          provide: StandaloneOrderIngestionService,
          useValue: {
            resolveWritableSource: (user: AuthenticatedUser, codes: never) =>
              resolver.resolveWritable(user, codes),
          },
        },
        { provide: VerificationsService, useValue: verifications },
        { provide: TestVerificationService, useValue: {} },
      ],
    }).compile();
    app = moduleRef.createNestApplication();
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

  const setFlag = (enabled: boolean) => {
    bulkImport = parseBulkImportConfig({
      STANDALONE_BULK_IMPORT_ENABLED: enabled ? 'true' : 'false',
      BULK_IMPORT_QUOTE_SECRET: SECRET,
    });
  };

  beforeEach(() => {
    jest.clearAllMocks();
    setFlag(true);
    Object.assign(state, {
      status: 'draft',
      pausedReason: null,
      startIdempotencyKey: null,
    });
  });

  /** A fresh user id per call keeps the per-user upload throttle out of it. */
  const as = (principal: Principal, call: request.Test) =>
    principal === 'unauthenticated'
      ? call
      : call.set('Authorization', `Bearer ${principal}:${++userCounter}`);

  const cells = ENDPOINTS.flatMap((endpoint) =>
    PRINCIPALS.map(
      (principal) =>
        [endpoint.name, principal, endpoint, expected(endpoint, principal)] as [
          string,
          Principal,
          Endpoint,
          Expected,
        ],
    ),
  );

  it.each(cells)('%s as %s', async (_name, principal, endpoint, want) => {
    state.status = endpoint.batchStatus;
    if (endpoint.batchStatus === 'paused')
      state.pausedReason = 'INSUFFICIENT_CREDITS';
    if (principal === 'flagOff') setFlag(false);

    const response = await as(principal, endpoint.call(server()));

    expect({
      status: response.status,
      code: (response.body as { code?: string }).code,
    }).toEqual({
      status: want.status,
      code: want.code ?? (response.body as { code?: string }).code,
    });
    if (want.status >= 400 && want.status !== 404) {
      // A refusal before the handler: nothing of organization A was read.
      expect(imports.findBatchDetail).not.toHaveBeenCalled();
      expect(imports.createDraftWithRows).not.toHaveBeenCalled();
      expect(releases.markStopped).not.toHaveBeenCalled();
      expect(releases.claimForStart).not.toHaveBeenCalled();
      expect(commitProducer.enqueue).not.toHaveBeenCalled();
    }
  });

  it('creates an upload in the caller organization only, never the one owning the batch', async () => {
    await as('otherOrgOwner', ENDPOINTS[0].call(server()));

    expect(imports.createDraftWithRows).toHaveBeenCalledWith(
      expect.objectContaining({ orgId: ORG_B, integrationId: 'int-b' }),
      expect.anything(),
      expect.anything(),
    );
  });

  it('lists nothing of organization A to another organization', async () => {
    const response = await as(
      'otherOrgOwner',
      request(server()).get('/api/order-imports?status=draft'),
    );

    expect(response.body).toMatchObject({ drafts: [] });
    expect(imports.listOpenDrafts).toHaveBeenCalledWith(
      ORG_B,
      expect.any(Date),
    );
  });

  /**
   * AC5: flipping the flag while a batch is releasing never leaves it in a
   * state its routes disagree about. Off, resume is refused and stop still
   * works; back on, a repeated stop answers the same final state.
   */
  it('keeps a releasing batch consistent while the flag flips on and off', async () => {
    state.status = 'paused';
    state.pausedReason = 'INSUFFICIENT_CREDITS';
    const resume = () => as('owner', request(server()).post(route('/resume')));
    const stop = () => as('owner', request(server()).post(route('/stop')));

    setFlag(false);
    expect((await resume()).body).toMatchObject({ code: 'IMPORT_DISABLED' });
    expect(state.status).toBe('paused');

    setFlag(true);
    expect((await resume()).status).toBe(200);
    expect(state.status).toBe('releasing');

    setFlag(false);
    expect((await resume()).body).toMatchObject({ code: 'IMPORT_DISABLED' });
    expect(state.status).toBe('releasing');
    const stopped = await stop();
    expect(stopped.status).toBe(200);
    expect(stopped.body).toMatchObject({ status: 'stopped' });

    setFlag(true);
    const again = await stop();
    expect(again.status).toBe(200);
    expect(again.body).toEqual(stopped.body);
    expect((await resume()).body).toMatchObject({
      code: 'IMPORT_BATCH_STATE_CONFLICT',
      status: 'stopped',
    });
    expect(state.status).toBe('stopped');
  });

  describe('GET /api/verifications?importBatchId= (the Verifications filter)', () => {
    const list = (principal: Principal) =>
      as(
        principal,
        request(server()).get(`/api/verifications?importBatchId=${BATCH}`),
      );

    it.each<[Principal, number]>([
      ['owner', 200],
      ['admin', 200],
      ['viewer', 200],
      ['otherOrgOwner', 200],
      ['shopifyOrg', 200],
      ['flagOff', 200],
      ['unauthenticated', 401],
      ['removedMember', 403],
    ])(
      'as %s answers %i, scoped to the session organization',
      async (principal, status) => {
        if (principal === 'flagOff') setFlag(false);

        const response = await list(principal);

        expect(response.status).toBe(status);
        if (status !== 200) {
          expect(verifications.listByOrg).not.toHaveBeenCalled();
          return;
        }
        // The id from the query only narrows the caller's own orders; the
        // organization always comes from the session, so another org's
        // batch id simply matches nothing.
        expect(verifications.listByOrg).toHaveBeenCalledWith(
          IDENTITIES[principal as keyof typeof IDENTITIES].orgId,
          expect.objectContaining({ importBatchId: BATCH }),
        );
      },
    );
  });
});
