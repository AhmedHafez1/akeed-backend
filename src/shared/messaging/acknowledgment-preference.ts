import { BadRequestException } from '@nestjs/common';

/** One saved preference controls acknowledgments from either sender. */
export function acknowledgmentPreferenceUpdates(
  current: boolean,
  enabled: boolean,
  available: boolean,
) {
  if (enabled && !current && !available)
    throw new BadRequestException({
      statusCode: 400,
      error: 'Bad Request',
      message: 'Thank-you messages are not available',
      code: 'SETTINGS_ACKNOWLEDGMENT_UNAVAILABLE',
    });
  return {
    acknowledgmentEnabled: enabled,
    ...(enabled && !current
      ? { acknowledgmentEnabledAt: new Date().toISOString() }
      : {}),
  };
}
