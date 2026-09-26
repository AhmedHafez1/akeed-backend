/* eslint-disable @typescript-eslint/require-await -- the in-memory fakes keep the async signatures of the repositories they replace. */
import { HttpException } from '@nestjs/common';
import type { AuthenticatedUser } from '../../auth/guards/dual-auth.guard';
import { StandaloneSendReadinessService } from '../../order-ingestion/standalone-send-readiness.service';
import type { StandaloneSource } from '../../order-ingestion/standalone-source-resolver';
import type { OrderImportStartQuoteDto } from '../dto/order-import-release.dto';
import { OrderImportExpireService } from './order-import-expire.service';
import { OrderImportReleaseTickService } from './order-import-release-tick.service';
import { OrderImportReleaseService } from './order-import-release.service';

/**
 * The start checkpoint and paced release over an in-memory model of the
 * batch table and the held events, with the same guards as the SQL: every
 * transition checks the status it leaves, and an event moves out of `held`
 * at most once. The clock is faked; the dispatcher is a fake messaging port
 * that "reserves" one credit per dispatched order.
 */

const ORG = '11111111-1111-4111-8111-111111111111';
const SOURCE_ID = '22222222-2222-4222-8222-222222222222';
const USER: AuthenticatedUser = {
  userId: '33333333-3333-4333-8333-333333333333',
  orgId: ORG,
  role: 'owner',
} as AuthenticatedUser;
const SECRET = 'test-quote-secret-0123456789abcdef';
const HOUR = 3_600_000;

interface Batch {
  id: string;
  orgId: string;
  integrationId: string;
  status: string;
  startDeadlineAt: string | null;
  startIdempotencyKey: string | null;
  pausedReason: string | null;
  startedAt: string | null;
  attestedBy: string | null;
  quietHoursUntil: string | null;
  mappingConfirmed: boolean;
  readyCount: number;
  events: Array<{ type: string }>;
}

interface HeldEvent {
  id: string;
  orgId: string;
  groupId: string;
  rowNumber: number;
  holdState: 'held' | 'released' | 'withdrawn';
}

