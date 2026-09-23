export const PRODUCT_EVENT_NAMES = [
  'app_installed',
  'setup_started',
  'setup_completed',
  'test_sent',
  'test_resend',
  'test_confirmed',
  'test_skipped',
  'first_order_sent',
  'first_reply',
  'credits_80',
  'plan_upgraded',
  'onboarding_exited',
] as const;

export type ProductEventName = (typeof PRODUCT_EVENT_NAMES)[number];

export const CLIENT_PRODUCT_EVENT_NAMES = [
  'setup_started',
  'onboarding_exited',
] as const satisfies readonly ProductEventName[];

export type ClientProductEventName =
  (typeof CLIENT_PRODUCT_EVENT_NAMES)[number];

export type ProductEventProps = Record<
  string,
  string | number | boolean | null
>;

export const ONBOARDING_TEST_SEND_EVENTS = [
  'test_sent',
  'test_resend',
] as const satisfies readonly ProductEventName[];

export const ONBOARDING_TEST_COOLDOWN_SECONDS = 30;
export const ONBOARDING_TEST_DAILY_LIMIT = 5;

export const CREDITS_WARNING_RATIO = 0.8;

export function hasCrossedCreditsWarning(params: {
  consumedBefore: number;
  consumedAfter: number;
  includedLimit: number;
}): boolean {
  if (params.includedLimit <= 0) return false;
  const threshold = params.includedLimit * CREDITS_WARNING_RATIO;
  return params.consumedBefore < threshold && params.consumedAfter >= threshold;
}
