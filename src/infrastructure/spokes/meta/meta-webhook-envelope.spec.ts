import { createHash } from 'node:crypto';
import {
  canonicalJson,
  changeIdentity,
  isSingleChange,
  parseBody,
  splitWebhookBody,
} from './meta-webhook-envelope';

const LARGE_ID = '1234567890123456789';

const buffer = (value: unknown) => Buffer.from(JSON.stringify(value));

describe('Meta webhook envelope', () => {
  it('stores one single-change envelope per change across entries', () => {
    const events = splitWebhookBody(
      buffer({
        object: 'whatsapp_business_account',
        entry: [
          {
            id: 'waba-1',
            changes: [
              {
                field: 'messages',
                value: {
                  metadata: { phone_number_id: 'phone-1' },
                  messages: [{ id: 'wamid.1' }],
                },
              },
              { field: 'messages', value: { statuses: [{ id: 'wamid.2' }] } },
            ],
          },
          {
            id: 'waba-2',
            time: 1767268800,
            changes: [{ field: 'template_category_update', value: { a: 1 } }],
          },
        ],
      }),
    );

    expect(events).toHaveLength(3);
    expect(events[0]).toMatchObject({
      field: 'messages',
      wabaId: 'waba-1',
      phoneNumberId: 'phone-1',
    });
    expect(events[2]).toMatchObject({
      field: 'template_category_update',
      wabaId: 'waba-2',
      phoneNumberId: null,
    });
    expect(new Set(events.map((event) => event.dedupeHash)).size).toBe(3);
    for (const event of events) {
      expect(isSingleChange(JSON.parse(event.payload))).toBe(true);
    }
    expect(JSON.parse(events[2].payload)).toEqual({
      object: 'whatsapp_business_account',
      entry: [
        {
          id: 'waba-2',
          time: 1767268800,
          changes: [{ field: 'template_category_update', value: { a: 1 } }],
        },
      ],
    });
  });

  it('builds the hash from the field, entry id, time and a canonical value', () => {
    const [event] = splitWebhookBody(
      buffer({
        entry: [
          {
            id: 'waba',
            time: 5,
            changes: [{ field: 'f', value: { b: 2, a: 1 } }],
          },
        ],
      }),
    );

    const expected = createHash('sha256')
      .update(
        [
          'f',
          'waba',
          '5',
          createHash('sha256').update('{"a":1,"b":2}').digest('hex'),
        ].join('|'),
      )
      .digest('hex');
    expect(event.dedupeHash).toBe(expected);
    expect(changeIdentity('f', 'waba', 5, { a: 1, b: 2 })).toBe(expected);
  });

  it('gives a recurring template value a new identity at a new time', () => {
    const delivery = (time: number) =>
      buffer({
        entry: [
          { id: 'waba', time, changes: [{ field: 'f', value: { a: 1 } }] },
        ],
      });

    expect(splitWebhookBody(delivery(1))[0].dedupeHash).not.toBe(
      splitWebhookBody(delivery(2))[0].dedupeHash,
    );
  });

  it('gives the same change one identity however a delivery batches it', () => {
    const change = { field: 'messages', value: { messages: [{ id: 'w' }] } };
    const other = { field: 'messages', value: { messages: [{ id: 'x' }] } };

    const alone = splitWebhookBody(
      buffer({ entry: [{ id: 'waba', changes: [change] }] }),
    );
    const batched = splitWebhookBody(
      buffer({ entry: [{ id: 'waba', changes: [other, change] }] }),
    );

    expect(batched[1].dedupeHash).toBe(alone[0].dedupeHash);
  });

  it('keeps a template id over 2^53 exact through the stored envelope', () => {
    const raw = Buffer.from(
      `{"entry":[{"id":"waba","time":1,"changes":[{"field":"message_template_status_update","value":{"message_template_id":${LARGE_ID}}}]}]}`,
    );

    const [event] = splitWebhookBody(raw);
    expect(event.payload).toContain(LARGE_ID);

    const replayed = parseBody(Buffer.from(event.payload)) as {
      entry: { changes: { value: { message_template_id: unknown } }[] }[];
    };
    expect(replayed.entry[0].changes[0].value.message_template_id).toBe(
      LARGE_ID,
    );
    // Replaying can't move the hash: the value reads the same both ways.
    expect(canonicalJson(replayed.entry[0].changes[0].value)).toBe(
      `{"message_template_id":"${LARGE_ID}"}`,
    );
  });

  it.each([
    ['no entry', { object: 'x' }],
    ['an empty entry list', { entry: [] }],
    ['an entry with no changes', { entry: [{ id: 'waba', changes: [] }] }],
    ['a change that is not an object', { entry: [{ changes: ['nope'] }] }],
    ['an array body', [1, 2]],
  ])('stores a body with %s as one row', (_case, value) => {
    const raw = buffer(value);

    const events = splitWebhookBody(raw);

    expect(events).toEqual([
      {
        dedupeHash: createHash('sha256').update(raw).digest('hex'),
        field: null,
        wabaId: null,
        phoneNumberId: null,
        payload: raw.toString('utf8'),
      },
    ]);
    expect(isSingleChange(JSON.parse(events[0].payload))).toBe(false);
  });

  it('stores a body that is not JSON as one row', () => {
    expect(splitWebhookBody(Buffer.from('not json'))).toHaveLength(1);
  });

  it('keeps the usable changes and the whole body when one part is malformed', () => {
    const events = splitWebhookBody(
      buffer({
        entry: [{ id: 'waba', changes: [{ field: 'messages', value: {} }, 7] }],
      }),
    );

    expect(events).toHaveLength(2);
    expect(events[0].field).toBe('messages');
    expect(events[1].field).toBeNull();
    expect(isSingleChange(JSON.parse(events[1].payload))).toBe(false);
  });
});
