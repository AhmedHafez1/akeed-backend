import type { AuthenticatedUser } from '../auth/guards/dual-auth.guard';
import { VerificationsService } from './verifications.service';

const verificationId = '7d0e5c0e-2f43-4d55-9a0b-1c2d3e4f5a6b';

const owner = {
  userId: 'user-1',
  orgId: 'org-1',
  role: 'owner',
  source: 'supabase',
} as unknown as AuthenticatedUser;

function failedSync(overrides: Record<string, unknown> = {}) {
  return {
    id: 'sync-1',
    orgId: 'org-1',
    integrationId: 'integration-1',
    orderId: 'order-1',
    externalOrderId: 'external-1',
    correlationId: verificationId,
    action: 'customer_confirmation',
    state: 'failed',
    attempts: 5,
    deferrals: 0,
    retryInBackground: true,
    requiresAssistance: false,
    providerStatus: null,
    errorCode: 'source_unavailable',
    nextAttemptAt: null,
    createdAt: '2026-10-03T09:00:00.000Z',
    updatedAt: '2026-10-03T10:00:00.000Z',
    ...overrides,
  };
}

function setup(sync: ReturnType<typeof failedSync> | null = failedSync()) {
  const verificationsRepo = {
    findByIdForOrg: jest.fn().mockResolvedValue({
      id: verificationId,
      orgId: 'org-1',
      status: 'confirmed',
      cancellationSource: null,
    }),
  };
  const outcomeSyncs = {
    findByCorrelationIds: jest.fn().mockResolvedValue(sync ? [sync] : []),
    resetForRetry: jest
      .fn()
      .mockResolvedValue(sync ? { ...sync, state: 'pending' } : undefined),
    findByIdForOrg: jest
      .fn()
      .mockResolvedValue(
        sync ? { ...sync, state: 'succeeded', errorCode: null } : undefined,
      ),
  };
  const commerceOutcomes = {
    dispatch: jest.fn().mockResolvedValue({ status: 'applied' }),
  };
  const service = new VerificationsService(
    verificationsRepo as never,
    null as never,
    null as never,
    null as never,
    commerceOutcomes as never,
    { finalizeVerification: jest.fn() } as never,
    outcomeSyncs as never,
  );
  return { service, verificationsRepo, outcomeSyncs, commerceOutcomes };
}

describe('VerificationsService.retryOutcomeSync', () => {
  it('reopens the failed sync and dispatches it for the row’s own source', async () => {
    const { service, outcomeSyncs, commerceOutcomes, verificationsRepo } =
      setup();

    await expect(
      service.retryOutcomeSync(owner, verificationId),
    ).resolves.toEqual({
      success: true,
      verificationId,
      remote_sync: expect.objectContaining({
        state: 'succeeded',
        error_code: null,
      }) as unknown,
    });

    expect(verificationsRepo.findByIdForOrg).toHaveBeenCalledWith(
      verificationId,
      'org-1',
    );
    expect(outcomeSyncs.findByCorrelationIds).toHaveBeenCalledWith('org-1', [
      verificationId,
    ]);
    expect(outcomeSyncs.resetForRetry).toHaveBeenCalledWith('sync-1', 'org-1');
    expect(commerceOutcomes.dispatch).toHaveBeenCalledWith({
      orgId: 'org-1',
      integrationId: 'integration-1',
      externalOrderId: 'external-1',
      action: 'customer_confirmation',
      correlationId: verificationId,
      retryInBackground: true,
    });
  });

  it('refuses a viewer before reading anything', async () => {
    const { service, verificationsRepo, commerceOutcomes } = setup();

    await expect(
      service.retryOutcomeSync(
        { ...owner, role: 'viewer' } as AuthenticatedUser,
        verificationId,
      ),
    ).rejects.toMatchObject({
      response: { code: 'VERIFICATION_ROLE_REQUIRED' },
    });
    expect(verificationsRepo.findByIdForOrg).not.toHaveBeenCalled();
    expect(commerceOutcomes.dispatch).not.toHaveBeenCalled();
  });

  it('answers 404 for another organization’s verification', async () => {
    const { service, verificationsRepo, outcomeSyncs } = setup();
    verificationsRepo.findByIdForOrg.mockResolvedValue(undefined);

    await expect(
      service.retryOutcomeSync(owner, verificationId),
    ).rejects.toMatchObject({ response: { code: 'VERIFICATION_NOT_FOUND' } });
    expect(outcomeSyncs.findByCorrelationIds).not.toHaveBeenCalled();
  });

  it.each([
    ['there is no sync row', null],
    ['the sync is still pending', failedSync({ state: 'pending' })],
    ['the sync succeeded', failedSync({ state: 'succeeded' })],
    [
      'the failed action is not the current local result',
      failedSync({ action: 'customer_cancellation' }),
    ],
    [
      'the failed action was the merchant’s own',
      failedSync({ retryInBackground: false }),
    ],
  ])('refuses when %s', async (_name, sync) => {
    const { service, outcomeSyncs, commerceOutcomes } = setup(sync);

    await expect(
      service.retryOutcomeSync(owner, verificationId),
    ).rejects.toMatchObject({
      response: { code: 'OUTCOME_SYNC_NOT_RETRYABLE' },
    });
    expect(outcomeSyncs.resetForRetry).not.toHaveBeenCalled();
    expect(commerceOutcomes.dispatch).not.toHaveBeenCalled();
  });

  it('lets only one of two concurrent retries dispatch', async () => {
    const { service, outcomeSyncs, commerceOutcomes } = setup();
    outcomeSyncs.resetForRetry.mockResolvedValue(undefined);

    await expect(
      service.retryOutcomeSync(owner, verificationId),
    ).rejects.toMatchObject({
      response: { code: 'OUTCOME_SYNC_NOT_RETRYABLE' },
    });
    expect(commerceOutcomes.dispatch).not.toHaveBeenCalled();
  });
});
