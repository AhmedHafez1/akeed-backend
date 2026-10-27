import { HttpException, HttpStatus } from '@nestjs/common';

/** Stable codes the frontend translates. Never rename one. */
const LOGO_ERRORS = {
  LOGO_FILE_REQUIRED: {
    status: HttpStatus.BAD_REQUEST,
    message: 'Upload one PNG or JPEG file in the "logo" field.',
  },
  LOGO_FILE_TOO_LARGE: {
    status: HttpStatus.PAYLOAD_TOO_LARGE,
    message: 'The logo must be 5 MB or smaller.',
  },
  LOGO_FILE_TYPE_UNSUPPORTED: {
    status: HttpStatus.UNSUPPORTED_MEDIA_TYPE,
    message: 'The logo must be a PNG or JPEG image.',
  },
  LOGO_IMAGE_UNREADABLE: {
    status: HttpStatus.UNPROCESSABLE_ENTITY,
    message: 'The logo image could not be read.',
  },
  LOGO_IMAGE_TOO_SMALL: {
    status: HttpStatus.UNPROCESSABLE_ENTITY,
    message: 'The logo must be at least 64 pixels on its shorter side.',
  },
  LOGO_STORAGE_UNAVAILABLE: {
    status: HttpStatus.SERVICE_UNAVAILABLE,
    message: 'The logo could not be saved right now. Try again shortly.',
  },
  LOGO_WRITE_FORBIDDEN: {
    status: HttpStatus.FORBIDDEN,
    message: 'Owner or admin role is required to change the logo.',
  },
  LOGO_RATE_LIMITED: {
    status: HttpStatus.TOO_MANY_REQUESTS,
    message: 'Too many logo uploads. Try again in a minute.',
  },
} as const;

export type LogoErrorCode = keyof typeof LOGO_ERRORS;

export function logoError(code: LogoErrorCode): HttpException {
  const { status, message } = LOGO_ERRORS[code];
  return new HttpException(
    {
      statusCode: status,
      error: HttpStatus[status],
      message,
      code,
    },
    status,
  );
}
