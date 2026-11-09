import { ConfigService } from '@nestjs/config';
import {
  ChangeRequestEffectsService,
  EMAIL_REPLAY_WINDOW_MS,
} from './change-request-effects.service';
import type { ChangeRequestEffectRow } from '../../infrastructure/database/repositories/verification-change-requests.repository';
import {
  parseUsageAlertsConfig,
  USAGE_ALERTS_CONFIG,
} from '../../shared/config/usage-alerts.config';
import type {
  EmailMessage,
  EmailSendResult,
} from '../../shared/ports/email.port';

function fixture(
  options: {
    recipient?: string | null;
    owner?: string | null;
    result?: EmailSendResult;
    kind?: ChangeRequestEffectRow['kind'];
    enabled?: boolean;
  } = {},
) {
  const effect = {
    id: 'effect-1',
    orgId: 'org-1',
    changeRequestId: 'request-1',
    kind: options.kind ?? 'merchant_email',
    status: 'pending',
    attempts: 0,
    reason: null,
    nextAttemptAt: null,
    firstAttemptAt: null,
    emailPayload: null,
  } as ChangeRequestEffectRow;
  const request = {
    id: effect.changeRequestId,
    orgId: effect.orgId,
    verificationId: '86cf9da1-71a0-4604-aa90-9da9329ed087',
    orderId: 'order-1',
    integrationId: 'store-1',
    openedAt: new Date().toISOString(),
  };
  const context = {
    notificationEmail:
      options.recipient === undefined
        ? 'notify@example.test'
        : options.recipient,
    defaultLanguage: 'en',
    platformType: 'standalone',
    platformStoreUrl: 'standalone:org-1',
    storeName: 'Synthetic Store',
    orderNumber: '123',
    externalOrderId: 'external-1',
    timezone: 'Africa/Cairo',
  };
  const requests = {
    claimEffect: jest.fn(
      (kind: string, _lease: number, _now: Date, id?: string) => {
        if (
          kind !== effect.kind ||
          (id && id !== request.id) ||
          effect.status !== 'pending' ||
          (effect.nextAttemptAt &&
            Date.parse(effect.nextAttemptAt) > Date.now())
        )
          return Promise.resolve(null);
        effect.status = 'in_progress';
        effect.attempts++;
        return Promise.resolve({ ...effect });
      },
    ),
    findById: jest.fn().mockResolvedValue(request),
    notificationContext: jest.fn().mockResolvedValue(context),
    prepareEmail: jest.fn((_effect: unknown, payload: EmailMessage) => {
      effect.emailPayload = payload;
      effect.firstAttemptAt = new Date().toISOString();
      return Promise.resolve({ ...effect });
    }),
    settleEffect: jest.fn(
      (input: {
        status: ChangeRequestEffectRow['status'];
        reason?: string;
        nextAttemptAt?: string;
      }) => {
        effect.status = input.status;
        effect.reason = input.reason ?? null;
        effect.nextAttemptAt = input.nextAttemptAt ?? null;
        return Promise.resolve(true);
      },
    ),
  };
  const owners = {
    findOwnerEmail: jest
      .fn()
      .mockResolvedValue(
        options.owner === undefined ? 'owner@example.test' : options.owner,
      ),
  };
  const email = {
    send: jest
      .fn<Promise<EmailSendResult>, [EmailMessage]>()
      .mockResolvedValue(options.result ?? { status: 'sent' }),
  };
  const config = new ConfigService({
    [USAGE_ALERTS_CONFIG]: parseUsageAlertsConfig({
      EMAIL_ALERTS_ENABLED: options.enabled === false ? 'false' : 'true',
      RESEND_API_KEY: 'synthetic',
      EMAIL_FROM: 'alerts@example.test',
      FRONTEND_DASHBOARD_URL: 'https://app.example.test/en/dashboard',
    }),
  });
  const commerce = {
    dispatch: jest.fn().mockResolvedValue({ status: 'applied' }),
  };
  const automation = {
    enqueueChangeRequestEffects: jest.fn().mockResolvedValue(undefined),
  };
  const service = new ChangeRequestEffectsService(
    requests as never,
    owners as never,
    email,
    config,
    commerce as never,
    automation as never,
  );
  return {
    effect,
    request,
    context,
    requests,
    owners,
    email,
    commerce,
    automation,
    service,
  };
}