function world(options: { mode?: 'prepaid_credit' | 'periodic_plan' } = {}) {
  const state = {
    mode: options.mode ?? 'prepaid_credit',
    credits: 5_000,
    debt: 0,
    suspended: false,
    consumed: 0,
    includedLimit: 1_000,
    source: {
      id: SOURCE_ID,
      orgId: ORG,
      platformType: 'standalone',
      platformStoreUrl: 'store.example',
      isActive: true,
      onboardingStatus: 'completed',
      isAutoVerifyEnabled: true,
      followUpEnabled: false,
      quietHoursEnabled: false,
      quietHoursStart: '22:00',
      quietHoursEnd: '09:00',
      timezone: 'Africa/Cairo',
    } as StandaloneSource,
    batches: new Map<string, Batch>(),
    events: [] as HeldEvent[],
    dispatches: new Map<string, number>(),
    reservations: new Set<string>(),
    schedulers: new Set<string>(),
    failDispatch: new Set<string>(),
    beforeRelease: undefined as undefined | (() => Promise<void>),
  };

  const releasingOf = (orgId: string) =>
    [...state.batches.values()]
      .filter((batch) => batch.orgId === orgId && batch.status === 'releasing')
      .sort((a, b) => a.startedAt!.localeCompare(b.startedAt!));

  const releases = {
    findBatch: jest.fn(async (orgId: string, id: string) => {
      const batch = state.batches.get(id);
      return batch && batch.orgId === orgId ? { ...batch } : null;
    }),
    holdCounts: jest.fn(async (orgId: string, id: string) => {
      const counts = { held: 0, released: 0, withdrawn: 0 };
      for (const event of state.events)
        if (event.orgId === orgId && event.groupId === id)
          counts[event.holdState] += 1;
      return counts;
    }),
    claimForStart: jest.fn(
      async (input: {
        orgId: string;
        batchId: string;
        key: string;
        startedBy: string;
        now: Date;
      }) => {
        for (const other of state.batches.values())
          if (
            other.id !== input.batchId &&
            other.startIdempotencyKey === input.key
          )
            return 'key_taken';
        const batch = state.batches.get(input.batchId);
        if (
          !batch ||
          batch.status !== 'awaiting_start' ||
          Date.parse(batch.startDeadlineAt!) <= input.now.getTime()
        )
          return 'not_startable';
        Object.assign(batch, {
          status: 'releasing',
          startIdempotencyKey: input.key,
          attestedBy: input.startedBy,
          startedAt: input.now.toISOString(),
          pausedReason: null,
        });
        batch.events.push({ type: 'started' });
        return 'claimed';
      },
    ),
    resume: jest.fn(async (input: { batchId: string; now: Date }) => {
      const batch = state.batches.get(input.batchId)!;
      if (batch.status !== 'paused' || batch.pausedReason === 'staff_paused')
        return false;
      Object.assign(batch, { status: 'releasing', pausedReason: null });
      batch.events.push({ type: 'resumed' });
      return true;
    }),
    markStopped: jest.fn(async (input: { batchId: string }) => {
      const batch = state.batches.get(input.batchId)!;
      if (!['releasing', 'paused'].includes(batch.status)) return false;
      batch.status = 'stopped';
      batch.events.push({ type: 'stopped' });
      return true;
    }),
    listReleasing: jest.fn(async (orgId: string) =>
      [...state.batches.values()]
        .filter(
          (batch) => batch.orgId === orgId && batch.status === 'releasing',
        )
        .sort((a, b) => a.startedAt!.localeCompare(b.startedAt!))
        .map((batch) => ({
          id: batch.id,
          integrationId: batch.integrationId,
          startedAt: batch.startedAt,
        })),
    ),
    listOrgsWithReleasing: jest.fn(),
    setQuietHoursUntil: jest.fn(async (orgId: string, until: string | null) => {
      for (const batch of state.batches.values())
        if (batch.orgId === orgId && batch.status === 'releasing')
          batch.quietHoursUntil = until;
    }),
    pauseReleasing: jest.fn(async (orgId: string, reason: string) => {
      const paused: string[] = [];
      for (const batch of state.batches.values())
        if (batch.orgId === orgId && batch.status === 'releasing') {
          Object.assign(batch, { status: 'paused', pausedReason: reason });
          batch.events.push({ type: 'paused' });
          paused.push(batch.id);
        }
      return paused;
    }),
    selectHeldForRelease: jest.fn(async (orgId: string, limit: number) => {
      const releasing = releasingOf(orgId);
      const order = new Map(releasing.map((batch, index) => [batch.id, index]));
      const selected = state.events
        .filter(
          (event) => event.holdState === 'held' && order.has(event.groupId),
        )
        .sort(
          (a, b) =>
            order.get(a.groupId)! - order.get(b.groupId)! ||
            a.rowNumber - b.rowNumber,
        )
        .slice(0, limit)
        .map((event) => ({ eventId: event.id, batchId: event.groupId }));
      await state.beforeRelease?.();
      return selected;
    }),
    completeDrained: jest.fn(async (orgId: string) => {
      const completed: string[] = [];
      for (const batch of state.batches.values())
        if (
          batch.orgId === orgId &&
          batch.status === 'releasing' &&
          !state.events.some(
            (event) => event.groupId === batch.id && event.holdState === 'held',
          )
        ) {
          batch.status = 'completed';
          batch.events.push({ type: 'completed' });
          completed.push(batch.id);
        }
      return completed;
    }),
    listPastStartDeadline: jest.fn(async (now: Date, limit: number) =>
      [...state.batches.values()]
        .filter(
          (batch) =>
            ['awaiting_start', 'paused'].includes(batch.status) &&
            Date.parse(batch.startDeadlineAt!) <= now.getTime(),
        )
        .slice(0, limit)
        .map((batch) => ({ id: batch.id, orgId: batch.orgId })),
    ),
    markNotStarted: jest.fn(async (input: { batchId: string; now: Date }) => {
      const batch = state.batches.get(input.batchId)!;
      if (
        !['awaiting_start', 'paused'].includes(batch.status) ||
        Date.parse(batch.startDeadlineAt!) > input.now.getTime()
      )
        return false;
      batch.status = 'not_started';
      return true;
    }),
  };

  const webhookEvents = {
    releaseHeld: jest.fn(async (orgId: string, ids: string[]) => {
      const released: string[] = [];
      for (const event of state.events)
        if (
          event.orgId === orgId &&
          ids.includes(event.id) &&
          event.holdState === 'held'
        ) {
          event.holdState = 'released';
          released.push(event.id);
        }
      return released;
    }),
    withdrawHeld: jest.fn(
      async (orgId: string, target: { groupId: string }) => {
        const withdrawn: string[] = [];
        for (const event of state.events)
          if (
            event.orgId === orgId &&
            event.groupId === target.groupId &&
            event.holdState === 'held'
          ) {
            event.holdState = 'withdrawn';
            withdrawn.push(event.id);
          }
        return withdrawn;
      },
    ),
  };

  // The fake messaging port: the dispatch claim is at-most-once per event,
  // and each dispatched order reserves one credit, like the real send path.
  const dispatcher = {
    dispatchById: jest.fn(async (id: string) => {
      state.dispatches.set(id, (state.dispatches.get(id) ?? 0) + 1);
      if (state.failDispatch.has(id)) throw new Error('queue unavailable');
      const event = state.events.find((candidate) => candidate.id === id);
      if (!event || event.holdState !== 'released') return 'not_claimed';
      if (state.reservations.has(id)) return 'not_claimed';
      state.reservations.add(id);
      state.credits -= 1;
      return 'dispatched';
    }),
  };

  const entitlements = {
    accountingModeFor: () => state.mode,
    evaluateAccess: (source: StandaloneSource) => ({
      allowed: Boolean(source.isActive),
      reason: source.isActive ? null : 'integration_inactive',
    }),
    hasAvailableSlot: jest.fn(async () =>
      state.mode === 'prepaid_credit'
        ? {
            available: state.credits >= 1,
            reason: state.credits >= 1 ? null : 'INSUFFICIENT_CREDITS',
            consumedCount: 0,
            includedLimit: Math.max(state.credits, 0),
            credits: { availableCredits: state.credits },
          }
        : {
            available: state.consumed < state.includedLimit,
            reason:
              state.consumed < state.includedLimit
                ? null
                : 'plan_limit_reached',
            consumedCount: state.consumed,
            includedLimit: state.includedLimit,
          },
    ),
  };
  const creditEligibility = {
    resolveDenial: jest.fn(async () => {
      if (state.mode !== 'prepaid_credit') return null;
      if (state.suspended) return 'CREDIT_ACCOUNT_SUSPENDED';
      if (state.debt > 0) return 'CREDIT_DEBT_OUTSTANDING';
      if (state.credits < 1) return 'INSUFFICIENT_CREDITS';
      return null;
    }),
  };
  const readiness = new StandaloneSendReadinessService(
    entitlements as never,
    creditEligibility as never,
    {} as never,
  );
  const scheduler = {
    ensure: jest.fn(async (orgId: string) => {
      state.schedulers.add(orgId);
    }),
    remove: jest.fn(async (orgId: string) => {
      state.schedulers.delete(orgId);
    }),
  };
  const detail = {
    detail: jest.fn(async (_user: AuthenticatedUser, id: string) => ({
      batchId: id,
      status: state.batches.get(id)!.status,
    })),
  };
  const settings = { releasePerMinute: 20, quoteSecret: SECRET };
  const config = { get: () => settings };
  const integrations = {
    findByOrg: jest.fn(async () => [state.source]),
  };

  const service = new OrderImportReleaseService(
    releases as never,
    webhookEvents as never,
    readiness,
    scheduler as never,
    detail as never,
    config as never,
  );
  const ticker = new OrderImportReleaseTickService(
    releases as never,
    integrations as never,
    readiness,
    webhookEvents as never,
    dispatcher as never,
    scheduler as never,
    config as never,
  );
  const expirer = new OrderImportExpireService(
    releases as never,
    webhookEvents as never,
  );

  let batchCounter = 0;
  function addBatch(held: number, overrides: Partial<Batch> = {}): string {
    batchCounter += 1;
    const id = `00000000-0000-4000-8000-${String(batchCounter).padStart(12, '0')}`;
    state.batches.set(id, {
      id,
      orgId: ORG,
      integrationId: SOURCE_ID,
      status: 'awaiting_start',
      startDeadlineAt: new Date(Date.now() + 72 * HOUR).toISOString(),
      startIdempotencyKey: null,
      pausedReason: null,
      startedAt: null,
      attestedBy: null,
      quietHoursUntil: null,
      mappingConfirmed: true,
      readyCount: held,
      events: [],
      ...overrides,
    });
    for (let row = 1; row <= held; row++)
      state.events.push({
        id: `${id}:${row}`,
        orgId: ORG,
        groupId: id,
        rowNumber: row,
        holdState: 'held',
      });
    return id;
  }

  async function quote(batchId: string): Promise<OrderImportStartQuoteDto> {
    return service.quote(USER, state.source, batchId);
  }

  async function start(batchId: string, key = `start-${batchId}`) {
    const fresh = await quote(batchId);
    return service.start(USER, state.source, batchId, key, {
      quoteToken: fresh.quoteToken,
    });
  }

  const tick = (now = new Date()) => ticker.tick(ORG, now);
  const eventsOf = (batchId: string, holdState?: HeldEvent['holdState']) =>
    state.events.filter(
      (event) =>
        event.groupId === batchId &&
        (holdState === undefined || event.holdState === holdState),
    );

  return {
    state,
    service,
    ticker,
    expirer,
    dispatcher,
    scheduler,
    releases,
    addBatch,
    quote,
    start,
    tick,
    eventsOf,
  };
}

