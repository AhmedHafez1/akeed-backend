/**
 * Embedded Signup as a full-page sign-in.
 *
 * The connect page sends the merchant's tab to Meta's login dialog, and Meta
 * sends it back to the same page with `?code=&state=` (or `?error=&state=`).
 * Nothing waits in a second tab, so a phone browser that reloads or drops a
 * background tab cannot lose the result.
 *
 * `state` carries the page's single-use signup ticket. Meta returns it
 * unchanged; the server spends it once, so it ties the code to the
 * organization that started the signup.
 */

/** Embedded Signup's own options, as the SDK popup sent them. */
const SIGNUP_EXTRAS = JSON.stringify({ setup: {}, version: 'v5' });

/**
 * The connect page for one interface language. Meta must list each of these
 * exactly under Valid OAuth Redirect URIs, and the code exchange repeats it.
 */
export function embeddedSignupRedirectUri(
  connectPageBaseUrl: string,
  locale: string,
): string {
  const base = connectPageBaseUrl.replace(/\/+$/, '');
  return new URL(`${base}/${locale}/whatsapp/connect`).toString();
}

export function buildEmbeddedSignupUrl(input: {
  graphApiVersion: string;
  appId: string;
  configId: string;
  redirectUri: string;
  state: string;
}): string {
  const url = new URL(
    `https://www.facebook.com/${input.graphApiVersion}/dialog/oauth`,
  );
  url.searchParams.set('client_id', input.appId);
  url.searchParams.set('redirect_uri', input.redirectUri);
  url.searchParams.set('state', input.state);
  url.searchParams.set('config_id', input.configId);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('override_default_response_type', 'true');
  url.searchParams.set('extras', SIGNUP_EXTRAS);
  return url.toString();
}