describe('durable merchant change-request effects', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2026-11-09T10:00:00Z'));
  });
  afterEach(() => jest.useRealTimers());

  it('uses the configured address once, without coupling email to customer messaging or platform work', async () => {
    const f = fixture();
    await Promise.all([
      f.service.drain(f.request.id),
      f.service.drain(f.request.id),
    ]);
    await f.service.drain(f.request.id);
    expect(f.email.send).toHaveBeenCalledTimes(1);
    expect(f.email.send).toHaveBeenCalledWith(
      expect.objectContaining({
        to: 'notify@example.test',
        from: 'alerts@example.test',
        idempotencyKey: 'change-request-request-1-initial',
      }),
    );
    expect(f.email.send.mock.calls[0][0].text).toContain(
      'open=86cf9da1-71a0-4604-aa90-9da9329ed087',
    );
    expect(f.email.send.mock.calls[0][0].text).toContain(
      'Contact them before shipping',
    );
    expect(f.owners.findOwnerEmail).not.toHaveBeenCalled();
    expect(f.commerce.dispatch).not.toHaveBeenCalled();
    expect(f.automation.enqueueChangeRequestEffects).not.toHaveBeenCalled();
    expect(f.effect.status).toBe('done');
  });

  it.each([null, '', 'not an address', 'synthetic@akeed-shopify.internal'])(
    'falls back to the owner for unusable configured address %s',
    async (recipient) => {
      const f = fixture({ recipient });
      await f.service.drain();
      expect(f.email.send).toHaveBeenCalledWith(
        expect.objectContaining({ to: 'owner@example.test' }),
      );
      expect(f.owners.findOwnerEmail).toHaveBeenCalledWith('org-1');
    },
  );

  it('records a missing recipient without losing the request', async () => {
    const f = fixture({ recipient: null, owner: null });
    await f.service.drain();
    expect(f.effect).toMatchObject({
      status: 'failed',
      reason: 'no_recipient',
    });
    expect(f.requests.findById).toHaveBeenCalledWith('request-1', 'org-1');
    expect(f.email.send).not.toHaveBeenCalled();
    expect(f.request.id).toBe('request-1');
  });

  it('records email disabled and never calls the provider', async () => {
    const f = fixture({ enabled: false });
    await f.service.drain();
    expect(f.effect).toMatchObject({
      status: 'skipped',
      reason: 'email_disabled',
    });
    expect(f.email.send).not.toHaveBeenCalled();
  });

  it('retries with the identical envelope after recipient, store and configuration changes', async () => {
    const f = fixture({
      result: {
        status: 'failed',
        reason: 'provider_unreachable',
        retryable: true,
        uncertain: true,
      },
    });
    await f.service.drain();
    const first = f.email.send.mock.calls[0][0];
    expect(f.effect).toMatchObject({
      status: 'pending',
      reason: 'provider_unreachable',
    });
    expect(f.automation.enqueueChangeRequestEffects).toHaveBeenCalledTimes(1);
    f.context.notificationEmail = 'changed@example.test';
    f.context.storeName = 'Changed';
    jest.advanceTimersByTime(3_001);
    f.email.send.mockResolvedValue({ status: 'sent' });
    await f.service.drain();
    expect(f.email.send.mock.calls[1][0]).toEqual(first);
    expect(f.requests.prepareEmail).toHaveBeenCalledTimes(1);
    expect(f.effect.status).toBe('done');
  });

  it('never replays an uncertain attempt after the provider key expires', async () => {
    const f = fixture({
      result: {
        status: 'failed',
        reason: 'provider_outcome_unknown',
        retryable: true,
        uncertain: true,
      },
    });
    await f.service.drain();
    jest.advanceTimersByTime(EMAIL_REPLAY_WINDOW_MS);
    await f.service.drain();
    expect(f.email.send).toHaveBeenCalledTimes(1);
    expect(f.effect).toMatchObject({
      status: 'failed',
      reason: 'email_outcome_unresolved',
    });
  });

  it('exhausts bounded retries and retains failure', async () => {
    const f = fixture({
      result: {
        status: 'failed',
        reason: 'provider_status_503',
        retryable: true,
      },
    });
    for (let n = 0; n < 6; n++) {
      await f.service.drain();
      jest.advanceTimersByTime(60_000);
    }
    expect(f.email.send).toHaveBeenCalledTimes(5);
    expect(f.effect).toMatchObject({
      status: 'failed',
      reason: 'provider_status_503',
    });
  });

  it('does not report a permanent rejection as success', async () => {
    const f = fixture({
      result: { status: 'failed', reason: 'provider_status_422' },
    });
    await f.service.drain();
    expect(f.effect.status).toBe('failed');
    expect(f.automation.enqueueChangeRequestEffects).not.toHaveBeenCalled();
  });

  it('recovers a failed queue insertion from the persisted due effect', async () => {
    const f = fixture({
      result: {
        status: 'failed',
        reason: 'provider_status_429',
        retryable: true,
      },
    });
    f.automation.enqueueChangeRequestEffects.mockRejectedValue(
      new Error('queue unavailable'),
    );
    await f.service.drain();
    jest.advanceTimersByTime(3_001);
    f.email.send.mockResolvedValue({ status: 'sent' });
    await f.service.drain();
    expect(f.effect.status).toBe('done');
  });

  it.each(['platform_marker_set', 'platform_marker_clear'] as const)(
    'routes %s through the existing registry',
    async (kind) => {
      const f = fixture({ kind });
      await f.service.drain();
      expect(f.commerce.dispatch).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'change_request_reconciliation',
          orgId: 'org-1',
          correlationId: f.request.verificationId,
        }),
      );
      expect(f.email.send).not.toHaveBeenCalled();
    },
  );
});
