import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Logger } from '@nestjs/common';
import { MetaTemplateCatalogAdapter } from '../../src/infrastructure/spokes/meta/meta-template-catalog.adapter';
import { WhatsAppService } from '../../src/infrastructure/spokes/meta/whatsapp.service';
import { TemplateAlertService } from '../../src/modules/template-registry/template-alert.service';
import { InMemoryTemplateSyncRepository } from '../../src/modules/template-registry/testing/in-memory-template-sync.repository';
import { WhatsappTemplateSyncService } from '../../src/modules/template-registry/whatsapp-template-sync.service';
import {
  CustomerReplyFollowUpService,
  type CustomerReplyFollowUp,
} from '../../src/modules/verification-replies/customer-reply-follow-up.service';
import {
  MESSAGE_IMPROVEMENT_SWITCHES_OFF,
  parseWhatsappTemplateConfig,
} from '../../src/shared/config/whatsapp-template.config';
import type { TemplateDraftContent } from '../../src/shared/messaging/template-draft.types';
import {
  buildTemplateName,
  toTemplateSubmission,
} from '../../src/shared/messaging/template-draft.validation';
import { decideEdit } from '../../src/shared/messaging/template-lifecycle.policy';
import { isSendableReviewStatus } from '../../src/shared/messaging/template-provider.types';
import {
  TemplateCatalogError,
  TemplateSubmissionError,
} from '../../src/shared/ports/template-catalog.port';
import {
  FAKE_MESSAGES_TOKEN,
  FAKE_PHONE_NUMBER_ID,
  FakeMetaMessagesApi,
  SERVICE_WINDOW_MS,
} from '../contracts/meta-messages-fake';
import {
  FAKE_ACCOUNT_ID,
  FAKE_TOKEN,
  FakeMetaTemplateApi,
  type FakeMetaTemplate,
  akeedTemplates,
} from '../contracts/meta-template-api-fake';

/**
 * US-08-08 criteria 1 and 2: the Meta fakes follow the US-08-01 contract
 * record, and the port adapter, the sync, the submit and edit rules and the
 * free-form window rule hold against them. Every test names the record
 * finding it covers. The per-story suites the gate also runs go deeper; this
 * file is the one place that walks the record end to end.
 */
const FIXTURES = resolve(__dirname, '../fixtures/whatsapp-templates');

function capturedTemplates(): FakeMetaTemplate[] {
  return (
    JSON.parse(
      readFileSync(resolve(FIXTURES, 'template-list.json'), 'utf8'),
    ) as { payload: { data: FakeMetaTemplate[] } }
  ).payload.data;
}

function templateSetup(api = new FakeMetaTemplateApi()) {
  const values: Record<string, unknown> = {
    WA_ACCESS_TOKEN: FAKE_TOKEN,
    whatsappTemplates: parseWhatsappTemplateConfig({
      WHATSAPP_TEMPLATE_SYNC_ENABLED: 'true',
      WA_BUSINESS_ACCOUNT_ID: FAKE_ACCOUNT_ID,
    }),
  };
  const config = { get: (key: string) => values[key] };
  const adapter = new MetaTemplateCatalogAdapter(
    api.httpService as never,
    config as never,
  );
  const repository = new InMemoryTemplateSyncRepository();
  const sync = new WhatsappTemplateSyncService(
    repository as never,
    adapter,
    { listTemplates: jest.fn(), invalidate: jest.fn() },
    new TemplateAlertService(repository as never),
    config as never,
  );
  return { api, adapter, repository, sync };
}

function draft(): TemplateDraftContent {
  return {
    purpose: 'cod_confirmation',
    language: 'en',
    style: 'gate',
    version: 1,
    templateName: buildTemplateName('cod_confirmation', 'gate', 1),
    languageCode: 'en',
    parameterFormat: 'named',
    category: 'utility',
    body: 'Hello {{customer}}, your order {{order}} from {{store}} comes to {{total}} in all today.',
    confirmLabel: 'Confirm order',
    cancelLabel: 'Cancel order',
    samples: {
      customer: 'Ahmed',
      store: 'Akeed Store',
      order: 'TEST-1',
      total: '250.00 USD',
    },
  };
}

