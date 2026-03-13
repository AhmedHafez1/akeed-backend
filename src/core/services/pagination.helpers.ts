import { BadRequestException } from '@nestjs/common';

interface CursorPayload {
  createdAt: string;
  id: string;
}

export function encodeCursor(item: {
  createdAt?: string | null;
  id: string;
}): string {
  const payload: CursorPayload = {
    createdAt: item.createdAt ?? '',
    id: item.id,
  };
  return Buffer.from(JSON.stringify(payload)).toString('base64url');
}

export function decodeCursor(cursor?: string): CursorPayload | undefined {
  if (!cursor) return undefined;

  try {
    const json = Buffer.from(cursor, 'base64url').toString('utf-8');
    const parsed = JSON.parse(json) as Record<string, unknown>;

    if (typeof parsed.createdAt !== 'string' || typeof parsed.id !== 'string') {
      throw new Error('Invalid cursor shape');
    }

    return { createdAt: parsed.createdAt, id: parsed.id };
  } catch {
    throw new BadRequestException('Invalid cursor');
  }
}