/** The response body of a thrown import error. */
async function errorOf(promise: Promise<unknown>) {
  const error = await promise.then(
    () => {
      throw new Error('expected a rejection');
    },
    (caught: unknown) => caught,
  );
  expect(error).toBeInstanceOf(HttpException);
  return (error as HttpException).getResponse() as Record<string, unknown>;
}

beforeEach(() => {
  jest.useFakeTimers({ now: new Date('2026-09-21T10:00:00Z') });
});
afterEach(() => {
  jest.useRealTimers();
});

describe('start quote (AC1, AC2)', () => {
  it('prices N orders in credit mode with follow-up off', async () => {
    const w = world();
    w.state.credits = 2_300;
    const batchId = w.addBatch(970);
    await expect(w.quote(batchId)).resolves.toMatchObject({
      orders: 970,
      accountingMode: 'prepaid_credit',
      creditsAvailable: 2_300,
      slotsRemaining: null,
      estimatedCreditsMin: 970,
      estimatedCreditsMax: 970,
      ratePerMinute: 20,
      estimatedDurationMinutes: 49,
      blockers: [],
      quoteExpiresAt: '2026-09-21T10:10:00.000Z',
    });
  });

  it('doubles the maximum when follow-ups are on', async () => {
    const w = world();
    w.state.source = { ...w.state.source, followUpEnabled: true };
    const batchId = w.addBatch(970);
    await expect(w.quote(batchId)).resolves.toMatchObject({
      estimatedCreditsMin: 970,
      estimatedCreditsMax: 1_940,
    });
  });

  it('counts plan slots in periodic mode, follow-up on and off', async () => {
    const w = world({ mode: 'periodic_plan' });
    w.state.consumed = 400;
    const batchId = w.addBatch(500);
    await expect(w.quote(batchId)).resolves.toMatchObject({
      accountingMode: 'periodic_plan',
      creditsAvailable: null,
      slotsRemaining: 600,
      estimatedCreditsMax: 500,
      blockers: [],
    });
    w.state.source = { ...w.state.source, followUpEnabled: true };
    await expect(w.quote(batchId)).resolves.toMatchObject({
      estimatedCreditsMax: 1_000,
    });
  });

  it('includes the quiet-hours gap in the duration', async () => {
    const w = world();
    w.state.source = { ...w.state.source, quietHoursEnabled: true };
    jest.setSystemTime(new Date('2026-09-21T18:30:00Z')); // 21:30 Cairo
    const batchId = w.addBatch(970);
    await expect(w.quote(batchId)).resolves.toMatchObject({
      estimatedDurationMinutes: 49 + 11 * 60,
      quietHours: {
        enabled: true,
        start: '22:00',
        end: '09:00',
        timezone: 'Africa/Cairo',
      },
    });
  });

  it('reports a shortfall and the credits to buy', async () => {
    const w = world();
    w.state.credits = 400;
    const batchId = w.addBatch(970);
    const result = await w.quote(batchId);
    expect(result.blockers).toEqual([
      {
        code: 'INSUFFICIENT_CREDITS',
        shortfall: 570,
        suggestedPurchaseCredits: 600,
      },
    ]);
  });

  it.each([
    [
      'auto-verify off',
      (w: ReturnType<typeof world>) => {
        w.state.source = { ...w.state.source, isAutoVerifyEnabled: false };
      },
      'IMPORT_AUTO_VERIFY_DISABLED',
    ],
    [
      'a debt',
      (w: ReturnType<typeof world>) => {
        w.state.debt = 5;
      },
      'CREDIT_DEBT_OUTSTANDING',
    ],
    [
      'a suspended account',
      (w: ReturnType<typeof world>) => {
        w.state.suspended = true;
      },
      'CREDIT_ACCOUNT_SUSPENDED',
    ],
    [
      'an inactive source',
      (w: ReturnType<typeof world>) => {
        w.state.source = { ...w.state.source, isActive: false };
      },
      'IMPORT_SETUP_INCOMPLETE',
    ],
  ])('blocks on %s', async (_label, arrange, code) => {
    const w = world();
    const batchId = w.addBatch(10);
    arrange(w);
    const result = await w.quote(batchId);
    expect(result.blockers.map((blocker) => blocker.code)).toContain(code);
  });

  it('blocks on the plan limit in periodic mode', async () => {
    const w = world({ mode: 'periodic_plan' });
    w.state.consumed = 995;
    const batchId = w.addBatch(10);
    await expect(w.quote(batchId)).resolves.toMatchObject({
      blockers: [{ code: 'IMPORT_PLAN_LIMIT_REACHED', slotsRemaining: 5 }],
    });
  });

  it('blocks once the start window has passed', async () => {
    const w = world();
    const batchId = w.addBatch(10, {
      startDeadlineAt: new Date(Date.now() - 1).toISOString(),
    });
    await expect(w.quote(batchId)).resolves.toMatchObject({
      blockers: [{ code: 'IMPORT_START_WINDOW_EXPIRED' }],
    });
  });

  it('does not hold a draft to a start deadline it does not have yet', async () => {
    const w = world();
    const draft = w.addBatch(0, {
      status: 'draft',
      readyCount: 5,
      startDeadlineAt: null,
    });
    await expect(w.quote(draft)).resolves.toMatchObject({
      orders: 5,
      blockers: [],
    });
  });

  it('prices a validated draft on its ready rows, before the import', async () => {
    const w = world();
    w.state.credits = 457;
    const draft = w.addBatch(0, { status: 'draft', readyCount: 5 });
    await expect(w.quote(draft)).resolves.toMatchObject({
      orders: 5,
      creditsAvailable: 457,
      estimatedCreditsMin: 5,
      blockers: [],
    });
    expect(w.releases.holdCounts).not.toHaveBeenCalled();
  });

  it('carries a draft quote over to the start once the import is in', async () => {
    const w = world();
    const batchId = w.addBatch(0, { status: 'draft', readyCount: 5 });
    const seen = await w.quote(batchId);
    // The commit: the five rows are now held orders awaiting the start.
    const imported = w.addBatch(5);
    w.state.batches.set(batchId, {
      ...w.state.batches.get(imported)!,
      id: batchId,
    });
    for (const event of w.state.events)
      if (event.groupId === imported) event.groupId = batchId;
    await expect(
      w.service.start(USER, w.state.source, batchId, 'key-0000001', {
        quoteToken: seen.quoteToken,
      }),
    ).resolves.toMatchObject({ status: 'releasing' });
  });

  it('answers an unsaved draft with a state conflict and another source with 404', async () => {
    const w = world();
    const draft = w.addBatch(0, { status: 'draft', mappingConfirmed: false });
    await expect(errorOf(w.quote(draft))).resolves.toMatchObject({
      code: 'IMPORT_BATCH_STATE_CONFLICT',
    });
    const foreign = w.addBatch(1, { integrationId: 'another-source' });
    await expect(errorOf(w.quote(foreign))).resolves.toMatchObject({
      code: 'IMPORT_BATCH_NOT_FOUND',
    });
  });
});

