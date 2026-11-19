import { createSwappableClient } from './swappable-client';

type FakeClient = {
  id: number;
  options: {
    parsers: Record<string, unknown>;
    serializers: Record<string, unknown>;
  };
  unsafe: jest.Mock;
  begin: jest.Mock;
  end: jest.Mock;
  (strings: TemplateStringsArray): string;
};

function fakeClient(id: number): FakeClient {
  const tagged = ((strings: TemplateStringsArray) =>
    `${id}:${strings.join('')}`) as FakeClient;
  tagged.id = id;
  tagged.options = { parsers: { '25': String }, serializers: {} };
  tagged.unsafe = jest.fn(function (this: unknown, statement: string) {
    return { statement, client: id, self: this };
  });
  tagged.begin = jest.fn(() => Promise.resolve(`tx-${id}`));
  tagged.end = jest.fn(() => Promise.resolve());
  return tagged;
}

describe('createSwappableClient', () => {
  it('creates no client until the handle is first used', async () => {
    const create = jest.fn(fakeClient);
    const swappable = createSwappableClient(create);

    await swappable.endAll(5);
    expect(create).not.toHaveBeenCalled();

    expect(swappable.client.id).toBe(1);
    expect(create).toHaveBeenCalledTimes(1);
  });

  it('forwards property reads, method calls and tagged calls to the current client', () => {
    const swappable = createSwappableClient(fakeClient);
    const handle = swappable.client;

    expect(handle.id).toBe(1);
    expect(handle.unsafe('select 1')).toMatchObject({
      statement: 'select 1',
      client: 1,
    });
    // Methods keep their own client as `this`.
    expect((handle.unsafe('select 2') as { self: unknown }).self).toBeDefined();
    expect(handle`select 3`).toBe('1:select 3');
    expect('unsafe' in handle).toBe(true);
    expect(swappable.generation).toBe(1);
  });

  it('moves later calls to the new client and copies type handlers onto it', () => {
    const created: FakeClient[] = [];
    const swappable = createSwappableClient((generation) => {
      const client = fakeClient(generation);
      created.push(client);
      return client;
    });
    const handle = swappable.client;
    // Drizzle replaces handlers on the first client it is given.
    const transparent = (value: unknown) => value;
    handle.options.parsers['1184'] = transparent;
    handle.options.serializers['114'] = transparent;

    const { generation } = swappable.replace(60);

    expect(generation).toBe(2);
    expect(swappable.generation).toBe(2);
    expect(handle.id).toBe(2);
    handle.unsafe('select 1');
    expect(created[1].unsafe).toHaveBeenCalledWith('select 1');
    expect(created[0].unsafe).not.toHaveBeenCalled();
    expect(created[1].options.parsers['1184']).toBe(transparent);
    expect(created[1].options.serializers['114']).toBe(transparent);
    expect(created[1].options.parsers['25']).toBe(String);
  });

  it('ends the previous client with the drain timeout', async () => {
    const created: FakeClient[] = [];
    const swappable = createSwappableClient((generation) => {
      const client = fakeClient(generation);
      created.push(client);
      return client;
    });

    const { drained } = swappable.replace(42);

    await expect(drained).resolves.toBe('ended');
    expect(created[0].end).toHaveBeenCalledWith({ timeout: 42 });
    expect(created[1].end).not.toHaveBeenCalled();
  });

  it('reports a failed drain without throwing', async () => {
    const swappable = createSwappableClient((generation) => {
      const client = fakeClient(generation);
      client.end.mockRejectedValue(new Error('socket gone'));
      return client;
    });

    await expect(swappable.replace(1).drained).resolves.toBe('failed');
  });

  it('ends the current client and any client still draining on shutdown', async () => {
    const created: FakeClient[] = [];
    const swappable = createSwappableClient((generation) => {
      const client = fakeClient(generation);
      created.push(client);
      return client;
    });
    let finishDrain: () => void = () => undefined;
    expect(swappable.client.id).toBe(1);
    created[0].end.mockImplementationOnce(
      () => new Promise<void>((resolve) => (finishDrain = resolve)),
    );
    swappable.replace(60);

    const ending = swappable.endAll(5);
    finishDrain();
    await ending;

    expect(created[1].end).toHaveBeenCalledWith({ timeout: 5 });
    expect(created[0].end).toHaveBeenLastCalledWith({ timeout: 5 });
  });
});
