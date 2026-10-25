/**
 * The Akeed pages a tip's button may open. The button stores a key, never a
 * path: the frontend maps each key to the page in the merchant's mode and keeps
 * the embedded context, so a campaign cannot point anywhere else in the app.
 * A key missing from a mode renders no button there.
 */
export type TipActionMode = 'embedded' | 'standalone';

export const TIP_ACTION_ROUTES = {
  settings_message: { modes: ['embedded', 'standalone'] },
  settings_timing: { modes: ['embedded', 'standalone'] },
  plan: { modes: ['embedded', 'standalone'] },
  verifications: { modes: ['embedded', 'standalone'] },
  settings_store: { modes: ['standalone'] },
  settings_api_keys: { modes: ['standalone'] },
  imports_new: { modes: ['standalone'] },
} as const satisfies Record<string, { modes: readonly TipActionMode[] }>;

export type TipActionRoute = keyof typeof TIP_ACTION_ROUTES;

export const TIP_ACTION_ROUTE_KEYS = Object.keys(
  TIP_ACTION_ROUTES,
) as TipActionRoute[];

export function isTipActionRoute(value: unknown): value is TipActionRoute {
  return (
    typeof value === 'string' &&
    (TIP_ACTION_ROUTE_KEYS as readonly string[]).includes(value)
  );
}
