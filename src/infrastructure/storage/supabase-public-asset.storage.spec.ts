import { storageFailure } from './supabase-public-asset.storage';

describe('storageFailure', () => {
  it('names a missing bucket and keeps what Supabase said', () => {
    const failure = storageFailure('upload_failed', {
      message: 'Bucket not found',
      statusCode: '404',
    });
    expect(failure.reason).toBe('bucket_missing');
    expect(failure.detail).toEqual({
      providerStatus: '404',
      providerMessage: 'Bucket not found',
    });
  });

  it('keeps the fallback reason for other refusals', () => {
    const failure = storageFailure('upload_failed', {
      message: 'new row violates row-level security policy',
      status: 403,
    });
    expect(failure.reason).toBe('upload_failed');
    expect(failure.detail.providerStatus).toBe('403');
  });

  it('copes with an error that has no fields', () => {
    const failure = storageFailure('remove_failed', null);
    expect(failure.reason).toBe('remove_failed');
    expect(failure.detail).toEqual({
      providerStatus: undefined,
      providerMessage: undefined,
    });
  });
});
