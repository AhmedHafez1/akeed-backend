import {
  resolveSender,
  type SenderConnection,
  type SenderTemplate,
} from './sender-resolution.policy';

const active: SenderConnection = {
  id: 'connection',
  state: 'active',
  degradedClass: null,
};
const approved: SenderTemplate = { status: 'approved', category: 'utility' };

describe('sender resolution precedence', () => {
  it.each([
    {
      name: 'disabled beats missing connection',
      enabled: false,
      connection: null,
      template: null,
      reason: 'feature_off',
    },
    { name: 'missing connection', connection: null, reason: 'no_connection' },
    ...['connecting', 'verifying', 'unexpected'].map((state) => ({
      name: state,
      connection: { ...active, state, degradedClass: 'credentials' },
      reason: 'not_ready',
    })),
    ...['disconnected', 'offboarded'].map((state) => ({
      name: state,
      connection: { ...active, state, degradedClass: 'payment' },
      reason: state,
    })),
    ...['credentials', 'payment', 'restricted'].map((degradedClass) => ({
      name: degradedClass,
      connection: { ...active, degradedClass },
      template: null,
      reason: `degraded:${degradedClass}`,
    })),
    { name: 'missing row', template: null, reason: 'template_missing' },
    {
      name: 'missing at provider',
      template: { status: 'missing', category: 'utility' },
      reason: 'template_missing',
    },
    ...['rejected', 'paused'].map((status) => ({
      name: status,
      template: { status, category: 'marketing' },
      reason: `template_${status}`,
    })),
    ...[
      'pending',
      'unknown',
      'disabled',
      'not_submitted',
      'submitting',
      'unresolved',
      'exhausted',
      'in_appeal',
      'deleted',
      'flagged',
      'failed',
    ].map((status) => ({
      name: status,
      template: { status, category: 'marketing' },
      reason: 'template_pending',
    })),
    ...['marketing', 'authentication', 'unknown', null].map((category) => ({
      name: `category ${category}`,
      template: { status: 'approved', category },
      reason: 'template_recategorized',
    })),
    { name: 'eligible', reason: 'own_number' },
  ])('$name', ({ reason, ...overrides }) => {
    const result = resolveSender({
      enabled: true,
      connection: active,
      template: approved,
      ...overrides,
    });
    expect(result).toEqual({
      kind: reason === 'own_number' ? 'merchant_own' : 'akeed_system',
      connectionId: reason === 'own_number' ? active.id : null,
      reason,
      units: 1,
    });
  });
});