async function rejection<T extends Error>(
  promise: Promise<unknown>,
  type: new (...args: never[]) => T,
): Promise<T> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof type) return error;
    throw error;
  }
  throw new Error('expected a failure');
}

describe('US-08-08 Meta contract gate', () => {
  let lines: string[];

  beforeEach(() => {
    lines = [];
    for (const level of ['log', 'warn', 'error'] as const) {
      jest
        .spyOn(Logger.prototype, level)
        .mockImplementation((...args: unknown[]) => {
          lines.push(String(args[0]));
        });
    }
  });

  afterEach(() => {
    const logged = lines.join('\n');
    jest.restoreAllMocks();
    jest.useRealTimers();
    // Criterion 6: whatever a test did, no token reached a log line.
    expect(logged).not.toContain(FAKE_TOKEN);
    expect(logged).not.toContain(FAKE_MESSAGES_TOKEN);
  });

  describe('criterion 1: the fake and the fixtures come from the record', () => {
    it('record 4.1.1 and 1.4: a list is paged by the after cursor, and the next URL that carries the token is never followed', async () => {
      const { adapter, api } = templateSetup(
        new FakeMetaTemplateApi({ pageSize: 3 }),
      );

      const records = await adapter.listTemplates();

      expect(records).toHaveLength(8);
      expect(api.requests.map((request) => request.params.after)).toEqual([
        undefined,
        '3',
        '6',
      ]);
      for (const request of api.requests) {
        expect(request.url).not.toContain(FAKE_TOKEN);
        expect(request.authorization).toBe(`Bearer ${FAKE_TOKEN}`);
      }
    });

    it('record 3.2, 3.3 and 5.3: the list captured from the dev app reads as 9 neutral records', async () => {
      const { adapter } = templateSetup(
        new FakeMetaTemplateApi({ templates: capturedTemplates() }),
      );

      const records = await adapter.listTemplates();

      expect(records).toHaveLength(9);
      expect(new Set(records.map((record) => record.status))).toEqual(
        new Set(['approved']),
      );
      expect(new Set(records.map((record) => record.quality))).toEqual(
        new Set(['pending']),
      );
      expect(
        records.every(
          (record) => 'body' in record.components && record.components.body,
        ),
      ).toBe(true);
    });

    it('record 4.1.3 and 4.2.2: a create answers an ID, a review status and a category, and is listed from then on', async () => {
      const { adapter, api } = templateSetup();

      const created = await adapter.createTemplate(
        toTemplateSubmission(draft()),
      );

      expect(created).toEqual({
        providerTemplateId: expect.stringMatching(/^\d+$/) as string,
        status: 'pending',
        category: 'utility',
      });
      expect(await adapter.listTemplates()).toHaveLength(9);
      expect(api.writes).toHaveLength(1);
    });

    it('record 4.1.4, 4.3.4 and the 4.3.8 worst case: an edit replaces every component and the template is not sendable until approved again', async () => {
      const { adapter, api } = templateSetup();
      const created = await adapter.createTemplate(
        toTemplateSubmission(draft()),
      );
      api.templates.at(-1)!.status = 'APPROVED';

      await adapter.editTemplate(
        created.providerTemplateId,
        toTemplateSubmission({
          ...draft(),
          body: 'Hello {{customer}}, please confirm order {{order}} from {{store}} for {{total}} today.',
        }),
      );

      const edited = (await adapter.listTemplates()).at(-1)!;
      expect(edited.status).toBe('pending');
      expect(isSendableReviewStatus(edited.status)).toBe(false);
      expect(edited.components).toMatchObject({
        body: 'Hello {{customer}}, please confirm order {{order}} from {{store}} for {{total}} today.',
      });
    });

    it.each([4, 80007, 80008])(
      'record 4.9.4: rate-limit code %d fails a read and a write as rate_limited, each after one request',
      async (code) => {
        const { adapter, api } = templateSetup();
        api.failOnPage(1, { kind: 'meta_error', httpStatus: 400, code });
        api.failNextWrite({ kind: 'meta_error', httpStatus: 400, code });

        await expect(
          rejection(adapter.listTemplates(), TemplateCatalogError),
        ).resolves.toMatchObject({ code: 'rate_limited', providerCode: code });
        await expect(
          rejection(
            adapter.createTemplate(toTemplateSubmission(draft())),
            TemplateSubmissionError,
          ),
        ).resolves.toMatchObject({ code: 'rate_limited', ambiguous: false });
        expect(api.requests).toHaveLength(1);
        expect(api.writes).toHaveLength(1);
      },
    );

    it('record 4.1.10: an error keeps the code and nothing of the message, which echoes the token', async () => {
      const { adapter, api } = templateSetup();
      api.failOnPage(1, { kind: 'meta_error', httpStatus: 401, code: 190 });

      const error = await rejection(
        adapter.listTemplates(),
        TemplateCatalogError,
      );

      expect(error).toMatchObject({ code: 'auth_failed', providerCode: 190 });
      expect(error.message).not.toContain(FAKE_TOKEN);
    });

    it('record 4.1.5 and the 4.4.3 worst case: there is no delete, in the fake or in the port adapter', () => {
      const { adapter, api } = templateSetup();

      expect(Object.keys(api.httpService).sort()).toEqual(['get', 'post']);
      expect(
        Object.getOwnPropertyNames(MetaTemplateCatalogAdapter.prototype).filter(
          (name) => /delete|remove|archive/i.test(name),
        ),
      ).toEqual([]);
      expect(adapter).not.toHaveProperty('deleteTemplate');
    });

    it('record 4.8.1 to 4.8.11: every committed webhook payload is the documented shape of a documented field, with synthetic IDs', () => {
      const fields = [
        'message_template_status_update',
        'message_template_quality_update',
        'template_category_update',
        'message_template_components_update',
      ];
      const events = [
        'APPROVED',
        'ARCHIVED',
        'UNARCHIVED',
        'DELETED',
        'DISABLED',
        'FLAGGED',
        'IN_APPEAL',
        'LIMIT_EXCEEDED',
        'LOCKED',
        'PAUSED',
        'PENDING',
        'REINSTATED',
        'PENDING_DELETION',
        'REJECTED',
      ];
      const scores = ['GREEN', 'YELLOW', 'RED', 'UNKNOWN'];
      const names = readdirSync(resolve(FIXTURES, 'webhooks'));
      const seenEvents = new Set<string>();

      for (const name of names) {
        const fixture = JSON.parse(
          readFileSync(resolve(FIXTURES, 'webhooks', name), 'utf8'),
        ) as {
          _fixture: { field: string; documentation: string };
          payload: {
            object: string;
            entry: {
              id: string;
              time: number;
              changes: { field: string; value: Record<string, unknown> }[];
            }[];
          };
        };
        const [entry] = fixture.payload.entry;
        const [change] = entry.changes;
        expect(fixture.payload.object).toBe('whatsapp_business_account');
        expect(entry.id).toBe(FAKE_ACCOUNT_ID);
        expect(Number.isInteger(entry.time)).toBe(true);
        expect(fields).toContain(change.field);
        expect(fixture._fixture.field).toBe(change.field);
        expect(fixture._fixture.documentation).toBe(
          `https://developers.facebook.com/documentation/business-messaging/whatsapp/webhooks/reference/${change.field}`,
        );
        // 4.8.12: the webhook carries the template ID as an integer.
        expect(typeof change.value.message_template_id).toBe('number');
        if (change.field === 'message_template_status_update') {
          expect(events).toContain(change.value.event);
          seenEvents.add(String(change.value.event));
        }
        if (change.field === 'message_template_quality_update') {
          expect(scores).toContain(change.value.new_quality_score);
          expect(scores).toContain(change.value.previous_quality_score);
        }
      }
      // 4.8.7: one payload for each of the 14 documented events.
      expect([...seenEvents].sort()).toEqual([...events].sort());
    });
  });

  describe('criterion 2: sync against the fake', () => {
    it.each([
      ['APPROVED', true],
      ['IN_APPEAL', false],
      ['PENDING', false],
      ['REJECTED', false],
      ['PENDING_DELETION', false],
      ['DELETED', false],
      ['DISABLED', false],
      ['PAUSED', false],
      ['LIMIT_EXCEEDED', false],
      ['ARCHIVED', false],
      ['A_VALUE_THE_RECORD_DOES_NOT_LIST', false],
    ])(
      'record 4.2.1 and its worst-case rule: after a sync, a template Meta lists as %s is sendable: %s',
      async (status, sendable) => {
        const templates = akeedTemplates();
        templates[0].status = status;
        const { sync, repository } = templateSetup(
          new FakeMetaTemplateApi({ templates }),
        );

        await expect(sync.runSync('scheduled')).resolves.toMatchObject({
          outcome: 'succeeded',
        });

        expect(
          isSendableReviewStatus(
            repository.row('cod_confirm.ar.standard').reviewStatus,
          ),
        ).toBe(sendable);
        expect(
          isSendableReviewStatus(
            repository.row('cod_confirm.en.friendly').reviewStatus,
          ),
        ).toBe(true);
      },
    );

    it('record 5.2 and 5.3 worst case: the name Meta does not hold is marked missing, the two it holds extra are reported, and nothing is created', async () => {
      const { sync, repository, api } = templateSetup(
        new FakeMetaTemplateApi({ templates: capturedTemplates() }),
      );

      const result = await sync.runSync('scheduled');

      expect(result).toMatchObject({
        outcome: 'succeeded',
        run: {
          providerTemplateCount: 9,
          missingKeys: ['cod_confirm.en.direct'],
          unknownAtProvider: expect.arrayContaining([
            {
              templateName: 'akeed_cod_verification_direct',
              languageCode: 'en',
            },
            { templateName: 'hello_world', languageCode: 'en_US' },
          ]) as unknown,
        },
      });
      expect(repository.row('cod_confirm.en.direct').reviewStatus).toBe(
        'missing',
      );
      expect(repository.rows).toHaveLength(8);
      expect(api.writes).toHaveLength(0);
    });

    it('record 4.9.4 and the 4.9.5 worst case: a rate limit mid-read stops the sync, changes no row and is not retried', async () => {
      const api = new FakeMetaTemplateApi({ pageSize: 3 }).failOnPage(2, {
        kind: 'meta_error',
        httpStatus: 400,
        code: 80007,
      });
      const { sync, repository } = templateSetup(api);
      const before = JSON.stringify(repository.rows);

      await expect(sync.runSync('scheduled')).resolves.toMatchObject({
        outcome: 'failed',
        run: { errorCode: 'rate_limited' },
      });

      expect(JSON.stringify(repository.rows)).toBe(before);
      expect(api.requests).toHaveLength(2);
    });
  });

  describe('criterion 2: submit and edit rules', () => {
    it.each([
      ['no answer', { kind: 'network' }],
      ['an answer lost after it was applied', { kind: 'applied_then_lost' }],
    ] as const)(
      'worst-case rule under 4.1: a create with %s is unresolved and is never sent again',
      async (_case, fault) => {
        const { adapter, api } = templateSetup();
        api.failNextWrite(fault);

        await expect(
          rejection(
            adapter.createTemplate(toTemplateSubmission(draft())),
            TemplateSubmissionError,
          ),
        ).resolves.toMatchObject({ code: 'unresolved', ambiguous: true });
        expect(api.writes).toHaveLength(1);
      },
    );

    const unused = {
      isActive: false,
      isDefault: false,
      retiredAt: null,
    };

    it.each([
      ['approved', true],
      ['rejected', true],
      ['paused', true],
      ['pending', false],
      ['disabled', false],
      ['in_appeal', false],
      ['archived', false],
      ['missing', false],
      [null, false],
    ] as const)(
      'record 4.3.1: a template whose status is %s may be edited: %s',
      (reviewStatus, editable) => {
        const decision = decideEdit({
          target: { ...unused, reviewStatus },
          hasDraft: true,
          storeCount: 0,
          editsLastDay: 0,
          editsLast30Days: 0,
        });

        expect(decision.ok).toBe(editable);
        if (!decision.ok) expect(decision.rule).toBe('4.3.1');
      },
    );

    it.each([
      ['active', { isActive: true }, 0],
      ['a language default', { isActive: true, isDefault: true }, 0],
      ['selected by a store', {}, 1],
    ] as const)(
      'worst-case rule for 4.3.9: a template that is %s is never edited in place',
      (_case, flags, storeCount) => {
        expect(
          decideEdit({
            target: { ...unused, ...flags, reviewStatus: 'approved' },
            hasDraft: true,
            storeCount,
            editsLastDay: 0,
            editsLast30Days: 0,
          }),
        ).toEqual({ ok: false, reason: 'in_use', rule: '4.3.9' });
      },
    );

    it('record 4.3.2 and the 4.3.10 worst case: an approved template gets one edit in 24 hours and ten in 30 days; a rejected or paused one has no limit', () => {
      const edit = (
        reviewStatus: 'approved' | 'rejected' | 'paused',
        editsLastDay: number,
        editsLast30Days: number,
      ) =>
        decideEdit({
          target: { ...unused, reviewStatus },
          hasDraft: true,
          storeCount: 0,
          editsLastDay,
          editsLast30Days,
        });

      expect(edit('approved', 1, 1)).toEqual({
        ok: false,
        reason: 'daily_limit',
        rule: '4.3.2',
      });
      expect(edit('approved', 0, 10)).toEqual({
        ok: false,
        reason: 'monthly_limit',
        rule: '4.3.2',
      });
      expect(edit('approved', 0, 9)).toEqual({ ok: true });
      expect(edit('rejected', 5, 50)).toEqual({ ok: true });
      expect(edit('paused', 5, 50)).toEqual({ ok: true });
    });
  });

  describe('criterion 2: the free-form window rule (US-08-07 b, c)', () => {
    const NOW = Date.parse('2026-10-06T12:00:00.000Z');
    const PHONE = '+201001112223';

    function windowSetup() {
      const api = new FakeMetaMessagesApi();
      api.now = () => Date.now();
      const whatsapp = new WhatsAppService(
        api.httpService as never,
        {
          get: (key: string) =>
            ({
              WA_ACCESS_TOKEN: FAKE_MESSAGES_TOKEN,
              WA_PHONE_NUMBER_ID: FAKE_PHONE_NUMBER_ID,
            })[key],
        } as never,
      );
      const serviceMessages = {
        claim: jest.fn().mockResolvedValue({ id: 'msg-1' }),
        markSent: jest.fn().mockResolvedValue(undefined),
        markNotSent: jest.fn().mockResolvedValue(undefined),
      };
      const service = new CustomerReplyFollowUpService(
        {
          findById: jest.fn().mockResolvedValue({
            id: 'ver-1',
            orgId: 'org-1',
            orderId: 'order-1',
            status: 'confirmed',
            confirmationSource: 'customer',
            cancellationSource: null,
            merchantCanceledAt: null,
          }),
        } as never,
        {
          findById: jest.fn().mockResolvedValue({
            id: 'order-1',
            orgId: 'org-1',
            isTest: false,
            customerPhone: PHONE,
            orderNumber: '1117',
            externalOrderId: 'ext-1',
            integration: { defaultLanguage: 'auto', storeName: 'Nour' },
          }),
        } as never,
        {
          findLatestAcceptedIdentity: jest.fn().mockResolvedValue({
            resolvedLanguage: 'en',
            variantKey: 'en.friendly',
          }),
        } as never,
        serviceMessages as never,
        {
          resolve: jest.fn().mockResolvedValue({
            body: 'Your order #{{order}} from {{store}} is confirmed.',
            style: 'default',
          }),
        } as never,
        whatsapp,
        {
          current: () => ({
            ...MESSAGE_IMPROVEMENT_SWITCHES_OFF,
            acknowledgment: true,
          }),
        } as never,
      );
      const acknowledgment = (repliedAt: number): CustomerReplyFollowUp => ({
        kind: 'acknowledgment',
        verificationId: 'ver-1',
        orgId: 'org-1',
        repliedAt: new Date(repliedAt).toISOString(),
        intent: 'confirmed',
      });
      return { api, service, serviceMessages, whatsapp, acknowledgment };
    }

    beforeEach(() => {
      jest.useFakeTimers({ doNotFake: ['nextTick', 'setImmediate'] });
      jest.setSystemTime(NOW);
    });

    it('record 4.10.1, 4.10.2 and 4.10.4: inside the window Meta accepts one text message', async () => {
      const { api, service, serviceMessages, acknowledgment } = windowSetup();
      api.customerMessaged(PHONE, 'text', NOW - 60_000);

      await expect(
        service.handle(acknowledgment(NOW - 60_000)),
      ).resolves.toEqual({
        outcome: 'sent',
        providerMessageId: 'wamid.fake-1',
      });

      expect(api.sends).toHaveLength(1);
      expect(api.sends[0].body).toEqual({
        messaging_product: 'whatsapp',
        to: PHONE,
        type: 'text',
        text: { body: 'Your order #1117 from Nour is confirmed.' },
      });
      expect(api.sends[0].url).not.toContain(FAKE_MESSAGES_TOKEN);
      expect(serviceMessages.markSent).toHaveBeenCalledTimes(1);
    });

    it('record 4.10.3: Meta refuses with 131047 once the window has closed; it is a recorded skip, attempted once and never retried', async () => {
      const { api, service, serviceMessages, acknowledgment } = windowSetup();
      api.customerMessaged(PHONE, 'text', NOW - SERVICE_WINDOW_MS);

      await expect(
        service.handle(acknowledgment(NOW - 60_000)),
      ).resolves.toEqual({ outcome: 'skipped', reason: 'window_closed' });

      expect(api.sends).toHaveLength(1);
      expect(serviceMessages.markNotSent).toHaveBeenCalledWith(
        expect.objectContaining({ state: 'skipped', reason: 'window_closed' }),
      );
      expect(serviceMessages.markSent).not.toHaveBeenCalled();
    });

    it('record 4.10.8 (UNKNOWN) and its worst-case rule: if a button tap opens no window, the text is refused once and the answer already recorded stands', async () => {
      const { api, service, serviceMessages, acknowledgment } = windowSetup();
      api.customerMessaged(PHONE, 'button', NOW - 60_000);

      await expect(
        service.handle(acknowledgment(NOW - 60_000)),
      ).resolves.toEqual({ outcome: 'skipped', reason: 'window_closed' });

      expect(api.sends).toHaveLength(1);
      expect(serviceMessages.markNotSent).toHaveBeenCalledTimes(1);
    });

    it('record 4.10.8, the other reading: if a button tap does open the window, the same send is accepted', async () => {
      const { api, service, acknowledgment } = windowSetup();
      api.buttonTapOpensWindow = true;
      api.customerMessaged(PHONE, 'button', NOW - 60_000);

      await expect(
        service.handle(acknowledgment(NOW - 60_000)),
      ).resolves.toMatchObject({ outcome: 'sent' });
    });

    it('record 4.10.2: a reply Akeed itself received 24 hours ago or more is never sent to Meta', async () => {
      const { api, service, serviceMessages, acknowledgment } = windowSetup();
      api.customerMessaged(PHONE, 'text', NOW - 60_000);

      await expect(
        service.handle(acknowledgment(NOW - SERVICE_WINDOW_MS)),
      ).resolves.toEqual({ outcome: 'skipped', reason: 'outside_window' });

      expect(api.sends).toHaveLength(0);
      expect(serviceMessages.markNotSent).toHaveBeenCalledWith(
        expect.objectContaining({ reason: 'outside_window' }),
      );
    });

    it('record 4.10.4: a body over 4096 characters never reaches Meta', async () => {
      const { api, whatsapp } = windowSetup();
      api.customerMessaged(PHONE, 'text', NOW - 60_000);

      await expect(
        whatsapp.sendFreeFormText({
          to: PHONE,
          body: 'x'.repeat(4097),
          verificationId: 'ver-1',
        }),
      ).resolves.toEqual({ outcome: 'rejected', code: 'body_length' });
      expect(api.sends).toHaveLength(0);
    });

    it('record 4.10.2: a template send does not need the window', async () => {
      const { api, whatsapp } = windowSetup();

      await expect(
        whatsapp.sendVerificationTemplate({
          to: PHONE,
          customerName: 'Sara',
          storeName: 'Nour',
          orderNumber: '1117',
          totalPrice: '100.00 EGP',
          verificationId: 'ver-1',
          template: {
            variantKey: 'en.short',
            language: 'en',
            templateName: 'akeed_cod_verification',
            languageCode: 'en',
            parameterFormat: 'positional',
            variables: [{ key: 'order' }, { key: 'total' }],
          },
        }),
      ).resolves.toMatchObject({ messages: [{ id: 'wamid.fake-1' }] });
      expect(api.sends).toHaveLength(1);
    });

    it('record 4.1.10: a text send with no answer is a failure, never retried, and its error, which quotes the token, is logged without it', async () => {
      const { api, whatsapp } = windowSetup();
      api.customerMessaged(PHONE, 'text', NOW - 60_000);
      api.failNextSend({ kind: 'network' });

      await expect(
        whatsapp.sendFreeFormText({
          to: PHONE,
          body: 'Your order is confirmed.',
          verificationId: 'ver-1',
        }),
      ).resolves.toEqual({ outcome: 'failed', code: 'provider_error' });

      expect(api.sends).toHaveLength(1);
      expect(lines.join('\n')).toContain('whatsapp-text-send');
    });

    it.each([
      ['a refusal', { kind: 'meta_error', httpStatus: 400, code: 132001 }],
      ['no answer', { kind: 'network' }],
    ] as const)(
      'record 4.1.10: %s of a template send, whose message echoes the token, puts no token in the log or the error',
      async (_case, failure) => {
        const { api, whatsapp } = windowSetup();
        api.failNextSend(failure);

        const error = await whatsapp
          .sendVerificationTemplate({
            to: PHONE,
            customerName: 'Sara',
            storeName: 'Nour',
            orderNumber: '1117',
            totalPrice: '100.00 EGP',
            verificationId: 'ver-1',
            template: {
              variantKey: 'en.short',
              language: 'en',
              templateName: 'akeed_cod_verification',
              languageCode: 'en',
              parameterFormat: 'positional',
              variables: [{ key: 'order' }, { key: 'total' }],
            },
          })
          .then(
            () => null,
            (caught: Error) => caught,
          );

        expect(error).toBeInstanceOf(Error);
        expect(error?.message).not.toContain(FAKE_MESSAGES_TOKEN);
        expect(lines.join('\n')).toContain('whatsapp-template-send');
      },
    );
  });
});