describe('start (AC3, AC4)', () => {
  it('starts once, records who started it and ensures the scheduler', async () => {
    const w = world();
    const batchId = w.addBatch(30);
    await expect(w.start(batchId)).resolves.toEqual({
      batchId,
      status: 'releasing',
    });
    const batch = w.state.batches.get(batchId)!;
    expect(batch).toMatchObject({
      status: 'releasing',
      attestedBy: USER.userId,
      startIdempotencyKey: `start-${batchId}`,
      startedAt: '2026-09-21T10:00:00.000Z',
    });
    expect(batch.events).toEqual([{ type: 'started' }]);
    expect(w.state.schedulers.has(ORG)).toBe(true);
    // Starting sends nothing by itself; only ticks release.
    expect(w.dispatcher.dispatchById).not.toHaveBeenCalled();
    expect(w.eventsOf(batchId, 'held')).toHaveLength(30);
  });

  it('replays the same key and refuses a different one', async () => {
    const w = world();
    const batchId = w.addBatch(5);
    await w.start(batchId, 'key-one-0001');
    const fresh = await w.quote(w.addBatch(1));
    await expect(
      w.service.start(USER, w.state.source, batchId, 'key-one-0001', {
        quoteToken: fresh.quoteToken,
      }),
    ).resolves.toMatchObject({ status: 'releasing' });
    expect(w.releases.claimForStart).toHaveBeenCalledTimes(1);
    await expect(
      errorOf(
        w.service.start(USER, w.state.source, batchId, 'key-two-0002', {}),
      ),
    ).resolves.toMatchObject({
      code: 'IMPORT_BATCH_STATE_CONFLICT',
      status: 'releasing',
    });
  });

  it('requires the Idempotency-Key', async () => {
    const w = world();
    const batchId = w.addBatch(5);
    await expect(
      errorOf(w.service.start(USER, w.state.source, batchId, undefined, {})),
    ).resolves.toMatchObject({ code: 'IMPORT_IDEMPOTENCY_KEY_REQUIRED' });
  });

  it.each([undefined, 'bulk-import-consent-v0'])(
    'starts without a consent statement and ignores an old one (got %p)',
    async (attestationVersion) => {
      const w = world();
      const batchId = w.addBatch(5);
      const fresh = await w.quote(batchId);
      expect(fresh).not.toHaveProperty('attestation');
      await expect(
        w.service.start(USER, w.state.source, batchId, 'key-0000001', {
          attestationVersion,
          quoteToken: fresh.quoteToken,
        }),
      ).resolves.toMatchObject({ status: 'releasing' });
    },
  );

  it('answers a missing, expired or forged quote with a fresh one', async () => {
    const w = world();
    const batchId = w.addBatch(5);
    const attempt = (quoteToken?: string) =>
      errorOf(
        w.service.start(USER, w.state.source, batchId, 'key-0000001', {
          quoteToken,
        }),
      );
    const missing = await attempt();
    expect(missing).toMatchObject({
      code: 'IMPORT_QUOTE_STALE',
      quote: { orders: 5, blockers: [] },
    });
    const old = await w.quote(batchId);
    jest.advanceTimersByTime(10 * 60_000 + 1);
    await expect(attempt(old.quoteToken)).resolves.toMatchObject({
      code: 'IMPORT_QUOTE_STALE',
    });
    await expect(attempt(`${old.quoteToken}x`)).resolves.toMatchObject({
      code: 'IMPORT_QUOTE_STALE',
    });
  });

  it('is stale when N changed since the quote', async () => {
    const w = world();
    const batchId = w.addBatch(5);
    const seen = await w.quote(batchId);
    w.state.events[0].holdState = 'withdrawn';
    await expect(
      errorOf(
        w.service.start(USER, w.state.source, batchId, 'key-0000001', {
          quoteToken: seen.quoteToken,
        }),
      ),
    ).resolves.toMatchObject({
      code: 'IMPORT_QUOTE_STALE',
      quote: { orders: 4 },
    });
  });

  it('is stale when the balance dropped below N, and fine when it only moved', async () => {
    const w = world();
    w.state.credits = 100;
    const batchId = w.addBatch(50);
    const seen = await w.quote(batchId);
    w.state.credits = 40;
    await expect(
      errorOf(
        w.service.start(USER, w.state.source, batchId, 'key-0000001', {
          quoteToken: seen.quoteToken,
        }),
      ),
    ).resolves.toMatchObject({
      code: 'IMPORT_QUOTE_STALE',
      quote: {
        creditsAvailable: 40,
        blockers: [{ code: 'INSUFFICIENT_CREDITS', shortfall: 10 }],
      },
    });
    w.state.credits = 60;
    await expect(
      w.service.start(USER, w.state.source, batchId, 'key-0000001', {
        quoteToken: seen.quoteToken,
      }),
    ).resolves.toMatchObject({ status: 'releasing' });
  });

  it('re-evaluates the gates even with a valid quote', async () => {
    const w = world();
    const batchId = w.addBatch(5);
    const seen = await w.quote(batchId);
    w.state.source = { ...w.state.source, isAutoVerifyEnabled: false };
    await expect(
      errorOf(
        w.service.start(USER, w.state.source, batchId, 'key-0000001', {
          quoteToken: seen.quoteToken,
        }),
      ),
    ).resolves.toMatchObject({
      code: 'IMPORT_AUTO_VERIFY_DISABLED',
      blockers: [{ code: 'IMPORT_AUTO_VERIFY_DISABLED' }],
    });
  });

  it('refuses a batch past its start window', async () => {
    const w = world();
    const batchId = w.addBatch(5);
    const seen = await w.quote(batchId);
    jest.advanceTimersByTime(72 * HOUR);
    await expect(
      errorOf(
        w.service.start(USER, w.state.source, batchId, 'key-0000001', {
          quoteToken: seen.quoteToken,
        }),
      ),
    ).resolves.toMatchObject({ code: 'IMPORT_START_WINDOW_EXPIRED' });
  });
});

