import type { ResolvedSender } from '../../shared/ports/sender-resolver.port';

export interface SenderConnection {
  id: string;
  state: string;
  degradedClass: string | null;
}

export interface SenderTemplate {
  status: string;
  category: string | null;
}

/** First failing check wins; credentials are interpreted only by the spoke. */
export function resolveSender(params: {
  enabled: boolean;
  connection: SenderConnection | null;
  template: SenderTemplate | null;
}): ResolvedSender {
  const shared = (reason: string): ResolvedSender => ({
    kind: 'akeed_system',
    connectionId: null,
    reason,
    units: 1,
  });
  if (!params.enabled) return shared('feature_off');
  const connection = params.connection;
  if (!connection) return shared('no_connection');
  if (connection.state !== 'active') {
    return shared(
      connection.state === 'disconnected' || connection.state === 'offboarded'
        ? connection.state
        : 'not_ready',
    );
  }
  if (connection.degradedClass)
    return shared(`degraded:${connection.degradedClass}`);
  const template = params.template;
  if (!template || template.status === 'missing')
    return shared('template_missing');
  if (template.status !== 'approved') {
    return shared(
      template.status === 'rejected'
        ? 'template_rejected'
        : template.status === 'paused'
          ? 'template_paused'
          : 'template_pending',
    );
  }
  if (template.category !== 'utility') return shared('template_recategorized');
  return {
    kind: 'merchant_own',
    connectionId: connection.id,
    reason: 'own_number',
    units: 1,
  };
}
