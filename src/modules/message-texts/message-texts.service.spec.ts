import { Logger } from '@nestjs/common';
import type { MessageText } from '../../shared/messaging/message-texts.types';
import { MessageTextsService } from './message-texts.service';

function text(change: Partial<MessageText>): MessageText {
  return {
    id: 'id',
    purpose: 'ack_confirmed',
    language: 'ar',
    style: 'default',
    body: 'body',
    isActive: true,
    updatedAt: '2026-10-06T00:00:00.000Z',
    ...change,
  };
}

describe('MessageTextsService', () => {
  const texts = [
    text({ body: 'ar default' }),
    text({ style: 'egyptian', body: 'ar egyptian' }),
    text({ style: 'gulf', body: 'ar gulf', isActive: false }),
    text({ language: 'en', body: 'en default' }),
  ];

  it('prefers the style text, falls back to the default, and skips inactive rows', async () => {
    const service = new MessageTextsService({
      findAll: jest.fn().mockResolvedValue(texts),
    } as never);
    expect(
      (await service.resolve('ack_confirmed', 'ar', 'egyptian'))?.body,
    ).toBe('ar egyptian');
    expect((await service.resolve('ack_confirmed', 'ar', 'gulf'))?.body).toBe(
      'ar default',
    );
    expect(
      (await service.resolve('ack_confirmed', 'en', 'friendly'))?.body,
    ).toBe('en default');
    expect(await service.resolve('ack_canceled', 'ar')).toBeNull();
  });

  it('reads once until invalidated, and serves the last copy when a refresh fails', async () => {
    jest.spyOn(Logger.prototype, 'warn').mockImplementation();
    const findAll = jest.fn().mockResolvedValue(texts);
    const service = new MessageTextsService({ findAll } as never);
    await service.resolve('ack_confirmed', 'ar');
    await service.resolve('ack_confirmed', 'en');
    expect(findAll).toHaveBeenCalledTimes(1);
    service.invalidate();
    await service.resolve('ack_confirmed', 'ar');
    expect(findAll).toHaveBeenCalledTimes(2);

    findAll.mockRejectedValueOnce(new Error('down'));
    jest.spyOn(Date, 'now').mockReturnValue(Date.now() + 120_000);
    expect((await service.resolve('ack_confirmed', 'ar'))?.body).toBe(
      'ar default',
    );
    jest.restoreAllMocks();
  });
});