describe('paced release (AC5, AC6, AC9, AC10)', () => {
  it('shares one rate budget across two batches, oldest start first', async () => {
    const w = world();
    const first = w.addBatch(15);
    const second = w.addBatch(15);
    await w.start(first);
    jest.advanceTimersByTime(1_000);
    await w.start(second);

    await w.tick();
    expect(w.eventsOf(first, 'released')).toHaveLength(10);
    expect(w.eventsOf(second, 'released')).toHaveLength(0);

    await w.tick();
    expect(w.eventsOf(first, 'released')).toHaveLength(15);
    expect(w.eventsOf(second, 'released').map((e) => e.rowNumber)).toEqual([
      1, 2, 3, 4, 5,
    ]);
    expect(w.state.batches.get(first)!.status).toBe('completed');

    await w.tick();
    await w.tick();
    expect(w.state.batches.get(second)!.status).toBe('completed');
    expect(w.state.schedulers.has(ORG)).toBe(false);
  });

  it('pauses for quiet hours across midnight and resumes at the window end', async () => {
    const w = world();
    w.state.source = { ...w.state.source, quietHoursEnabled: true };
    const batchId = w.addBatch(40);
    await w.start(batchId);

    // 21:59:30 Cairo: still open.
    await expect(w.tick(new Date('2026-09-21T18:59:30Z'))).resolves.toEqual({
      kind: 'released',
      released: 10,
      completed: 0,
    });
    // 23:30 Cairo and 08:59 the next morning: quiet.
    for (const at of ['2026-09-21T20:30:00Z', '2026-09-22T05:59:00Z']) {
      await expect(w.tick(new Date(at))).resolves.toEqual({
        kind: 'quiet_hours',
        until: '2026-09-22T06:00:00.000Z',
      });
    }
    expect(w.state.batches.get(batchId)!.quietHoursUntil).toBe(
      '2026-09-22T06:00:00.000Z',
    );
    expect(w.eventsOf(batchId, 'released')).toHaveLength(10);
    // 09:00 Cairo: sending resumes and the banner clears.
    await w.tick(new Date('2026-09-22T06:00:00Z'));
    expect(w.eventsOf(batchId, 'released')).toHaveLength(20);
    expect(w.state.batches.get(batchId)!.quietHoursUntil).toBeNull();
    expect(w.state.batches.get(batchId)!.status).toBe('releasing');
  });

  it('re-reads quiet hours every tick', async () => {
    const w = world();
    const batchId = w.addBatch(20);
    await w.start(batchId);
    const lateEvening = new Date('2026-09-21T20:00:00Z');
    await w.tick(lateEvening);
    expect(w.eventsOf(batchId, 'released')).toHaveLength(10);
    w.state.source = { ...w.state.source, quietHoursEnabled: true };
    await expect(w.tick(lateEvening)).resolves.toMatchObject({
      kind: 'quiet_hours',
    });
  });

  it('auto-pauses every releasing batch when the balance runs out, and resume continues', async () => {
    const w = world();
    const first = w.addBatch(100);
    const second = w.addBatch(100);
    await w.start(first);
    jest.advanceTimersByTime(1_000);
    await w.start(second);
    // Credits are spent elsewhere (manual orders) after the start.
    w.state.credits = 60;

    for (let i = 0; i < 6; i++) await w.tick();
    // 60 released and each reserved a credit; the next tick finds none left.
    expect(w.state.credits).toBe(0);
    expect(w.eventsOf(first, 'released')).toHaveLength(60);
    await expect(w.tick()).resolves.toEqual({
      kind: 'paused',
      reason: 'INSUFFICIENT_CREDITS',
      batches: 2,
    });
    for (const id of [first, second])
      expect(w.state.batches.get(id)).toMatchObject({
        status: 'paused',
        pausedReason: 'INSUFFICIENT_CREDITS',
      });
    expect(w.state.schedulers.has(ORG)).toBe(false);
    await w.tick();
    expect(w.eventsOf(first, 'released')).toHaveLength(60);

    await expect(
      errorOf(w.service.resume(USER, w.state.source, first)),
    ).resolves.toMatchObject({ code: 'INSUFFICIENT_CREDITS' });

    w.state.credits = 500; // the merchant bought credits
    await expect(
      w.service.resume(USER, w.state.source, first),
    ).resolves.toMatchObject({ status: 'releasing' });
    expect(w.state.schedulers.has(ORG)).toBe(true);
    await w.tick();
    expect(w.eventsOf(first, 'released')).toHaveLength(70);
    // Resuming one batch leaves the other paused until its own resume.
    expect(w.state.batches.get(second)!.status).toBe('paused');
  });

  it('pauses when auto-verify is switched off and resumes when it is back', async () => {
    const w = world();
    const batchId = w.addBatch(30);
    await w.start(batchId);
    await w.tick();
    w.state.source = { ...w.state.source, isAutoVerifyEnabled: false };
    await expect(w.tick()).resolves.toMatchObject({
      kind: 'paused',
      reason: 'IMPORT_AUTO_VERIFY_DISABLED',
    });
    await expect(
      errorOf(w.service.resume(USER, w.state.source, batchId)),
    ).resolves.toMatchObject({ code: 'IMPORT_AUTO_VERIFY_DISABLED' });
    w.state.source = { ...w.state.source, isAutoVerifyEnabled: true };
    await w.service.resume(USER, w.state.source, batchId);
    await w.tick();
    expect(w.eventsOf(batchId, 'released')).toHaveLength(20);
  });

  it('leaves a failed dispatch released for the reconciler and carries on', async () => {
    const w = world();
    const batchId = w.addBatch(3);
    await w.start(batchId);
    w.state.failDispatch.add(`${batchId}:2`);
    await expect(w.tick()).resolves.toEqual({
      kind: 'released',
      released: 3,
      completed: 1,
    });
    expect(w.eventsOf(batchId, 'released')).toHaveLength(3);
    expect(w.state.reservations.has(`${batchId}:2`)).toBe(false);
  });

  it('never dispatches an event twice, whatever ticks overlap', async () => {
    const w = world();
    const batchId = w.addBatch(55);
    await w.start(batchId);
    await Promise.all([w.tick(), w.tick(), w.tick()]);
    for (let i = 0; i < 6; i++) await w.tick();
    expect(w.eventsOf(batchId, 'released')).toHaveLength(55);
    expect([...w.state.dispatches.values()].every((count) => count === 1)).toBe(
      true,
    );
    expect(w.state.dispatches.size).toBe(55);
  });

  it('removes an idle scheduler and ignores batches that are not releasing', async () => {
    const w = world();
    w.state.schedulers.add(ORG);
    w.addBatch(5); // awaiting_start: never released without a start
    await expect(w.tick()).resolves.toEqual({ kind: 'idle' });
    expect(w.state.schedulers.has(ORG)).toBe(false);
    expect(w.dispatcher.dispatchById).not.toHaveBeenCalled();
  });
});

