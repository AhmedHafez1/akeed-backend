import { ConfigService } from '@nestjs/config';
import { OwnNumberGraphClient } from './own-number-graph.client';

describe('Meta phone health mapping', () => {
  afterEach(() => jest.restoreAllMocks());
  function setup(body: unknown, status = 200) {
    const fetch = jest.spyOn(global, 'fetch').mockResolvedValue(
      new Response(JSON.stringify(body), {
        status,
        headers: { 'content-type': 'application/json' },
      }),
    );
    return {
      fetch,
      client: new OwnNumberGraphClient(
        new ConfigService({ META_GRAPH_API_VERSION: 'v26.0' }),
      ),
    };
  }
  it('reads aggregate capability and phone fields with a bounded authenticated request', async () => {
    const s = setup({
      id: '1000',
      health_status: { can_send_message: 'AVAILABLE', entities: [] },
      quality_rating: 'GREEN',
      name_status: 'APPROVED',
    });
    expect(await s.client.readHealth('1000', 'synthetic-token')).toEqual({
      status: 'AVAILABLE',
      qualityRating: 'GREEN',
      nameStatus: 'APPROVED',
    });
    expect(s.fetch).toHaveBeenCalledTimes(1);
    const request = s.fetch.mock.calls[0][0];
    const url =
      typeof request === 'string'
        ? request
        : request instanceof URL
          ? request.href
          : request.url;
    expect(url).toContain('health_status');
    expect(url).not.toContain('synthetic-token');
  });
  it('uses health entity error codes for degradation', async () => {
    const s = setup({
      id: '1000',
      health_status: {
        can_send_message: 'BLOCKED',
        entities: [{ errors: [{ error_code: 131042 }] }],
      },
    });
    expect(await s.client.readHealth('1000', 'synthetic-token')).toMatchObject({
      status: 'BLOCKED',
      failure: { class: 'payment', degrade: 'payment' },
    });
  });
  it.each([
    { id: 'other', health_status: { can_send_message: 'AVAILABLE' } },
    { id: '1000' },
    { id: '1000', health_status: { can_send_message: 'FUTURE_VALUE' } },
  ])(
    'does not infer AVAILABLE from malformed or mismatched health %j',
    async (body) => {
      const s = setup(body);
      expect(await s.client.readHealth('1000', 'synthetic-token')).toEqual({
        status: 'unknown',
      });
    },
  );
  it('a 5xx does not degrade a connection', async () => {
    const s = setup({ error: { code: 131042 } }, 503);
    expect(await s.client.readHealth('1000', 'synthetic-token')).toEqual({
      status: 'unknown',
    });
    expect(s.fetch).toHaveBeenCalledTimes(1);
  });
});
