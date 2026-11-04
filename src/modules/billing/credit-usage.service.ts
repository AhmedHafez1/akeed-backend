import {
  BadRequestException,
  Injectable,
  ServiceUnavailableException,
} from '@nestjs/common';
import { CreditUsageRepository } from '../../infrastructure/database/repositories/credit-usage.repository';
import { BILLING_ERROR_CODES } from './billing.types';

export function creditUsageTimeZone(value: unknown): string {
  if (value === undefined) return 'UTC';
  if (
    typeof value === 'string' &&
    value.length <= 100 &&
    !/^[+-]/.test(value)
  ) {
    try {
      return new Intl.DateTimeFormat('en', {
        timeZone: value,
      }).resolvedOptions().timeZone;
    } catch {
      /* Return the same safe validation error for every invalid zone. */
    }
  }
  throw new BadRequestException({
    code: BILLING_ERROR_CODES.validationFailed,
    message: 'A valid timeZone is required.',
  });
}

@Injectable()
export class CreditUsageService {
  constructor(private readonly usage: CreditUsageRepository) {}

  async read(orgId: string, timeZone?: unknown) {
    const snapshot = await this.usage.read(
      orgId,
      creditUsageTimeZone(timeZone),
      new Date().toISOString(),
    );
    if (!snapshot)
      throw new ServiceUnavailableException(
        'Complete credit usage is unavailable.',
      );
    return snapshot;
  }
}
