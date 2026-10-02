import { HttpException, type ArgumentMetadata } from '@nestjs/common';
import {
  createIntegrationKeyPipe,
  integrationKeyIdPipe,
} from './integration-keys.controller';

const BODY: ArgumentMetadata = { type: 'body', metatype: Object, data: '' };
const PARAM: ArgumentMetadata = { type: 'param', metatype: String, data: 'id' };

async function rejection(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof HttpException) return error.getResponse();
    throw error;
  }
  throw new Error('expected the pipe to refuse');
}

describe('IntegrationKeysController pipes', () => {
  it('trims and accepts a valid name', async () => {
    await expect(
      createIntegrationKeyPipe.transform({ name: '  Shop server  ' }, BODY),
    ).resolves.toMatchObject({ name: 'Shop server' });
  });

  it.each([
    ['a missing name', {}, 'name'],
    ['an empty name', { name: '   ' }, 'name'],
    ['a long name', { name: 'x'.repeat(61) }, 'name'],
    ['a non-text name', { name: 42 }, 'name'],
    ['a control character', { name: `a${String.fromCharCode(0x07)}b` }, 'name'],
    ['an unknown field', { name: 'ok', integrationId: 'x' }, 'integrationId'],
  ])('answers API_KEY_VALIDATION_FAILED for %s', async (_case, body, field) => {
    const response = (await rejection(
      createIntegrationKeyPipe.transform(body, BODY),
    )) as {
      statusCode: number;
      code: string;
      fieldErrors: Record<string, unknown>;
    };
    expect(response.statusCode).toBe(400);
    expect(response.code).toBe('API_KEY_VALIDATION_FAILED');
    expect(typeof response.fieldErrors[field]).toBe('string');
  });

  it('reads a malformed key id as not found', async () => {
    await expect(
      rejection(integrationKeyIdPipe.transform('not-a-uuid', PARAM)),
    ).resolves.toMatchObject({ statusCode: 404, code: 'API_KEY_NOT_FOUND' });
  });
});
