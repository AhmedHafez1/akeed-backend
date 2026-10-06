import { ForbiddenException, type ExecutionContext } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import {
  WHATSAPP_TEMPLATE_CONFIG,
  parseWhatsappTemplateConfig,
} from '../../shared/config/whatsapp-template.config';
import { WhatsappTemplateOperatorGuard } from './whatsapp-template-operator.guard';

const OPERATOR = '6f1b6c1e-2d4a-4c3b-9a8e-1f2e3d4c5b6a';
const OTHER_STAFF = '0f1b6c1e-2d4a-4c3b-9a8e-1f2e3d4c5b6a';

function guard(environment: Record<string, string>) {
  const templates = parseWhatsappTemplateConfig(environment);
  return new WhatsappTemplateOperatorGuard({
    get: (key: string) =>
      key === WHATSAPP_TEMPLATE_CONFIG ? templates : undefined,
  } as unknown as ConfigService);
}

function context(userId?: string): ExecutionContext {
  const request = {
    method: 'POST',
    path: '/api/admin/templates/drafts',
    headers: { 'x-request-id': 'req-1' },
    admin: userId ? { userId, role: 'admin', aal: 'aal2' } : undefined,
  };
  return {
    switchToHttp: () => ({ getRequest: () => request }),
  } as unknown as ExecutionContext;
}

function codeOf(run: () => unknown): unknown {
  try {
    run();
  } catch (error) {
    expect(error).toBeInstanceOf(ForbiddenException);
    return ((error as ForbiddenException).getResponse() as { code: string })
      .code;
  }
  return null;
}

describe('WhatsappTemplateOperatorGuard (US-08-06 criterion 1)', () => {
  const enabled = {
    WHATSAPP_TEMPLATE_OPERATIONS_ENABLED: 'true',
    WHATSAPP_TEMPLATE_OPERATOR_IDS: OPERATOR,
  };

  it('admits a named operator while operations are enabled', () => {
    expect(guard(enabled).canActivate(context(OPERATOR))).toBe(true);
    expect(
      guard({
        ...enabled,
        WHATSAPP_TEMPLATE_OPERATOR_IDS: ` ${OTHER_STAFF} , ${OPERATOR.toUpperCase()} `,
      }).canActivate(context(OPERATOR)),
    ).toBe(true);
  });

  it('refuses every staff member while the switch is off, which is the default', () => {
    expect(
      codeOf(() =>
        guard({ WHATSAPP_TEMPLATE_OPERATOR_IDS: OPERATOR }).canActivate(
          context(OPERATOR),
        ),
      ),
    ).toBe('WHATSAPP_TEMPLATE_OPERATIONS_DISABLED');
    expect(codeOf(() => guard({}).canActivate(context(OPERATOR)))).toBe(
      'WHATSAPP_TEMPLATE_OPERATIONS_DISABLED',
    );
  });

  it('refuses staff who are not named operators', () => {
    expect(codeOf(() => guard(enabled).canActivate(context(OTHER_STAFF)))).toBe(
      'WHATSAPP_TEMPLATE_OPERATOR_REQUIRED',
    );
  });

  it('refuses a request no staff guard authenticated', () => {
    expect(codeOf(() => guard(enabled).canActivate(context()))).toBe(
      'WHATSAPP_TEMPLATE_OPERATOR_REQUIRED',
    );
  });

  it('admits every staff member when the switch is on and no operator is listed', () => {
    const open = {
      WHATSAPP_TEMPLATE_OPERATIONS_ENABLED: 'true',
      WHATSAPP_TEMPLATE_OPERATOR_IDS: '',
    };
    expect(guard(open).canActivate(context(OPERATOR))).toBe(true);
    expect(guard(open).canActivate(context(OTHER_STAFF))).toBe(true);
    expect(codeOf(() => guard(open).canActivate(context()))).toBe(
      'WHATSAPP_TEMPLATE_OPERATOR_REQUIRED',
    );
  });
});
