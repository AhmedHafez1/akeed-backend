import {
  EASYORDERS_DASHBOARD_ORIGIN,
  EASYORDERS_INSTALL_CALLBACK_PATH,
} from './easyorders.config';

/**
 * Routes a provider's own web page calls from the browser. Each is answered
 * for exactly one origin, without credentials, whatever the app-wide
 * `CORS_ALLOWED_ORIGINS` says; every other route keeps the app-wide rule.
 */
export interface RouteScopedCors {
  pathPrefix: string;
  origin: string;
  methods: string;
  headers: string;
}

export const ROUTE_SCOPED_CORS: readonly RouteScopedCors[] = [
  {
    pathPrefix: `${EASYORDERS_INSTALL_CALLBACK_PATH}/`,
    origin: EASYORDERS_DASHBOARD_ORIGIN,
    methods: 'POST, OPTIONS',
    headers: 'Content-Type',
  },
];

export function findRouteScopedCors(
  path: string,
  routes: readonly RouteScopedCors[] = ROUTE_SCOPED_CORS,
): RouteScopedCors | undefined {
  return routes.find((route) => path.startsWith(route.pathPrefix));
}
