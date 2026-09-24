import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { GetVerificationsQueryDto } from './dashboard.dto';

async function errorsFor(query: Record<string, unknown>) {
  const dto = plainToInstance(GetVerificationsQueryDto, query);
  const errors = await validate(dto, { whitelist: true });
  return { dto, fields: errors.map((error) => error.property) };
}

describe('GetVerificationsQueryDto', () => {
  it.each(['1138', '#1138', '+20 100 761 1456', '(010) 761-1456'])(
    'accepts the search %p',
    async (q) => {
      await expect(errorsFor({ q })).resolves.toMatchObject({ fields: [] });
    },
  );

  it.each(["1138' OR 1=1", '%', 'abc', '1'.repeat(33)])(
    'rejects the search %p',
    async (q) => {
      await expect(errorsFor({ q })).resolves.toMatchObject({
        fields: ['q'],
      });
    },
  );

  it('treats a blank search as none', async () => {
    const { dto, fields } = await errorsFor({ q: '   ' });
    expect(fields).toEqual([]);
    expect(dto.q).toBeUndefined();
  });

  it.each(['all', 'needs_action', 'confirmed', 'canceled', 'failed'])(
    'accepts the tab %p',
    async (tab) => {
      await expect(errorsFor({ tab })).resolves.toMatchObject({ fields: [] });
    },
  );

  it('rejects an unknown tab', async () => {
    await expect(errorsFor({ tab: 'pending' })).resolves.toMatchObject({
      fields: ['tab'],
    });
  });

  it.each(['0', '101', 'ten'])('rejects the page size %p', async (limit) => {
    await expect(errorsFor({ limit })).resolves.toMatchObject({
      fields: ['limit'],
    });
  });
});