describe('stop, resume and expiry (AC7, AC8, AC9)', () => {
  it('stops the rest, reports both counts and is idempotent', async () => {
    const w = world();
    const batchId = w.addBatch(25);
    await w.start(batchId);
    await w.tick();
    const expected = {
      batchId,
      status: 'stopped',
      released: 10,
      withdrawn: 15,
    };
    await expect(
      w.service.stop(USER, w.state.source, batchId),
    ).resolves.toEqual(expected);
    await expect(
      w.service.stop(USER, w.state.source, batchId),
    ).resolves.toEqual(expected);
    await w.tick();
    expect(w.eventsOf(batchId, 'released')).toHaveLength(10);
    // Withdrawn orders were never dispatched, so they reserved nothing.
    for (const event of w.eventsOf(batchId, 'withdrawn')) {
      expect(w.state.dispatches.has(event.id)).toBe(false);
      expect(w.state.reservations.has(event.id)).toBe(false);
    }
  });

  it('leaves every event either released or withdrawn when stop races a tick', async () => {
    const w = world();
    const batchId = w.addBatch(25);
    await w.start(batchId);
    // The stop lands after the tick selected its events but before it
    // releases them.
    w.state.beforeRelease = async () => {
      w.state.beforeRelease = undefined;
      await w.service.stop(USER, w.state.source, batchId);
    };
    await w.tick();
    const released = w.eventsOf(batchId, 'released');
    const withdrawn = w.eventsOf(batchId, 'withdrawn');
    expect(released.length + withdrawn.length).toBe(25);
    expect(w.eventsOf(batchId, 'held')).toHaveLength(0);
    for (const event of withdrawn)
      expect(w.state.dispatches.has(event.id)).toBe(false);
    expect(w.state.batches.get(batchId)!.status).toBe('stopped');
  });

  it('refuses to stop a batch that never started', async () => {
    const w = world();
    const batchId = w.addBatch(5);
    await expect(
      errorOf(w.service.stop(USER, w.state.source, batchId)),
    ).resolves.toMatchObject({
      code: 'IMPORT_BATCH_STATE_CONFLICT',
      status: 'awaiting_start',
    });
  });

  it('keeps a staff pause out of the merchant’s hands', async () => {
    const w = world();
    const batchId = w.addBatch(5, {
      status: 'paused',
      pausedReason: 'staff_paused',
      startIdempotencyKey: 'key-0000001',
    });
    await expect(
      errorOf(w.service.resume(USER, w.state.source, batchId)),
    ).resolves.toMatchObject({
      code: 'IMPORT_BATCH_STATE_CONFLICT',
      reason: 'staff_paused',
    });
  });

  it('resumes idempotently', async () => {
    const w = world();
    const batchId = w.addBatch(5, {
      status: 'paused',
      pausedReason: 'INSUFFICIENT_CREDITS',
    });
    await w.service.resume(USER, w.state.source, batchId);
    await expect(
      w.service.resume(USER, w.state.source, batchId),
    ).resolves.toMatchObject({ status: 'releasing' });
    expect(w.releases.resume).toHaveBeenCalledTimes(1);
    expect(w.state.batches.get(batchId)!.events).toEqual([{ type: 'resumed' }]);
  });

  it('expires never-started and paused batches after 72 hours, and only those', async () => {
    const w = world();
    const waiting = w.addBatch(5);
    const paused = w.addBatch(5, {
      status: 'paused',
      pausedReason: 'INSUFFICIENT_CREDITS',
    });
    const releasing = w.addBatch(5);
    await w.start(releasing);

    jest.advanceTimersByTime(72 * HOUR - 60_000);
    await expect(w.expirer.run()).resolves.toEqual({
      expired: 0,
      withdrawn: 0,
    });

    jest.advanceTimersByTime(60_000);
    await expect(w.expirer.run()).resolves.toEqual({
      expired: 2,
      withdrawn: 10,
    });
    expect(w.state.batches.get(waiting)!.status).toBe('not_started');
    expect(w.state.batches.get(paused)!.status).toBe('not_started');
    expect(w.state.batches.get(releasing)!.status).toBe('releasing');
    expect(w.eventsOf(waiting, 'withdrawn')).toHaveLength(5);
    expect(w.eventsOf(releasing, 'held')).toHaveLength(5);

    const seen = await w.quote(releasing).catch(() => null);
    expect(seen).toBeNull();
    await expect(
      errorOf(
        w.service.start(USER, w.state.source, waiting, 'key-0000009', {}),
      ),
    ).resolves.toMatchObject({ code: 'IMPORT_START_WINDOW_EXPIRED' });
  });
});
