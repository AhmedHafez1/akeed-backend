/* eslint-disable @typescript-eslint/no-unsafe-assignment */
import { BadRequestException, ConflictException, Logger } from '@nestjs/common';
import { GUARDS_METADATA } from '@nestjs/common/constants';
import { MessageTextConflictError } from '../../infrastructure/database/repositories/whatsapp-message-texts.repository';
import {
  WHATSAPP_TEMPLATE_CONFIG,
  parseWhatsappTemplateConfig,
} from '../../shared/config/whatsapp-template.config';
import { AdminAccessGuard } from './admin-access.guard';
import { AdminMessageTextsController } from './admin-message-texts.controller';
import {
  AdminMessageTextsService,
  MESSAGE_TEXT_AUDIT_ACTION,
} from './admin-message-texts.service';
import type { AdminMessageTextDto } from './dto/admin-message-texts.dto';
import { WhatsappTemplateOperatorGuard } from './whatsapp-template-operator.guard';

const OPERATOR = '6f1b6c1e-2d4a-4c3b-9a8e-1f2e3d4c5b6a';

function setup(upsert = jest.fn()) {
  const config = parseWhatsappTemplateConfig({
    WHATSAPP_TEMPLATE_OPERATIONS_ENABLED: 'true',
    WHATSAPP_TEMPLATE_OPERATOR_IDS: OPERATOR,
    WHATSAPP_ACKNOWLEDGMENT_ENABLED: 'true',
  });
  const repository = { findAll: jest.fn().mockResolvedValue([]), upsert };
  const texts = { invalidate: jest.fn() };
  const service = new AdminMessageTextsService(
    repository as never,
    texts as never,
    {
      get: (key: string) =>
        key === WHATSAPP_TEMPLATE_CONFIG ? config : undefined,
    } as never,
  );
  return { service, repository, texts };
}

function dto(change: Partial<AdminMessageTextDto> = {}): AdminMessageTextDto {
  return {
    purpose: 'ack_confirmed',
    language: 'ar',
    style: 'default',
    body: 'تم تأكيد طلبك رقم #{{order}} من {{store}}.',
    is_active: true,
    ...change,
  };
}

const SAVED = {
  id: 'text-1',
  purpose: 'ack_confirmed',
  language: 'ar',
  style: 'default',
  body: 'x',
  isActive: true,
  updatedAt: '2026-10-06T00:00:00.000Z',
};

describe('AdminMessageTextsService (US-08-07)', () => {
  beforeEach(() => jest.spyOn(Logger.prototype, 'log').mockImplementation());
  afterEach(() => jest.restoreAllMocks());

  it('saves a text, audits it under its own action and drops the cached copy', async () => {
    const upsert = jest
      .fn()
      .mockResolvedValue({ action: 'create', text: SAVED });
    const { service, texts } = setup(upsert);
    await expect(service.save(OPERATOR, dto(), 'req-1')).resolves.toEqual({
      change: 'create',
      text: expect.objectContaining({ id: 'text-1', is_active: true }),
    });
    expect(upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: OPERATOR,
        requestId: 'req-1',
        auditAction: MESSAGE_TEXT_AUDIT_ACTION,
      }),
    );
    expect(texts.invalidate).toHaveBeenCalled();
  });

  it('keeps the cache when nothing changed', async () => {
    const { service, texts } = setup(
      jest.fn().mockResolvedValue({ action: 'unchanged', text: SAVED }),
    );
    await service.save(OPERATOR, dto());
    expect(texts.invalidate).not.toHaveBeenCalled();
  });

  it.each([
    [{ body: 'Hi {{customer}}' }, 'variable_not_allowed'],
    [{ body: 'Order {{order}' }, 'variable_malformed'],
    [
      { purpose: 'fallback_store_name', body: '{{store}}' },
      'variable_not_allowed',
    ],
    [
      { purpose: 'fallback_store_name', body: 'x'.repeat(61) },
      'fallback_too_long',
    ],
    [
      { purpose: 'fallback_customer_name', style: 'egyptian', body: 'يا فندم' },
      'fallback_default_style_only',
    ],
    [
      { purpose: 'fallback_customer_name', body: 'dear\ncustomer' },
      'fallback_single_line',
    ],
    [{ body: '' }, 'body_empty'],
  ] as const)(
    'refuses %j with rule %s and writes nothing',
    async (change, rule) => {
      const { service, repository } = setup();
      const error = await service
        .save(OPERATOR, dto(change as Partial<AdminMessageTextDto>))
        .catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(BadRequestException);
      expect((error as BadRequestException).getResponse()).toMatchObject({
        code: 'WHATSAPP_MESSAGE_TEXT_INVALID',
        rule,
      });
      expect(repository.upsert).not.toHaveBeenCalled();
    },
  );

  it('answers 409 when another operator created the same text at once', async () => {
    const { service } = setup(
      jest.fn().mockRejectedValue(new MessageTextConflictError()),
    );
    await expect(service.save(OPERATOR, dto())).rejects.toBeInstanceOf(
      ConflictException,
    );
  });

  it('lists the texts with the switches and whether the user may write', async () => {
    const { service } = setup();
    await expect(service.list(OPERATOR)).resolves.toMatchObject({
      operations: { enabled: true, operator: true },
      switches: {
        acknowledgment: true,
        unresolved_reply_nudge: false,
        localized_fallbacks: false,
      },
      texts: [],
    });
    expect((await service.list('someone-else')).operations.operator).toBe(
      false,
    );
  });
});

describe('AdminMessageTextsController guards', () => {
  it('needs staff for every route and a template operator to write', () => {
    const guardsOf = (target: object): unknown =>
      Reflect.getMetadata(GUARDS_METADATA, target);
    const method = (name: 'save' | 'list') =>
      Object.getOwnPropertyDescriptor(
        AdminMessageTextsController.prototype,
        name,
      )?.value as object;
    expect(guardsOf(AdminMessageTextsController)).toEqual([AdminAccessGuard]);
    expect(guardsOf(method('save'))).toEqual([WhatsappTemplateOperatorGuard]);
    expect(guardsOf(method('list'))).toBeUndefined();
  });
});
