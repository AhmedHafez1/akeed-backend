import { ConfigService } from '@nestjs/config';
import {
  META_CONVERSIONS_GRAPH_URL,
  MetaConversionsClient,
  type MetaConversionEvent,
} from './meta-conversions.client';

const EVENT: MetaConversionEvent = {
  event_name: 'CompleteRegistration',
  event_time: 1_790_000_000,
  event_id: 'evt-1',
  event_source_url: 'https://getakeed.com/ar/signup',
  action_source: 'website',
  user_data: { external_id: ['hash'] },
};

function clientWith(env: Record<string, string | undefined>) {
  return new MetaConversionsClient(
    new ConfigService(env as Record<string, unknown>),
  );
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('MetaConversionsClient', () => {
  let fetchMock: jest.SpyInstance;

  beforeEach(() => {
    fetchMock = jest.spyOn(global, 'fetch');
  });

  afterEach(() => {
    fetchMock.mockRestore();
  });

  it('is disabled and sends nothing without a Pixel and token', async () => {
    for (const env of [
      {},
      { META_PIXEL_ID: '999653349077771' },
      { META_CAPI_ACCESS_TOKEN: 'secret' },
      { META_PIXEL_ID: ' ', META_CAPI_ACCESS_TOKEN: 'secret' },
    ]) {
      const client = clientWith(env);
      expect(client.isEnabled()).toBe(false);
      await expect(client.send(EVENT)).resolves.toBe('disabled');
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('posts the event to the Pixel with the token in the body', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(200, { events_received: 1, fbtrace_id: 'trace' }),
    );
    const client = clientWith({
      META_PIXEL_ID: '999653349077771',
      META_CAPI_ACCESS_TOKEN: 'secret',
    });

    await expect(client.send(EVENT)).resolves.toBe('sent');

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(`${META_CONVERSIONS_GRAPH_URL}/999653349077771/events`);
    expect(url).not.toContain('secret');
    expect(init.method).toBe('POST');
    expect(init.signal).toBeDefined();
    expect(JSON.parse(init.body as string)).toEqual({
      data: [EVENT],
      access_token: 'secret',
    });
  });

  it('adds the test event code when configured', async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, { events_received: 1 }));
    const client = clientWith({
      META_PIXEL_ID: '999653349077771',
      META_CAPI_ACCESS_TOKEN: 'secret',
      META_TEST_EVENT_CODE: 'TEST123',
    });

    await client.send(EVENT);

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(init.body as string)).toMatchObject({
      test_event_code: 'TEST123',
    });
  });

  it('reports a Graph error as failed without throwing', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(400, { error: { message: 'Invalid', code: 100 } }),
    );
    const client = clientWith({
      META_PIXEL_ID: '1',
      META_CAPI_ACCESS_TOKEN: 'secret',
    });
    await expect(client.send(EVENT)).resolves.toBe('failed');
  });

  it('reports a network error as failed without throwing', async () => {
    fetchMock.mockRejectedValue(new Error('ECONNRESET'));
    const client = clientWith({
      META_PIXEL_ID: '1',
      META_CAPI_ACCESS_TOKEN: 'secret',
    });
    await expect(client.send(EVENT)).resolves.toBe('failed');
  });
});
