import {
  ACCOUNT_LIFECYCLE_EVENTS,
  lifecycleReason,
} from './connection-lifecycle.policy';
import { buildBackendLog } from '../../shared/logging/backend-log.util';

describe('connection lifecycle policy and logging', () => {
  it('accepts the eight uppercase lifecycle events only', () => {
    expect(ACCOUNT_LIFECYCLE_EVENTS.size).toBe(8);
    expect(ACCOUNT_LIFECYCLE_EVENTS.has('account_offboarded')).toBe(false);
    expect(ACCOUNT_LIFECYCLE_EVENTS.has('ACCOUNT_OFFBOARDED')).toBe(true);
  });
  it('retains the inactivity reason but refuses arbitrary provider text', () => {
    expect(lifecycleReason('PARTNER_REMOVED', 'PRIMARY_INACTIVITY')).toBe(
      'PRIMARY_INACTIVITY',
    );
    expect(lifecycleReason('PARTNER_REMOVED', 'private customer text')).toBe(
      'PARTNER_REMOVED',
    );
    expect(lifecycleReason('ACCOUNT_DELETED', 'PRIMARY_INACTIVITY')).toBe(
      'ACCOUNT_DELETED',
    );
  });
  it('redacts nested message bodies, phones and business-scoped identities', () => {
    const result = buildBackendLog('Test', {
      action: 'test',
      outcome: 'success',
      body: 'private-body',
      text: { body: 'private-text' },
      from: '201000000000',
      from_user_id: 'private-bsuid',
      customerUserId: 'private-user',
      displayPhoneNumber: 'private-phone',
    });
    for (const secret of [
      'private-body',
      'private-text',
      '201000000000',
      'private-bsuid',
      'private-user',
      'private-phone',
    ])
      expect(result).not.toContain(secret);
  });
});
