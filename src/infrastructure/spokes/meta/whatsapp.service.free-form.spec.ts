import { Logger } from '@nestjs/common';
import { AxiosError, type AxiosResponse } from 'axios';
import { of, throwError } from 'rxjs';
import { WhatsAppService } from './whatsapp.service';

/** US-08-07 b and c at the Meta spoke: one text message, never retried. */
function setup(post: jest.Mock) {
  return new WhatsAppService(
    { post } as never,
    {
      get: (key: string) =>
        ({ WA_ACCESS_TOKEN: 'token', WA_PHONE_NUMBER_ID: 'phone-id' })[key],
    } as never,
  );
}

function metaError(status: number, code: number) {
  const response = {
    status,
    data: { error: { code, message: 'Meta says no' } },
  } as AxiosResponse;
  return new AxiosError(
    'Request failed',
    'ERR',
    undefined,
    undefined,
    response,
  );
}

const PARAMS = { to: '+201001112223', body: 'شكرًا لك!', verificationId: 'v1' };

describe('WhatsAppService.sendFreeFormText (record 4.10.4)', () => {
  beforeEach(() => {
    jest.spyOn(Logger.prototype, 'warn').mockImplementation();
    jest.spyOn(Logger.prototype, 'error').mockImplementation();
  });
  afterEach(() => jest.restoreAllMocks());

  it('posts a text message in the template envelope and returns the id', async () => {
    const post = jest
      .fn()
      .mockReturnValue(of({ data: { messages: [{ id: 'wamid.text-1' }] } }));
    await expect(setup(post).sendFreeFormText(PARAMS)).resolves.toEqual({
      outcome: 'accepted',
      providerMessageId: 'wamid.text-1',
    });
    expect(post).toHaveBeenCalledTimes(1);
    expect(post).toHaveBeenCalledWith(
      'https://graph.facebook.com/v24.0/phone-id/messages',
      {
        messaging_product: 'whatsapp',
        to: '+201001112223',
        type: 'text',
        text: { body: 'شكرًا لك!' },
      },
      {
        headers: {
          Authorization: 'Bearer token',
          'Content-Type': 'application/json',
        },
      },
    );
  });

  it('maps 131047 to window_closed, once, and logs no failure', async () => {
    const post = jest
      .fn()
      .mockReturnValue(throwError(() => metaError(400, 131047)));
    const error = jest.spyOn(Logger.prototype, 'error');
    await expect(setup(post).sendFreeFormText(PARAMS)).resolves.toEqual({
      outcome: 'window_closed',
    });
    expect(post).toHaveBeenCalledTimes(1);
    expect(error).not.toHaveBeenCalled();
  });

  it('reports another refusal as rejected and no answer as failed, never throwing', async () => {
    const rejected = jest
      .fn()
      .mockReturnValue(throwError(() => metaError(400, 100)));
    await expect(setup(rejected).sendFreeFormText(PARAMS)).resolves.toEqual({
      outcome: 'rejected',
      code: 'provider_rejected',
    });
    const down = jest
      .fn()
      .mockReturnValue(throwError(() => new Error('socket hang up')));
    await expect(setup(down).sendFreeFormText(PARAMS)).resolves.toEqual({
      outcome: 'failed',
      code: 'provider_error',
    });
    const noId = jest.fn().mockReturnValue(of({ data: {} }));
    await expect(setup(noId).sendFreeFormText(PARAMS)).resolves.toEqual({
      outcome: 'failed',
      code: 'missing_provider_message_id',
    });
  });

  it('refuses a body over 4096 characters without calling Meta', async () => {
    const post = jest.fn();
    await expect(
      setup(post).sendFreeFormText({ ...PARAMS, body: 'x'.repeat(4097) }),
    ).resolves.toEqual({ outcome: 'rejected', code: 'body_length' });
    await expect(
      setup(post).sendFreeFormText({ ...PARAMS, body: 'x'.repeat(4096) }),
    ).resolves.toMatchObject({ outcome: 'failed' });
    expect(post).toHaveBeenCalledTimes(1);
  });
});
