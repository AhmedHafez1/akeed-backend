import { resolveTemplateSendPurpose } from './cod-template-selector';

describe('resolveTemplateSendPurpose', () => {
  it.each([
    ['initial', false, 'initial'],
    ['follow_up', false, 'reminder'],
    ['initial', true, 'test'],
    ['follow_up', true, 'test'],
  ] as const)(
    'a %s dispatch for a test order %s is %s',
    (kind, isTestOrder, purpose) => {
      expect(resolveTemplateSendPurpose({ kind, isTestOrder })).toBe(purpose);
    },
  );
});
