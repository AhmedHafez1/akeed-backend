import type {
  SenderFailure,
  SenderFailureClass,
} from '../../../../shared/ports/sender-recovery.port';
import { UNKNOWN_SENDER_OUTCOME } from '../../../../shared/ports/sender-recovery.port';

const CODES: Record<string, SenderFailureClass> = {};
for (const [kind, codes] of Object.entries({
  recipient: [131026, 131021, 131050, 131049],
  retryable: [1, 2, 4, 80007, 130429, 131000, 131016, 131056, 131057, 133004],
  credentials: [0, 3, 10, 190, 200, 131005],
  payment: [131042],
  restricted: [368, 131031, 131045, 131048, 133010, 131037],
  template: [132001, 132007, 132015, 132016],
  payload: [100, 131008, 131009, 132000, 132005, 132012, 135000],
}))
  for (const code of codes) CODES[String(code)] = kind as SenderFailureClass;

/** Provider codes are interpreted only in the spoke; no provider text escapes. */
export function classifyOwnNumberFailure(input: {
  code?: unknown;
  httpStatus?: number;
  transport?: boolean;
  missingMessageId?: boolean;
  localCode?: string;
}): SenderFailure {
  if (input.localCode) {
    const credentials = input.localCode === 'sender_credentials_unavailable';
    return {
      class: credentials ? 'credentials' : 'unknown',
      code: input.localCode,
      action: 'fallback',
      degrade: credentials ? 'credentials' : null,
    };
  }
  if (
    input.transport ||
    input.missingMessageId ||
    (input.httpStatus ?? 0) >= 500
  )
    return { ...UNKNOWN_SENDER_OUTCOME };
  const raw = input.code;
  const code =
    typeof raw === 'number' && Number.isSafeInteger(raw) && raw >= 0
      ? String(raw)
      : typeof raw === 'string' && /^\d+$/.test(raw.trim())
        ? String(Number(raw.trim()))
        : null;
  if (code === null) return { ...UNKNOWN_SENDER_OUTCOME };
  const kind = CODES[code] ?? 'unknown';
  return {
    class: kind,
    code,
    action:
      kind === 'recipient'
        ? 'fail'
        : kind === 'retryable'
          ? 'retry'
          : 'fallback',
    degrade:
      kind === 'credentials' || kind === 'payment' || kind === 'restricted'
        ? kind
        : null,
    ...(kind === 'template'
      ? {
          templateStatus: (
            {
              '132001': 'missing',
              '132007': 'rejected',
              '132015': 'paused',
              '132016': 'disabled',
            } as Record<string, string>
          )[code],
        }
      : {}),
  };
}
